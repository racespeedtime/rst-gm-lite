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
import { getOwnedVehicle, spawnVehicle, destroyPlayerVehicle } from "@/vehicles";
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
import { sysMsg } from "@/utils/msg";

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

/** 挑战进行状态：待命（起点停影，等 /challenge go）→ 倒计时 → 比赛中 */
export type ChallengeState = "STANDBY" | "COUNTDOWN" | "RACING";

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
  cps: { x: number; y: number; z: number; angle: number; size: number }[];
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
  /** 进行状态：待命/倒计时/比赛中。待命与倒计时期间不计时、不算 CP（无界待命防提前刷 CP） */
  state: ChallengeState;
  /** 倒计时代数：每次 /challenge go 递增。倒计时链每步比对，restart 后旧链
   * （无法直接取消的 setTimeoutSafe 链）靠代数失配自停，防新旧双链并行双 GO */
  countdownEpoch: number;
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
/** 刷车在途标记（防 60fps tick 在 spawnVehicle await 期间重复触发双车） */
const pendingRespawn = new Set<number>();

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
  pendingRespawn.delete(playerId);
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
      sysMsg(
        p,
        "challenge",
        s.online ? `${ch.recorderName} 已重新上线` : `${ch.recorderName} 掉线了`,
        "info",
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

/**
 * 挑战用车兜底：玩家应始终在车上（对齐比赛"无车兜底"语义）。
 * 仅当"不在任何车里"时才检测——正常行驶（在车里）零开销。
 * 车完好但人被弹出/下车 → 放回；车已毁 → 刷录制车型（懒创建爱车）继续，
 * 否则爆车后只能步行看着影子跑完。pendingRespawn 防 60fps tick 双车。
 * isWasted（爆车连带死亡）不处理：死亡后走通用重生回大世界 → 世界检查自动
 * 结束挑战，车由 challenge 清理统一销毁（不给尸体刷车）。
 */
function ensureChallengeCar(player: Player, ch: ChallengeSession): void {
  if (player.isWasted() || player.isInAnyVehicle() || pendingRespawn.has(player.id)) return;
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.putPlayerIn(player, 0);
  } else {
    if (owned) destroyPlayerVehicle(player.id); // 清理爆炸后残留的失效实体引用
    pendingRespawn.add(player.id);
    void spawnVehicle(player, ch.data.header.vehicleModelId, true).finally(() => {
      pendingRespawn.delete(player.id);
    });
    sysMsg(player, "challenge", "车辆已损毁，自动刷出挑战用车", "info");
  }
}

/** 重设玩家检查点：红圈在起点 CP（cps[0]）、箭头指向第二个（对齐比赛 joinRoom 的
 * 起点 CP 箭头）。首进/restart 待命时摆一次；GO 时**必须再摆一次**——open.mp 检查点是
 * "进入即消耗"：待命期间玩家站在起点圈内时 enter 已触发（被 STANDBY 态吞掉）且检查点
 * 已消耗消失，若不重设，GO 后玩家驶离起点就永远触发不了第一个 CP（整场无法推进）。
 * 重设后玩家仍在起点圈内 → RACING 态重新进入 → 起点 CP 立即计数（对齐比赛 beginRace
 * 开赛时重调 showNextCheckpoint 让起点 CP 在 RACING 态计数的行为）。 */
function resetChallengeCheckpoint(player: Player, ch: ChallengeSession): void {
  const first = ch.cps[0];
  const nxt2 = ch.cps[1];
  if (!first || !nxt2) return;
  RaceCheckpoint.set(player, 0, first.x, first.y, first.z, nxt2.x, nxt2.y, nxt2.z, first.size);
}

/** 玩家位置挪到起点 CP（车就位 + 放回车里；restart 与首进共用）。
 * async：无车时刷车是异步的，调用方 await 后需自行做断线检查。 */
