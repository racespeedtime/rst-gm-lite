import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  GameText,
  KeysEnum,
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
import {
  setIntervalSafe,
  clearIntervalSafe,
  setTimeoutSafe,
  clearTimeoutSafe,
} from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import type { ReplayData } from "./format";
import {
  sampleAt,
  emulateDriverSync,
  allocReplayWorld,
  freeReplayWorld,
  allocReplayNpc,
  loadReplayData,
  getReplaySession,
  registerReplayNpcForReplay,
  unregisterReplayNpcForReplay,
} from "./playback";
import { registerObserveCandidate, unregisterObserveCandidate } from "@/core/observe";
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
  /** 上次补氮气时刻（SA 氮气有容量，按录制者按键补，500ms 节流防高频 addComponent） */
  lastNitroAt: number;
  /** 当前标签显示的在线状态（录制者掉线时标签追加红字"掉线"；变化时 updateText） */
  online: boolean;
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
  /** 录制者昵称（标签/掉线提示用） */
  recorderName: string;
  data: ReplayData;
  ghost: ChallengeGhost;
  /** 影子起始播放帧（= 录制发车帧；倒计时期间停在起始帧，GO 后从这里开始播） */
  startFrame: number;
  cps: { x: number; y: number; z: number; size: number }[];
  /** 赛道圈数（多圈挑战：玩家累计跑 laps×一圈CP 个检查点才结算） */
  laps: number;
  /** 玩家已过的 CP 数（累计，0 = 未过任何 CP；跨圈用 cps[cpIndex % cps.length] 取目标） */
  cpIndex: number;
  /** 总 CP 数 = 圈数 × 一圈 CP 数（完成判定 cpIndex >= totalCp） */
  totalCp: number;
  /** 影子已跨过的圈数（帧 cpProgress 每圈重置，播放时检测回退累计） */
  shadowLapOffset: number;
  /** 上一采样帧的圈内 cpProgress（-1 = 尚未采样；回退检测用） */
  lastShadowCp: number;
  startAt: number;
  /** 实际发车时间（倒计时结束 GO 时刻；结算/超时用真实时间差，不用帧数累计防漂移） */
  goAt: number;
  finished: boolean;
  /** 影子已播完并触发"冲线倒计时"（对齐真人比赛第一名冲线 → 20 秒宽限） */
  shadowFinished: boolean;
  /** 影子完赛倒计时（20s 后未完成则结束结算影子赢） */
  endTimer?: NodeJS.Timeout;
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
  if (ch.endTimer) clearTimeoutSafe(ch.endTimer);
  try {
    unregisterReplayNpcForReplay(ch.ghost.npcPlayerId); // 注销屏蔽（影子销毁后不再有 sync 包）
    unregisterObserveCandidate(ch.ghost.vehicle.id, "vehicle"); // 移出观战切换候选
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
  }
  // 爱车无条件检查所在世界 == 挑战世界（不依赖玩家是否仍在该世界——玩家可能
  // 已提前离开但车留在即将回收的独立世界，worldId 复用后成幽灵车）
  const owned = getOwnedVehicle(playerId);
  if (owned && owned.isValid() && owned.getVirtualWorld() === ch.worldId) {
    owned.setVirtualWorld(ch.prevWorld);
  }
  // 挑战独立世界已无人使用 → 回收世界 id 供复用
  freeReplayWorld(ch.worldId);
}

/** 服务器退出：全部挑战销毁 */
export function destroyAllChallenges(): void {
  for (const id of [...challenges.keys()]) cleanupChallenge(id);
}

/** 影子车顶标签文本：身份 + 挑战谁；录制者掉线时追加红字标记 */
function shadowLabelText(recorderName: string, online: boolean): string {
  return `{FFD700}影子\n{FFFFFF}挑战 · ${recorderName}` + (online ? "" : `\n{FF0000}掉线`);
}

