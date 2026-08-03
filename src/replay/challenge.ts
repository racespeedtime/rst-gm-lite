import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  GameText,
  Npc,
  Player,
  RaceCheckpoint,
  RaceCpEvent,
  Vehicle,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isInRace } from "@/race/room";
import { getOwnedVehicle, spawnVehicle } from "@/vehicles";
import { getDefaultRaceModel } from "@/race/vehicle";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { parseReplayFile, type ReplayData } from "./format";
import { join } from "node:path";
import { RECORDING_DIR } from "./storage";
import { sampleAt, allocReplayWorld, getReplaySession } from "./playback";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_RACE, COLOR_SUCCESS, COLOR_ERROR } from "@/utils/colors";

/**
 * 影子挑战：选一条"自己的该赛道比赛回放"当影子（NPC 车），
 * 在独立世界里与它同步起跑，过 CP 对比进度，到终点比用时。
 * 回放帧自带 CP 进度 → 影子进度实时从帧读（事件无关，天然一致）。
 */

interface ChallengeGhost {
  npc: Npc;
  vehicle: Vehicle;
  label: Dynamic3DTextLabel;
  /** 影子播放时间（毫秒，从 0 起跑，播完 clamp 在终点） */
  playTime: number;
}

export interface ChallengeSession {
  playerId: number;
  worldId: number;
  /** 挑战前所在世界（退出/结束恢复） */
  prevWorld: number;
  replayId: string;
  data: ReplayData;
  ghost: ChallengeGhost;
  cps: { x: number; y: number; z: number; size: number }[];
  /** 玩家已过的 CP 数（0 = 未过任何 CP） */
  cpIndex: number;
  totalCp: number;
  startAt: number;
  finished: boolean;
  tickMs: number; // 玩家挑战已推进毫秒（结算用）
  timer?: NodeJS.Timeout;
}

const challenges = new Map<number, ChallengeSession>();

export function isInChallenge(playerId: number): boolean {
  return challenges.has(playerId);
}

/** 玩家断线/退出清理（挑战会话销毁 + ghost 清理 + 恢复原世界） */
export function cleanupChallenge(playerId: number): void {
  const ch = challenges.get(playerId);
  if (!ch) return;
  challenges.delete(playerId);
  if (ch.timer) clearIntervalSafe(ch.timer);
  try {
    ch.ghost.label.destroy();
    ch.ghost.npc.destroy();
    ch.ghost.vehicle.destroy();
  } catch {
    /* 已销毁/失效 */
  }
  const p = Player.getInstance(playerId);
  if (p && p.isConnected()) {
    p.setVirtualWorld(ch.prevWorld);
    RaceCheckpoint.disable(p);
    // 爱车一并切回原世界（防留在挑战世界成幽灵车；对齐比赛 restorePlayerAfterRace）
    const owned = getOwnedVehicle(playerId);
    if (owned && owned.isValid() && owned !== p.getVehicle()) {
      owned.setVirtualWorld(ch.prevWorld);
    }
  }
}

/** 服务器退出：全部挑战销毁 */
export function destroyAllChallenges(): void {
  for (const id of [...challenges.keys()]) cleanupChallenge(id);
}

/** 渲染影子到当前播放时间（帧序一致；播完 clamp 终点） */
function renderGhost(ch: ChallengeSession): void {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return;
  try {
    ch.ghost.npc.setVehiclePos(s.x, s.y, s.z, true);
    ch.ghost.npc.setVehicleRot(s.rx, s.ry, s.rz, true);
    ch.ghost.npc.setVelocity(s.vx, s.vy, s.vz);
  } catch {
    /* 实体失效由清理兜底 */
  }
}

/** 影子当前已过的 CP 数（从帧读，事件无关） */
function ghostCpProgress(ch: ChallengeSession): number {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  return s ? Math.max(0, Math.min(ch.totalCp, s.cpProgress)) : 0;
}

/** 60fps 推进影子（玩家自己动，影子按录制时间推进） */
function tickChallenge(ch: ChallengeSession): void {
  if (ch.finished) return;
  ch.tickMs += 16;
  const dur = ch.data.header.frameCount * ch.data.header.frameIntervalMs;
  ch.ghost.playTime = Math.min(dur, ch.ghost.playTime + 16);
  renderGhost(ch);
}

