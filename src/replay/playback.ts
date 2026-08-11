import {
  Dynamic3DTextLabel,
  GameText,
  KeysEnum,
  Npc,
  Player,
  RaceCheckpoint,
  Streamer,
  StreamerItemTypes,
  TextDraw,
  Vehicle,
} from "@infernus/core";
import { InCarSync, IncomingBitStream } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { formatRaceTimeCs } from "@/utils/format";
import { sysMsg } from "@/utils/msg";
import { isInRace } from "@/race/room";
import { isInChallenge } from "./challenge";
import { getOwnedVehicle, addNitro } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import {
  startObserveVehicle,
  stopObserve,
  isObserving,
  detachObservingVehicle,
  registerObserveCandidate,
  unregisterObserveCandidate,
} from "@/core/observe";
import {
  parseReplayFile,
  decodeFrame,
  lerpFrame,
  FRAME_BYTES_V7,
  FRAME_BYTES_V8,
  type ReplayData,
  type ReplayFrame,
} from "./format";
import { join } from "node:path";
import { RECORDING_DIR } from "./storage";
import { applyWorldEnv } from "@/core/worldenv";
import { playCountdown, cancelCountdownFx } from "@/interface/countdownFx";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_RACE, COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/**
 * 回放会话（NPC 逐帧驱动，非原生 .rec）：
 * - 回放文件整读入内存（Buffer 帧切片，O(1) seek）
 * - 60fps tick：按播放时间（方向×倍速推进）→ 相邻帧插值 → 构造 InCarSync
 *   DriverSync 包 emulateIncomingPacket 模拟 NPC 传入——服务器按真实司机处理
 *   并广播给所有玩家，客户端物理驱动（位置/速度/氮气按键都真实平滑）
 * - 帧带"完整状态"：车型变化（cveh 换车）→ 重建车辆；时间/天气/血量随帧应用。
 *   CP 脚本是离散事件，NPC 不触发 onPlayerReachCp——seek/回退时"恢复状态而非
 *   重放事件"，天然无事件顺序问题。观战者的比赛 TD（C P/TIME/BEST）也从帧状态
 *   渲染（事件无关），NPC 的 TextDraw 状态观战者完整可见。
 * - 控制：播放/暂停/正放/倍速/seek（只支持正放——倒放时帧间速度插值方向与
 *   录制速度矛盾，客户端物理按正向速度处理，车辆会一抽一抽，故不支持）
 * - 多分身：同一数据错峰起始（每 ghost 独立 playTime，控制同步作用于全部）
 * - 观看：发起人自动 startObserveVehicle(ghost 车)（复用观战系统）
 * - 清理：/rp stop / 发起人断线 / onExit 全路径销毁
 */

/** 回放/挑战 NPC 的 playerId 集合：其 DriverSync/OnFootSync 包直接丢弃——
 *  emulateIncomingPacket 模拟的包不会进入 onIncomingPacket 回调，但 NPC 自身
 * （如 putInVehicle 后的残留状态 / setVehiclePos immediate 路径）可能发真实
 *  sync，会与 emulate 的广播冲突，必须屏蔽（不交给游戏处理、不采样） */
const replayNpcIds = new Set<number>();

export function isReplayNpc(playerId: number): boolean {
  return replayNpcIds.has(playerId);
}

function registerReplayNpc(playerId: number): void {
  replayNpcIds.add(playerId);
}

function unregisterReplayNpc(playerId: number): void {
  replayNpcIds.delete(playerId);
}

/** 供 challenge 登记/注销其影子 NPC（复用同一屏蔽集合与清理逻辑） */
export function registerReplayNpcForReplay(playerId: number): void {
  registerReplayNpc(playerId);
}

export function unregisterReplayNpcForReplay(playerId: number): void {
  unregisterReplayNpc(playerId);
}

/** 回放/挑战世界起始 id（战局 1..1000、比赛 1001..2000，回放从 2001 起——
 * 三区间独立不叠加；挑战共用） */
export const REPLAY_WORLD_BASE = 2001;
let nextReplayWorldId = REPLAY_WORLD_BASE;
/**
 * 已释放的回放/挑战世界 id（复用防无界增长）：
 * 回放/挑战会话频繁创建销毁（每人可开多场），只递增不复用会一直涨；
 * 复用已回收 id 避免长期运行后无界增长。
 */
const freedReplayWorlds: number[] = [];

/** 分配回放/挑战独立世界 id */
export function allocReplayWorld(): number {
  return freedReplayWorlds.pop() ?? nextReplayWorldId++;
}

/** 回收回放/挑战世界 id（仅回收本模块分配的 id；ghost 回放用当前世界不回收） */
export function freeReplayWorld(worldId: number): void {
  if (worldId >= REPLAY_WORLD_BASE) freedReplayWorlds.push(worldId);
}

/** 播放推进帧间隔（60fps） */
const TICK_MS = 16;
/** 支持的倍速档位（/rp speed、面板倍速选择共用校验） */
export const REPLAY_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 4];
/** emulate 发包节流：对齐 open.mp in_vehicle_sync_rate=30（30Hz）——60fps tick
 *  每 2 tick 发一个 DriverSync 模拟包（发太多服务器会合并/浪费） */
const EMULATE_INTERVAL_MS = 33;

/** 找回放 ghost 车所属会话的倍速（非回放/挑战车返回 null）。
 * 速度表反向除倍速用：emulate 驱动把 velocity×倍速推进（物理位置与速度一致），
 * 车速表显示要还原录制原始 1 倍速——gui.getDisplaySpeed 对回放车 sp/scale。
 * 挑战影子固定 1 倍速且不在本 sessions，返回 null 走原值（除 1 等效）。 */
export function getReplaySpeedScaleForVehicle(vehicleId: number): number | null {
  for (const s of sessions.values()) {
    for (const g of s.ghosts) {
      if (g.vehicle.id === vehicleId) return s.speed;
    }
  }
  return null;
}

/**
 * 回放 ghost 身份标签（车顶 3D 标签"身份 + 扮演谁 + ghost N/M"）的临时显隐偏好。
 * 会话级临时设置**不落库**：playerId 在集合 = 该玩家隐藏标签（区分多分身可能
 * 干扰视线，玩家可暂时屏蔽）。断线/重新登录即重置为默认显示。
 */
const hiddenReplayLabels = new Set<number>();

/** 该玩家是否隐藏回放/挑战 ghost 标签（供 challenge 复用同一偏好） */
export function isReplayLabelHidden(playerId: number): boolean {
  return hiddenReplayLabels.has(playerId);
}

/** 对某玩家应用一个回放会话的 ghost 标签显隐（创建会话 / 切换偏好时调用） */
function applyLabelVisibilityForPlayer(session: ReplaySession, playerId: number): void {
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  const visible = !hiddenReplayLabels.has(playerId);
  for (const g of session.ghosts) {
    try {
      // per-item 流式显隐：只影响该玩家对这个 label 的可见性（不影响他人/其他标签）
      Streamer.toggleItem(p, StreamerItemTypes.TEXT_3D_LABEL, g.label.id, visible);
    } catch {
      /* 标签已失效等，忽略 */
    }
  }
}

/** 切换该玩家回放标签显隐（/rp label；不落库，断线重置）。返回切换后的状态（true=显示） */
export function toggleReplayLabels(player: Player): boolean {
  if (hiddenReplayLabels.has(player.id)) {
    hiddenReplayLabels.delete(player.id);
  } else {
    hiddenReplayLabels.add(player.id);
  }
  const visible = !hiddenReplayLabels.has(player.id);
  // 应用到该玩家当前所有回放会话（新建会话在 spawnReplay 里按当前偏好应用）
  for (const s of sessions.values()) {
    if (s.ownerId === player.id) {
      applyLabelVisibilityForPlayer(s, player.id);
    }
  }
  return visible;
}

interface Ghost {
  npc: Npc;
  vehicle: Vehicle;
  /** 身份 3D 标签（NPC 无 nametag，用 Dynamic3DTextLabel 显示"本身身份 + 扮演谁"） */
  label: Dynamic3DTextLabel;
  /** 该分身的播放时间（毫秒，从文件起点；错峰起始） */
  playTime: number;
  /** 该分身的错峰偏移（毫秒，相对文件起点；seek 时叠加保持错峰） */
  staggerMs: number;
  /** 当前车辆模型（帧车型变化时重建） */
  model: number;
  /** NPC playerId（emulate 的发送者；缓存避免每帧 getPlayer） */
  npcPlayerId: number;
  /** 上次 emulate 发包时间（30Hz 节流） */
  lastEmulateAt: number;
  /** emulate/send 失败是否已警告过（一次性防刷屏） */
  warnedEmulateFail: boolean;
  /** 已播完（playTime 到终点）：停止 emulate 驱动标志（seek 回看时重置） */
  stopped: boolean;
  /** 上一帧录制按键是否按着氮气（KEY_FIRE 上升沿检测——点按模式按 FIRE 补一管，
   *  不边喷边装组件，防打断客户端正在进行的喷射） */
  nitroWasOn: boolean;
  /** 上次自动补氮气时刻（timer 模式录制者 15 秒自动补、帧里无按键信号——回放
   *  每 15 秒自动补一管兜底，保证 timer 玩家录像的 ghost 氮气不断档） */
  lastAutoNitroAt: number;
  /** 分身编号（1..N，头车=1；标签显示用） */
  labelNo: number;
  /** 当前标签显示的在线状态（掉线时标签追加红字"掉线"；变化时 updateText） */
  online: boolean;
}

