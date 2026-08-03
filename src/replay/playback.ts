import { Dynamic3DTextLabel, Npc, Player, TextDraw, Vehicle } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { isInRace } from "@/race/room";
import { isInChallenge } from "./challenge";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { startObserveVehicle, stopObserve, isObserving } from "@/core/observe";
import { parseReplayFile, decodeFrame, lerpFrame, type ReplayData, type ReplayFrame } from "./format";
import { join } from "node:path";
import { RECORDING_DIR } from "./storage";
import { DEFAULT_CHARSET } from "@/utils/constants";
import { COLOR_RACE, COLOR_ERROR, COLOR_SUCCESS, COLOR_ORANGE } from "@/utils/colors";

/**
 * 回放会话（NPC 逐帧驱动，非原生 .rec）：
 * - 回放文件整读入内存（Buffer 帧切片，O(1) seek）
 * - 60fps tick：按播放时间（方向×倍速推进）→ 相邻帧插值 → npc.setVehiclePos/
 *   setVehicleRot/setVelocity 驱动 NPC 车辆
 * - 帧带"完整状态"：车型变化（cveh 换车）→ 重建车辆；时间/天气/血量随帧应用。
 *   CP 脚本是离散事件，NPC 不触发 onPlayerReachCp——seek/回退时"恢复状态而非
 *   重放事件"，天然无事件顺序问题。观战者的比赛 TD（C P/TIME/BEST）也从帧状态
 *   渲染（事件无关），NPC 的 TextDraw 状态观战者完整可见。
 * - 控制：播放/暂停/快进/后退/倍速/seek（时间线变动，前后一致性由帧序插值保证）
 * - 多分身：同一数据错峰起始（每 ghost 独立 playTime，控制同步作用于全部）
 * - 观看：发起人自动 startObserveVehicle(ghost 车)（复用观战系统）
 * - 清理：/rp stop / 发起人断线 / onExit 全路径销毁
 */

/** 回放世界起始 id（避开公共大世界 0、战局 1..n、比赛 5000+；挑战共用） */
const REPLAY_WORLD_BASE = 6000;
let nextReplayWorldId = REPLAY_WORLD_BASE;

/** 分配回放/挑战独立世界 id */
export function allocReplayWorld(): number {
  return nextReplayWorldId++;
}

/** 播放推进帧间隔（60fps） */
const TICK_MS = 16;