/** 渲染影子到当前播放时间（帧序一致；播完 clamp 终点）
 * emulate 驱动（与回放一致，复用 playback 的 emulateDriverSync 发包）：
 * 构造 DriverSync 包模拟影子 NPC 传入 + 发给挑战者——客户端本地物理驱动，
 * 影子速度/朝向真实平滑。30Hz 节流；血量由 emulate 的 vehicleHealth 处理。 */
function renderGhost(ch: ChallengeSession): void {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return;
  // 掉线状态变化（跨过掉线边界帧）：更新车顶标签（红字"掉线"）+ 聊天提示。
  // 检测放采样后、节流前——保证边界帧即使被 30Hz 节流跳过也能触发。
  if (s.online !== ch.ghost.online) {
    ch.ghost.online = s.online;
    try {
      ch.ghost.label.updateText(
        "#ffffff",
        shadowLabelText(ch.recorderName, s.online),
        DEFAULT_CHARSET,
      );
    } catch {
      /* 标签已失效等，忽略 */
    }
    const p = Player.getInstance(ch.playerId);
    if (p && p.isConnected()) {
      p.sendClientMessage(
        COLOR_RACE,
        s.online ? `[影子] ${ch.recorderName} 已重新上线` : `[影子] ${ch.recorderName} 掉线了`,
      );
    }
  }
  const maxTime = (ch.data.header.frameCount - 1) * Math.max(1, ch.data.header.frameIntervalMs);
  // 倒计时期间：playTime 停在起始帧（startFrame=录制发车帧）→ 按静止帧渲染
  //（速度/按键清零，影子停在起点等发车；GO 后 tick 推进 playTime 才离开
  // startFrame，恢复正常驱动）。起始帧如果是换车帧，ensureGhostVehicle 只在
  // 创建渲染时执行一次，不会反复换车。
  const atStart = ch.ghost.playTime <= ch.startFrame;
  // 影子播完（playTime 到最后一帧）→ 速度/按键清零：影子停在终点，挑战者
  // 仍要看见它作参照（不能停发）。否则尾帧非零速度会让影子在终点持续滑行
  // 抖动，按键残留还会原地转向抖动（emulateDriverSync 的 atEnd 分支处理）。
  const atEnd = ch.ghost.playTime >= maxTime || atStart;
  try {
    // 30Hz 发包节流
    const now = Date.now();
    if (now - ch.ghost.lastEmulateAt < 33) return;
    ch.ghost.lastEmulateAt = now;
    // 氮气跟随录制者按键：SA 氮气有容量、喷完即消失，录制时由 vehicleAuto
    // 定时补充，挑战影子车无人补——检测到 keys.SPRINT 置位就补一个氮气
    // 组件（500ms 节流防高频 addComponent），保证该喷的时刻有氮气可喷
    // （与回放 playback renderGhost 同一套逻辑；起始/播完后 atEnd 不再补）
    if (s.keys & KeysEnum.SPRINT && !atEnd && now - ch.ghost.lastNitroAt >= 500) {
      ch.ghost.lastNitroAt = now;
      ch.ghost.vehicle.addComponent(1010);
    }
    emulateDriverSync(ch.ghost.npcPlayerId, ch.ghost.vehicle, s, atEnd);
  } catch (e) {
    // 一次性 warn 防刷屏；实体失效由清理兜底
    if (!ch.ghost.warnedEmulateFail) {
      ch.ghost.warnedEmulateFail = true;
      logger.warn(`[replay] 挑战影子 emulate/send 失败（仅提示一次）`, e);
    }
  }
}

/**
 * 影子圈数推进（每 tick 调用，跟随影子播放）：帧里 cpProgress 是圈内进度
 * （每圈重置），播放时间单调递增——检测 cpProgress 回退（当前 < 上一帧 =
 * 从一圈末尾跳回圈首）累计 shadowLapOffset。
 * 必须每 tick 推进而非在玩家过 CP 时才采样：稀疏采样会漏圈（玩家过 CP 间隔
 * 大时，两次采样之间影子可能跨多圈，回退只 +1）。16ms 采样 ≥ 帧率，不漏。
 */
