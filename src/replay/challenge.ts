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
import { InCarSync, IncomingBitStream } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isInRace } from "@/race/room";
import { getOwnedVehicle, spawnVehicle } from "@/vehicles";
import { getDefaultRaceModel } from "@/race/vehicle";
import { setIntervalSafe, clearIntervalSafe, setTimeoutSafe } from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import type { ReplayData } from "./format";
import {
  sampleAt,
  allocReplayWorld,
  freeReplayWorld,
  allocReplayNpc,
  loadReplayData,
  getReplaySession,
  registerReplayNpcForReplay,
  unregisterReplayNpcForReplay,
} from "./playback";
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
  /** NPC playerId（emulate 的发送者；缓存避免每帧 getPlayer） */
  npcPlayerId: number;
  /** 上次 emulate 发包时间（30Hz 节流） */
  lastEmulateAt: number;
  /** emulate/send 失败是否已警告过（一次性防刷屏） */
  warnedEmulateFail: boolean;
}

export interface ChallengeSession {
  playerId: number;
  worldId: number;
  /** 挑战前所在世界（退出/结束恢复） */
  prevWorld: number;
  replayId: string;
  /** 影子战绩快照（结算显示） */
  replayRank: number | null;
  replayName: string | null;
  data: ReplayData;
  ghost: ChallengeGhost;
  cps: { x: number; y: number; z: number; size: number }[];
  /** 玩家已过的 CP 数（0 = 未过任何 CP） */
  cpIndex: number;
  totalCp: number;
  startAt: number;
  /** 实际发车时间（倒计时结束 GO 时刻；结算/超时用真实时间差，不用帧数累计防漂移） */
  goAt: number;
  finished: boolean;
  /** 影子播放推进基准（真实流逝计时，防定时器节流导致影子慢放） */
  lastTickAt: number;
  timer?: NodeJS.Timeout;
}

const challenges = new Map<number, ChallengeSession>();

export function isInChallenge(playerId: number): boolean {
  return challenges.has(playerId);
}

/** 玩家断线/退出清理（挑战会话销毁 + ghost 清理 + 恢复原世界）。
 * 仅在玩家仍处于挑战世界时恢复世界/CP/爱车——若玩家已离开挑战世界
 * （如挑战中途进入比赛/战局），不得覆盖其当前世界（防把玩家从比赛中拉走）。 */
export function cleanupChallenge(playerId: number): void {
  const ch = challenges.get(playerId);
  if (!ch) return;
  challenges.delete(playerId);
  if (ch.timer) clearIntervalSafe(ch.timer);
  try {
    unregisterReplayNpcForReplay(ch.ghost.npcPlayerId); // 注销屏蔽（影子销毁后不再有 sync 包）
    ch.ghost.label.destroy();
    ch.ghost.npc.destroy();
    ch.ghost.vehicle.destroy();
  } catch {
    /* 已销毁/失效 */
  }
  const p = Player.getInstance(playerId);
  if (p && p.isConnected() && p.getVirtualWorld() === ch.worldId) {
    p.setVirtualWorld(ch.prevWorld);
    RaceCheckpoint.disable(p);
    // 爱车一并切回原世界（防留在挑战世界成幽灵车；对齐比赛 restorePlayerAfterRace）
    const owned = getOwnedVehicle(playerId);
    if (owned && owned.isValid() && owned !== p.getVehicle()) {
      owned.setVirtualWorld(ch.prevWorld);
    }
  }
  // 挑战独立世界已无人使用 → 回收世界 id 供复用
  freeReplayWorld(ch.worldId);
}

/** 服务器退出：全部挑战销毁 */
export function destroyAllChallenges(): void {
  for (const id of [...challenges.keys()]) cleanupChallenge(id);
}

/** 渲染影子到当前播放时间（帧序一致；播完 clamp 终点）
 * emulate 驱动（与回放一致）：构造 DriverSync 包模拟影子 NPC 传入 + 发给
 * 挑战者——客户端本地物理驱动，影子速度/朝向真实平滑。
 * 30Hz 节流；血量由 emulate 的 vehicleHealth 处理。 */