interface Ghost {
  npc: Npc;
  vehicle: Vehicle;
  /** 身份 3D 标签（NPC 无 nametag，用 Dynamic3DTextLabel 显示"本身身份 + 扮演谁"） */
  label: Dynamic3DTextLabel;
  /** 该分身的播放时间（毫秒，从文件起点；错峰起始） */
  playTime: number;
  staggerMs: number;
  /** 当前车辆模型（帧车型变化时重建） */
  model: number;
  /** 上次应用的车辆血量（变化检测，防每帧 setHealth） */
  lastHealth: number;
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
  direction: 1 | -1;
  speed: number; // 倍速 0.5~4
  timer?: NodeJS.Timeout;
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

/** SA 车辆四元数 → 欧拉角（度）。与 getRotationQuat/setVehicleRot 同引擎约定。（challenge 复用） */
export function quatToEuler(q: { x: number; y: number; z: number; w: number }): { rx: number; ry: number; rz: number } {
  const { x, y, z, w } = q;
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  const sinp = Math.min(1, Math.max(-1, 2 * (w * y - z * x)));
  const pitch = Math.asin(sinp);
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  return {
    rx: (roll * 180) / Math.PI,
    ry: (pitch * 180) / Math.PI,
    rz: (yaw * 180) / Math.PI,
  };
}

/** 采样帧解出的可渲染状态（位置/旋转/速度 + 完整离散状态） */
export interface SampledState {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  vx: number;
  vy: number;
  vz: number;
  vehicleModel: number;
  cpProgress: number;
  hour: number;
  minute: number;
  weather: number;
  vehicleHealth: number;
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
    const e = quatToEuler({ x: f.qx, y: f.qy, z: f.qz, w: f.qw });
    return {
      x: f.x,
      y: f.y,
      z: f.z,
      rx: e.rx,
      ry: e.ry,
      rz: e.rz,
      vx: f.vx,
      vy: f.vy,
      vz: f.vz,
      vehicleModel: f.vehicleModel,
      cpProgress: f.cpProgress,
      hour: f.hour,
      minute: f.minute,
      weather: f.weather,
      vehicleHealth: f.vehicleHealth,
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
    v.setHealth(1000);
    ghost.npc.setVirtualWorld(session.worldId);
    ghost.npc.putInVehicle(v, 0);
    ghost.vehicle = v;
  } catch (e) {
    logger.warn(`[replay] 换车型失败 ${oldModel} -> ${model}`, e);
    ghost.model = oldModel;
  }
}

/** 渲染单个 ghost 到当前帧（位置/旋转/速度 + 车型/血量；时间天气随帧给观察者） */
function renderGhost(session: ReplaySession, ghost: Ghost): void {
  const s = sampleAt(session.data, ghost.playTime);
  if (!s) return;
  try {
    ensureGhostVehicle(session, ghost, s.vehicleModel);
    ghost.npc.setVehiclePos(s.x, s.y, s.z, true);
    ghost.npc.setVehicleRot(s.rx, s.ry, s.rz, true);
    ghost.npc.setVelocity(s.vx, s.vy, s.vz);
    // 血量变化检测（血量帧间极少变化，防 60fps×N 每帧 setHealth）
    if (Math.abs(s.vehicleHealth - ghost.lastHealth) > 0.5) {
      ghost.lastHealth = s.vehicleHealth;
      ghost.vehicle.setHealth(s.vehicleHealth);
    }
  } catch {
    // NPC/车辆失效（异常销毁由清理兜底）
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
  if (!session.playing || session.paused) return;
  const dt = TICK_MS * session.speed * session.direction;
  const lastIdx = session.data.header.frameCount - 1;
  const maxTime = lastIdx * session.data.header.frameIntervalMs;
  for (const g of session.ghosts) {
    // 播放时间推进并 clamp 到 [0, maxTime]（播到头/退到头停在边界，不循环）
    g.playTime = Math.min(maxTime, Math.max(0, g.playTime + dt));
  }
  // 播完提示（一次）：正向播放到达结尾 → 提示用户可后退/seek 继续看
  if (
    !session.endedNotified &&
    session.direction === 1 &&
    session.ghosts.every((g) => g.playTime >= maxTime)
  ) {
    session.endedNotified = true;
    const owner = Player.getInstance(session.ownerId);
    if (owner && owner.isConnected()) {
      owner.sendClientMessage(COLOR_RACE, "回放已播完（/rp back 或 /rp seek 可回看）");
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
  const idx = Math.floor(session.ghosts[0].playTime / Math.max(1, session.data.header.frameIntervalMs));
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
export async function spawnReplay(player: Player, replayId: string, opts?: { npcCount?: number }): Promise<boolean> {
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
  const duration = data.header.frameCount * data.header.frameIntervalMs;
  const staggerMs = count > 1 ? duration / count : 0;

  try {
    for (let i = 0; i < count; i++) {
      // 创建中失败自动降级：某分身 NPC 分配失败（槽位被并发抢占）→
      // 若已成功 ≥1 个则用已成功的继续，否则整体失败（防一半资源半拉子）
      // 名字带随机后缀：同毫秒多人创建防重名冲突
      const rand = Math.random().toString(36).slice(2, 6);
      const npc = allocReplayNpc(`RP${Date.now().toString(36)}_${i}_${rand}`.slice(0, 24));
      if (!npc) {
        if (ghosts.length === 0) {
          player.sendClientMessage(COLOR_ERROR, "NPC 槽位不足，回放创建失败");
          return false;
        }
        logger.warn(`[replay] ${player.getName().name} 分身 ${i + 1}/${count} NPC 分配失败，降级为 ${ghosts.length} 台`);
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
      // 锁门防玩家开走 ghost 车（回放车只可看不可开；NPC 已在车内不受影响）
      vehicle.setParamsEx(true, false, false, true, false, false, false);
      npc.setVirtualWorld(worldId);
      npc.putInVehicle(vehicle, 0);
      npc.setInvulnerable(true);
      // NPC 无 nametag：绑 3D 标签显示"本身身份（NPC 名）+ 扮演谁（录制者 + 分身编号）"
      const label = new Dynamic3DTextLabel({
        text:
          `{FFD700}${npc.getName()}` +
          `\n{FFFFFF}回放 · ${replay.recorderName}` +
          (ghosts.length + 1 > 1 ? `{808080} [ghost ${ghosts.length + 1}/${count}]` : ""),
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
      ghosts.push({ npc, vehicle, label, playTime: i * staggerMs, staggerMs, model: data.header.vehicleModelId, lastHealth: -1 });
    }
  } catch (e) {
    logger.error(`[replay] 创建回放实体失败`, e);
    // 清理已创建的
    for (const g of ghosts) {
      try {
        g.label.destroy();
        g.npc.destroy();
        g.vehicle.destroy();
      } catch {
        /* 忽略 */
      }
    }
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
    direction: 1,
    speed: 1,
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
      `回放已开始：${ghosts.length} 台车在世界上重播 · /rp 控制（暂停/快进/后退/倍速/seek）· /rp watch 观战`,
    );
    return true;
  }
  // 比赛回放：独立世界 + 发起人自动观战（复用观战系统：切世界/spectateVehicle/退出恢复）
  player.setVirtualWorld(worldId);
  player.setPos(data.header.startX, data.header.startY, data.header.startZ + 1);
  try {
    startObserveVehicle(player, ghosts[0].vehicle);
    session.watchers.add(player.id);
    // 观战者比赛信息 TD（事件无关，从帧状态渲染）——NPC 回放的 TextDraw 状态可见
    ensureObserverTds(session, player);
    syncObserverTds(session);
  } catch {
    /* 观战失败不影响播放 */
  }
  player.sendClientMessage(COLOR_SUCCESS, `回放已开始：${ghosts.length} 台车 · /rp 控制（暂停/快进/后退/倍速/seek）`);
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
      player.sendClientMessage(COLOR_RACE, "回放已暂停");
      break;
    }
    case "resume":
    case "play": {
      session.paused = false;
      session.direction = 1;
      player.sendClientMessage(COLOR_RACE, "回放继续");
      break;
    }
    case "forward": {
      const n = Number(arg);
      session.direction = 1;
      session.speed = n === 2 || n === 4 ? n : 1; // 默认 ×1（正放）
      session.paused = false;
      player.sendClientMessage(COLOR_RACE, `快进 ×${session.speed}`);
      break;
    }
    case "back": {
      const n = Number(arg);
      // 倒放档位与正放对称：/rp back [0.5|1|2|4]（默认 ×1 倒放）
      session.direction = -1;
      session.speed = n === 0.5 || n === 1 || n === 2 || n === 4 ? n : 1;
      session.paused = false;
      player.sendClientMessage(COLOR_RACE, `倒放 ×${session.speed}`);
      break;
    }
    case "speed": {
      const n = Number(arg);
      session.speed = n === 0.5 || n === 1 || n === 2 || n === 4 ? n : 1;
      player.sendClientMessage(COLOR_RACE, `倍速 ×${session.speed}`);
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
      const max = session.data.header.frameCount * session.data.header.frameIntervalMs;
      const target = Math.min(max, Math.max(0, ms));
      for (const g of session.ghosts) g.playTime = target;
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
  for (const g of session.ghosts) {
    try {
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
  // 统一退出观战（发起人 + 非发起人 watch 者）：防观战者卡在 spectating 指向已销毁 ghost
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
  // 比赛回放（独立世界）：玩家可能在其中刷过车 → 恢复玩家世界 + 爱车世界，
  // 防爱车留在独立世界成幽灵车（仅当玩家仍在回放世界；已离开则不覆盖其状态）
  const owner = Player.getInstance(playerId);
  if (owner && owner.isConnected() && session.replayType === "race" && owner.getVirtualWorld() === session.worldId) {
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
