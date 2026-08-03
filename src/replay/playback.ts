import { Npc, Player, Vehicle } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { startObserveVehicle, stopObserve, isObserving } from "@/core/observe";
import { parseReplayFile, decodeFrame, lerpFrame, type ReplayData, type ReplayFrame } from "./format";
import { join } from "node:path";
import { RECORDING_DIR } from "./storage";
import { COLOR_RACE, COLOR_ERROR, COLOR_SUCCESS, COLOR_ORANGE } from "@/utils/colors";

/**
 * 回放会话（NPC 逐帧驱动，非原生 .rec）：
 * - 回放文件整读入内存（Buffer 帧切片，O(1) seek）
 * - 60fps tick：按播放时间（方向×倍速推进）→ 相邻帧插值 → npc.setVehiclePos/
 *   setVehicleRot/setVelocity 驱动 NPC 车辆
 * - 控制：播放/暂停/快进/后退/倍速/seek（时间线变动，前后一致性由帧序插值保证）
 * - 多分身：同一数据错峰起始（每 ghost 独立 playTime，控制同步作用于全部）
 * - 观看：发起人自动 startObserveVehicle(ghost 车)（复用观战系统）
 * - 清理：/rp stop / 发起人断线 / onExit 全路径销毁
 */

/** 回放世界起始 id（避开公共大世界 0、战局 1..n、比赛 5000+） */
const REPLAY_WORLD_BASE = 6000;
let nextReplayWorldId = REPLAY_WORLD_BASE;

/** 播放推进帧间隔（60fps） */
const TICK_MS = 16;

interface Ghost {
  npc: Npc;
  vehicle: Vehicle;
  /** 该分身的播放时间（毫秒，从文件起点；错峰起始） */
  playTime: number;
  staggerMs: number;
}

export interface ReplaySession {
  id: string; // replay 记录 id
  ownerId: number; // 发起人 playerId
  worldId: number;
  data: ReplayData;
  ghosts: Ghost[];
  /** 会话级播放状态（作用于所有 ghost） */
  playing: boolean;
  paused: boolean;
  direction: 1 | -1;
  speed: number; // 倍速 0.5~4
  timer?: NodeJS.Timeout;
  autoObserve: boolean;
}

const sessions = new Map<number, ReplaySession>(); // ownerId -> session

export function getReplaySession(playerId: number): ReplaySession | undefined {
  return sessions.get(playerId);
}

/** 正在播放回放的玩家数（菜单可显示） */
export function isPlayingReplay(playerId: number): boolean {
  return sessions.has(playerId);
}