function advanceShadowLap(ch: ChallengeSession): void {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return;
  if (ch.lastShadowCp !== -1 && s.cpProgress < ch.lastShadowCp) {
    ch.shadowLapOffset++;
  }
  ch.lastShadowCp = s.cpProgress;
}

/** 影子当前进度（累计 CP 数 + 距其下一 CP 距离）——对齐真人排名算法：
 *  完成 CP 数降序，相同比"距下一 CP 距离"升序（近者领先）。
 *  只读 shadowLapOffset/lastShadowCp（由 tickChallenge 的 advanceShadowLap 推进） */
function ghostProgress(ch: ChallengeSession): { cp: number; dist: number } {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return { cp: 0, dist: Infinity };
  const lapCp = Math.max(0, Math.min(ch.cps.length, s.cpProgress));
  const cp = ch.shadowLapOffset * ch.cps.length + lapCp; // 累计（跨圈）
  const next = ch.cps[cp % ch.cps.length]; // 影子朝第 (圈内) 下一个 CP 跑
  if (!next) return { cp, dist: Infinity };
  return { cp, dist: Math.hypot(s.x - next.x, s.y - next.y, s.z - next.z) };
}

/** 影子挑战冲线倒计时（对齐真人比赛 END_GRACE：第一名冲线 → 20 秒宽限） */
const CHALLENGE_END_GRACE_MS = 20_000;

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
  // 影子播完时间 = 播放终点 (frameCount-1)×interval（对齐 playback）
  const dur = (ch.data.header.frameCount - 1) * ch.data.header.frameIntervalMs;
  // 影子播放用真实流逝时间推进（固定 16ms/tick 在定时器节流时影子会慢放，
  // 与玩家实际速度不同步）；clamp 250ms 防卡顿后跳变
  const now = Date.now();
  const elapsed = Math.min(250, now - ch.lastTickAt);
  ch.lastTickAt = now;
  ch.ghost.playTime = Math.min(dur, ch.ghost.playTime + elapsed);
  // 影子圈数推进：跟随影子播放检测跨圈（每 tick，不漏圈——见 advanceShadowLap）
  advanceShadowLap(ch);
  renderGhost(ch);
  // 影子播完（playTime 到终点）→ 视同真实玩家冲线：触发 20 秒冲线倒计时
  //（对齐真人比赛"第一名已完成，20 秒后比赛结束"）。玩家在倒计时内完成 →
  // onChallengePlayerEnter 正常结算；超时未完成 → 结束结算影子赢。
  if (ch.ghost.playTime >= dur && !ch.shadowFinished && !ch.finished) {
    ch.shadowFinished = true;
    if (p && p.isConnected()) {
      p.sendClientMessage(COLOR_RACE, "[影子] 影子已完赛，20 秒后挑战结束（倒计时内完成可继续）");
    }
    ch.endTimer = setTimeoutSafe(() => {
      if (ch.finished || !challenges.has(ch.playerId)) return;
      ch.finished = true;
      const pp = Player.getInstance(ch.playerId);
      if (pp && pp.isConnected()) {
        void finishChallenge(pp, ch);
      } else {
        cleanupChallenge(ch.playerId);
      }
    }, CHALLENGE_END_GRACE_MS);
    return;
  }
}

/** 玩家过 CP（RaceCpEvent.onPlayerEnter 注册：进入 checkpoint 范围自动触发；
 * 进入后不再触发直到离开再进 → cpIndex 递增天然防重复计数）。
 * 多圈：cpIndex 累计（0..totalCp-1），目标 CP 按下标取模循环（跨圈箭头流转），
 * 完成判定 cpIndex >= totalCp（跑满 laps 圈） */