/** ghost 车顶标签文本：身份 + 扮演谁 + 分身编号；掉线时追加红字标记 */
function ghostLabelText(
  npcName: string,
  recorderName: string,
  labelNo: number,
  total: number,
  online: boolean,
): string {
  return (
    `{FFD700}${npcName}` +
    `\n{FFFFFF}回放 · ${recorderName}` +
    (total > 1 ? `{808080} [ghost ${labelNo}/${total}]` : "") +
    (online ? "" : `\n{FF0000}掉线`)
  );
}

export interface ReplaySession {
  id: string; // replay 记录 id
  ownerId: number; // 发起人 playerId
  worldId: number;
  /** 发起人进入回放前的世界（race 独立世界回放停止时恢复玩家+爱车） */
  ownerPrevWorld: number;
  /** 回放类型：ghost=自由录制（当前世界，大家可玩可控制）；race=比赛回放（独立世界+观战） */
  replayType: "ghost" | "race";
  /** 录制时名次快照（race 回放 RANK TD 用；null = 未完成/无） */
  rank: number | null;
  data: ReplayData;
  ghosts: Ghost[];
  /** 录制者名（回放标签"扮演谁"用；从 replay 记录取） */
  recorderName: string;
  /** 会话级播放状态（作用于所有 ghost） */
  playing: boolean;
  paused: boolean;
  speed: number; // 倍速 0.5~4
  /** 开场倒计时剩余毫秒（>0 = 车停起始帧，3-2-1-GO 动画期间；动画 onGo 归 0 放行） */
  countdownMs: number;
  timer?: NodeJS.Timeout;
  /** 上次播放推进时间（真实流逝计时）：
   *  固定 16ms/tick 推进在事件循环繁忙/定时器节流时实际间隔 >16ms → 播放时间
   *  走得比现实慢，回放呈慢倍速感。改用真实流逝时间推进，快慢恒定 1:1。 */
  lastTickAt: number;
  /** 播放到结尾是否已提示过（防每帧重复提示"已播完"） */
  endedNotified: boolean;
  /** 观战者（发起人 + /rp watch 的人）的比赛信息 TD：playerId → 4 行 TD */
  tds: Map<number, { cp: TextDraw; time: TextDraw; best: TextDraw; rank: TextDraw }>;
  /** 当前观战中的玩家（含发起人）：会话停止时统一退出观战（防观战者卡 spectating） */
  watchers: Set<number>;
  /** 上次渲染的 TD 内容（去重，防每帧 setString 重绘） */
  lastCpText: string;
  lastTimeText: string;
  /** 上次渲染的 RANK 文本（v8 帧内实时名次动态刷新去重；旧文件静态不刷） */
  lastRankText: string;
  /** 观察者视角时间/天气（随帧状态应用；变化检测防每帧调用） */
  lastHour: number;
  lastMinute: number;
  lastWeather: number;
  /** 比赛赛道 CP 坐标（race 回放从 raceCp 表加载；观战者 3D 箭头/图标渲染用；
   *  ghost 回放无赛道为 undefined） */
  cps?: { x: number; y: number; z: number; size: number }[];
  /** 播放中发现过 KEY_FIRE 位（点按模式录制）→ 停用 15s 自动补氮气兜底（FIRE
   *  上升沿已覆盖补给，兜底反而会在喷射中打断，见 renderGhost） */
  nitroFireSeen: boolean;
  /** 上次渲染的 ghost CP 进度（过 CP 检测：cpProgress 前进 → 观战者音效 + 箭头推进） */
  cpProgressLast?: number;
}

const sessions = new Map<number, ReplaySession>(); // playerId -> 该玩家自己的回放会话（各看各的）

/**
 * 回放文件只读缓存（LRU）：多人看同一回放共享解析后的数据（Buffer 帧切片），
 * 避免各开会话时重复读文件。缓存只读共享——session 采样只读 frames，无写入，
 * 线程安全。容量上限 + 最久未用淘汰（防内存累积）。
 */
const fileCache = new Map<string, ReplayData>();
const CACHE_MAX = 16;

/** 读取回放文件（带缓存）。损坏抛 Error（调用方处理）。 */
export function loadReplayData(fileName: string): ReplayData {
  const cached = fileCache.get(fileName);
  if (cached) {
    fileCache.delete(fileName); // LRU：移到末尾（最近使用）
    fileCache.set(fileName, cached);
    return cached;
  }
  const data = parseReplayFile(join(RECORDING_DIR, fileName));
  if (fileCache.size >= CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest != null) fileCache.delete(oldest);
  }
  fileCache.set(fileName, data);
  return data;
}

/**
 * NPC 池子边界（回放/挑战共用，对齐 config.json max_bots=100——open.mp 的
 * NPC 数量上限；代码写死 100 与其一致，未动态读取配置）：
 * - 用 Npc.getInstances() 实时统计已用槽位（服务器权威，destroy 后自动减少，
 *   无需自维护计数）
 * - 创建前检查剩余槽位；创建后校验 isValid（open.mp 的 npc_create 失败
 *   不抛异常，仅 NPC 保持 invalid，必须显式校验）
 * - 创建中失败自动降级：已成功 ≥1 个 ghost 则继续用已成功的，否则整体失败
 */
const MAX_REPLAY_NPC = 100;

/** 剩余 NPC 槽位 */
export function npcSlotsLeft(): number {
  return MAX_REPLAY_NPC - Npc.getInstances().length;
}

/**
 * 分配一个 NPC（创建 + isValid 校验 + getPlayer 验证）。
 * 失败返回 null（槽位不足/创建失败），不抛异常。
 */
export function allocReplayNpc(name: string): Npc | null {
  let npc: Npc | undefined;
  try {
    npc = new Npc(name).create();
    if (!npc.isValid()) {
      // 创建"成功"但槽位未占（open.mp 失败静默）：实体无效，无泄漏
      return null;
    }
    npc.getPlayer(); // 触发 NpcException 校验（invalid NPC 的 getPlayer 会抛）
    return npc;
  } catch {
    // create 已占槽但 getPlayer 抛错（库行为）：必须销毁，否则 NPC 槽位泄漏——
    // 反复触发会耗尽 MAX_REPLAY_NPC，全服回放/挑战永久创建失败
    if (npc && npc.isValid()) {
      try {
        npc.destroy();
      } catch {
        /* 已销毁/失效 */
      }
    }
    return null;
  }
}

export function getReplaySession(playerId: number): ReplaySession | undefined {
  return sessions.get(playerId);
}

/** 回放调试信息（调试 GUI 用）：当前播放时间/总时长、当前帧速度、帧率 */
export interface ReplayDebugState {
  playTimeMs: number;
  durationMs: number;
  frameIndex: number;
  frameCount: number;
  currentKmh: number;
  /** 当前帧玩家是否在线（掉线重连的静止帧 false） */
  online: boolean;
}

/** 取玩家回放会话的调试状态（无会话返回 null） */
export function getReplayDebugState(playerId: number): ReplayDebugState | null {
  const s = sessions.get(playerId);
  if (!s || s.ghosts.length === 0) return null;
  const g = s.ghosts[0];
  const sampled = sampleAt(s.data, g.playTime);
  return {
    playTimeMs: g.playTime,
    durationMs: replayDurationMs(s.data),
    frameIndex: sampleIndexAt(s.data, g.playTime).index,
    frameCount: s.data.header.frameCount,
    currentKmh: sampled ? Math.hypot(sampled.vx, sampled.vy, sampled.vz) : 0,
    online: sampled ? sampled.online : true,
  };
}

/** 比赛信息 TD 样式（对齐原版 CreatePRaceTextDraw，与比赛房间一致） */
function replayTdBase(player: Player, y: number, text: string): TextDraw {
  return new TextDraw({ player, x: 500, y, text })
    .create()
    .setFont(2)
    .setLetterSize(0.238, 1.19)
    .setAlignment(1)
    .setColor(0xffffffff)
    .setOutline(0)
    .setShadow(1)
    .setProportional(true);
}

