import { Player } from "@infernus/core";
import { IPacket, PacketIdList, InCarSync } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { encodeHeader, encodeFrame, HEADER_BYTES, FRAME_BYTES, REPLAY_TYPE_GHOST, REPLAY_TYPE_RACE, type ReplayFrame, type ReplayHeader } from "./format";
import { saveRecordingFile, deleteRecordingFile } from "./storage";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_ORANGE } from "@/utils/colors";

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
  /** 录制起始世界（跨世界录制自动停止用） */
  startWorld: number;
  /** 自动停止已触发标记（防采样回调重复触发 stop） */
  autoStopTriggered: boolean;
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
  /** 离散状态缓存（车型/时间/天气/血量）——必须 per-session：
   *  多人比赛同时录制时模块级缓存会互相污染（A 的车型/血量写进 B 的帧），
   *  且 cveh 换车后各玩家车型独立。缓存随会话生命周期，startRecording 初始化。 */
  cacheModel: number;
  cacheHour: number;
  cacheMinute: number;
  cacheWeather: number;
  cacheHealth: number;
  cacheAt: number;
  /** 诊断：RakNet DriverSync 拦截采到的帧数（与兜底帧分开计数，
   *  停止时打印——0 说明拦截未触发） */
  raknetFrames: number;
  /** 诊断：拦截回调进入次数（含 readSync 失败/边界拦截等未采样的路径——
   *  与 raknetFrames 对比可判断是"回调没触发"还是"回调在但采样失败"） */
  interceptHits: number;
  /** 诊断：最后一次 RakNet 拦截采样的时间（停止时打印，判断拦截是否"从头到尾都在"） */
  lastRaknetAt: number;
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

/** 录制时长硬上限（1 小时）：防玩家挂机无限录制拖垮内存/磁盘（帧数组常驻内存） */
const MAX_RECORD_MS = 60 * 60 * 1000;
/** 离散状态缓存刷新间隔（sync 帧间少读 native） */
const DISCRETE_REFRESH_MS = 2000;
/**
 * 兜底采样判定：距上次采样超过该间隔才补帧。
 * 100ms：不依赖 RakNet 拦截的主采样频率（拦截是否触发不影响帧数）。
 * 原 2000ms 时 15s 录制只有 8 帧，回放时间轴（按 33ms×帧数算）0.23s 就
 * clamp 到尾帧 → 播放"瞬移+原地开"。加密后 15s ≈ 150 帧，回放正常。
 */
const FALLBACK_GAP_MS = 100;
/** 兜底采样定时器间隔 */
const FALLBACK_INTERVAL_MS = 100;

/**
 * 录制边界检查（每次采样前调用）：
 * - 超时（挂机/长录）→ 自动停止落盘
 * - 玩家离开录制起始世界（传送/换战局/死亡回世界）→ 自动停止（跨世界位置
 *   跳变会让回放 ghost 瞬移，录出错误轨迹）
 * 返回 true = 应停止（已触发，调用方不再采样）。
 */
function checkRecordingBoundary(session: RecordingSession, player: Player): boolean {
  if (session.autoStopTriggered) return true;
  const reason =
    Date.now() - session.startAt > MAX_RECORD_MS
      ? "录制已达时长上限"
      : player.getVirtualWorld() !== session.startWorld
        ? "已离开录制世界"
        : null;
  if (reason) {
    session.autoStopTriggered = true;
    player.sendClientMessage(COLOR_ORANGE, `[回放] ${reason}，自动停止并保存`);
    void stopRecording(session.playerId, { quiet: true });
    return true;
  }
  return false;
}

/** 采样一次（RakNet 驱动） */
function sample(session: RecordingSession, frame: ReplayFrame): void {
  session.frames.push(frame);
  session.last = frame;
  session.lastSampleAt = Date.now();
}

/**
 * 刷新离散状态缓存（时间/天气/车型/血量）：
 * 30Hz sync 帧连续到来时若每帧都读 6-7 个 native（getPlayer/getTime/getWeather/
 * getVehicle/getModel/getHealth）开销大。缓存节流：只在上次刷新 ≥DISCRETE_REFRESH_MS
 * 前才重读，帧间用缓存（状态变化延迟最多该间隔写帧，CP 进度由 noteCpProgress
 * 事件驱动不受影响）。
 * 缓存存于会话内：并发录制（多人比赛）时各会话互不干扰。
 */