/** 玩家过 CP（RaceCpEvent.onPlayerEnter 注册：进入 checkpoint 范围自动触发；
 * 进入后不再触发直到离开再进 → cpIndex 递增天然防重复计数） */
function onChallengePlayerEnter(player: Player): void {
  const ch = challenges.get(player.id);
  if (!ch || ch.finished) return;
  // 目标 CP = 当前进度（RaceCheckpoint.set 维护的箭头流指向它）
  const next = ch.cps[ch.cpIndex];
  if (!next) return;
  ch.cpIndex++;
  const ghostCp = ghostCpProgress(ch);
  if (ch.cpIndex >= ch.totalCp) {
    // 完成：结算
    ch.finished = true;
    RaceCheckpoint.disable(player);
    void finishChallenge(player, ch);
    return;
  }
  // 下一个 CP 箭头（对齐比赛：type 0 箭头指向下一个 CP）
  const nxt = ch.cps[ch.cpIndex];
  const nxt2 = ch.cps[ch.cpIndex + 1];
  if (nxt && nxt2) {
    RaceCheckpoint.set(player, 0, nxt.x, nxt.y, nxt.z, nxt2.x, nxt2.y, nxt2.z, nxt.size);
  }
  const ahead = ch.cpIndex > ghostCp ? "领先影子" : ch.cpIndex < ghostCp ? "落后影子" : "与影子持平";
  player.sendClientMessage(COLOR_RACE, `[影子] CP ${ch.cpIndex}/${ch.totalCp}（影子 ${ghostCp}/${ch.totalCp}）${ahead}`);
}

/** 完成结算（玩家用时 vs 影子用时 = 录制时长） */
async function finishChallenge(player: Player, ch: ChallengeSession): Promise<void> {
  const playerMs = ch.tickMs;
  const ghostMs = ch.data.header.durationMs;
  const diff = playerMs - ghostMs;
  const verdict =
    diff <= -500
      ? "你赢了！"
      : diff >= 500
        ? "影子赢了"
        : "势均力敌！";
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "影子挑战",
      info: [
        `{98CDFE}你的用时: {FFFFFF}${fmtMs(playerMs)}`,
        `{98CDFE}影子用时: {FFFFFF}${fmtMs(ghostMs)}`,
        `{98CDFE}差距: {FFFFFF}${fmtMs(Math.abs(diff))}`,
        "",
        `{FFD700}${verdict}`,
      ].join("\n"),
      button1: "确定",
    }),
  );
  void res;
  // 结算后退出挑战（回放记录已完成）
  const owner = Player.getInstance(ch.playerId);
  if (owner && owner.isConnected()) {
    owner.sendClientMessage(COLOR_SUCCESS, "影子挑战结束，可再选回放继续挑战");
  }
  cleanupChallenge(ch.playerId);
}