/** 毫秒 → mm:ss.cc（对齐原版 ms2time 后 msg[2]/10；公共函数在 utils/format） */

/** 给观战者创建比赛信息 TD（回放事件无关，从帧状态渲染；rank 用录制名次快照） */
function ensureObserverTds(session: ReplaySession, player: Player): void {
  if (session.tds.has(player.id)) return;
  const header = session.data.header;
  const best = header.bestMs >= 0 ? `BEST / ${formatRaceTimeCs(header.bestMs)}` : "BEST / --:--:--";
  // 初始 RANK：v8 文件用帧内实时名次（首帧 syncObserverTds 立即刷入，初始 -- 防
  // DB 快照闪变）；旧 v7 及以下无帧内名次 → 用 DB 名次快照
  const rank =
    header.frameBytes >= FRAME_BYTES_V8
      ? "RANK / --"
      : session.rank != null
        ? `RANK / No.${session.rank}`
        : "RANK / --";
  const tds = {
    cp: replayTdBase(player, 118, `C  P / ~p~1~w~/~y~${header.totalCp || 1}`),
    time: replayTdBase(player, 136, "TIME / 00:00:00"),
    best: replayTdBase(player, 154, best),
    rank: replayTdBase(player, 172, rank),
  };
  Object.values(tds).forEach((t) => t.show(player));
  session.tds.set(player.id, tds);
}

/** 销毁观战者 TD（会话销毁/退出回放），并清其回放 CP 箭头/小地图图标（防残留屏幕） */
function destroyObserverTds(session: ReplaySession, playerId: number): void {
  const tds = session.tds.get(playerId);
  if (!tds) return;
  for (const td of Object.values(tds)) {
    try {
      if (td.isValid()) td.destroy();
    } catch {
      /* 已销毁 */
    }
  }
  session.tds.delete(playerId);
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  try {
    RaceCheckpoint.disable(p); // 回放 3D CP 箭头
  } catch {
    /* 已失效 */
  }
  try {
    p.removeMapIcon(70); // 回放 CP 小地图图标
  } catch {
    /* 已失效 */
  }
}

/** 采样帧解出的可渲染状态（位置/四元数/速度 + 完整离散状态）。
 *  emulate 驱动直接用四元数（写进 DriverSync 包），无需欧拉角换算
 * （旧摆位驱动 setVehicleRot 需要欧拉的 quatToEuler 已随 challenge 换 emulate 一并移除） */
export interface SampledState {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  vehicleModel: number;
  cpProgress: number;
  hour: number;
  minute: number;
  weather: number;
  vehicleHealth: number;
  keys: number;
  lrKey: number;
  udKey: number;
  additionalKey: number;
  landingGearState: boolean;
  sirenState: boolean;
  trailerId: number;
  trainSpeed: number;
  /** 该帧玩家是否在线（掉线重连的静止帧 false） */
  online: boolean;
  /** 该帧玩家的实时名次（v8 帧内；0=未排名/旧文件无此数据） */
  rank: number;
}

/** 播放时长（毫秒）：v7 起用帧时间戳精确（末帧-首帧）；旧文件回退帧数×间隔。
 *  与 sampleAt 的 maxTime / seek 上限统一（renderGhost/tickSession/challenge 复用）。 */
export function replayDurationMs(data: ReplayData): number {
  const { header } = data;
  if (header.frameCount === 0) return 0;
  const last = frameTimeAt(data, header.frameCount - 1);
  return Math.max(0, last);
}

/** 帧绝对时间（毫秒）：v7 帧时间戳（相对录制开始，首帧偏移）；旧文件回退 idx×间隔。
 *  惰性构建全帧时间戳缓存（采样 O(1)，整文件读入时一次性计算；只读缓存共享安全）。 */
export function frameTimeAt(data: ReplayData, index: number): number {
  const { header, frames } = data;
  const fb = header.frameBytes;
  if (fb >= FRAME_BYTES_V7 && data.frameTs) return data.frameTs[index] ?? 0;
  if (fb >= FRAME_BYTES_V7) {
    const count = header.frameCount;
    const ts: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      ts[i] = frames.readUInt32LE(i * fb + 69);
    }
    data.frameTs = ts;
    return ts[index] ?? 0;
  }
  // 旧文件（v6 及以下）：无帧时间戳 → 均匀间隔回退（历史行为）
  return index * Math.max(1, header.frameIntervalMs);
}

/** 帧定位（sampleAt / syncObserverTds 共用）：返回播放时间对应的帧索引与钳制后的时间。
 *  v7 按每帧真实时间戳二分（帧间真实间隔不等——掉线静止帧 100ms / RakNet 驾驶帧
 *  33ms——必须按真实时间定位，否则静止段频率摊平全片、驾驶段回放被放慢）；
 *  旧文件无时间戳（relTimeMs=0）→ 均匀间隔回退（历史行为）。判定用 header 的
 *  自描述 frameBytes（兼容旧文件），不依赖 FORMAT_VERSION */
export function sampleIndexAt(
  data: ReplayData,
  playTime: number,
): { index: number; lastIndex: number; t: number } {
  const { header } = data;
  const interval = Math.max(1, header.frameIntervalMs);
  const lastIndex = header.frameCount - 1;
  const maxTime = lastIndex * interval;
  const fb = header.frameBytes;
  if (fb >= FRAME_BYTES_V7) {
    const lastTime = frameTimeAt(data, lastIndex);
    if (playTime >= lastTime) return { index: lastIndex, lastIndex, t: lastTime };
    let a = 0;
    let b = lastIndex;
    // 二分：找最后一个 time ≤ playTime 的帧（帧时间戳单调不减——每帧记录相对
    // 录制开始的真实时间，采样时点单调）
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (frameTimeAt(data, mid) <= playTime) a = mid;
      else b = mid - 1;
    }
    const t = Math.max(frameTimeAt(data, 0), Math.min(lastTime, playTime));
    return { index: a, lastIndex, t };
  }
  const t = Math.min(maxTime, Math.max(0, playTime));
  return { index: Math.floor(t / interval), lastIndex, t };
}

/**
 * 按播放时间取插值帧：v7 按帧时间戳二分定位（见 sampleIndexAt）；旧文件回退
 * 均匀间隔。帧序保证前后一致性；超范围 clamp。（challenge 复用） */
export function sampleAt(data: ReplayData, playTime: number): SampledState | null {
  const { header, frames } = data;
  if (header.frameCount === 0) return null;
  const interval = Math.max(1, header.frameIntervalMs);
  const lastIdx = header.frameCount - 1;
  const { index: idx, t } = sampleIndexAt(data, playTime);
  const pick = (f: ReplayFrame): SampledState => {
    return {
      x: f.x,
      y: f.y,
      z: f.z,
      qx: f.qx,
      qy: f.qy,
      qz: f.qz,
      qw: f.qw,
      vx: f.vx,
      vy: f.vy,
      vz: f.vz,
      vehicleModel: f.vehicleModel,
      cpProgress: f.cpProgress,
      hour: f.hour,
      minute: f.minute,
      weather: f.weather,
      vehicleHealth: f.vehicleHealth,
      keys: f.keys,
      lrKey: f.lrKey,
      udKey: f.udKey,
      additionalKey: f.additionalKey,
      landingGearState: f.landingGearState,
      sirenState: f.sirenState,
      trailerId: f.trailerId,
      trainSpeed: f.trainSpeed,
      online: f.online,
      rank: f.rank ?? 0,
    };
  };
  if (idx >= lastIdx) {
    const f = decodeFrame(frames, lastIdx, data.header.frameBytes);
    if (!f) return null;
    return pick(f);
  }
  const a = decodeFrame(frames, idx, data.header.frameBytes);
  const b = decodeFrame(frames, idx + 1, data.header.frameBytes);
  if (!a || !b) return null;
  // 插值系数：v7 用帧间真实时间差（时间戳模式），旧文件用均匀间隔
  const span =
    header.frameBytes >= FRAME_BYTES_V7
      ? frameTimeAt(data, idx + 1) - frameTimeAt(data, idx)
      : interval;
  const frac = span > 0 ? (t - frameTimeAt(data, idx)) / span : 0;
  return pick(lerpFrame(a, b, frac));
}