async function seatPlayerAtStart(player: Player, ch: ChallengeSession): Promise<void> {
  const first = ch.cps[0];
  if (!first) return;
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(first.x, first.y, first.z);
    owned.setZAngle(first.angle);
    owned.setVirtualWorld(ch.worldId);
    owned.setHealth(1000);
    owned.repair();
    owned.addComponent(1010);
    owned.putPlayerIn(player, 0);
  } else {
    if (owned) destroyPlayerVehicle(player.id); // 车已毁（爆炸残留失效实体）
    // pendingRespawn 与 ensureChallengeCar 共用：刷车期间（可能跨 tick/go 的
    // 异步窗口）不重复刷，防 restart↔go 交错双车；finally 兜底——刷车失败
    //（如中途断线/实体创建异常）也放行，防守卫永久卡死阻断后续救援
    pendingRespawn.add(player.id);
    await spawnVehicle(player, ch.data.header.vehicleModelId, true).finally(() => {
      pendingRespawn.delete(player.id);
    });
  }
  player.setVirtualWorld(ch.worldId);
  player.setPos(first.x, first.y, first.z);
  // 第一个 CP 箭头（指向第二个）
  resetChallengeCheckpoint(player, ch);
}

/** 起点待命：影子归位起始帧 + 渲染一次（起点车可见）+ 提示 go 命令。
 * 首次进入与局内重开共用；待命期间不计时、不算 CP。 */
function standbyAtStart(player: Player, ch: ChallengeSession): void {
  ch.state = "STANDBY";
  ch.finished = false;
  ch.shadowFinished = false;
  ch.cpIndex = 0;
  ch.shadowLapOffset = 0;
  ch.lastShadowCp = -1;
  ch.goAt = 0;
  // 影子重置到录制起点（车就位 + 修复），强制重渲染起始帧
  ch.ghost.playTime = 0;
  ch.ghost.lastEmulateAt = 0;
  try {
    ch.ghost.vehicle.setPos(ch.data.header.startX, ch.data.header.startY, ch.data.header.startZ);
    ch.ghost.vehicle.setZAngle(0);
    ch.ghost.vehicle.setHealth(1000);
    ch.ghost.vehicle.repair();
  } catch {
    /* 已失效，清理兜底 */
  }
  // 直接复位影子标签（不发"重新上线"的聊天提示；renderGhost 检测不到翻转即静默）
  const s0 = sampleAt(ch.data, 0);
  if (s0) {
    ch.ghost.online = s0.online;
    try {
      ch.ghost.label.updateText(
        "#ffffff",
        shadowLabelText(ch.recorderName, s0.online),
        DEFAULT_CHARSET,
      );
    } catch {
      /* 标签已失效 */
    }
  }
  renderGhost(ch);
}

/** 玩家触发开始（/challenge go）：待命 → 3 秒倒计时 → GO。倒计时期间玩家可控：
 * restart 打断回待命；死亡打断回待命（车可能已爆，restart/ensureChallengeCar 兜底）。 */