function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${s}.${String(cs).padStart(2, "0")}s`;
}

/**
 * 开始影子挑战：从"本人的该赛道比赛回放"选一条当影子。
 * 独立世界隔离；玩家放入（有爱车则用，无则刷标准车型），与影子同步起跑。
 */
export async function startChallengeFromRace(player: Player, raceId: string): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) {
    player.sendClientMessage(COLOR_ERROR, "请先登录");
    return false;
  }
  if (challenges.has(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "你已在影子挑战中，先 /challenge stop");
    return false;
  }
  if (getReplaySession(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "你正在播放回放中，先 /rp stop");
    return false;
  }
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "比赛中不能进入影子挑战");
    return false;
  }
  // 本人该赛道的比赛回放（完成比赛的优先，未完成也允许——影子只跑已录部分）
  const races = await prisma.replay.findMany({
    where: { userId: auth.userId, raceId, type: "race", deletedAt: null },
    orderBy: [{ finished: "desc" }, { createdAt: "desc" }],
  });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "你还没有该赛道的比赛回放（跑一场比赛后自动生成）");
    return false;
  }
  const replay = races[0]; // 最近一次完成比赛的回放
  let data: ReplayData;
  try {
    data = parseReplayFile(join(RECORDING_DIR, replay.fileName));
  } catch (e) {
    logger.error(`[replay] 挑战回放读取失败 ${replay.fileName}`, e);
    player.sendClientMessage(COLOR_ERROR, "回放文件损坏或不存在");
    return false;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId },
    orderBy: { index: "asc" },
  });
  if (cps.length < 2) {
    player.sendClientMessage(COLOR_ERROR, "该赛道至少需要 2 个检查点");
    return false;
  }
  const worldId = allocReplayWorld();

  // 影子（ghost）创建
  let ghost: ChallengeGhost;
  try {
    const npc = new Npc(`CHA_${Date.now()}`.slice(0, 24)).create();
    const vehicle = new Vehicle({
      modelId: data.header.vehicleModelId,
      // 影子起点 = 录制起始位置（与回放/玩家起点一致）
      x: data.header.startX,
      y: data.header.startY,
      z: data.header.startZ,
      zAngle: 0,
      color: [-1, -1],
      respawnDelay: 0,
    });
    vehicle.create();
    vehicle.setVirtualWorld(worldId);
    npc.setVirtualWorld(worldId);
    npc.putInVehicle(vehicle, 0);
    npc.setInvulnerable(true);
    const label = new Dynamic3DTextLabel({
      text: `{FFD700}影子\n{FFFFFF}挑战 · ${replay.recorderName}`,
      color: "#ffffff",
      x: 0,
      y: 0,
      z: 0.3,
      drawDistance: 40,
      testLOS: false,
      attachedPlayer: npc.getPlayer().id,
      worldId,
      charset: DEFAULT_CHARSET,
    });
    label.create();
    ghost = { npc, vehicle, label, playTime: 0 };
  } catch (e) {
    logger.error(`[replay] 创建挑战影子失败`, e);
    player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足或创建失败");
    return false;
  }

  const ch: ChallengeSession = {
    playerId: player.id,
    worldId,
    prevWorld: player.getVirtualWorld(),
    replayId: replay.id,
    data,
    ghost,
    cps: cps.map((c) => ({ x: Number(c.x), y: Number(c.y), z: Number(c.z), size: Number(c.size) })),
    cpIndex: 0,
    totalCp: cps.length,
    startAt: Date.now(),
    finished: false,
    tickMs: 0,
  };
  challenges.set(player.id, ch);
  ch.timer = setIntervalSafe(() => tickChallenge(ch), 16);

  // 玩家放入（有爱车则用（模型不符也直接用——挑战自由），无则刷标准车型）
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(ch.cps[0].x, ch.cps[0].y, ch.cps[0].z);
    owned.setZAngle(Number(cps[0].angle ?? 0));
    owned.setVirtualWorld(worldId);
    owned.putPlayerIn(player, 0);
  } else {
    await spawnVehicle(player, getDefaultRaceModel(cps.map(() => ({ scripts: [] as string[] }))), true);
    if (!player.isConnected()) {
      cleanupChallenge(player.id); // await 期间断线 → 清理 ghost
      return false;
    }
    const v = getOwnedVehicle(player.id);
    if (v && v.isValid()) {
      v.setPos(ch.cps[0].x, ch.cps[0].y, ch.cps[0].z);
      v.setZAngle(Number(cps[0].angle ?? 0));
      v.setVirtualWorld(worldId);
      v.putPlayerIn(player, 0);
    }
  }
  player.setVirtualWorld(worldId);
  player.setPos(ch.cps[0].x, ch.cps[0].y, ch.cps[0].z);
  // 第一个 CP 箭头（指向第二个）
  const nxt2 = ch.cps[1];
  RaceCheckpoint.set(player, 0, ch.cps[0].x, ch.cps[0].y, ch.cps[0].z, nxt2.x, nxt2.y, nxt2.z, ch.cps[0].size);
  player.sendClientMessage(COLOR_SUCCESS, `影子挑战开始！目标 ${replay.raceName ?? "该赛道"}，追上影子 /challenge stop 退出`);
  // 同步起跑提示
  const gt = new GameText("~g~GO~r~!~n~~g~GO~r~!", 2000, 3);
  gt.forPlayer(player);
  player.playSound(1057);
  return true;
}

/** 初始化挑战：注册 CP 进入检测（与比赛共用 RaceCpEvent 入口） */
export function initChallenge(): void {
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    onChallengePlayerEnter(player);
    return next();
  });
}

/** 玩家断线清理挂接（callbacks onDisconnect 调用） */
export function challengeDisconnect(playerId: number): void {
  cleanupChallenge(playerId);
}