/** 按帧状态重建车辆（cveh 换车等车型变化） */
function ensureGhostVehicle(session: ReplaySession, ghost: Ghost, model: number): void {
  if (model === ghost.model) return;
  const oldModel = ghost.model;
  ghost.model = model;
  try {
    const pos = ghost.vehicle.getPos();
    const oldVehId = ghost.vehicle.id; // 换车前先记录旧车 id（换后观战重挂匹配用）
    // 换车前先摘除观战旧车的所有观察者：destroy 会触发旧车对观察者的 onStreamOut →
    // retracePlayer → suggestStop 弹"对象已无法跟踪"对话框，用户点"是"会撤销后面的
    // 重挂（并把观战者踢出回放世界）。detachObservingVehicle 覆盖全表（含左右键
    // 切入但不在 session.watchers 的观战者），先 stopObserve(quiet) 清观战态、
    // 不触发弹窗；建新车后在同一同步函数内重挂（stopObserve 恢复 prevWorld 与
    // startObserveVehicle 切回回放世界无感知）
    const reattach = detachObservingVehicle(oldVehId);
    // 换车型：销毁旧车、建新车、NPC 立即上车（位置延续）
    unregisterObserveCandidate(ghost.vehicle.id, "vehicle"); // 旧车移出观战切换候选
    ghost.vehicle.destroy();
    const v = new Vehicle({
      modelId: model,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      zAngle: 0,
      color: [-1, -1],
      respawnDelay: 0,
    });
    v.create();
    v.setVirtualWorld(session.worldId);
    v.linkToInterior(0);
    addNitro(v); // 氮气（换车型后新车同样带，对齐录制时玩家爱车）
    v.setHealth(1000);
    ghost.npc.setVirtualWorld(session.worldId);
    ghost.npc.putInVehicle(v, 0);
    ghost.vehicle = v;
    registerObserveCandidate(v.id, "vehicle"); // 新车登记进观战切换候选（否则该 ghost 无法被切到）
    // 重挂到新车（startObserveVehicle 保留 originPlayerId，下车后仍能重跟踪）
    for (const { playerId, originPlayerId } of reattach) {
      const w = Player.getInstance(playerId);
      if (w && w.isConnected()) {
        startObserveVehicle(w, v, originPlayerId);
      }
    }
  } catch (e) {
    logger.warn(`[replay] 换车型失败 ${oldModel} -> ${model}`, e);
    ghost.model = oldModel;
  }
}

/**
 * 构造 DriverSync（InCarSync）包并模拟 NPC 传入 + 发给能看到该车的所有玩家
 * （回放 ghost 与挑战影子共用）。
 * - emulate 进服务器（按真实司机处理车辆状态），再显式 send 给玩家——客户端
 *   本地物理驱动（车速表/氮气真实）。emulate 只进服务器处理、不会自动转发。
 * - 不能用 sendPacketToPlayerStream(players, npcPlayer)：NPC 无客户端实体，
 *   open.mp 的 Player::streamedFor_ 对 NPC 从不置位（源码确认 streamInForPlayer
 *   只在 Actor/Pickup/TextLabel/Vehicle 调用），isStreamedIn(npc) 恒 false →
 *   一个玩家都收不到。用车辆维度 Vehicle.isStreamedIn（服务器按世界+距离维护）。
 * - atEnd（播完/影子到达终点）：速度、按键与警笛/起落架清零——尾帧非零速度
 *   会让车辆在停发后继续滑行/终点抖动，按键清零防原地转向抖动，警笛/起落架
 *   不清会让停在终点的影子一直亮警笛/放起落架。
 */
export function emulateDriverSync(
  npcPlayerId: number,
  vehicle: Vehicle,
  s: SampledState,
  atEnd: boolean,
): void {
  const bs = new IncomingBitStream();
  try {
    const sync = new InCarSync(bs);
    sync.writeSync({
      vehicleId: vehicle.id,
      lrKey: atEnd ? 0 : s.lrKey,
      udKey: atEnd ? 0 : s.udKey,
      keys: atEnd ? 0 : s.keys, // 键位含 FIRE=氮气触发（点按模式），客户端据此喷氮
      quaternion: [s.qw, s.qx, s.qy, s.qz], // InCarSync quaternion 序 = [w,x,y,z]
      position: [s.x, s.y, s.z],
      velocity: atEnd ? [0, 0, 0] : [s.vx, s.vy, s.vz],
      vehicleHealth: s.vehicleHealth,
      playerHealth: 100,
      armour: 0,
      additionalKey: atEnd ? 0 : s.additionalKey,
      weaponId: 0,
      sirenState: atEnd ? false : s.sirenState,
      landingGearState: atEnd ? false : s.landingGearState,
      trailerId: s.trailerId,
      trainSpeed: s.trainSpeed,
    });
    bs.emulateIncomingPacket(npcPlayerId);
    for (const p of Player.getInstances()) {
      if (p.isNpc() || !p.isConnected()) continue;
      if (vehicle.isStreamedIn(p)) {
        bs.sendPacket(p.id);
      }
    }
  } finally {
    bs.delete(); // 释放 BitStream 原生句柄
  }
}

/** 渲染单个 ghost：按播放时间采样 → emulateDriverSync 模拟司机传入 + 广播 */
function renderGhost(session: ReplaySession, ghost: Ghost): void {
  // 已停发（播完）：不再 emulate，车辆静止停在终点
  if (ghost.stopped) return;
  const s = sampleAt(session.data, ghost.playTime);
  if (!s) return;
  // velocity 随倍速缩放：位置按倍速跳变（playTime 走得快），速度字段同步乘
  // 倍速——客户端物理插值/位置推进与速度一致（不缩放会出现"位置快、速度字段
  // 慢"的抽动）。倍速 1 时跳过（恒等）；atEnd 时 emulateDriverSync 会把速度清零，
  // 缩放无影响。车速表侧由 gui.getDisplaySpeed 反向除回倍速显示录制原始速度。
  if (session.speed !== 1) {
    s.vx *= session.speed;
    s.vy *= session.speed;
    s.vz *= session.speed;
  }
  const maxTime = frameTimeAt(session.data, session.data.header.frameCount - 1);
  // 播完判定：playTime 已 clamp 到终点 → 发完这一帧即停止驱动。否则会持续
  // 重发"位置恒定、速度非零"的尾帧——客户端物理每帧按速度跑动又被服务器拉回，
  // 车辆原地抖动/朝向乱转（终点地面起伏或碰撞干扰时更明显）。
  const atEnd = ghost.playTime >= maxTime;
  if (atEnd) ghost.stopped = true;
  // 掉线状态变化（跨过掉线边界帧）：更新车顶标签（红字"掉线"）+ 聊天提示
  //（发起人/观战者）。检测放采样后、节流前——保证边界帧即使被 30Hz 节流跳过
  // 也能触发。每次变化只提示一次（lastOnline 状态翻转才进这里）。
  if (s.online !== ghost.online) {
    ghost.online = s.online;
    try {
      ghost.label.updateText(
        "#ffffff",
        ghostLabelText(
          ghost.npc.getName(),
          session.recorderName,
          ghost.labelNo,
          session.ghosts.length,
          s.online,
        ),
        DEFAULT_CHARSET,
      );
    } catch {
      /* 标签已失效等，忽略 */
    }
    const msg = s.online ? `${session.recorderName} 已重新上线` : `${session.recorderName} 掉线了`;
    const targets = new Set([session.ownerId, ...session.watchers]);
    for (const pid of targets) {
      const w = Player.getInstance(pid);
      if (w && w.isConnected()) {
        sysMsg(w, "replay", msg, "info");
      }
    }
  }
  try {
    ensureGhostVehicle(session, ghost, s.vehicleModel);
    // 30Hz 发包节流（60fps tick 每 2 tick 一次；seek/快进时播放时间跳变，
    // 首帧/跳转帧立即发一次保证位置同步）。atEnd 帧必须强制发——它是
    // 客户端收到的最后一帧（速度/按键已清零），若被节流跳过则停发前最后发
    // 的是带非零速度的旧帧，车辆在终点仍会滑行。
    const now = Date.now();
    if (now - ghost.lastEmulateAt < EMULATE_INTERVAL_MS && !atEnd) return;
    ghost.lastEmulateAt = now;
    // 氮气跟随录制者按键：SA 氮气是**客户端单管容量**（安装 1010 给满一管，喷射
    // 时持续消耗，喷完即消失）。录制时由 vehicleAuto 补充，回放 NPC 车无人补。
    // 关键：组件重装会**打断客户端正在进行的喷射**——原实现每 500ms 补一次组件，
    // 喷射被反复掐断，观感就是"氮气 1 秒就没了"。两路补给、都不打断喷射：
    // 1) KEY_FIRE 上升沿补满：录制者（点按模式）每按下一次 FIRE → 补一管，该段
    //    喷射全程不再动组件、整段连续喷（长按超出一管后速度仍由帧 velocity 承载，
    //    与录制时玩家自身一致——原版玩家的管也是有限的）。
    // 2) 每 15 秒自动补一管兜底：timer 模式录制者自动补、帧里没有按键信号——
    //    不自动补则其录像的 ghost 氮气会断档（"回放里没氮气"）。
    // 兜底只对"帧里从未出现 FIRE 位"的录像生效（timer 录制）：一旦发现 FIRE 位
    // （点按录制，FIRE 上升沿已覆盖补给）就停用兜底——否则 15s 边界撞上正在
    // 喷射的影子会重新打断（复现"氮气 1 秒就没了"）。
    // 播完（atEnd）不再补。
    const nitroOn = (s.keys & KeysEnum.FIRE) !== 0; // KEY_FIRE = 点按氮气触发键
    if (nitroOn && !atEnd && !ghost.nitroWasOn) {
      session.nitroFireSeen = true;
      addNitro(ghost.vehicle);
    }
    ghost.nitroWasOn = nitroOn;
    if (!atEnd && !session.nitroFireSeen && now - ghost.lastAutoNitroAt >= 15_000) {
      ghost.lastAutoNitroAt = now;
      addNitro(ghost.vehicle);
    }
    // 血量由 emulate 的 vehicleHealth 处理，无需显式 setHealth（重复操作）
    emulateDriverSync(ghost.npcPlayerId, ghost.vehicle, s, atEnd);
  } catch (e) {
    // 一次性 warn 防刷屏（30Hz 下持续失败会刷日志）；实体失效由清理兜底
    if (!ghost.warnedEmulateFail) {
      ghost.warnedEmulateFail = true;
      logger.warn(`[replay] ghost emulate/send 失败（仅提示一次）`, e);
    }
  }
}

