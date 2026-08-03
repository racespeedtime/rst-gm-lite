import { Player } from "@infernus/core";
import { IPacket, PacketIdList, InCarSync } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { encodeHeader, encodeFrame, HEADER_BYTES, FRAME_BYTES, type ReplayFrame, type ReplayHeader } from "./format";
import { saveRecordingFile } from "./storage";

/**
 * 录制会话（自定义二进制录制，非原生 .rec）：
 * - RakNet 拦截 DriverSync（InCarSync）30Hz 采点（位置/四元数/速度）
 * - 兜底采样定时器（RakNet 丢包时补帧，保持播放平滑）
 * - 停止时写定长帧文件 + replay 元数据入 DB
 * - 所有 timer 走登记制 setIntervalSafe；断线强制落盘防泄漏
 */

export interface RecordingSession {
  playerId: number;
  type: "ghost" | "race";
  raceId: string | null;
  raceName: string | null;
  startAt: number;
  vehicleModelId: number;
  /** 车辆初始快照（写 Header 用，记录与回放同一引擎约定） */
  startX: number;
  startY: number;
  startZ: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vy: number;
  vz: number;
  frames: ReplayFrame[];
  /** 最近一次采样帧（兜底 + 提速） */
  last: ReplayFrame | null;
  lastSampleAt: number;
  /** 当前已完成的 CP 数（room 过 CP 时 noteCpProgress 更新，采样写帧） */
  cpProgress: number;
  /** 赛道 CP 总数（回放 C P TD 分母；非比赛录制 0） */
  totalCp: number;
  /** 录制者该赛道个人最佳毫秒（回放 BEST TD；无 -1） */
  bestMs: number;
}

const sessions = new Map<number, RecordingSession>();
/** 兜底采样定时器句柄（模块级，init 时启动一次） */
let fallbackTimer: NodeJS.Timeout | undefined;

export function isRecording(playerId: number): boolean {
  return sessions.has(playerId);
}

/** 取当前录制会话 */
export function getRecording(playerId: number): RecordingSession | undefined {
  return sessions.get(playerId);
}

/** 记录已完成的 CP 数（room 过 CP 时调用，采样写帧——回放 C P TD 与 seek 恢复用） */
export function noteCpProgress(playerId: number, cpDone: number, totalCp: number): void {
  const s = sessions.get(playerId);
  if (!s) return;
  s.cpProgress = cpDone;
  s.totalCp = totalCp;
}

/** 采样一次（RakNet 驱动） */
function sample(session: RecordingSession, frame: ReplayFrame): void {
  session.frames.push(frame);
  session.last = frame;
  session.lastSampleAt = Date.now();
}

/** 从车辆实体采集当前帧（位置/四元数/速度/车型/时间天气/血量） */
function captureVehicleFrame(player: Player, session?: RecordingSession): ReplayFrame | null {
  const veh = getOwnedVehicle(player.id);
  if (!veh || !veh.isValid()) return null;
  const pos = veh.getPos();
  const q = veh.getRotationQuat();
  const vel = veh.getVelocity();
  if (!q.ret) return null;
  const tm = player.getTime();
  const hour = tm.ret ? tm.hour : 12;
  const minute = tm.ret ? tm.minute : 0;
  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    qx: q.x,
    qy: q.y,
    qz: q.z,
    qw: q.w,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    vehicleModel: veh.getModel(),
    cpProgress: session?.cpProgress ?? 0,
    hour,
    minute,
    weather: player.getWeather(),
    vehicleHealth: veh.getHealth().health,
  };
}

/**
 * 开始录制：需已认证 + 在车内（v1 仅车内采集）+ 未在录制。
 * 车内指"玩家的爱车实体"（车辆采集源），不要求 putPlayerIn。
 * 挑战/回放中禁录由调用方（/rec start、面板）拦截（避免循环依赖）。
 */