function renderGhost(ch: ChallengeSession): void {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return;
  try {
    // 30Hz 发包节流
    const now = Date.now();
    if (now - ch.ghost.lastEmulateAt < 33) return;
    ch.ghost.lastEmulateAt = now;
    const bs = new IncomingBitStream();
    try {
      const sync = new InCarSync(bs);
      sync.writeSync({
        vehicleId: ch.ghost.vehicle.id,
        lrKey: s.lrKey,
        udKey: s.udKey,
        keys: s.keys,
        quaternion: [s.qx, s.qy, s.qz, s.qw],
        position: [s.x, s.y, s.z],
        velocity: [s.vx, s.vy, s.vz],
        vehicleHealth: s.vehicleHealth,
        playerHealth: 100,
        armour: 0,
        additionalKey: s.additionalKey,
        weaponId: 0,
        sirenState: s.sirenState,
        landingGearState: s.landingGearState,
        trailerId: s.trailerId,
        trainSpeed: s.trainSpeed,
      });
      bs.emulateIncomingPacket(ch.ghost.npcPlayerId);
      // 发给能看到影子车的玩家（独立挑战世界只有挑战者；车辆 stream 由
      // 服务器维护，NPC 无 stream 不能用 sendPacketToPlayerStream——见 playback）
      for (const p of Player.getInstances()) {
        if (p.isNpc() || !p.isConnected()) continue;
        if (ch.ghost.vehicle.isStreamedIn(p)) {
          bs.sendPacket(p.id);
        }
      }
    } finally {
      bs.delete();
    }
  } catch (e) {
    // 一次性 warn 防刷屏；实体失效由清理兜底
    if (!ch.ghost.warnedEmulateFail) {
      ch.ghost.warnedEmulateFail = true;
      logger.warn(`[replay] 挑战影子 emulate/send 失败（仅提示一次）`, e);
    }
  }
}

/** 影子当前已过的 CP 数（从帧读，事件无关） */
function ghostCpProgress(ch: ChallengeSession): number {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  return s ? Math.max(0, Math.min(ch.totalCp, s.cpProgress)) : 0;
}

/** 影子挑战超时宽限：影子播完后额外给玩家的时间（未完成自动结束，覆盖跑一半/挂机/没跑） */
const CHALLENGE_GRACE_MS = 60_000;