/** 60fps 播放推进 */
function tickSession(session: ReplaySession): void {
  // 发起人已离开会话世界（换世界/退出观战回 prevWorld）→ 自动停止：
  // ghost 留在无人世界继续播是资源浪费且用户困惑（"我的回放呢"）
  const owner = Player.getInstance(session.ownerId);
  if (owner && owner.isConnected() && owner.getVirtualWorld() !== session.worldId) {
    sysMsg(owner, "replay", "已离开回放世界，回放已停止", "warn");
    stopReplaySession(session.ownerId);
    return;
  }
  if (!session.playing) return;
  // 清扫已退出观战的 watcher：玩家 /tv off 离开回放后若不清理，其比赛 TD 会
  // 残留屏幕上并持续被 syncObserverTds 更新（用户回到原世界还挂着回放 HUD）
  for (const pid of session.watchers) {
    if (!isObserving(pid)) {
      destroyObserverTds(session, pid);
      session.watchers.delete(pid);
    }
  }
  // 用真实流逝时间推进播放（固定 16ms/tick 在定时器节流时偏慢 → 慢倍速感）。
  // clamp 250ms：服务器卡顿/断线恢复等单次大延迟不跳变（最多跳 0.25s 播放）
  const now = Date.now();
  const elapsed = Math.min(250, now - session.lastTickAt);
  session.lastTickAt = now;
  // 开场倒计时：数字/GO 动画由 spawnReplay 开场 playCountdown 负责（TextDraw），
  // 本块只推进 countdownMs 并在倒计时期间发静止锚定帧（车停起始位置，速度/按键
  // 清零，防物理滑走）。countdownMs 归 0 由动画 onGo 触发 → 放行正常播放
  if (session.countdownMs > 0) {
    session.countdownMs -= elapsed;
    // 倒计时期间：车停起始位置（发静止帧，速度/按键清零）。与正常路径一样
    // 30Hz 节流——位置恒定，60Hz 重发同样坐标纯浪费带宽（5 分身翻倍发包）
    for (const g of session.ghosts) {
      if (g.stopped) continue;
      const now = Date.now();
      if (now - g.lastEmulateAt < EMULATE_INTERVAL_MS) continue;
      g.lastEmulateAt = now;
      const s = sampleAt(session.data, g.playTime);
      if (!s) continue;
      try {
        emulateDriverSync(g.npcPlayerId, g.vehicle, s, true);
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  // 暂停：时间不推进，但每 tick 持续发一帧静止帧锚定位置——暂停时若只发
  // 一次，车停在斜坡/不平地形时客户端本地物理无持续校正会缓慢滑走。
  // lastTickAt 已在上面刷新：恢复播放时不会把暂停时长算进推进（否则
  // 播放时间瞬移最多 250ms）。30Hz 节流：位置恒定，60Hz 重发同样坐标浪费
  if (session.paused) {
    for (const g of session.ghosts) {
      if (g.stopped) continue; // 播完停发的车保持静止（不发重复静止帧）
      const now = Date.now();
      if (now - g.lastEmulateAt < EMULATE_INTERVAL_MS) continue;
      g.lastEmulateAt = now;
      const s = sampleAt(session.data, g.playTime);
      if (!s) continue;
      try {
        emulateDriverSync(g.npcPlayerId, g.vehicle, s, true); // atEnd=true → 速度/按键清零
      } catch {
        /* 暂停锚定帧失败忽略：恢复播放后正常发包 */
      }
    }
    return;
  }
  const dt = elapsed * session.speed;
  const lastIdx = session.data.header.frameCount - 1;
  // 播放边界：v7 按真实时间戳（末帧时间）；旧文件回退均匀间隔
  const maxTime = frameTimeAt(session.data, lastIdx);
  for (const g of session.ghosts) {
    // 播放时间推进并 clamp 到 [0, maxTime]（播到结尾停在边界，不循环；seek 可回看）
    g.playTime = Math.min(maxTime, Math.max(0, g.playTime + dt));
  }
  // 播完提示（一次）：播放到达结尾 → 比赛回放提示"比赛结束"（对齐冲线仪式感），
  // 否则提示可 seek 回看
  if (!session.endedNotified && session.ghosts.every((g) => g.playTime >= maxTime)) {
    session.endedNotified = true;
    const targets = new Set([session.ownerId, ...session.watchers]);
    for (const pid of targets) {
      const w = Player.getInstance(pid);
      if (w && w.isConnected()) {
        if (session.replayType === "race") {
          // GameText 不支持中文（AGENTS.md 约定），比赛结束用英文
          new GameText("~r~RACE FINISHED~w~!", 3000, 3).forPlayer(w);
        }
        w.sendClientMessage(
          COLOR_RACE,
          session.replayType === "race"
            ? "比赛回放已播完（/rp seek 可回看）"
            : "回放已播完（/rp seek 可回看）",
        );
      }
    }
  }
  for (const g of session.ghosts) renderGhost(session, g);
  syncObserverTds(session);
}

/** 观战者比赛信息 TD + 时间/天气：从"第一个 ghost 的当前帧状态"渲染（事件无关）。
 * CP 进度在帧里（录制时过 CP 采样写入）→ seek/回退 TD 自动一致。
 * 内容无变化时跳过（省 60Hz 无用调用）。 */
function syncObserverTds(session: ReplaySession): void {
  if (session.tds.size === 0 || session.ghosts.length === 0) return;
  const s = sampleAt(session.data, session.ghosts[0].playTime);
  if (!s) return;
  // TD 时间 = 当前播放时间（v7 帧时间戳模式按真实时间轴，与 sampleAt 一致；
  // 旧文件回退均匀间隔 idx×interval）
  const timeMs = Math.min(
    frameTimeAt(session.data, session.data.header.frameCount - 1),
    session.ghosts[0].playTime,
  );
  const cpText = `C  P / ~p~${s.cpProgress}~w~/~y~${session.data.header.totalCp || 1}`;
  const timeText = `TIME / ${formatRaceTimeCs(timeMs)}`;
  if (cpText !== session.lastCpText || timeText !== session.lastTimeText) {
    session.lastCpText = cpText;
    session.lastTimeText = timeText;
    for (const tds of session.tds.values()) {
      tds.cp.setString(cpText);
      tds.time.setString(timeText);
    }
  }
  // 动态 RANK：v8 文件帧内带实时名次（tickRooms 200ms 排名），按播放进度
  // 刷新——掉线重连录像的名次变化（被超越/恢复）随播放还原；旧 v7 及以下
  // 文件无帧内名次 → 保持 ensureObserverTds 写死的 DB 快照，不刷
  if (session.data.header.frameBytes >= FRAME_BYTES_V8) {
    const rankText = s.rank > 0 ? `RANK / No.${s.rank}` : "RANK / --";
    if (rankText !== session.lastRankText) {
      session.lastRankText = rankText;
      for (const tds of session.tds.values()) {
        tds.rank.setString(rankText);
      }
    }
  }
  // 3D CP 箭头 + 小地图图标（比赛回放，观战者视角）：按当前帧 cpProgress 在
  // 观战者屏幕显示 ghost 当前要过的 CP（对齐局内观战同步）。帧没存 CP 坐标，
  // 用 spawnReplay 加载的赛道 cps；无 cps（ghost 回放/加载失败）跳过。
  // 进度变化才调 native（60fps 下大多 tick 不变）。
  const cps = session.cps;
  if (cps && cps.length >= 2) {
    const prog = Math.max(0, s.cpProgress); // 已完成 CP 数（1-based 触达计数）
    // 当前要过的 CP 索引：已完成 count 个 → 下一个是 count（0-based），圈满回绕
    const total = cps.length;
    const nextIdx = prog % total; // 跨圈回绕（cpProgress 续增，%total 落到圈内）
    if (nextIdx !== session.cpProgressLast) {
      const changed = session.cpProgressLast != null;
      session.cpProgressLast = nextIdx;
      const nxt = cps[nextIdx];
      const nxt2 = cps[(nextIdx + 1) % total];
      // 过 CP 音效（1056 普通）：进度推进（回放中 ghost 过了个 CP）
      if (changed) {
        for (const pid of session.tds.keys()) {
          const p = Player.getInstance(pid);
          if (p && p.isConnected()) p.playSound(1056);
        }
      }
      // 更新观战者的箭头 + 图标（含起点首次显示）
      for (const pid of session.tds.keys()) {
        const p = Player.getInstance(pid);
        if (!p || !p.isConnected()) continue;
        try {
          RaceCheckpoint.set(p, 0, nxt.x, nxt.y, nxt.z, nxt2.x, nxt2.y, nxt2.z, nxt.size);
        } catch {
          /* 已失效 */
        }
        p.setMapIcon(70, nxt2.x, nxt2.y, nxt2.z, 56, 0, 1);
      }
    }
  }
  // 观察者视角时间/天气随帧应用（CP 脚本 time/weather 的效果"状态化"重放；
  // NPC 玩家无 setTime/setWeather，作用于观察者视角）
  if (
    s.hour !== session.lastHour ||
    s.minute !== session.lastMinute ||
    s.weather !== session.lastWeather
  ) {
    session.lastHour = s.hour;
    session.lastMinute = s.minute;
    session.lastWeather = s.weather;
    for (const pid of session.tds.keys()) {
      const p = Player.getInstance(pid);
      if (p && p.isConnected()) {
        p.setTime(s.hour, s.minute);
        p.setWeather(s.weather);
      }
    }
  }
}

/**
 * 创建回放会话并开始播放（发起人自动观战第一个 ghost）。
 * replayId 必须存在且未删除；文件损坏/不存在返回提示。
 */
export async function spawnReplay(
  player: Player,
  replayId: string,
  opts?: { npcCount?: number; staggerMs?: number },
): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  if (sessions.has(player.id)) {
    sysMsg(player, "replay", "你已在播放回放中，先 /rp stop", "error");
    return false;
  }
  if (isInRace(player.id)) {
    sysMsg(player, "replay", "比赛中不能播放回放（世界隔离）", "error");
    return false;
  }
  if (isInChallenge(player.id)) {
    sysMsg(player, "replay", "影子挑战中不能播放回放", "error");
    return false;
  }
  const replay = await prisma.replay.findFirst({
    where: { id: replayId, deletedAt: null },
  });
  if (!replay) {
    sysMsg(player, "replay", "回放不存在或已删除", "error");
    return false;
  }
  let data: ReplayData;
  try {
    data = loadReplayData(replay.fileName); // 只读缓存（多人共享同一文件数据）
  } catch (e) {
    logger.error(`[replay] 回放文件读取失败 ${replay.fileName}`, e);
    sysMsg(player, "replay", "回放文件损坏或不存在", "error");
    return false;
  }

  // 比赛回放：加载赛道 CP 坐标（观战者 3D 箭头/图标渲染用；ghost 回放无赛道跳过）。
  // 回放文件 header 只存了 totalCp 数量、未存坐标，须查 raceCp 表（与挑战同源）
  let raceCps: { x: number; y: number; z: number; size: number }[] | undefined;
  if (replay.type === "race" && replay.raceId) {
    try {
      const rows = await prisma.raceCp.findMany({
        where: { raceId: replay.raceId },
        orderBy: { index: "asc" },
      });
      if (rows.length >= 2) {
        raceCps = rows.map((c) => ({
          x: Number(c.x),
          y: Number(c.y),
          z: Number(c.z),
          size: Number(c.size),
        }));
      }
    } catch (e) {
      // 加载失败：退化为只有 C P 文本 TD，不影响回放本身
      logger.warn(`[replay] 赛道 CP 加载失败（回放无 3D 箭头）${replay.raceId}`, e);
    }
  }

  const count = Math.min(5, Math.max(1, opts?.npcCount ?? 1));
  // NPC 池子边界：创建前检查剩余槽位（回放/挑战共用 100 槽，各世界多人同时
  // 开回放/挑战可能占满）。不足则明确提示剩余数，避免创建到一半才失败
  if (npcSlotsLeft() < count) {
    sysMsg(player, "replay", `NPC 槽位不足（剩余 ${npcSlotsLeft()}），请稍后再试`, "error");
    return false;
  }
  // 按类型分流：ghost（自由录制）→ 当前世界播放（其他玩家看得见、可一起玩，
  // 但控制 strictly per-player——每人只能控制自己发起的会话，各看各的）；
  // race（比赛回放）→ 独立世界 + 发起人自动观战（重现比赛场景）。
  // 同一世界允许多份 ghost 回放（每人各开一份实体，各自时间线互不干扰）。
  const isGhost = replay.type === "ghost";
  const worldId = isGhost ? player.getVirtualWorld() : allocReplayWorld();
  const ghosts: Ghost[] = [];
  // 播放总时长 = 播放终点（末帧时间戳；v7 真实时间轴，旧文件回退均匀间隔）——
  // 与 renderGhost/tickSession 一致
  const duration = replayDurationMs(data);
  // 分身错峰间隔：自定义（opts.staggerMs，毫秒）或自动等分总时长（count 辆均匀铺开）。
  // 用 || 而非 ??：显式传 0 视为"未指定"（0 间隔 = 无错峰，非用户本意）
  const baseGap = opts?.staggerMs || (count > 1 ? duration / count : 0);

  try {
    for (let i = 0; i < count; i++) {
      // 创建中失败自动降级：某分身 NPC 分配失败（槽位被并发抢占）→
      // 若已成功 ≥1 个则用已成功的继续，否则整体失败（防一半资源半拉子）
      // 名字带随机后缀：同毫秒多人创建防重名冲突
      const rand = Math.random().toString(36).slice(2, 6);
      const npc = allocReplayNpc(`RP${Date.now().toString(36)}_${i}_${rand}`.slice(0, 24));
      if (!npc) {
        if (ghosts.length === 0) {
          freeReplayWorld(worldId); // race 回放已分配独立世界：失败即回收（ghost 回放 worldId 是玩家世界，内部守卫不会误回收）
          sysMsg(player, "replay", "NPC 槽位不足，回放创建失败", "error");
          return false;
        }
        logger.warn(
          `[replay] ${player.getName().name} 分身 ${i + 1}/${count} NPC 分配失败，降级为 ${ghosts.length} 台`,
        );
        break;
      }
      // 迭代内 try：创建中途（putInVehicle/label.create/register 等）抛异常时
      // 清理本次已建实体（外层 catch 只覆盖已 push 进 ghosts 的，循环局部变量
      // 不清理会泄漏 NPC 槽位 + 车辆实体）
      try {
        const npcPlayer = npc.getPlayer();
        const vehicle = new Vehicle({
          modelId: data.header.vehicleModelId,
          x: data.header.startX,
          y: data.header.startY,
          z: data.header.startZ,
          zAngle: 0,
          color: [-1, -1],
          respawnDelay: 0,
        });
        vehicle.create();
        vehicle.setVirtualWorld(worldId);
        vehicle.linkToInterior(0);
        addNitro(vehicle); // 氮气（录制时玩家爱车带氮气，回放车一致）
        // 锁门防玩家开走 ghost 车（回放车只可看不可开；NPC 已在车内不受影响）
        vehicle.setParamsEx(true, false, false, true, false, false, false);
        npc.setVirtualWorld(worldId);
        npc.putInVehicle(vehicle, 0);
        npc.setInvulnerable(true);
        // NPC 无 nametag：绑 3D 标签显示"本身身份（NPC 名）+ 扮演谁（录制者 + 分身编号）"。
        // 编号反序：所有 ghost 同速播同一文件，playTime 越大 = 位置越靠后 = 视觉跑最前
        //（头车）；创建顺序 i=0 是 playTime 最小（视觉尾车）。故编号取 total-已建数：
        // 头车（playTime 最大）= ghost 1/N，尾车 = ghost N/N，与视觉顺序一致
        const labelNo = count - ghosts.length;
        const label = new Dynamic3DTextLabel({
          text: ghostLabelText(npc.getName(), replay.recorderName, labelNo, count, true),
          color: "#ffffff",
          x: 0,
          y: 0,
          z: 0.3, // 头顶上方（附着玩家时 x/y/z 为相对偏移）
          drawDistance: 40,
          testLOS: false,
          attachedPlayer: npcPlayer.id, // IDynamic3DTextLabel.attachedPlayer 为 playerId（number）
          worldId,
          charset: DEFAULT_CHARSET, // 支持中文（录制者名可能为中文）
        });
        label.create();
        // 登记 NPC playerId：屏蔽其真实 sync 包（emulate 的包不走 onIncomingPacket，
        // 但 NPC 自身/残留状态可能发真实 sync 会冲突）；同时记录 em
        registerReplayNpc(npcPlayer.id);
        // 登记为观战切换候选：回放/挑战玩家按左/右键可在各 ghost 车之间循环切换
        registerObserveCandidate(vehicle.id, "vehicle");
        ghosts.push({
          npc,
          vehicle,
          label,
          playTime: i * baseGap, // 错峰起始（相对文件起点）
          staggerMs: i * baseGap, // 该分身的错峰偏移（seek 保持错峰用）
          model: data.header.vehicleModelId,
          npcPlayerId: npcPlayer.id,
          lastEmulateAt: 0,
          warnedEmulateFail: false,
          stopped: false,
          nitroWasOn: false,
          lastAutoNitroAt: 0,
          labelNo,
          online: true,
        });
      } catch (e) {
        // 本次迭代部分实体已建：销毁 npc/车辆（label 附 NPC 随 destroy 清理），
        // 注销已登记的 sync 屏蔽/观战候选，再上抛交外层统一处理
        try {
          unregisterReplayNpc(npc.getPlayer().id);
          npc.destroy();
        } catch {
          /* 已失效 */
        }
        throw e;
      }
    }
    // 降级修正：实际创建数 < 请求数（某分身分配失败 break）时，已创建标签的
    // 分母仍写着请求 count，会显示"ghost 3/2"——统一重编号（labelNo 反序 1..N
    // 按实际数量）并 updateText
    if (ghosts.length !== count) {
      for (let k = 0; k < ghosts.length; k++) {
        const g = ghosts[k];
        g.labelNo = ghosts.length - k; // 反序重编号：k=0（尾车）→ N，头车 → 1
        try {
          g.label.updateText(
            "#ffffff",
            ghostLabelText(
              g.npc.getName(),
              replay.recorderName,
              g.labelNo,
              ghosts.length,
              g.online,
            ),
            DEFAULT_CHARSET,
          );
        } catch {
          /* 标签已失效等，忽略 */
        }
      }
    }
  } catch (e) {
    logger.error(`[replay] 创建回放实体失败`, e);
    // 完整清理：注销 NPC sync 屏蔽（防 NPC id 残留，复用后真实 sync 被静默丢弃）、
    // 移出观战候选、销毁实体、回收世界 id（race 回放）
    for (const g of ghosts) {
      try {
        unregisterReplayNpc(g.npcPlayerId);
        unregisterObserveCandidate(g.vehicle.id, "vehicle");
        g.label.destroy();
        g.npc.destroy();
        g.vehicle.destroy();
      } catch {
        /* 忽略 */
      }
    }
    freeReplayWorld(worldId);
    sysMsg(player, "replay", "NPC 槽位不足或创建失败", "error");
    return false;
  }

  // 跨 await（DB 查回放/查赛道 CP/加载文件）期间玩家可能已断线：不校验就建
  // 会话会注册孤儿 ghost（NPC/车辆/世界 id/60fps 定时器永久占用——tickSession
  // 的"发起人离开回放世界自动停止"要求 owner.isConnected，断线后恒不触发；
  // cleanupReplay 已在断线时跑过，不会二次清理）
  if (!Player.getInstance(player.id)?.isConnected()) {
    for (const g of ghosts) {
      try {
        unregisterReplayNpc(g.npcPlayerId);
        unregisterObserveCandidate(g.vehicle.id, "vehicle");
        g.label.destroy();
        g.npc.destroy();
        g.vehicle.destroy();
      } catch {
        /* 忽略 */
      }
    }
    freeReplayWorld(worldId);
    return false;
  }

  const session: ReplaySession = {
    id: replay.id,
    ownerId: player.id,
    worldId,
    ownerPrevWorld: player.getVirtualWorld(),
    replayType: isGhost ? "ghost" : "race",
    rank: replay.rank ?? null,
    data,
    ghosts,
    recorderName: replay.recorderName,
    playing: true,
    paused: false,
    speed: 1,
    countdownMs: isGhost ? 0 : 3000, // 开场 3-2-1-GO 只对比赛回放模拟（倒计时期间车停起始帧）；自由录制直接播
    lastTickAt: Date.now(),
    endedNotified: false,
    tds: new Map(),
    watchers: new Set(),
    lastCpText: "",
    lastTimeText: "",
    lastRankText: "", // 首帧 syncObserverTds 即写入实时名次（v8 文件）
    nitroFireSeen: false,
    lastHour: -1,
    cps: raceCps, // 赛道 CP 坐标（ghost 回放 undefined）
    lastMinute: -1,
    lastWeather: -128,
  };
  sessions.set(player.id, session);
  session.timer = setIntervalSafe(() => tickSession(session), TICK_MS);
  for (const g of session.ghosts) renderGhost(session, g);
  // 按该玩家当前偏好应用 ghost 标签显隐（默认显示；隐藏偏好是临时设置不落库）
  applyLabelVisibilityForPlayer(session, player.id);

  if (isGhost) {
    // 自由录制回放：ghost 放当前世界（不切世界、不观战），同世界玩家看得见
    // 可一起玩；控制只对自己会话生效（各看各的）；/rp watch 进入自己的观战视角
    player.sendClientMessage(
      COLOR_SUCCESS,
      `回放已开始：${ghosts.length} 台车在世界上重播 · /rp 控制（暂停/快进/倍速/seek）· /rp watch 观战`,
    );
    return true;
  }
  // 比赛回放：独立世界 + 发起人自动观战（复用观战系统：切世界/spectateVehicle/退出恢复）。
  // 必须先 startObserveVehicle 再手动切世界：它内部捕获 prevWorld = 当时的虚拟世界，
  // 若先切到回放世界，prevWorld 会被记成回放世界自身——/tv off 或观战中死亡恢复时
  // 玩家被扔回回放世界，且 tickSession 的"离开回放世界自动停止"判定永不触发
  //（owner 世界恒等于回放世界），回放一直播、玩家被困。
  try {
    startObserveVehicle(player, ghosts[0].vehicle); // 内部会切到 ghost 车世界（worldId）
    session.watchers.add(player.id);
    // 观战者比赛信息 TD（事件无关，从帧状态渲染）——NPC 回放的 TextDraw 状态可见
    ensureObserverTds(session, player);
    syncObserverTds(session);
  } catch {
    /* 观战失败不影响播放 */
  }
  player.setVirtualWorld(worldId); // 幂等（startObserveVehicle 已切）
  player.setPos(data.header.startX, data.header.startY, data.header.startZ + 1);
  // 开场倒计时动画（TextDraw 掉落弹跳+放大淡出，替代 GameText）：数字 3-2-1 期间
  // countdownMs>0 车停起始帧（tickSession 锚定），GO 显示瞬间放行正常播放。
  // 数字 1056 / GO 1057 音效由组件播放（对齐比赛倒计时）
  if (session.countdownMs > 0) {
    const targets = [...session.watchers]
      .map((pid) => Player.getInstance(pid))
      .filter((p): p is Player => !!p && p.isConnected());
    playCountdown(targets, {
      numbers: [3, 2, 1],
      onGo: () => {
        session.countdownMs = 0;
      },
    });
  }
  player.sendClientMessage(
    COLOR_SUCCESS,
    `回放已开始：${ghosts.length} 台车 · /rp 控制（暂停/快进/倍速/seek）`,
  );
  return true;
}

/** 会话级控制（各看各的：只作用于自己发起的会话）。想控制别人的 ghost → 自己开一份。 */
export function controlReplay(player: Player, action: string, arg?: string): void {
  const session = sessions.get(player.id);
  if (!session) {
    sysMsg(player, "replay", "你不在播放回放中，用 /rp play 开始", "error");
    return;
  }
  switch (action) {
    case "pause": {
      session.paused = true;
      // 立即发一帧静止帧（即时反馈，不等下一个 tick）；暂停期间 tickSession
      // 会持续发静止帧锚定位置（防斜坡/物理干扰滑走），恢复播放后正常推进
      for (const g of session.ghosts) {
        const s = sampleAt(session.data, g.playTime);
        if (!s) continue;
        try {
          ensureGhostVehicle(session, g, s.vehicleModel); // 暂停点模型对齐（cveh 换车帧）
          emulateDriverSync(g.npcPlayerId, g.vehicle, s, true); // atEnd=true → 速度/按键清零
        } catch {
          /* 暂停帧失败不影响：恢复播放后下一帧会重发 */
        }
      }
      sysMsg(player, "replay", "回放已暂停", "warn");
      break;
    }
    case "play": {
      // 只支持正放：播放/继续都是同一件事（解除暂停继续推进）
      session.paused = false;
      // 全部 ghost 已播完（停发）→ 按 play 不会动，明确提示回看而非无响应
      if (session.ghosts.every((g) => g.stopped)) {
        sysMsg(player, "replay", "回放已播完（/rp seek 可回看）", "warn");
        break;
      }
      sysMsg(player, "replay", `回放继续 ×${session.speed}`, "warn");
      break;
    }
    case "speed": {
      if (!arg) {
        // 不填参数：只显示当前倍速（对齐命令帮助的提示逻辑）
        sysMsg(player, "replay", `当前倍速 ×${session.speed}`, "warn");
        break;
      }
      const n = Number(arg);
      if (REPLAY_SPEEDS.includes(n)) {
        session.speed = n;
        sysMsg(player, "replay", `倍速 ×${session.speed}`, "warn");
      } else {
        session.speed = 1;
        player.sendClientMessage(
          COLOR_ERROR,
          `无效倍速，已回退 ×1（可选：${REPLAY_SPEEDS.join(" / ")}）`,
        );
      }
      break;
    }
    case "seek": {
      if (!arg) {
        sysMsg(player, "replay", "用法: /rp seek <秒|mm:ss>", "error");
        return;
      }
      const ms = parseTimeArg(arg);
      if (ms == null) {
        sysMsg(player, "replay", "时间格式无效（秒或 mm:ss）", "error");
        return;
      }
      // seek 上限 = 播放终点（v7 末帧时间戳 / 旧文件均匀间隔——与
      // renderGhost/tickSession 的 maxTime 一致；旧 frameCount×interval 多一格，
      // seek 到尾端会直接触发 atEnd 停发 + "已播完"提示重置失效）
      const max = frameTimeAt(session.data, session.data.header.frameCount - 1);
      const target = Math.min(max, Math.max(0, ms));
      for (const g of session.ghosts) {
        // 保持分身的错峰偏移：各分身落在 target + 自身偏移（clamp 到文件末尾），
        // 否则 seek 后全部分身重合在同一时刻，错峰演示被破坏
        g.playTime = Math.min(max, target + g.staggerMs);
        // seek 后强制立即发包：重置节流时间戳，否则距上次发包 <33ms 时
        // renderGhost 会被节流跳过，ghost 位置延迟最多 1 tick
        g.lastEmulateAt = 0;
        // 恢复驱动：seek 回看重新开始发包（seek 到结尾会发一次尾帧后由
        // renderGhost 重新标记停发）
        g.stopped = false;
      }
      // seek 离开结尾 → 重置"已播完"提示标记（再次正放播完会重新提示）
      if (target < max) session.endedNotified = false;
      // seek 跳过开场倒计时（用户主动定位到某时刻，不再 3-2-1 等待）
      session.countdownMs = 0;
      cancelCountdownFx(player.id); // 取消进行中的开场倒计时动画（TD 一并销毁）
      for (const g of session.ghosts) renderGhost(session, g);
      syncObserverTds(session); // seek 后 TD 状态与时间线一致
      sysMsg(player, "replay", `已跳转到 ${(target / 1000).toFixed(1)}s`, "warn");
      break;
    }
    case "watch": {
      // 观看自己的回放（观战 ghost 车；比赛回放额外挂比赛信息 TD）
      if (!isObserving(player.id)) {
        startObserveVehicle(player, session.ghosts[0].vehicle);
        session.watchers.add(player.id); // 会话停止时统一退出观战
        if (session.replayType === "race") {
          ensureObserverTds(session, player);
          syncObserverTds(session);
        }
        sysMsg(player, "replay", "已切换为观看回放视角", "warn");
      }
      break;
    }
    case "stop": {
      stopReplaySession(player.id);
      sysMsg(player, "replay", "回放已停止", "success");
      break;
    }
    default:
      player.sendClientMessage(COLOR_ERROR, "未知回放指令: " + action);
  }
}

function parseTimeArg(arg: string): number | null {
  const m = arg.match(/^(\d{1,3}):(\d{1,2})$/);
  if (m) {
    const min = Number(m[1]);
    const sec = Number(m[2]);
    if (sec >= 60) return null;
    return (min * 60 + sec) * 1000;
  }
  const n = Number(arg);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : null;
}

/** 停止并销毁回放会话（ghost NPC/车辆 + 观察者退出观战 + TD 清理） */
export function stopReplaySession(playerId: number): void {
  const session = sessions.get(playerId);
  if (!session) return;
  sessions.delete(playerId);
  if (session.timer) clearIntervalSafe(session.timer);
  // 先统一退出观战（发起人 + 非发起人 watch 者），再销毁车：destroy 车辆会触发
  // onStreamOut，若观战态还在会弹 suggestStop"是否停止观战"对话框——点"否"会把
  // 过期观战状态写回（observeStates 保留指向已销毁 ghost），玩家卡在观战态。
  for (const pid of session.watchers) {
    const w = Player.getInstance(pid);
    if (w && w.isConnected() && isObserving(pid)) {
      try {
        stopObserve(w);
      } catch {
        /* 观战状态已失效 */
      }
    }
  }
  session.watchers.clear();
  for (const g of session.ghosts) {
    try {
      unregisterReplayNpc(g.npcPlayerId); // 注销屏蔽（NPC 销毁后不再有 sync 包）
      unregisterObserveCandidate(g.vehicle.id, "vehicle"); // 移出观战切换候选
      g.label.destroy();
      g.npc.destroy();
      g.vehicle.destroy();
    } catch {
      /* 已销毁/失效 */
    }
  }
  // 快照 TD 持有者：恢复时间/天气需要遍历（销毁 TD 会清空 session.tds，须先存）
  const tdsHolders = [...session.tds.keys()];
  for (const pid of tdsHolders) {
    destroyObserverTds(session, pid);
  }
  // 独立世界（比赛回放）的会话：会话销毁后世界无人使用 → 回收世界 id 供复用
  if (session.replayType === "race") freeReplayWorld(session.worldId);
  // 取消进行中的开场倒计时动画（owner + watchers 的 TD/句柄一并清）
  for (const pid of [session.ownerId, ...session.watchers]) {
    cancelCountdownFx(pid);
  }
  // 恢复观察者视角时间/天气：syncObserverTds 随帧给 TD 持有者 setTime/setWeather，
  // 停止后不恢复会停留在最后一帧的值，直到下次重生/登录才被 worldenv 重刷。
  // 按玩家设置重放世界时间/天气（applyWorldEnv 读个性化设置，异步无感）
  for (const pid of tdsHolders) {
    const p = Player.getInstance(pid);
    if (p && p.isConnected()) {
      void applyWorldEnv(p).catch(() => {
        /* 恢复失败：下次 spawn/登录 worldenv 兜底 */
      });
    }
  }
  // 比赛回放（独立世界）：玩家可能在其中刷过车 → 恢复玩家世界 + 爱车世界，
  // 防爱车留在独立世界成幽灵车（worldId 已被回收，下次复用会串进别的回放）。
  // 无条件检查爱车所在世界 == 回放世界（不依赖 owner 是否仍在该世界——owner
  // 可能已提前离开/切走，但爱车仍留在即将回收的独立世界）
  const owner = Player.getInstance(playerId);
  if (owner && owner.isConnected() && session.replayType === "race") {
    if (owner.getVirtualWorld() === session.worldId) {
      owner.setVirtualWorld(session.ownerPrevWorld);
    }
    const owned = getOwnedVehicle(playerId);
    if (owned && owned.isValid() && owned.getVirtualWorld() === session.worldId) {
      owned.setVirtualWorld(session.ownerPrevWorld);
    }
  }
}

/** 玩家断线清理（发起的会话销毁） */
export function cleanupPlayback(playerId: number): void {
  stopReplaySession(playerId);
  hiddenReplayLabels.delete(playerId); // 临时偏好随断线重置（默认显示）
}

/** 服务器退出：销毁全部回放会话 */
export function destroyAllPlaybacks(): void {
  for (const id of [...sessions.keys()]) {
    stopReplaySession(id);
  }
}