function beginChallengeCountdown(player: Player, ch: ChallengeSession): void {
  if (ch.state !== "STANDBY") return;
  ch.state = "COUNTDOWN";
  ch.countdownEpoch++; // 打断任何旧倒计时链（restart 后旧链的 pending 步骤靠代数失配自停）
  const epoch = ch.countdownEpoch;
  let cd = 3;
  const countdown = (): void => {
    // 挑战已被清理（中途 stop/掉线）→ 停倒计时（防泄漏）
    if (!challenges.has(player.id)) return;
    // 代数失配：期间发生过 restart / 新的 go，旧链必须自停（防双链并行双 GO）
    if (epoch !== ch.countdownEpoch) return;
    if (!player.isConnected()) {
      cleanupChallenge(player.id);
      return;
    }
    // 状态已被 restart 打断（回 STANDBY）→ 停倒计时链
    if (ch.state !== "COUNTDOWN") return;
    if (player.isWasted()) {
      // 死亡打断倒计时 → 回待命（复活后玩家可 /challenge go 重来）
      ch.state = "STANDBY";
      sysMsg(player, "challenge", "死亡，已回到起点待命，/challenge go 重新开始", "info");
      return;
    }
    if (cd <= 0) {
      if (!challenges.has(player.id)) return; // 双保险
      ch.state = "RACING";
      ch.goAt = Date.now(); // 真实起跑时刻（结算/超时计时基准）
      ch.lastTickAt = Date.now(); // 重置影子推进基准（待命可能等很久，防首帧跳变）
      // 重设检查点：待命期间站在起点圈内时 enter 已被 STANDBY 态吞掉且检查点消耗，
      // 重设让起点 CP 在 RACING 态重新进入计数（对齐比赛 beginRace 开赛重设），
      // 否则 GO 后驶离起点永远触发不了第一个 CP
      resetChallengeCheckpoint(player, ch);
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
}

/** /challenge go：待命 → 倒计时（统一待命制——开始时机由玩家掌控）。
 * 先归位起点 + 车兜底（死亡/下车/爆车后 go 前先就位到起点线），车就位后才进倒计时。 */
export function goChallenge(player: Player): void {
  const ch = challenges.get(player.id);
  if (!ch) {
    sysMsg(player, "challenge", "你不在影子挑战中", "warn");
    return;
  }
  if (ch.finished) return; // 结算中/已结束
  if (ch.state === "RACING") {
    sysMsg(player, "challenge", "挑战已在比赛中，/challenge restart 可重置", "warn");
    return;
  }
  if (ch.state === "COUNTDOWN") {
    sysMsg(player, "challenge", "已在倒计时中，请稍候", "warn");
    return;
  }
  // 待命检查：玩家已不在挑战世界（死亡/传送离开）→ 直接结束
  if (player.getVirtualWorld() !== ch.worldId) {
    sysMsg(player, "challenge", "你已离开挑战世界，挑战结束", "warn");
    cleanupChallenge(player.id);
    return;
  }
  // 归位起点 + 刷车兜底；await 期间玩家可能又 restart/死亡/离开 → .then 里再校验。
  // epoch 快照：restart 会自增 countdownEpoch，代数失配则不再触发倒计时（防在途
  // go 在 restart 后误起一个玩家没请求的倒计时）
  const epoch = ch.countdownEpoch;
  void seatPlayerAtStart(player, ch).then(() => {
    if (
      challenges.has(player.id) &&
      epoch === ch.countdownEpoch &&
      ch.state === "STANDBY" &&
      player.isConnected() &&
      !player.isWasted() &&
      player.getVirtualWorld() === ch.worldId
    ) {
      beginChallengeCountdown(player, ch);
    }
  });
}

/** /challenge restart：任意时刻（待命/倒计时/比赛中）重置回起点待命。
 * 影子与玩家车都归位起点、进度清零，玩家就绪后 /challenge go 重跑同一影子。 */
export function restartChallenge(player: Player): void {
  const ch = challenges.get(player.id);
  if (!ch) {
    sysMsg(player, "challenge", "你不在影子挑战中", "warn");
    return;
  }
  // 打断进行中的计时/倒计时（tick 与倒计时链都以 state 门控，清理定时器防泄漏）。
  // 自增 countdownEpoch：在途的 go 刷车 continuation 靠代数失配自停（防 restart 后
  // 误起倒计时），旧倒计时链 pending 步骤同被代数守卫终止
  ch.countdownEpoch++;
  if (ch.timer) clearIntervalSafe(ch.timer);
  ch.timer = undefined;
  if (ch.endTimer) clearTimeoutSafe(ch.endTimer);
  ch.endTimer = undefined;
  standbyAtStart(player, ch);
  seatPlayerAtStart(player, ch);
  player.setFacingAngle(ch.cps[0]?.angle ?? 0);
  sysMsg(
    player,
    "challenge",
    "已回到起点待命，/challenge go 重新开始（/challenge stop 退出）",
    "success",
  );
}

/** 60fps 推进影子（玩家自己动，影子按录制时间推进） */
function tickChallenge(ch: ChallengeSession): void {
  if (ch.finished) return;
  // 非比赛状态（待命/倒计时）不进 tick——timer 只在 GO 后启动，restart 已清 timer
  if (ch.state !== "RACING") return;
  // 会话已被清理（中途 stop/掉线）→ 停掉定时器，防空转泄漏
  if (!challenges.has(ch.playerId)) {
    if (ch.timer) clearIntervalSafe(ch.timer);
    return;
  }
  const p = Player.getInstance(ch.playerId);
  // 玩家在线但已不在挑战世界（死亡重生回原世界/传送离开）→ 自动结束，
  // 防 ghost 在挑战世界挂到超时（重生后玩家已不在挑战上下文）
  if (p && p.isConnected() && p.getVirtualWorld() !== ch.worldId) {
    sysMsg(p, "challenge", "你已离开挑战世界，挑战结束", "warn");
    cleanupChallenge(ch.playerId);
    return;
  }
  if (p && p.isConnected()) {
    ensureChallengeCar(p, ch);
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
      sysMsg(p, "challenge", "影子已完赛，20 秒后挑战结束（倒计时内完成可继续）", "info");
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
  // 只有比赛中算 CP：待命/倒计时期间（无界待命、起点在 CP 检测范围内）忽略，
  // 防止未 start 就提前刷 CP/卡起跑
  if (ch.state !== "RACING") return;
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
  sysMsg(
    player,
    "challenge",
    `CP ${pcp}/${ch.totalCp}（影子 ${gp.cp}/${ch.totalCp}）${ahead}`,
    "info",
  );
}

/** 完成结算（玩家用时 vs 影子用时 = 录制时长）；「再跑一次」重置回起点待命 */
async function finishChallenge(player: Player, ch: ChallengeSession): Promise<void> {
  // 真实时间差（从 GO 起跑，不用帧数累计防漂移）
  const playerMs = Math.max(0, Date.now() - ch.goAt);
  const ghostMs = ch.data.header.durationMs;
  const diff = playerMs - ghostMs;
  const verdict = diff <= -500 ? "你赢了！" : diff >= 500 ? "影子赢了" : "势均力敌！";
  const res = await showDialog(
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
      button1: "再跑一次",
      button2: "退出",
    }),
  );
  // 会话已被清理（掉线等）→ 不再操作
  if (!challenges.has(ch.playerId)) return;
  if (res && res.response === 1) {
    // 再跑一次：同一影子回起点待命，玩家就绪后 /challenge go（不再重选影子）
    restartChallenge(player);
  } else {
    const owner = Player.getInstance(ch.playerId);
    if (owner && owner.isConnected()) {
      sysMsg(owner, "challenge", "影子挑战结束，可再选回放继续挑战", "success");
    }
    cleanupChallenge(ch.playerId);
  }
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
    sysMsg(player, "challenge", "请先登录", "warn");
    return false;
  }
  if (challenges.has(player.id)) {
    sysMsg(player, "challenge", "你已在影子挑战中，先 /challenge stop", "warn");
    return false;
  }
  if (getReplaySession(player.id)) {
    sysMsg(player, "challenge", "你正在播放回放中，先 /rp stop", "warn");
    return false;
  }
  if (isInRace(player.id)) {
    sysMsg(player, "challenge", "比赛中不能进入影子挑战", "warn");
    return false;
  }
  // 本人该赛道的比赛回放（完成比赛的优先，未完成也允许——影子只跑已录部分）
  const races = await prisma.replay.findMany({
    where: { userId: auth.userId, raceId, type: "race", deletedAt: null },
    orderBy: [{ finished: "desc" }, { createdAt: "desc" }],
  });
  if (races.length === 0) {
    sysMsg(player, "challenge", "你还没有该赛道的比赛回放（跑一场比赛后自动生成）", "warn");
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
    sysMsg(player, "challenge", "回放文件损坏或不存在", "error");
    return false;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId },
    orderBy: { index: "asc" },
  });
  if (cps.length < 2) {
    sysMsg(player, "challenge", "该赛道至少需要 2 个检查点", "error");
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
    sysMsg(player, "challenge", "请先登录", "warn");
    return false;
  }
  if (challenges.has(player.id)) {
    sysMsg(player, "challenge", "你已在影子挑战中，先 /challenge stop", "warn");
    return false;
  }
  if (getReplaySession(player.id)) {
    sysMsg(player, "challenge", "你正在播放回放中，先 /rp stop", "warn");
    return false;
  }
  if (isInRace(player.id)) {
    sysMsg(player, "challenge", "比赛中不能进入影子挑战", "warn");
    return false;
  }
  const replay = await prisma.replay.findFirst({
    where: { id: replayId, type: "race", deletedAt: null }, // 任意玩家
  });
  if (!replay) {
    sysMsg(player, "challenge", "回放不存在或已删除", "error");
    return false;
  }
  if (!replay.raceId) {
    sysMsg(player, "challenge", "该回放没有关联赛道，无法影子挑战", "error");
    return false;
  }
  let data: ReplayData;
  try {
    data = loadReplayData(replay.fileName); // 只读缓存（与回放共享文件数据）
  } catch (e) {
    logger.error(`[replay] 挑战回放读取失败 ${replay.fileName}`, e);
    sysMsg(player, "challenge", "回放文件损坏或不存在", "error");
    return false;
  }
  // 赛道可能已被软删/禁用：此时 cps 查出来为空会误报"至少需要 2 个检查点"，
  // 先确认赛道状态再读检查点（laps 一并取出，供多圈挑战）
  const race = await prisma.race.findFirst({
    where: { id: replay.raceId, deletedAt: null, isEnabled: true },
    select: { id: true, laps: true },
  });
  if (!race) {
    sysMsg(player, "challenge", "该赛道已被删除或禁用，无法进行影子挑战", "error");
    return false;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId: replay.raceId },
    orderBy: { index: "asc" },
  });
  if (cps.length < 2) {
    sysMsg(player, "challenge", "该赛道至少需要 2 个检查点", "error");
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
      sysMsg(player, "challenge", "NPC 槽位不足，影子挑战创建失败", "error");
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
    sysMsg(player, "challenge", "NPC 槽位不足或创建失败", "error");
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
    cps: cps.map((c) => ({
      x: Number(c.x),
      y: Number(c.y),
      z: Number(c.z),
      angle: Number(c.angle ?? 0),
      size: Number(c.size),
    })),
    laps,
    cpIndex: 0,
    // 多圈：总 CP = 圈数 × 一圈 CP 数（玩家累计跑满才结算，与影子整场时长对比）
    totalCp: Math.max(1, laps) * cps.length,
    shadowLapOffset: 0,
    lastShadowCp: -1, // 首帧采样时初始化（-1 跳过首帧回退检测）
    state: "STANDBY",
    countdownEpoch: 0,
    startAt: Date.now(),
    goAt: 0, // 待命期间无发车时刻（/challenge go 倒计时结束才置）
    finished: false,
    shadowFinished: false,
    lastTickAt: Date.now(),
  };
  challenges.set(player.id, ch);
  // 统一待命制：影子停在起始帧只渲染一次（起点车可见），玩家就位后由
  // /challenge go 触发倒计时 → GO（首次进入与局内重开同一套交互）
  standbyAtStart(player, ch);
  await seatPlayerAtStart(player, ch);
  if (!player.isConnected()) {
    cleanupChallenge(player.id); // await 期间断线 → 清理 ghost
    return false;
  }
  player.setFacingAngle(ch.cps[0]?.angle ?? 0);
  sysMsg(
    player,
    "challenge",
    `挑战开始！目标 ${replay.raceName ?? "该赛道"}，准备好了输入 /challenge go 起跑` +
      `（/challenge restart 重置 · /challenge stop 退出）`,
    "success",
  );
  return true;
}

/** 初始化挑战：注册 CP 进入检测（与比赛共用 RaceCpEvent 入口） */
export function initChallenge(): void {
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    // 统一排除 NPC（对齐项目约定：所有事件回调排除 NPC；NPC 不会进 challenges）
    if (player.isNpc()) return next();
    onChallengePlayerEnter(player);
    return next();
  });
}

/** 玩家断线清理挂接（callbacks onDisconnect 调用） */
export function challengeDisconnect(playerId: number): void {
  cleanupChallenge(playerId);
}
