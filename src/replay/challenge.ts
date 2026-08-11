import {
  Dialog,
  DialogStylesEnum,
  Dynamic3DTextLabel,
  KeysEnum,
  Npc,
  Player,
  PlayerEvent,
  RaceCheckpoint,
  RaceCpEvent,
  Streamer,
  StreamerItemTypes,
  Vehicle,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isInRace } from "@/race/room";
import { getOwnedVehicle, spawnVehicle, destroyPlayerVehicle, addNitro } from "@/vehicles";
import {
  setIntervalSafe,
  clearIntervalSafe,
  setTimeoutSafe,
  clearTimeoutSafe,
} from "@/core/timers";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
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
  frameTimeAt,
  isReplayLabelHidden,
} from "./playback";
import { registerObserveCandidate, unregisterObserveCandidate } from "@/core/observe";
import { playCountdown, cancelCountdownFx } from "@/interface/countdownFx";
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
  /** 上次自动补氮气**播放时间**（timer 模式录制者 15 秒自动补、帧里无按键信号——
   *  影子每播放 15 秒自动补一管兜底，对齐录制节奏） */
  lastAutoNitroAt: number;
  /** 上次氮气按住持续补**播放时间**（点按模式录制：帧 FIRE 位按住每播放 1 秒补一管） */
  lastNitroAt: number;
  /** 补氮气后强制模拟 SPRINT（模拟玩家按下氮气键）的**墙钟**截止点：补组件那帧
   *  采样可能恰好是录制者松油门瞬间（帧 keys 无 SPRINT），客户端有组件没按键
   *  不喷——窗口内强制 SPRINT 保证喷起来；窗口结束恢复录制按键 */
  nitroSimUntil: number;
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

/** 对某玩家的挑战影子标签应用显隐偏好（复用回放 /rp label 的同一偏好，
 *  challenge 影子与回放 ghost 标签一视同仁，切换一次两侧同时生效） */
function applyShadowLabelVisibility(playerId: number): void {
  const ch = challenges.get(playerId);
  if (!ch || !ch.ghost.label.isValid()) return;
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  try {
    Streamer.toggleItem(
      p,
      StreamerItemTypes.TEXT_3D_LABEL,
      ch.ghost.label.id,
      !isReplayLabelHidden(playerId),
    );
  } catch {
    /* 标签已失效等，忽略 */
  }
}

/** 切换该玩家挑战影子标签显隐（/rp label 与回放标签共用）；返回切换后的可见状态 */
export function toggleChallengeShadowLabel(playerId: number): boolean {
  const visible = !isReplayLabelHidden(playerId);
  applyShadowLabelVisibility(playerId);
  return visible;
}

/** 玩家断线/退出清理（挑战会话销毁 + ghost 清理 + 恢复原世界）。
 * 仅在玩家仍处于挑战世界时恢复世界/CP/爱车——若玩家已离开挑战世界
 * （如挑战中途进入比赛/战局），不得覆盖其当前世界（防把玩家从比赛中拉走）。 */