function onChallengePlayerEnter(player: Player): void {
  const ch = challenges.get(player.id);
  if (!ch || ch.finished) return;
  // 目标 CP = 当前进度（RaceCheckpoint.set 维护的箭头流指向它）；跨圈取模
  const next = ch.cps[ch.cpIndex % ch.cps.length];
  if (!next) return;
  ch.cpIndex++;
  const gp = ghostProgress(ch); // 影子进度（累计 CP 数 + 距下一 CP 距离，对齐真人排名）
  if (ch.cpIndex >= ch.totalCp) {
    // 完成：结算
    ch.finished = true;
    RaceCheckpoint.disable(player);
    void finishChallenge(player, ch);
    return;
  }
  // 下一个 CP 箭头（跨圈循环：nxt = 下一个累计 CP，nxt2 = 下下个；仅最后一圈
  // 的最后一个 CP（cpIndex == totalCp-1）无下下个 → type 1 终点。否则玩家永远
  // 无法触发完成；取模让中间点跨圈循环有值，但最后一点必须终点）
  const nxt = ch.cps[ch.cpIndex % ch.cps.length];
  const nxt2 = ch.cpIndex < ch.totalCp - 1 ? ch.cps[(ch.cpIndex + 1) % ch.cps.length] : undefined;
  if (nxt && nxt2) {
    RaceCheckpoint.set(player, 0, nxt.x, nxt.y, nxt.z, nxt2.x, nxt2.y, nxt2.z, nxt.size);
  } else if (nxt) {
    RaceCheckpoint.set(player, 1, nxt.x, nxt.y, nxt.z, nxt.x, nxt.y, nxt.z, nxt.size);
  }
  // 领先判定对齐真人排名算法：CP 数多者领先；相同则比"距下一 CP 距离"（近者领先）
  const pcp = ch.cpIndex;
  const pnext = ch.cps[pcp % ch.cps.length];
  const ppos = player.getPos();
  const pdist = pnext ? Math.hypot(ppos.x - pnext.x, ppos.y - pnext.y, ppos.z - pnext.z) : Infinity;
  let ahead: string;
  if (pcp !== gp.cp) {
    ahead = pcp > gp.cp ? "领先影子" : "落后影子";
  } else if (pdist < gp.dist) {
    ahead = `领先影子 ${Math.max(1, Math.round(gp.dist - pdist))}m`;
  } else if (pdist > gp.dist) {
    ahead = `落后影子 ${Math.max(1, Math.round(pdist - gp.dist))}m`;
  } else {
    ahead = "与影子持平";
  }
  player.sendClientMessage(
    COLOR_RACE,
    `[影子] CP ${pcp}/${ch.totalCp}（影子 ${gp.cp}/${ch.totalCp}）${ahead}`,
  );
}

