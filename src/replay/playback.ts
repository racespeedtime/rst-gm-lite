import {
  Dynamic3DTextLabel,
  GameText,
  KeysEnum,
  Npc,
  Player,
  TextDraw,
  Vehicle,
} from "@infernus/core";
import { InCarSync, IncomingBitStream } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isInRace } from "@/race/room";
import { isInChallenge } from "./challenge";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import {
  startObserveVehicle,
  stopObserve,
  isObserving,
  registerObserveCandidate,
  unregisterObserveCandidate,
} from "@/core/observe";
import {
  parseReplayFile,
  decodeFrame,
  lerpFrame,
  type ReplayData,
  type ReplayFrame,
} from "./format";
import { join } from "node:path";
import { RECORDING_DIR } from "./storage";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_RACE, COLOR_ERROR, COLOR_SUCCESS, COLOR_ORANGE } from "@/utils/colors";

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

/** 回放世界起始 id（避开公共大世界 0、战局 1..n、比赛 5000+；挑战共用） */
const REPLAY_WORLD_BASE = 6000;
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
  /** 上次补氮气时刻（SA 氮气有容量，按录制者按键补，500ms 节流防高频 addComponent） */
  lastNitroAt: number;
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
  /** 开场倒计时剩余毫秒（>0 = 车停起始帧，3-2-1-GO 模拟比赛开场；0 = 已发车） */
  countdownMs: number;
  /** 上次显示的数字（防重复发 GameText） */
  lastCountdownDisplay: number;
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
  /** 观察者视角时间/天气（随帧状态应用；变化检测防每帧调用） */
  lastHour: number;
  lastMinute: number;
  lastWeather: number;
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
 * NPC 池子边界（回放/挑战共用，对齐 config.json max_bots=100）：
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
  try {
    const npc = new Npc(name).create();
    if (!npc.isValid()) return null;
    npc.getPlayer(); // 触发 NpcException 校验（invalid NPC 的 getPlayer 会抛）
    return npc;
  } catch {
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
  const interval = Math.max(1, s.data.header.frameIntervalMs);
  return {
    playTimeMs: g.playTime,
    durationMs: s.data.header.frameCount * interval,
    frameIndex: Math.floor(g.playTime / interval),
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

/** 毫秒 → mm:ss.cc（对齐原版 ms2time 后 msg[2]/10） */
function fmtRaceTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(cs).padStart(2, "0")}`;
}

/** 给观战者创建比赛信息 TD（回放事件无关，从帧状态渲染；rank 用录制名次快照） */
function ensureObserverTds(session: ReplaySession, player: Player): void {
  if (session.tds.has(player.id)) return;
  const header = session.data.header;
  const best = header.bestMs >= 0 ? `BEST / ${fmtRaceTime(header.bestMs)}` : "BEST / --:--:--";
  const rank = session.rank != null ? `RANK / No.${session.rank}` : "RANK / --";
  const tds = {
    cp: replayTdBase(player, 118, `C  P / ~p~1~w~/~y~${header.totalCp || 1}`),
    time: replayTdBase(player, 136, "TIME / 00:00:00"),
    best: replayTdBase(player, 154, best),
    rank: replayTdBase(player, 172, rank),
  };
  Object.values(tds).forEach((t) => t.show(player));
  session.tds.set(player.id, tds);
}

/** 销毁观战者 TD（会话销毁/退出回放） */
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
}

/** 按播放时间取插值帧（帧序保证前后一致性；超出范围 clamp 到边界帧）。（challenge 复用） */
export function sampleAt(data: ReplayData, playTime: number): SampledState | null {
  const { header, frames } = data;
  if (header.frameCount === 0) return null;
  const interval = Math.max(1, header.frameIntervalMs);
  // 帧坐标 = 时间 / 间隔（最后一帧边界）
  const lastIdx = header.frameCount - 1;
  const maxTime = lastIdx * interval;
  const t = Math.min(maxTime, Math.max(0, playTime));
  const idx = Math.floor(t / interval);
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
  const frac = (t - idx * interval) / interval;
  return pick(lerpFrame(a, b, frac));
}

/** 按帧状态重建车辆（cveh 换车等车型变化） */
function ensureGhostVehicle(session: ReplaySession, ghost: Ghost, model: number): void {
  if (model === ghost.model) return;
  const oldModel = ghost.model;
  ghost.model = model;
  try {
    const pos = ghost.vehicle.getPos();
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
    v.addComponent(1010); // 氮气（换车型后新车同样带，对齐录制时玩家爱车）
    v.setHealth(1000);
    ghost.npc.setVirtualWorld(session.worldId);
    ghost.npc.putInVehicle(v, 0);
    ghost.vehicle = v;
    registerObserveCandidate(v.id, "vehicle"); // 新车登记进观战切换候选（否则该 ghost 无法被切到）
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
 * - atEnd（播完/影子到达终点）：速度与按键（keys/lrKey/udKey/additionalKey）
 *   清零——尾帧非零速度会让车辆在停发后继续滑行/终点抖动，按键清零防原地
 *   转向抖动。
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
      keys: atEnd ? 0 : s.keys, // SPRINT=氮气，客户端据此在对应时刻喷氮
      quaternion: [s.qw, s.qx, s.qy, s.qz], // InCarSync quaternion 序 = [w,x,y,z]
      position: [s.x, s.y, s.z],
      velocity: atEnd ? [0, 0, 0] : [s.vx, s.vy, s.vz],
      vehicleHealth: s.vehicleHealth,
      playerHealth: 100,
      armour: 0,
      additionalKey: atEnd ? 0 : s.additionalKey,
      weaponId: 0,
      sirenState: s.sirenState,
      landingGearState: s.landingGearState,
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
  const maxTime =
    (session.data.header.frameCount - 1) * Math.max(1, session.data.header.frameIntervalMs);
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
        w.sendClientMessage(COLOR_RACE, `[回放] ${msg}`);
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
    // 氮气跟随录制者按键：SA 氮气有容量、喷完即消失，录制时由 vehicleAuto
    // 定时补充，回放 NPC 车无人补——检测到 keys.SPRINT 置位就给车补一个氮气
    // 组件（500ms 节流防高频 addComponent），保证该喷的时刻有氮气可喷
    // （否则氮气耗尽后 keys 仍按住却不喷，表现断断续续像点按；播完不再补）。
    if (s.keys & KeysEnum.SPRINT && !atEnd && now - ghost.lastNitroAt >= 500) {
      ghost.lastNitroAt = now;
      ghost.vehicle.addComponent(1010);
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
    owner.sendClientMessage(COLOR_ORANGE, "已离开回放世界，回放已停止");
    stopReplaySession(session.ownerId);
    return;
  }
  if (!session.playing) return;
  // 用真实流逝时间推进播放（固定 16ms/tick 在定时器节流时偏慢 → 慢倍速感）。
  // clamp 250ms：服务器卡顿/断线恢复等单次大延迟不跳变（最多跳 0.25s 播放）
  const now = Date.now();
  const elapsed = Math.min(250, now - session.lastTickAt);
  session.lastTickAt = now;
  // 开场倒计时：模拟比赛 3-2-1-GO（录像从发车帧开始，倒计时是回放系统生成）。
  // 倒计时期间车停在起始位置（发静止帧锚定），数字/GO 给所有观战者。
  if (session.countdownMs > 0) {
    session.countdownMs -= elapsed;
    const display = Math.max(0, Math.ceil(session.countdownMs / 1000));
    if (display !== session.lastCountdownDisplay) {
      session.lastCountdownDisplay = display;
      const msg =
        display > 0
          ? new GameText(`~y~${display}`, 850, 3)
          : new GameText("~g~GO~r~!~n~~g~GO~r~!", 2000, 3);
      const sound = display > 0 ? 1056 : 1057; // 对齐比赛倒计时音效
      // 显示对象：发起人 + 观战者（ghost 回放发起人未观战时也显示）
      const targets = new Set([session.ownerId, ...session.watchers]);
      for (const pid of targets) {
        const w = Player.getInstance(pid);
        if (w && w.isConnected()) {
          msg.forPlayer(w);
          w.playSound(sound);
        }
      }
    }
    // 倒计时期间：车停起始位置（发静止帧，速度/按键清零）
    for (const g of session.ghosts) {
      if (g.stopped) continue;
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
  // 播放时间瞬移最多 250ms）
  if (session.paused) {
    for (const g of session.ghosts) {
      if (g.stopped) continue; // 播完停发的车保持静止（不发重复静止帧）
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
  const maxTime = lastIdx * session.data.header.frameIntervalMs;
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
  const idx = Math.floor(
    session.ghosts[0].playTime / Math.max(1, session.data.header.frameIntervalMs),
  );
  const timeMs = idx * session.data.header.frameIntervalMs;
  const cpText = `C  P / ~p~${s.cpProgress}~w~/~y~${session.data.header.totalCp || 1}`;
  const timeText = `TIME / ${fmtRaceTime(timeMs)}`;
  if (cpText !== session.lastCpText || timeText !== session.lastTimeText) {
    session.lastCpText = cpText;
    session.lastTimeText = timeText;
    for (const tds of session.tds.values()) {
      tds.cp.setString(cpText);
      tds.time.setString(timeText);
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
    player.sendClientMessage(COLOR_ERROR, "你已在播放回放中，先 /rp stop");
    return false;
  }
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "比赛中不能播放回放（世界隔离）");
    return false;
  }
  if (isInChallenge(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "影子挑战中不能播放回放");
    return false;
  }
  const replay = await prisma.replay.findFirst({
    where: { id: replayId, deletedAt: null },
  });
  if (!replay) {
    player.sendClientMessage(COLOR_ERROR, "回放不存在或已删除");
    return false;
  }
  let data: ReplayData;
  try {
    data = loadReplayData(replay.fileName); // 只读缓存（多人共享同一文件数据）
  } catch (e) {
    logger.error(`[replay] 回放文件读取失败 ${replay.fileName}`, e);
    player.sendClientMessage(COLOR_ERROR, "回放文件损坏或不存在");
    return false;
  }

  const count = Math.min(5, Math.max(1, opts?.npcCount ?? 1));
  // NPC 池子边界：创建前检查剩余槽位（回放/挑战共用 100 槽，各世界多人同时
  // 开回放/挑战可能占满）。不足则明确提示剩余数，避免创建到一半才失败
  if (npcSlotsLeft() < count) {
    player.sendClientMessage(COLOR_ERROR, `NPC 槽位不足（剩余 ${npcSlotsLeft()}），请稍后再试`);
    return false;
  }
  // 按类型分流：ghost（自由录制）→ 当前世界播放（其他玩家看得见、可一起玩，
  // 但控制 strictly per-player——每人只能控制自己发起的会话，各看各的）；
  // race（比赛回放）→ 独立世界 + 发起人自动观战（重现比赛场景）。
  // 同一世界允许多份 ghost 回放（每人各开一份实体，各自时间线互不干扰）。
  const isGhost = replay.type === "ghost";
  const worldId = isGhost ? player.getVirtualWorld() : allocReplayWorld();
  const ghosts: Ghost[] = [];
  // 播放总时长 = 播放终点 (frameCount-1)×interval（与 renderGhost/tickSession 一致）
  const duration = (data.header.frameCount - 1) * data.header.frameIntervalMs;
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
          player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足，回放创建失败");
          return false;
        }
        logger.warn(
          `[replay] ${player.getName().name} 分身 ${i + 1}/${count} NPC 分配失败，降级为 ${ghosts.length} 台`,
        );
        break;
      }
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
      vehicle.addComponent(1010); // 氮气（录制时玩家爱车带氮气，回放车一致）
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
        lastNitroAt: 0,
        labelNo,
        online: true,
      });
    }
    // 降级修正：实际创建数 < 请求数（某分身分配失败 break）时，已创建标签的
    // 分母仍写着请求 count，会显示"ghost 3/4 但只有 2 台"——统一改成实际数量
    if (ghosts.length !== count) {
      for (let k = 0; k < ghosts.length; k++) {
        const g = ghosts[k];
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
    player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足或创建失败");
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
    countdownMs: 3000, // 开场 3-2-1-GO（模拟比赛；倒计时期间车停起始帧）
    lastCountdownDisplay: 4,
    lastTickAt: Date.now(),
    endedNotified: false,
    tds: new Map(),
    watchers: new Set(),
    lastCpText: "",
    lastTimeText: "",
    lastHour: -1,
    lastMinute: -1,
    lastWeather: -128,
  };
  sessions.set(player.id, session);
  session.timer = setIntervalSafe(() => tickSession(session), TICK_MS);
  for (const g of session.ghosts) renderGhost(session, g);

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
    player.sendClientMessage(COLOR_ERROR, "你不在播放回放中，用 /rp play 开始");
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
      player.sendClientMessage(COLOR_RACE, "回放已暂停");
      break;
    }
    case "play": {
      // 只支持正放：播放/继续都是同一件事（解除暂停继续推进）
      session.paused = false;
      // 全部 ghost 已播完（停发）→ 按 play 不会动，明确提示回看而非无响应
      if (session.ghosts.every((g) => g.stopped)) {
        player.sendClientMessage(COLOR_RACE, "回放已播完（/rp seek 可回看）");
        break;
      }
      player.sendClientMessage(COLOR_RACE, `回放继续 ×${session.speed}`);
      break;
    }
    case "speed": {
      if (!arg) {
        // 不填参数：只显示当前倍速（对齐命令帮助的提示逻辑）
        player.sendClientMessage(COLOR_RACE, `当前倍速 ×${session.speed}`);
        break;
      }
      const n = Number(arg);
      if (REPLAY_SPEEDS.includes(n)) {
        session.speed = n;
        player.sendClientMessage(COLOR_RACE, `倍速 ×${session.speed}`);
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
        player.sendClientMessage(COLOR_ERROR, "用法: /rp seek <秒|mm:ss>");
        return;
      }
      const ms = parseTimeArg(arg);
      if (ms == null) {
        player.sendClientMessage(COLOR_ERROR, "时间格式无效（秒或 mm:ss）");
        return;
      }
      // seek 上限 = 播放终点 (frameCount-1)×interval（与 renderGhost/tickSession
      // 的 maxTime 一致；旧 frameCount×interval 多一格，seek 到尾端会直接触发
      // atEnd 停发 + "已播完"提示重置失效）
      const max = (session.data.header.frameCount - 1) * session.data.header.frameIntervalMs;
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
      session.lastCountdownDisplay = 4;
      for (const g of session.ghosts) renderGhost(session, g);
      syncObserverTds(session); // seek 后 TD 状态与时间线一致
      player.sendClientMessage(COLOR_RACE, `已跳转到 ${(target / 1000).toFixed(1)}s`);
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
        player.sendClientMessage(COLOR_ORANGE, "已切换为观看回放视角");
      }
      break;
    }
    case "stop": {
      stopReplaySession(player.id);
      player.sendClientMessage(COLOR_SUCCESS, "回放已停止");
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
  for (const pid of [...session.tds.keys()]) {
    destroyObserverTds(session, pid);
  }
  // 独立世界（比赛回放）的会话：会话销毁后世界无人使用 → 回收世界 id 供复用
  if (session.replayType === "race") freeReplayWorld(session.worldId);
  // 比赛回放（独立世界）：玩家可能在其中刷过车 → 恢复玩家世界 + 爱车世界，
  // 防爱车留在独立世界成幽灵车（仅当玩家仍在回放世界；已离开则不覆盖其状态）
  const owner = Player.getInstance(playerId);
  if (
    owner &&
    owner.isConnected() &&
    session.replayType === "race" &&
    owner.getVirtualWorld() === session.worldId
  ) {
    owner.setVirtualWorld(session.ownerPrevWorld);
    const owned = getOwnedVehicle(playerId);
    if (owned && owned.isValid() && owned !== owner.getVehicle()) {
      owned.setVirtualWorld(session.ownerPrevWorld);
    }
  }
}

/** 玩家断线清理（发起的会话销毁） */
export function cleanupPlayback(playerId: number): void {
  stopReplaySession(playerId);
}

/** 服务器退出：销毁全部回放会话 */
export function destroyAllPlaybacks(): void {
  for (const id of [...sessions.keys()]) {
    stopReplaySession(id);
  }
}