export function cleanupChallenge(playerId: number): void {
  const ch = challenges.get(playerId);
  if (!ch) return;
  challenges.delete(playerId);
  ch.countdownEpoch++; // 代数兜底：清理后任何在途续体/定时链判"代数失配"自停，
  // 防 stop→重开（worldId 复用）后旧对象残留的 async 续体误对新会话起倒计时
  pendingRespawn.delete(playerId);
  cancelCountdownFx(playerId); // 取消进行中的倒计时动画（断链 + 销毁 TD）
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
  // 影子播完边界 = 播放终点（v7 末帧时间戳 / 旧文件均匀间隔——对齐 playback）
  const maxTime = frameTimeAt(ch.data, ch.data.header.frameCount - 1);
  // 倒计时期间：playTime 停在录制起始帧（文件第 0 帧）→ 按静止帧渲染
  //（速度/按键清零，影子停在起点等发车；GO 后 tick 推进 playTime 才离开
  // 起点，恢复正常驱动）。起始帧如果是换车帧，ensureGhostVehicle 只在
  // 创建渲染时执行一次，不会反复换车。
  const atStart = ch.ghost.playTime <= 0;
  // 影子播完（playTime 到最后一帧）→ 速度/按键清零：影子停在终点，挑战者
  // 仍要看见它作参照（不能停发）。否则尾帧非零速度会让影子在终点持续滑行
  // 抖动，按键残留还会原地转向抖动（emulateDriverSync 的 atEnd 分支处理）。
  const atEnd = ch.ghost.playTime >= maxTime || atStart;
  try {
    // 30Hz 发包节流
    const now = Date.now();
    if (now - ch.ghost.lastEmulateAt < 33) return;
    ch.ghost.lastEmulateAt = now;
    // 氮气：按住持续补，节流基准用**播放时间**（playTime）对齐录制节奏——
    // 录制时 vehicleAuto 按现实时间补（timer 15s / 点按按键即补），回放按播放
    // 时间补 = 复现"录制者补氮气的那段路线"。慢放时录制 15 秒 = 播放 15 秒 =
    // 现实更长，按播放时间补正好落在录制者补管的时段（按墙钟补会落在录制者
    // 根本没喷的时段）。**补组件同时模拟玩家按下氮气键**：SA 喷氮气 = 车有
    // 组件 + 按住 FIRE（左键）或 W（SPRINT）。我们的点按交互是 FIRE/ACTION，
    // 补组件那帧采样可能恰好是录制者松键瞬间（帧 keys 无 FIRE）——补了组件
    // 客户端也不喷。补组件起墙钟窗口内强制 FIRE|ACTION（不用 SPRINT——W 是
    // 油门会干扰录制速度物理），窗口结束恢复录制按键。与 playback renderGhost
    // 同一套。起始/播完后 atEnd 不再补。
    const pt = ch.ghost.playTime;
    const nitroOn = (s.keys & KeysEnum.FIRE) !== 0; // KEY_FIRE = 点按氮气触发键
    if (nitroOn && !atEnd) {
      if (pt - ch.ghost.lastNitroAt >= NITRO_REFILL_MS) {
        ch.ghost.lastNitroAt = pt;
        ch.ghost.nitroSimUntil = now + NITRO_SIM_MS;
        addNitro(ch.ghost.vehicle);
      }
      // 无墙钟兜底（playback 的 NITRO_TOPDUP_MS 仅慢放需要）：影子固定 1x，
      // 播放时间补管间隔 ≤1s 现实，罐子不会断
    } else if (!atEnd && pt - ch.ghost.lastAutoNitroAt >= 15_000) {
      ch.ghost.lastAutoNitroAt = pt;
      ch.ghost.nitroSimUntil = now + NITRO_SIM_MS;
      addNitro(ch.ghost.vehicle);
    }
    // 补氮气后的模拟窗口内：强制 FIRE/ACTION（模拟玩家按下点按氮气键），组件
    // 刚补上即喷
    if (!atEnd && now < ch.ghost.nitroSimUntil) {
      s.keys |= KeysEnum.FIRE | KeysEnum.ACTION;
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
 * 顺带：影子圈内 cpProgress 前进（过 CP）→ 给挑战者播过 CP 音效 1056——
 * 玩家自己开车或观战影子视角都能听到影子进度（挑战无原生 CP 事件给 NPC，
 * 影子过点只能从帧进度检测）。起步首帧 lastShadowCp=-1 跳过，不会误播。
 */
function advanceShadowLap(ch: ChallengeSession): void {
  const s = sampleAt(ch.data, ch.ghost.playTime);
  if (!s) return;
  // 跨圈判定：cpProgress 是 1-indexed 的"已完成 CP 数"（过第 N 个 CP 写 N，
  // 一圈最后一个写 len），跨圈瞬间帧序列是 len → 1（新圈第一 CP 触达写 1）。
  // 只有"回退到 1"才是圈边界。录制里的"回退到更早检查点"（rollback）把进度写
  // 回非 1 的某个 CP（或回退到圈首 CP=1，罕见），不是圈边界——不能 +1 圈，
  // 否则影子进度虚高、领先判定全错。
  if (ch.lastShadowCp !== -1 && s.cpProgress < ch.lastShadowCp && s.cpProgress === 1) {
    ch.shadowLapOffset++;
  }
  if (ch.lastShadowCp !== -1 && s.cpProgress > ch.lastShadowCp) {
    const p = Player.getInstance(ch.playerId);
    if (p && p.isConnected()) p.playSound(1056);
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
/** 氮气按住持续补间隔（**播放时间**毫秒，对齐 playback：补给随播放时间轴落在
 *  录制者按管时段） */
const NITRO_REFILL_MS = 1000;
/** 补氮气后强制模拟 SPRINT（模拟玩家按下氮气键）的时长（墙钟毫秒，对齐 playback） */
const NITRO_SIM_MS = 300;

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

/** 玩家位置挪到录制起点（车就位 + 放回车里；restart 与首进共用）。
 * 起点 = 回放录制者的**录制起点**（data.header.startX/Y/Z），与影子车同位置——
 * 玩家与影子并排起步，公平对齐（此前用第一个 CP cps[0]，与影子起点分离，
 * 玩家起步位置与影子错位）。restart 与首进共用。
 * async：无车时刷车是异步的，调用方 await 后需自行做断线检查。
 * 入口 pendingRespawn 短路：restart↔go 交错时（restart 的 seatPlayerAtStart 不 await
 * 就 go），在途刷车未完成则跳过本次——车由在途那次刷到位，防双 spawnVehicle 并发
 * 销毁对方刚建的车/残留孤儿实体。 */
async function seatPlayerAtStart(player: Player, ch: ChallengeSession): Promise<void> {
  if (pendingRespawn.has(player.id)) return; // 刷车在途 → 跳过（在途那次会就位）
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(ch.data.header.startX, ch.data.header.startY, ch.data.header.startZ);
    owned.setZAngle(0); // 朝向 0 对齐影子车（header 未存录制起点角度）
    owned.setVirtualWorld(ch.worldId);
    owned.setHealth(1000);
    owned.repair();
    addNitro(owned);
  } else {
    if (owned) destroyPlayerVehicle(player.id); // 车已毁（爆炸残留失效实体）
    // pendingRespawn 与 ensureChallengeCar 共用：刷车期间（可能跨 tick/go 的
    // 异步窗口）不重复刷，防 restart↔go 交错双车；finally 兜底——刷车失败
    //（如中途断线/实体创建异常）也放行，防守卫永久卡死阻断后续救援
    pendingRespawn.add(player.id);
    const spawned = await spawnVehicle(player, ch.data.header.vehicleModelId, true).finally(() => {
      pendingRespawn.delete(player.id);
    });
    // await 期间会话可能已被清理（/challenge stop / 断线）：cleanupChallenge
    // 已恢复玩家世界并回收世界 id——此时再挪车/切世界会把新车挪进已回收的
    // 独立世界（可能正被新挑战复用），且把玩家从恢复好的世界拉走。直接放弃
    if (challenges.get(player.id) !== ch) return;
    // 无爱车分支：spawnVehicle 在玩家当前世界/位置刷车（旧世界），车不随人走——
    // 显式挪到起点 + 切挑战世界（对齐有车分支的 owned.setPos/setVirtualWorld）。
    // spawnVehicle 内部已把玩家放入车内（vehicles spawnVehicle 末尾 putPlayerIn），
    // 车 setPos 会带着车内玩家一起到位。
    if (spawned) {
      const veh = getOwnedVehicle(player.id);
      if (veh && veh.isValid()) {
        veh.setPos(ch.data.header.startX, ch.data.header.startY, ch.data.header.startZ);
        veh.setZAngle(0);
        veh.setVirtualWorld(ch.worldId);
      }
    }
  }
  // 玩家同步世界后，**未上车才** setPos + 上车：SA/open.mp 的 SetPlayerPos 对车内
  // 玩家会直接把人移出车辆（"上车后被弹出车外"的根因）。有车分支此时还没上车
  // （上面只挪车），这里先传人再上车；无车分支 spawnVehicle 已上车，车 setPos 已带
  // 人到起点，跳过后玩家仍在车内就位。
  player.setVirtualWorld(ch.worldId);
  if (!player.isInAnyVehicle()) {
    player.setPos(ch.data.header.startX, ch.data.header.startY, ch.data.header.startZ);
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) veh.putPlayerIn(player, 0);
  }
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
  // 重置氮气补给状态并补一管：上一轮可能喷完空管（持续补/兜底节流未复位）——
  // 不重置则重开后影子一管都没有
  ch.ghost.lastAutoNitroAt = 0;
  ch.ghost.lastNitroAt = 0;
  ch.ghost.nitroSimUntil = -1;
  try {
    ch.ghost.vehicle.setPos(ch.data.header.startX, ch.data.header.startY, ch.data.header.startZ);
    ch.ghost.vehicle.setZAngle(0);
    ch.ghost.vehicle.setHealth(1000);
    ch.ghost.vehicle.repair();
    addNitro(ch.ghost.vehicle); // 起始补一管（与第一次进挑战一致）
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
  // 影子标签按 /rp label 偏好应用（首次创建与重开都走这里）
  applyShadowLabelVisibility(ch.playerId);
}

/** 玩家触发开始（/challenge go）：待命 → 3 秒倒计时 → GO。倒计时期间玩家可控：
 * restart 打断回待命；死亡打断回待命（车可能已爆，restart/ensureChallengeCar 兜底）。 */
function beginChallengeCountdown(player: Player, ch: ChallengeSession): void {
  if (ch.state !== "STANDBY") return;
  ch.state = "COUNTDOWN";
  ch.countdownEpoch++; // 打断任何旧倒计时链（restart 后旧链的 pending 步骤靠代数失配自停）
  const epoch = ch.countdownEpoch;
  // 倒计时动画（TextDraw 掉落弹跳+放大淡出，替代 GameText）：数字 3-2-1 + GO。
  // 音效由组件播放（数字 1056 / GO 1057）。开赛门控（身份/代数/state/死亡）在
  // onGo 里做——组件只负责动画，即使动画播完但校验不过也不进入 RACING
  playCountdown([player], {
    numbers: [3, 2, 1],
    onGo: () => {
      // 挑战已被清理（中途 stop/掉线）或会话对象已更换（stop→重开，worldId 复用）→
      // 不进入 RACING。身份判定而非 challenges.has：has 只能证明"当前存在某个会话"，
      // 不能证明还是本会话——旧对象的续体对上新会话会误起倒计时/双 GO
      if (challenges.get(player.id) !== ch) return;
      // 代数失配：期间发生过 restart / 新的 go，旧链必须自停（防双链并行双 GO）
      if (epoch !== ch.countdownEpoch) return;
      if (!player.isConnected()) {
        cleanupChallenge(player.id);
        return;
      }
      // 状态已被 restart 打断（回 STANDBY）→ 不进 RACING
      if (ch.state !== "COUNTDOWN") return;
      if (player.isWasted()) {
        // 死亡打断倒计时 → 回待命（复活后玩家可 /challenge go 重来）
        ch.state = "STANDBY";
        sysMsg(player, "challenge", "死亡，已回到起点待命，/challenge go 重新开始", "info");
        return;
      }
      ch.state = "RACING";
      ch.goAt = Date.now(); // 真实起跑时刻（结算/超时计时基准）
      ch.lastTickAt = Date.now(); // 重置影子推进基准（待命可能等很久，防首帧跳变）
      // 重设检查点：待命期间站在起点圈内时 enter 已被 STANDBY 态吞掉且检查点消耗，
      // 重设让起点 CP 在 RACING 态重新进入计数（对齐比赛 beginRace 开赛重设），
      // 否则 GO 后驶离起点永远触发不了第一个 CP
      resetChallengeCheckpoint(player, ch);
      ch.timer = setIntervalSafe(() => tickChallenge(ch), 16);
    },
  });
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
      challenges.get(player.id) === ch &&
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

/** 退出影子挑战（/challenge stop、比赛中 /r l 共用）：清理会话 + 恢复世界。
 * 不在挑战中明确提示（对齐 /r l 的"你不在比赛中"反馈习惯，防零反馈）。 */
export function exitChallenge(player: Player): void {
  if (!challenges.has(player.id)) {
    sysMsg(player, "challenge", "你不在影子挑战中", "warn");
    return;
  }
  cleanupChallenge(player.id);
  sysMsg(player, "challenge", "影子挑战已退出", "success");
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
  cancelCountdownFx(player.id); // 打断进行中的倒计时动画（断链 + 销毁 TD）
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
  // 会话已被清理或对象已更换（stop→重开）→ 停掉定时器，防空转泄漏
  if (challenges.get(ch.playerId) !== ch) {
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
  // 影子播完时间 = 播放终点（v7 末帧时间戳 / 旧文件均匀间隔——对齐 playback）
  const dur = frameTimeAt(ch.data, ch.data.header.frameCount - 1);
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
      if (ch.finished || challenges.get(ch.playerId) !== ch) return;
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
  // 过 CP 音效（对齐比赛普通 CP 音效 1056）。挑战不执行 CP 脚本（speed/cveh
  // 等不生效），统一用普通音效——不区分"显著脚本"的 1133，避免误导玩家
  // 以为撞上了加速带却没有任何效果。
  player.playSound(1056);
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

/** 完成结算（玩家用时 vs 影子用时 = 录制时长）；「再跑一次」重置回起点待命。
 * 结算框 60s 无响应自动按「退出」处理：挂机玩家不点按钮会永久占着影子 NPC
 * 槽位（MAX_REPLAY_NPC 全服 100 共享）与世界 id——超时兜底释放资源。 */
const CHALLENGE_RESULT_TIMEOUT_MS = 60_000;

async function finishChallenge(player: Player, ch: ChallengeSession): Promise<void> {
  // 真实时间差（从 GO 起跑，不用帧数累计防漂移）
  const playerMs = Math.max(0, Date.now() - ch.goAt);
  // 影子用时 = 影子实际播放终点（末帧时间戳），与 tickChallenge 的播完边界
  // frameTimeAt(last) 一致——不能用 header.durationMs（录制墙钟时长，断线尾段
  // 缺失时末帧早于停止时刻，会出现"结算显示 2:05、影子停在 1:58"的错位）
  const ghostMs = frameTimeAt(ch.data, ch.data.header.frameCount - 1);
  const diff = playerMs - ghostMs;
  const verdict = diff <= -500 ? "你赢了！" : diff >= 500 ? "影子赢了" : "势均力敌！";
  // 超时兜底：race 超时后 resolve null（视同玩家没点按钮 → 走退出分支清理）；
  // 玩家之后点按钮的响应由 showDialog 内部丢弃（本次 promise 已结算），无影响。
  // 对话框残留会随下一次 showDialog 覆盖。
  const res = await Promise.race([
    showDialog(
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
    ),
    new Promise<null>((resolve) => {
      setTimeoutSafe(() => resolve(null), CHALLENGE_RESULT_TIMEOUT_MS);
    }),
  ]);
  // 会话已被清理或对象已更换（掉线/stop→重开）→ 不再操作
  if (challenges.get(ch.playerId) !== ch) return;
  if (res && res.response === 1) {
    // 再跑一次：同一影子回起点待命，玩家就绪后 /challenge go（不再重选影子）。
    // 校验玩家仍在挑战世界：结算框展示期间玩家可能已离开（被传走/进比赛/死亡
    // 重生回大世界），restartChallenge 的 seatPlayerAtStart 会无条件拉回挑战世界
    // ——此时应视为挑战已结束（对齐 goChallenge 的离场校验）
    if (!player.isConnected() || player.getVirtualWorld() !== ch.worldId) {
      sysMsg(player, "challenge", "你已离开挑战世界，挑战结束", "warn");
      cleanupChallenge(ch.playerId);
      return;
    }
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
  // 全服该赛道的完赛比赛回放：影子挑战可以挑战**任何玩家**跑这条赛道的影子
  //（不限于自己的回放——"该赛道有完赛回放"即可挑战）。仅完赛（finished=true）
  // 可选：影子必须跑完整场录像才有可比性。热门赛道回放多，take 上限防一次拉取过多
  const races = await prisma.replay.findMany({
    where: { raceId, type: "race", deletedAt: null, finished: true },
    orderBy: [{ finished: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
  if (races.length === 0) {
    sysMsg(player, "challenge", "该赛道还没有完成的比赛回放（跑完一场比赛后自动生成）", "warn");
    return false;
  }
  // 多条回放可选：跟"哪一场/谁的影子"比由玩家决定。分页多列选择——
  // 名次 / 完成 / 时长 / 录制者 / 录制时间（录制者列区分是谁的影子）
  let chosen = races[0];
  if (races.length > 1) {
    const r = await showPagedDialog(player, {
      caption: "选择影子（全服比赛回放）",
      data: races,
      headers: ["#", "名次", "完成", "时长", "录制者", "录制时间"],
      format: (rec, index) => [
        String(index + 1),
        rec.rank != null ? `No.${rec.rank}` : "未完成",
        rec.finished ? "完成" : "未完成",
        challengeFmtDur(rec.durationMs),
        rec.recorderName ?? "?",
        challengeFmtTime(rec.createdAt),
      ],
      button1: "确定",
      button2: "取消",
    });
    if (!r) return false; // 取消选择
    chosen = r.item;
  }
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
  // 影子挑战仅对已完成的比赛回放开放（未完成回放影子只跑已录部分，不完整）
  if (replay.finished !== true) {
    sysMsg(player, "challenge", "只能挑战已完成的比赛回放", "warn");
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
    addNitro(veh); // 氮气（影子车与录制时玩家爱车一致）
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
    registerReplayNpcForReplay(shadowPlayer.id); // 登记为观战切换候选（与回放 ghost 同机制，可左右键切到影子车）
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
      lastAutoNitroAt: 0,
      lastNitroAt: 0,
      nitroSimUntil: -1,
      online: true, // 起始帧在线（掉线重连回放才可能翻转为 false）
    };
    // NPC 连接建立是异步的：刚 create 后立即 putInVehicle 可能未生效（NPC 未就绪
    // 时静默失败，车看起来"没人开"）。延迟短时间幂等补一次——已在车内则跳过；
    // 挑战已被清理（实体销毁）时 npc.isValid() 为 false，守卫兜底。
    setTimeoutSafe(() => {
      try {
        if (npc && npc.isValid()) {
          const np = npc.getPlayer();
          if (np && !np.isInAnyVehicle()) {
            npc.putInVehicle(veh, 0);
          }
        }
      } catch {
        /* 实体已销毁（挑战清理）等，忽略 */
      }
    }, 500);
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
  // await 期间断线或会话被清理（/challenge stop）→ 不再发成功提示（seatPlayerAtStart
  // 内部已按会话存续守卫跳过挪车，cleanupChallenge 已恢复玩家世界）。断线且会话
  // 仍在（在途续体先于断线链执行）→ 显式清理，防 ghost/世界 id 残留
  if (!player.isConnected() || challenges.get(player.id) !== ch) {
    if (!player.isConnected() && challenges.get(player.id) === ch) {
      cleanupChallenge(player.id);
    }
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

/**
 * 挑战中允许的主命令白名单：对齐比赛的命令隔离——挑战是独立竞速世界，
 * 刷车/传送/房屋等玩法操作会破坏挑战车/把玩家带出挑战世界。比赛白名单
 * （r/race/kill 等）不完全适用：挑战没有比赛房间语义，保留面板/聊天/脱卡
 * 等通用项。挑战自身的 go/restart/stop 也放行（onCommandText 与
 * onCommandReceived 不冲突——onCommandReceived 的白名单放行后命令才走到
 * onCommandText 处理）。
 */
const CHALLENGE_SAFE_COMMANDS = new Set([
  "challenge",
  "pm",
  "kill",
  "stuck",
  "f", // 车辆翻正（翻车自救，不传送不破坏挑战——比赛白名单也有 f）
  "tv",
  "ob",
  "spec",
  "p",
  "panel",
  "help",
]);

/** 初始化挑战：注册 CP 进入检测（与比赛共用 RaceCpEvent 入口）+ 命令隔离 */
export function initChallenge(): void {
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    // 统一排除 NPC（对齐项目约定：所有事件回调排除 NPC；NPC 不会进 challenges）
    if (player.isNpc()) return next();
    onChallengePlayerEnter(player);
    return next();
  });
  // 挑战中命令隔离：非白名单命令一律拒绝（对齐比赛 onCommandReceived 处理；
  // 主命令取 strictMainCmd 或 command 首 token，防 /c 123 被当未授权拦截错）
  PlayerEvent.onCommandReceived(({ player, command, strictMainCmd, next }) => {
    if (!challenges.has(player.id)) return next();
    const main = (strictMainCmd || command.split(/\s+/)[0] || "").toLowerCase();
    if (CHALLENGE_SAFE_COMMANDS.has(main)) return next();
    sysMsg(
      player,
      "challenge",
      "影子挑战中只能使用 /challenge 相关命令（go/restart/stop）",
      "warn",
    );
    return false;
  }, true); // unshift 优先执行（在限频之前，避免双提示）
}

/** 玩家断线清理挂接（callbacks onDisconnect 调用） */
export function challengeDisconnect(playerId: number): void {
  cleanupChallenge(playerId);
}