/** 完成结算（玩家用时 vs 影子用时 = 录制时长） */
async function finishChallenge(player: Player, ch: ChallengeSession): Promise<void> {
  // 真实时间差（从 GO 起跑，不用帧数累计防漂移）
  const playerMs = Math.max(0, Date.now() - ch.goAt);
  const ghostMs = ch.data.header.durationMs;
  const diff = playerMs - ghostMs;
  const verdict = diff <= -500 ? "你赢了！" : diff >= 500 ? "影子赢了" : "势均力敌！";
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

/** 时长格式化（mm:ss 或 ss，选择影子列表用） */
function challengeFmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 时间格式化（MM-DD HH:MM，固定格式不依赖 locale） */
function challengeFmtTime(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
  // 多场回放可选：跟"哪一场比赛"比由玩家决定（默认最近完成的一场）。
  // TABLIST_HEADERS 多列：名次 / 完成 / 时长 / 录制时间（表头不占行号）
  const chosen =
    races.length === 1
      ? races[0]
      : await showDialog(
          player,
          new Dialog({
            style: DialogStylesEnum.TABLIST_HEADERS,
            caption: "选择影子（比赛回放）",
            info: [
              "{FFD700}名次\t完成\t时长\t录制时间",
              ...races.map(
                (r) =>
                  `${r.rank != null ? `No.${r.rank}` : "{808080}未完成"}\t` +
                  `${r.finished ? "完成" : "未完成"}\t` +
                  `${challengeFmtDur(r.durationMs)}\t` +
                  `${challengeFmtTime(r.createdAt)}`,
              ),
            ].join("\n"),
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
  // 赛道圈数（多圈挑战：玩家累计跑 laps 圈才结算，与影子整场录像对比）
  const raceRow = await prisma.race.findFirst({
    where: { id: raceId },
    select: { laps: true },
  });
  return startChallengeCore(player, chosen, data, cps, Math.max(1, raceRow?.laps ?? 1));
}

/**
 * 影子挑战（任意玩家的比赛回放）：公开回放库入口——选一条别人的 race 回放当影子。
 * 校验后直接开挑战（不限本人录像）。
 */
export async function startChallengeWithReplay(player: Player, replayId: string): Promise<boolean> {
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
  const replay = await prisma.replay.findFirst({
    where: { id: replayId, type: "race", deletedAt: null }, // 任意玩家
  });
  if (!replay) {
    player.sendClientMessage(COLOR_ERROR, "回放不存在或已删除");
    return false;
  }
  if (!replay.raceId) {
    player.sendClientMessage(COLOR_ERROR, "该回放没有关联赛道，无法影子挑战");
    return false;
  }
  let data: ReplayData;
  try {
    data = loadReplayData(replay.fileName); // 只读缓存（与回放共享文件数据）
  } catch (e) {
    logger.error(`[replay] 挑战回放读取失败 ${replay.fileName}`, e);
    player.sendClientMessage(COLOR_ERROR, "回放文件损坏或不存在");
    return false;
  }
  // 赛道可能已被软删/禁用：此时 cps 查出来为空会误报"至少需要 2 个检查点"，
  // 先确认赛道状态再读检查点（laps 一并取出，供多圈挑战）
  const race = await prisma.race.findFirst({
    where: { id: replay.raceId, deletedAt: null, isEnabled: true },
    select: { id: true, laps: true },
  });
  if (!race) {
    player.sendClientMessage(COLOR_ERROR, "该赛道已被删除或禁用，无法进行影子挑战");
    return false;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId: replay.raceId },
    orderBy: { index: "asc" },
  });
  if (cps.length < 2) {
    player.sendClientMessage(COLOR_ERROR, "该赛道至少需要 2 个检查点");
    return false;
  }
  return startChallengeCore(player, replay, data, cps, Math.max(1, race.laps ?? 1));
}

/** 影子挑战核心：建影子实体 + 放入玩家 + 倒计时（startChallengeFromRace/WithReplay 共用）。
 * laps：赛道圈数（多圈挑战：玩家累计跑 laps 圈才结算，与影子整场录像对比） */
async function startChallengeCore(
  player: Player,
  replay: { id: string; rank: number | null; raceName: string | null; recorderName: string },
  data: ReplayData,
  cps: { x: unknown; y: unknown; z: unknown; angle: unknown; size: unknown }[],
  laps: number,
): Promise<boolean> {
  const worldId = allocReplayWorld();

  // 影子（ghost）创建：复用回放的 NPC 池子边界（槽位检查 + isValid 校验）
  // 实体句柄提升到 try 外：任何失败路径都要回收世界 id + 销毁已建实体
  //（否则幽灵 NPC/车/标签留在世界、世界 id 只增不回收）
  let ghost: ChallengeGhost;
  let npc: Npc | null = null;
  let vehicle: Vehicle | null = null;
  let label: Dynamic3DTextLabel | null = null;
  try {
    const created = allocReplayNpc(`CHA_${Date.now()}`.slice(0, 24));
    if (!created) {
      freeReplayWorld(worldId); // 槽位不足即失败：回收已分配的世界 id
      player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足，影子挑战创建失败");
      return false;
    }
    npc = created;
    const veh = new Vehicle({
      modelId: data.header.vehicleModelId,
      // 影子起点 = 录制起始位置（与回放/玩家起点一致）
      x: data.header.startX,
      y: data.header.startY,
      z: data.header.startZ,
      zAngle: 0,
      color: [-1, -1],
      respawnDelay: 0,
    });
    veh.create();
    veh.setVirtualWorld(worldId);
    veh.addComponent(1010); // 氮气（影子车与录制时玩家爱车一致）
    // 锁门防玩家开走影子车（影子只可看不可开；NPC 已在车内不受影响）
    veh.setParamsEx(true, false, false, true, false, false, false);
    npc.setVirtualWorld(worldId);
    npc.putInVehicle(veh, 0);
    npc.setInvulnerable(true);
    const shadowPlayer = npc.getPlayer();
    const lab = new Dynamic3DTextLabel({
      text: shadowLabelText(replay.recorderName, true),
      color: "#ffffff",
      x: 0,
      y: 0,
      z: 0.3,
      drawDistance: 40,
      testLOS: false,
      attachedPlayer: shadowPlayer.id,
      worldId,
      charset: DEFAULT_CHARSET,
    });
    lab.create();
    // 登记影子 NPC：屏蔽其真实 sync 包（emulate 的包不走 onIncomingPacket，
    // 防的是 NPC 自身/残留 sync 与模拟广播冲突）
    registerReplayNpcForReplay(shadowPlayer.id);
    // 登记为观战切换候选（与回放 ghost 同机制，可左右键切到影子车）
    registerObserveCandidate(veh.id, "vehicle");
    vehicle = veh;
    label = lab;
    ghost = {
      npc,
      vehicle: veh,
      label: lab,
      playTime: 0,
      npcPlayerId: shadowPlayer.id,
      lastEmulateAt: 0,
      warnedEmulateFail: false,
      lastNitroAt: 0,
      online: true, // 起始帧在线（掉线重连回放才可能翻转为 false）
    };
  } catch (e) {
    logger.error(`[replay] 创建挑战影子失败`, e);
    // 清理已创建的实体（NPC/车/标签）+ 回收世界 id，防幽灵实体与 id 泄漏
    try {
      if (npc) {
        unregisterReplayNpcForReplay(npc.getPlayer().id);
        npc.destroy();
      }
      if (vehicle) vehicle.destroy();
      if (label) label.destroy();
    } catch {
      /* 已销毁/失效 */
    }
    freeReplayWorld(worldId);
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
    recorderName: replay.recorderName,
    data,
    ghost,
    startFrame: 0, // 录制发车帧（倒计时期间停在起始帧，GO 后从这里播）
    cps: cps.map((c) => ({ x: Number(c.x), y: Number(c.y), z: Number(c.z), size: Number(c.size) })),
    laps,
    cpIndex: 0,
    // 多圈：总 CP = 圈数 × 一圈 CP 数（玩家累计跑满才结算，与影子整场时长对比）
    totalCp: Math.max(1, laps) * cps.length,
    shadowLapOffset: 0,
    lastShadowCp: -1, // 首帧采样时初始化（-1 跳过首帧回退检测）
    startAt: Date.now(),
    goAt: Date.now(),
    finished: false,
    shadowFinished: false,
    lastTickAt: Date.now(),
  };
  challenges.set(player.id, ch);
  // 倒计时期间：影子停在起始帧（playTime==startFrame → atStart 静止帧渲染），
  // 只渲染一次（起点车可见）；GO 后 tick 启动、playTime 才离开 startFrame 正常播
  renderGhost(ch);

  // 玩家放入（有爱车则用（模型不符也直接用——挑战自由），无则刷标准车型）
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(ch.cps[0].x, ch.cps[0].y, ch.cps[0].z);
    owned.setZAngle(Number(cps[0].angle ?? 0));
    owned.setVirtualWorld(worldId);
    owned.putPlayerIn(player, 0);
  } else {
    // 玩家车模型与影子一致（录制车型）——cveh 换车脚本赛道（如 562 漂移）上
    // 用 getDefaultRaceModel（读不到 cveh 恒 411）会与影子车不同型，对比失实
    await spawnVehicle(player, data.header.vehicleModelId, true);
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
  RaceCheckpoint.set(
    player,
    0,
    ch.cps[0].x,
    ch.cps[0].y,
    ch.cps[0].z,
    nxt2.x,
    nxt2.y,
    nxt2.z,
    ch.cps[0].size,
  );
  player.sendClientMessage(
    COLOR_SUCCESS,
    `影子挑战开始！目标 ${replay.raceName ?? "该赛道"}，跑完自动结算（中途 /challenge stop 可退出）`,
  );

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