export async function startRecording(
  player: Player,
  opts: { type: "ghost" | "race"; raceId?: string | null; raceName?: string | null },
): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) {
    player.sendClientMessage("#ff5555", "请先登录");
    return false;
  }
  if (sessions.has(player.id)) {
    player.sendClientMessage("#ff5555", "你已在录制中");
    return false;
  }
  const veh = getOwnedVehicle(player.id);
  if (!veh || !veh.isValid()) {
    player.sendClientMessage("#ff5555", "需要先刷车（/c 车辆ID）才能录制");
    return false;
  }
  const pos = veh.getPos();
  const q = veh.getRotationQuat();
  const vel = veh.getVelocity();
  if (!q.ret) {
    player.sendClientMessage("#ff5555", "车辆状态读取失败，请重试");
    return false;
  }
  // 比赛录制：带该赛道个人最佳（回放 BEST TD 用）——异步查询，不阻塞开始
  let bestMs = -1;
  if (opts.type === "race" && opts.raceId && auth) {
    try {
      const best = await prisma.raceRecord.findFirst({
        where: { raceId: opts.raceId, userId: auth.userId, deletedAt: null },
        orderBy: { record: "asc" },
        select: { record: true },
      });
      bestMs = best?.record ?? -1;
    } catch {
      bestMs = -1;
    }
  }
  const session: RecordingSession = {
    playerId: player.id,
    type: opts.type,
    raceId: opts.raceId ?? null,
    raceName: opts.raceName ?? null,
    startAt: Date.now(),
    vehicleModelId: veh.getModel(),
    startX: pos.x,
    startY: pos.y,
    startZ: pos.z,
    qx: q.x,
    qy: q.y,
    qz: q.z,
    qw: q.w,
    vx: vel.x,
    vy: vel.y,
    vz: vel.z,
    frames: [],
    last: null,
    lastSampleAt: 0,
    cpProgress: 0,
    totalCp: 0,
    bestMs,
  };
  sessions.set(player.id, session);
  return true;
}

/**
 * 停止录制：写回放文件 + replay 元数据入库。quiet=true 时不发提示（比赛结束等批量场景）。
 * 返回创建的记录（含文件名）；失败返回 null。
 */
export async function stopRecording(
  playerId: number,
  opts?: { quiet?: boolean; rank?: number | null; finished?: boolean | null },
): Promise<{ id: string; fileName: string } | null> {
  const session = sessions.get(playerId);
  if (!session) return null;
  sessions.delete(playerId);

  const player = Player.getInstance(playerId);
  // 兜底：最后采样太旧（RakNet 中断/玩家下车）→ 补一帧当前车辆状态，保证结尾有帧
  const now = Date.now();
  if (player && player.isConnected() && now - session.lastSampleAt > 2000) {
    const f = captureVehicleFrame(player, session);
    if (f) sample(session, f);
  }
  if (session.frames.length < 2) {
    if (player && player.isConnected() && !opts?.quiet) {
      player.sendClientMessage("#ff5555", "录制内容过短，已取消");
    }
    return null;
  }

  // 时长按帧数×标称采样间隔（播放时逐帧推进，保持一致）；实际帧间不均以插值平滑
  const durationMs = session.frames.length * 33;
  const header: ReplayHeader = {
    type: session.type === "race" ? 1 : 0,
    frameIntervalMs: 33, // 标称采样间隔（播放推进基准；实际帧间不均以帧序插值）
    vehicleModelId: session.vehicleModelId,
    startX: session.startX,
    startY: session.startY,
    startZ: session.startZ,
    qx: session.qx,
    qy: session.qy,
    qz: session.qz,
    qw: session.qw,
    vx: session.vx,
    vy: session.vy,
    vz: session.vz,
    frameCount: session.frames.length,
    durationMs,
    totalCp: session.totalCp ?? 0,
    bestMs: session.bestMs ?? -1,
  };

  // 组装文件 Buffer：定长头 + 定长帧（一次性分配，避免多次 Buffer 拼接）
  const buf = Buffer.allocUnsafe(HEADER_BYTES + session.frames.length * FRAME_BYTES);
  encodeHeader(header).copy(buf, 0);
  session.frames.forEach((f, i) => {
    encodeFrame(f).copy(buf, HEADER_BYTES + i * FRAME_BYTES);
  });

  const fileName = `${playerId}_${session.startAt}.rec`;
  if (!saveRecordingFile(fileName, buf)) {
    if (player && player.isConnected() && !opts?.quiet) {
      player.sendClientMessage("#ff5555", "回放保存失败（磁盘错误）");
    }
    return null;
  }

  const auth = getAuthState(playerId);
  try {
    const created = await prisma.replay.create({
      data: {
        type: session.type,
        userId: auth?.userId ?? "",
        recorderName: player?.getName().name ?? "未知",
        raceId: session.raceId,
        raceName: session.raceName,
        vehicleModelId: session.vehicleModelId,
        fileName,
        durationMs,
        frameCount: session.frames.length,
        fileSize: buf.length,
        rank: opts?.rank ?? null,
        finished: opts?.finished ?? null,
      },
    });
    if (player && player.isConnected() && !opts?.quiet) {
      player.sendClientMessage("#55ff55", `录制完成：${(durationMs / 1000).toFixed(1)}s / ${session.frames.length} 帧`);
    }
    return { id: created.id, fileName };
  } catch (e) {
    logger.error(`[replay] 写回放元数据失败`, e);
    return null;
  }
}