/** SA 车辆四元数 → 欧拉角（度）。与 getRotationQuat/setVehicleRot 同引擎约定。 */
function quatToEuler(q: { x: number; y: number; z: number; w: number }): { rx: number; ry: number; rz: number } {
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

/** 按播放时间取插值帧（帧序保证前后一致性；超出范围 clamp 到边界帧） */
function sampleAt(data: ReplayData, playTime: number): { x: number; y: number; z: number; rx: number; ry: number; rz: number; vx: number; vy: number; vz: number } | null {
  const { header, frames } = data;
  if (header.frameCount === 0) return null;
  const interval = Math.max(1, header.frameIntervalMs);
  // 帧坐标 = 时间 / 间隔（最后一帧边界）
  const lastIdx = header.frameCount - 1;
  const maxTime = lastIdx * interval;
  const t = Math.min(maxTime, Math.max(0, playTime));
  const idx = Math.floor(t / interval);
  const toEuler = (f: ReplayFrame): { rx: number; ry: number; rz: number } =>
    quatToEuler({ x: f.qx, y: f.qy, z: f.qz, w: f.qw });
  if (idx >= lastIdx) {
    const f = decodeFrame(frames, lastIdx);
    if (!f) return null;
    const e = toEuler(f);
    return { x: f.x, y: f.y, z: f.z, rx: e.rx, ry: e.ry, rz: e.rz, vx: f.vx, vy: f.vy, vz: f.vz };
  }
  const a = decodeFrame(frames, idx);
  const b = decodeFrame(frames, idx + 1);
  if (!a || !b) return null;
  const frac = (t - idx * interval) / interval;
  const f = lerpFrame(a, b, frac);
  const e = toEuler(f);
  return { x: f.x, y: f.y, z: f.z, rx: e.rx, ry: e.ry, rz: e.rz, vx: f.vx, vy: f.vy, vz: f.vz };
}

/** 渲染单个 ghost 到当前帧 */
function renderGhost(session: ReplaySession, ghost: Ghost): void {
  const s = sampleAt(session.data, ghost.playTime);
  if (!s) return;
  try {
    ghost.npc.setVehiclePos(s.x, s.y, s.z, true);
    ghost.npc.setVehicleRot(s.rx, s.ry, s.rz, true);
    ghost.npc.setVelocity(s.vx, s.vy, s.vz);
  } catch {
    // NPC/车辆失效（异常销毁由清理兜底）
  }
}

/** 60fps 播放推进 */
function tickSession(session: ReplaySession): void {
  if (!session.playing || session.paused) return;
  const dt = TICK_MS * session.speed * session.direction;
  const lastIdx = session.data.header.frameCount - 1;
  const maxTime = lastIdx * session.data.header.frameIntervalMs;
  for (const g of session.ghosts) {
    // 播放时间推进并 clamp 到 [0, maxTime]（播到头/退到头停在边界，不循环）
    g.playTime = Math.min(maxTime, Math.max(0, g.playTime + dt));
  }
  for (const g of session.ghosts) renderGhost(session, g);
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
  const replay = await prisma.replay.findFirst({
    where: { id: replayId, deletedAt: null },
  });
  if (!replay) {
    player.sendClientMessage(COLOR_ERROR, "回放不存在或已删除");
    return false;
  }
  let data: ReplayData;
  try {
    data = parseReplayFile(join(RECORDING_DIR, replay.fileName));
  } catch (e) {
    logger.error(`[replay] 回放文件读取失败 ${replay.fileName}`, e);
    player.sendClientMessage(COLOR_ERROR, "回放文件损坏或不存在");
    return false;
  }

  const count = Math.min(5, Math.max(1, opts?.npcCount ?? 1));
  const worldId = nextReplayWorldId++;
  const ghosts: Ghost[] = [];
  const duration = data.header.frameCount * data.header.frameIntervalMs;
  const staggerMs = count > 1 ? duration / count : 0;

  try {
    for (let i = 0; i < count; i++) {
      const name = `RP_${Date.now()}_${i}`.slice(0, 24);
      const npc = new Npc(name).create();
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
      npc.setVirtualWorld(worldId);
      npc.putInVehicle(vehicle, 0);
      npc.setInvulnerable(true);
      ghosts.push({ npc, vehicle, playTime: i * staggerMs, staggerMs });
    }
  } catch (e) {
    logger.error(`[replay] 创建回放实体失败`, e);
    // 清理已创建的
    for (const g of ghosts) {
      try {
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
    data,
    ghosts,
    playing: true,
    paused: false,
    direction: 1,
    speed: 1,
    autoObserve: true,
  };
  sessions.set(player.id, session);
  session.timer = setIntervalSafe(() => tickSession(session), TICK_MS);
  for (const g of session.ghosts) renderGhost(session, g);

  player.setVirtualWorld(worldId);
  player.setPos(data.header.startX, data.header.startY, data.header.startZ + 1);
  // 自动观战第一个 ghost（复用观战系统：切世界/spectateVehicle/退出恢复）
  try {
    startObserveVehicle(player, ghosts[0].vehicle);
  } catch {
    /* 观战失败不影响播放 */
  }
  player.sendClientMessage(COLOR_SUCCESS, `回放已开始：${ghosts.length} 台车 · /rp 控制（暂停/快进/后退/倍速/seek）`);
  return true;
}

/** 会话级控制（作用于所有 ghost 的播放状态） */
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
      session.speed = n === 2 || n === 4 ? n : 2;
      session.paused = false;
      player.sendClientMessage(COLOR_RACE, `快进 ×${session.speed}`);
      break;
    }
    case "back": {
      session.direction = -1;
      session.speed = Number(arg) === 2 || Number(arg) === 4 ? Number(arg) : 2;
      session.paused = false;
      player.sendClientMessage(COLOR_RACE, `后退 ×${session.speed}`);
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
      player.sendClientMessage(COLOR_RACE, `已跳转到 ${(target / 1000).toFixed(1)}s`);
      break;
    }
    case "watch": {
      // 观看当前回放（退出观战后可重新进入）
      if (!session.autoObserve) {
        startObserveVehicle(player, session.ghosts[0].vehicle);
        session.autoObserve = true;
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

/** 停止并销毁回放会话（ghost NPC/车辆 + 观察者退出观战） */
export function stopReplaySession(playerId: number): void {
  const session = sessions.get(playerId);
  if (!session) return;
  sessions.delete(playerId);
  if (session.timer) clearIntervalSafe(session.timer);
  for (const g of session.ghosts) {
    try {
      g.npc.destroy();
      g.vehicle.destroy();
    } catch {
      /* 已销毁/失效 */
    }
  }
  const owner = Player.getInstance(playerId);
  if (owner && owner.isConnected() && isObserving(playerId)) {
    stopObserve(owner);
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