/** 60fps 推进影子（玩家自己动，影子按录制时间推进） */
function tickChallenge(ch: ChallengeSession): void {
  if (ch.finished) return;
  // 会话已被清理（中途 stop/掉线）→ 停掉定时器，防空转泄漏
  if (!challenges.has(ch.playerId)) {
    if (ch.timer) clearIntervalSafe(ch.timer);
    return;
  }
  const p = Player.getInstance(ch.playerId);
  // 玩家在线但已不在挑战世界（死亡重生回原世界/传送离开）→ 自动结束，
  // 防 ghost 在挑战世界挂到超时（重生后玩家已不在挑战上下文）
  if (p && p.isConnected() && p.getVirtualWorld() !== ch.worldId) {
    p.sendClientMessage(COLOR_RACE, "[影子] 你已离开挑战世界，挑战结束");
    cleanupChallenge(ch.playerId);
    return;
  }
  const dur = ch.data.header.frameCount * ch.data.header.frameIntervalMs;
  // 影子播完 + 宽限后玩家未完成 → 自动结束（真实时间差，不用帧数累计防漂移）
  if (Date.now() - ch.goAt > dur + CHALLENGE_GRACE_MS) {
    if (p && p.isConnected()) {
      p.sendClientMessage(COLOR_RACE, "[影子] 影子已到达终点，挑战超时结束（可再次挑战）");
    }
    cleanupChallenge(ch.playerId);
    return;
  }
  // 影子播放用真实流逝时间推进（固定 16ms/tick 在定时器节流时影子会慢放，
  // 与玩家实际速度不同步）；clamp 250ms 防卡顿后跳变
  const now = Date.now();
  const elapsed = Math.min(250, now - ch.lastTickAt);
  ch.lastTickAt = now;
  ch.ghost.playTime = Math.min(dur, ch.ghost.playTime + elapsed);
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
  // 真实时间差（从 GO 起跑，不用帧数累计防漂移）
  const playerMs = Math.max(0, Date.now() - ch.goAt);
  const ghostMs = ch.data.header.durationMs;
  const diff = playerMs - ghostMs;
  const verdict =
    diff <= -500
      ? "你赢了！"
      : diff >= 500
        ? "影子赢了"
        : "势均力敌！";
  await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "影子挑战",
      info: [
        `{98CDFE}赛道: {FFFFFF}${ch.replayName ?? "—"}`,
        `{98CDFE}影子战绩: {FFFFFF}${ch.replayRank != null ? `No.${ch.replayRank}` : "未完成"}`,
        "",
        `{98CDFE}你的用时: {FFFFFF}${fmtMs(playerMs)}`,
        `{98CDFE}影子用时: {FFFFFF}${fmtMs(ghostMs)}`,
        `{98CDFE}差距: {FFFFFF}${fmtMs(Math.abs(diff))}`,
        "",
        `{FFD700}${verdict}`,
      ].join("\n"),
      button1: "确定",
    }),
  );
  // 结算后自动退出挑战（跑完自动结束；玩家可再选回放继续挑战）
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
  // 多场回放可选：跟"哪一场比赛"比由玩家决定（默认最近完成的一场）
  const chosen = races.length === 1
    ? races[0]
    : await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.LIST,
          caption: "选择影子（比赛回放）",
          info: races
            .map((r, i) => `${i + 1}. ${r.rank != null ? `No.${r.rank}` : "未完成"} · ${new Date(r.createdAt).toLocaleString("zh-CN", { hour12: false })}`)
            .join("\n"),
          button1: "确定",
          button2: "取消",
        }),
      ).then((res) => (res && res.response === 1 ? races[res.listItem] : undefined));
  if (!chosen) return false; // 取消选择
  const replay = chosen;
  let data: ReplayData;
  try {
    data = loadReplayData(replay.fileName); // 只读缓存（与回放共享文件数据）
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

  // 影子（ghost）创建：复用回放的 NPC 池子边界（槽位检查 + isValid 校验）
  let ghost: ChallengeGhost;
  try {
    const npc = allocReplayNpc(`CHA_${Date.now()}`.slice(0, 24));
    if (!npc) {
      player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足，影子挑战创建失败");
      return false;
    }
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
    vehicle.addComponent(1010); // 氮气（影子车与录制时玩家爱车一致）
    // 锁门防玩家开走影子车（影子只可看不可开；NPC 已在车内不受影响）
    vehicle.setParamsEx(true, false, false, true, false, false, false);
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
    const shadowPlayer = npc.getPlayer();
    label.create();
    // 登记影子 NPC：屏蔽其真实 sync 包（emulate 的包不走 onIncomingPacket，
    // 防的是 NPC 自身/残留 sync 与模拟广播冲突）
    registerReplayNpcForReplay(shadowPlayer.id);
    ghost = { npc, vehicle, label, playTime: 0, npcPlayerId: shadowPlayer.id, lastEmulateAt: 0, warnedEmulateFail: false };
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
    replayRank: replay.rank ?? null,
    replayName: replay.raceName ?? null,
    data,
    ghost,
    cps: cps.map((c) => ({ x: Number(c.x), y: Number(c.y), z: Number(c.z), size: Number(c.size) })),
    cpIndex: 0,
    totalCp: cps.length,
    startAt: Date.now(),
    goAt: Date.now(),
    finished: false,
    lastTickAt: Date.now(),
  };
  challenges.set(player.id, ch);

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
  player.sendClientMessage(COLOR_SUCCESS, `影子挑战开始！目标 ${replay.raceName ?? "该赛道"}，跑完自动结算（中途 /challenge stop 可退出）`);

  // 发车倒计时 3 秒（对齐比赛：~y~N + 音效 1056；倒计时期间 ghost 停在起点、不计玩家用时）。
  // 倒计时结束才启动 ghost 推进定时器（登记制）。
  // 挑战自动结束路径：跑完（过终点）结算 / 掉线清理 / 超时（影子播完 + 宽限未完成）。
  let cd = 3;
  const countdown = (): void => {
    // 挑战已被清理（中途 stop/掉线）→ 停倒计时，不再启动 ghost 定时器（防泄漏）
    if (!challenges.has(player.id)) return;
    if (!player.isConnected()) {
      cleanupChallenge(player.id);
      return;
    }
    if (cd <= 0) {
      if (!challenges.has(player.id)) return; // 双保险
      ch.goAt = Date.now(); // 真实起跑时刻（结算/超时计时基准）
      const go = new GameText("~g~GO~r~!~n~~g~GO~r~!", 2000, 3);
      go.forPlayer(player);
      player.playSound(1057);
      ch.timer = setIntervalSafe(() => tickChallenge(ch), 16);
      return;
    }
    const gt = new GameText(`~y~${cd}`, 850, 3);
    gt.forPlayer(player);
    player.playSound(1056);
    cd--;
    setTimeoutSafe(countdown, 1000);
  };
  countdown();
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