/** 强制停止录制（断线/离开比赛时调用；断线玩家无提示） */
export async function forceStopRecording(playerId: number): Promise<void> {
  if (sessions.has(playerId)) {
    await stopRecording(playerId, { quiet: true });
  }
}

/** 兜底采样定时器（每 500ms）：RakNet 中断时补帧，防播放卡顿 */
function fallbackSample(): void {
  for (const session of sessions.values()) {
    if (Date.now() - session.lastSampleAt < 2000) continue; // 有 RakNet 采样则跳过
    const player = Player.getInstance(session.playerId);
    if (!player || !player.isConnected()) continue;
    const f = captureVehicleFrame(player, session);
    if (f) sample(session, f);
  }
}

/** 初始化录制（RakNet 拦截 + 兜底定时器）。插件未加载时回退。 */
export function initRecorder(): void {
  try {
    IPacket(PacketIdList.DriverSync, ({ playerId, bs, next }) => {
      const session = sessions.get(playerId);
      if (session) {
        const sync = new InCarSync(bs).readSync();
        if (sync) {
          // Vector3/Vector4 均为 [x,y,z] / [x,y,z,w] 元组
          const p = sync.position;
          const v = sync.velocity;
          const q = sync.quaternion;
          // 离散状态（车型/时间/天气/CP进度）在采样时从实体与会话读取——
          // 帧要带"完整状态"，seek/回退才能恢复那一帧的观感
          const player = Player.getInstance(playerId);
          const veh = getOwnedVehicle(playerId);
          const tm = player ? player.getTime() : { ret: false as const, hour: 12, minute: 0 };
          sample(session, {
            x: p[0],
            y: p[1],
            z: p[2],
            qx: q[0],
            qy: q[1],
            qz: q[2],
            qw: q[3],
            vx: v[0],
            vy: v[1],
            vz: v[2],
            vehicleModel: veh && veh.isValid() ? veh.getModel() : session.vehicleModelId,
            cpProgress: session.cpProgress,
            hour: tm.ret ? tm.hour : 12,
            minute: tm.ret ? tm.minute : 0,
            weather: player ? player.getWeather() : 0,
            vehicleHealth: veh && veh.isValid() ? veh.getHealth().health : 1000,
          });
        }
      }
      bs.resetReadPointer(); // 放行（回放录制只采样不改包）
      return next();
    });
  } catch (e) {
    logger.warn(`[replay] RakNet 拦截不可用，录制将依赖兜底采样`, e);
  }
  fallbackTimer = setIntervalSafe(fallbackSample, 500);
}

/** 停止录制系统（onExit/清理）：全部强制落盘 + 停定时器 */
export async function cleanupRecorder(): Promise<void> {
  if (fallbackTimer) {
    clearIntervalSafe(fallbackTimer);
    fallbackTimer = undefined;
  }
  const ids = [...sessions.keys()];
  for (const id of ids) {
    await forceStopRecording(id);
  }
}