function refreshDiscreteCache(session: RecordingSession, player: Player): void {
  const now = Date.now();
  if (now - session.cacheAt < DISCRETE_REFRESH_MS) return;
  session.cacheAt = now;
  const veh = getOwnedVehicle(session.playerId);
  const tm = player.getTime();
  session.cacheModel = veh && veh.isValid() ? veh.getModel() : session.vehicleModelId;
  session.cacheHour = tm.ret ? tm.hour : 12;
  session.cacheMinute = tm.ret ? tm.minute : 0;
  session.cacheWeather = player.getWeather();
  session.cacheHealth = veh && veh.isValid() ? veh.getHealth().health : 1000;
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
    player.sendClientMessage(COLOR_ERROR, "请先登录");
    return false;
  }
  if (sessions.has(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "你已在录制中");
    return false;
  }
  const veh = getOwnedVehicle(player.id);
  if (!veh || !veh.isValid()) {
    player.sendClientMessage(COLOR_ERROR, "需要先刷车（/c 车辆ID）才能录制");
    return false;
  }
  const pos = veh.getPos();
  const q = veh.getRotationQuat();
  const vel = veh.getVelocity();
  if (!q.ret) {
    player.sendClientMessage(COLOR_ERROR, "车辆状态读取失败，请重试");
    return false;
  }
  // 同步注册会话（先 set 再异步补 bestMs）——消除竞态：beginRace 里
  // void startRecording() 后若比赛很快结束触发 stopRecording，必须能
  // 找到会话（否则该段录制静默丢失）
  const session: RecordingSession = {
    playerId: player.id,
    type: opts.type,
    raceId: opts.raceId ?? null,
    raceName: opts.raceName ?? null,
    startAt: Date.now(),
    startWorld: player.getVirtualWorld(),
    autoStopTriggered: false,
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
    bestMs: -1,
    // 离散缓存初始化为空态（cacheAt=0 使首次采样立即刷新），
    // 避免首帧用默认值（车型/血量等与实际不符）
    cacheModel: veh.getModel(),
    cacheHour: 12,
    cacheMinute: 0,
    cacheWeather: 0,
    cacheHealth: 1000,
    cacheAt: 0,
    raknetFrames: 0,
    interceptHits: 0,
    lastRaknetAt: 0,
  };
  sessions.set(player.id, session);
  // 诊断：录制开始快照——车内=否时 DriverSync 包不会产生（onfoot 是另一个包），
  // 只剩兜底采样，帧数必然稀疏；世界用于核对边界检查
  logger.info(
    `[replay] 录制开始 type=${opts.type} player=${player.getName().name}(${player.id}) ` +
      `车内=${player.isInAnyVehicle()} 世界=${player.getVirtualWorld()} 车型=${veh.getModel()}`,
  );
  // 比赛录制：异步补个人最佳（回放 BEST TD 用），不阻塞开始
  if (opts.type === "race" && opts.raceId && auth) {
    void (async () => {
      try {
        const best = await prisma.raceRecord.findFirst({
          where: { raceId: opts.raceId!, userId: auth.userId, deletedAt: null },
          orderBy: { record: "asc" },
          select: { record: true },
        });
        session.bestMs = best?.record ?? -1;
      } catch {
        session.bestMs = -1;
      }
    })();
  }
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
  if (player && player.isConnected() && now - session.lastSampleAt > FALLBACK_GAP_MS) {
    const f = captureVehicleFrame(player, session);
    if (f) sample(session, f);
  }
  if (session.frames.length < 2) {
    if (player && player.isConnected() && !opts?.quiet) {
      player.sendClientMessage(COLOR_ERROR, "录制内容过短，已取消");
    }
    return null;
  }

  // 时长：录制起止真实时间差（播放推进仍按帧序，帧间不均以插值平滑）。
  // 不用 frames.length×33ms——RakNet 拦截失效时只剩兜底采样（每 2s 一帧），
  // 帧数算出的时长会严重偏短（6 秒录制 3 帧 ≈ 0.1s），提示误导。
  const durationMs = Math.max(1, Date.now() - session.startAt);
  // 实际帧间隔：时长 / (帧数-1)。回放 sampleAt 按 header.frameIntervalMs×frameCount
  // 算播放总时长——若固定写 33ms 而实际帧间隔是 100ms（兜底采样），总时长
  // 会远小于真实录制时长，播放超 0.23s 即 clamp 到尾帧（"瞬移+原地开"）。
  // 用实际间隔让播放时间轴与帧一一对应（帧少时慢放但位置正确）。
  const frameIntervalMs = Math.round(durationMs / Math.max(1, session.frames.length - 1));
  const header: ReplayHeader = {
    type: session.type === "race" ? REPLAY_TYPE_RACE : REPLAY_TYPE_GHOST,
    frameIntervalMs, // 实际帧间隔（播放推进基准；兜底采样时 ≈100ms，RakNet 拦截时 ≈33ms）
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
    frameBytes: FRAME_BYTES, // 自描述帧字节数（v3；未来帧加字段时版本 +1 更新）
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
      player.sendClientMessage(COLOR_ERROR, "回放保存失败（磁盘错误）");
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
      player.sendClientMessage(COLOR_SUCCESS, `录制完成：${(durationMs / 1000).toFixed(1)}s / ${session.frames.length} 帧`);
    }
    // 采样来源诊断（定位录制帧数少/0.1s 问题）：
    // - interceptHits=0 → DriverSync 回调从未触发（插件未转发/包未到达）
    // - interceptHits>0 但 raknetFrames=0 → 回调在但采样失败（readSync 抛错，
    //   已单独打 error 日志）
    // - raknetFrames>0 但总量少 → 玩家没在开车（DriverSync 只在司机位产生）
    // - lastRaknetAt 距停止很远 → 录制中后期拦截中断
    const elapsed = durationMs / 1000;
    const lastHitAgo = session.lastRaknetAt > 0 ? ((Date.now() - session.lastRaknetAt) / 1000).toFixed(1) : "无";
    logger.info(
      `[replay] 录制落盘 ${fileName} ${elapsed.toFixed(1)}s/${session.frames.length}帧` +
        `（RakNet=${session.raknetFrames} 拦截=${session.interceptHits} 兜底=${session.frames.length - session.raknetFrames} 最后拦截于${lastHitAgo}s前）`,
    );
    return { id: created.id, fileName };
  } catch (e) {
    logger.error(`[replay] 写回放元数据失败`, e);
    // DB 写入失败：文件已落盘但无索引 → 删除文件（防孤儿文件永久占空间；
    // 启动时另有孤儿扫描兜底历史残留）
    deleteRecordingFile(fileName);
    if (player && player.isConnected() && !opts?.quiet) {
      player.sendClientMessage(COLOR_ERROR, "回放元数据保存失败，已删除录像");
    }
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
    if (Date.now() - session.lastSampleAt < FALLBACK_GAP_MS) continue; // 有 RakNet 采样则跳过
    const player = Player.getInstance(session.playerId);
    if (!player || !player.isConnected()) continue;
    if (checkRecordingBoundary(session, player)) continue; // 已自动停止
    const f = captureVehicleFrame(player, session);
    if (f) sample(session, f);
  }
}

/** 初始化录制：
 * - IPacket 是 samp.on 事件注册（与 PlayerEvent 同构），模块导入期注册即有效，
 *   与服务器初始化时序无关（此前误认为需延后到 onInit，已还原）
 * - 兜底定时器随系统启动（RakNet 拦截失效/玩家静止不发 sync 包时补帧）
 * - 采样来源诊断：RakNet 帧 / 兜底帧分别计数，停止录制时打印汇总——若 raknet=0
 *   说明拦截未触发（插件未加载/包未到达），若 raknet 有值但帧数仍少则是
 *   采样间隔/播放问题 */
export function initRecorder(): void {
  try {
    IPacket(PacketIdList.DriverSync, ({ playerId, bs, next }) => {
      const session = sessions.get(playerId);
      if (session) {
        const player = Player.getInstance(playerId);
        if (player && checkRecordingBoundary(session, player)) {
          // 已触发自动停止：不采样（会话可能已被 stopRecording 移除）
        } else {
          // 诊断：拦截是否真正进入（回调触发即 +1）；采样失败单独记日志——
          // 若回调在但 sample 不执行，就是 readSync 抛错
          session.interceptHits++;
          try {
            const sync = new InCarSync(bs).readSync();
            if (sync) {
              // Vector3/Vector4 均为 [x,y,z] / [x,y,z,w] 元组
              const p = sync.position;
              const v = sync.velocity;
              const q = sync.quaternion;
              // 离散状态（车型/时间/天气/血量）节流采样：sync 帧间用会话内缓存，
              // 避免每帧读 6-7 个 native（CP 进度由 noteCpProgress 事件驱动）
              if (player) refreshDiscreteCache(session, player);
              session.raknetFrames++; // 诊断：RakNet 拦截实际采到的帧数
              session.lastRaknetAt = Date.now();
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
                vehicleModel: session.cacheModel,
                cpProgress: session.cpProgress,
                hour: session.cacheHour,
                minute: session.cacheMinute,
                weather: session.cacheWeather,
                vehicleHealth: session.cacheHealth,
              });
            }
          } catch (e) {
            logger.error(`[replay] ${playerId} DriverSync 采样异常`, e);
          }
        }
      }
      bs.resetReadPointer(); // 放行（回放录制只采样不改包）
      return next();
    });
  } catch (e) {
    logger.warn(`[replay] RakNet 拦截不可用，录制将依赖兜底采样`, e);
  }
  fallbackTimer = setIntervalSafe(fallbackSample, FALLBACK_INTERVAL_MS);
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
