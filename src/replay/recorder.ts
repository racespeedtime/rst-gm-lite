import { Player } from "@infernus/core";
import { IPacket, PacketIdList, InCarSync } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import {
  encodeHeader,
  encodeFrame,
  HEADER_BYTES,
  FRAME_BYTES,
  REPLAY_TYPE_GHOST,
  REPLAY_TYPE_RACE,
  type ReplayFrame,
  type ReplayHeader,
} from "./format";
import { saveRecordingFile, deleteRecordingFile } from "./storage";
import { getReplaySession } from "./playback";
import { isInChallenge } from "./challenge";
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
  /** 录制者 userId（startRecording 时从 auth 存——落盘在断线/服务器退出后
   *  auth 可能已清，不能依赖 getAuthState） */
  userId: string;
  /** 录制者用户名（断线玩家 getName 可能取不到，落盘 recorderName 用） */
  recorderName: string;
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
  /** 掉线挂起标记（掉线重连：会话保持不落盘，挂起期间生成静止帧，重连成功续录） */
  suspended: boolean;
  /** 挂起时缓存的最近一帧（静止帧的数据源：位置/姿态/车型/时间天气血量保持，速度按键清零） */
  suspendFrame: ReplayFrame | null;
  /** 挂起是否因掉线（true=掉线挂起标 online:false；false=主动退赛挂起保持 online） */
  suspendedOffline: boolean;
  /** 所属比赛房间 id（race 录制）：房间销毁/结束收尾时校验归属，防跨房间误停/
   *  误丢"另一房间"的活跃会话（玩家退赛后又加入新房间时旧房间收尾会命中新会话） */
  raceRoomId?: number | null;
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

/** 挂起的录制会话从旧 playerId 迁移到新 playerId（掉线重连且 id 被复用场景）：
 *  重连恢复时用新 playerId resume——会话仍键控在 playerId 上，id 变了不迁移
 *  则 resume 找不到会话（掉线静帧断在旧 id、回放缺段），旧 id 还残留挂起会话。
 *  raceRoomId（可选）：归属校验——断线期间旧 playerId 可能被新连接复用并开了
 *  **别的房间**的挂起会话（同一键被覆盖），重连续录会劫持别人的会话（画面写进
 *  别人的录像）。仅当挂起会话属于本房间（无归属或匹配）才迁移，否则跳过
 *  （resume 找不到会话 → 调用方新开录制，别人的会话留在原键由原房间收尾）。 */
export function rebindRecording(
  oldPlayerId: number,
  newPlayerId: number,
  raceRoomId?: number,
): void {
  const session = sessions.get(oldPlayerId);
  if (!session || !session.suspended) return;
  if (raceRoomId != null && session.raceRoomId != null && session.raceRoomId !== raceRoomId) {
    return;
  }
  sessions.delete(oldPlayerId);
  session.playerId = newPlayerId;
  sessions.set(newPlayerId, session);
}

/** 记录已完成的 CP 数（room 过 CP 时调用，采样写帧——回放 C P TD 与 seek 恢复用） */
export function noteCpProgress(playerId: number, cpDone: number, totalCp: number): void {
  const s = sessions.get(playerId);
  if (!s) return;
  s.cpProgress = cpDone;
  s.totalCp = totalCp;
}

/** 自定义（ghost）录制时长硬上限（1 小时）：防玩家挂机无限录制拖垮内存/磁盘
 * （帧数组常驻内存，约 30Hz×3600s=10.8 万帧） */
const MAX_RECORD_MS_GHOST = 60 * 60 * 1000;
/** 比赛（race）录制时长硬上限（6 小时）：对齐原版比赛录像时长上限 */
const MAX_RECORD_MS_RACE = 6 * 60 * 60 * 1000;

/** 按录制类型取时长上限 */
function maxRecordMs(session: RecordingSession): number {
  return session.type === "race" ? MAX_RECORD_MS_RACE : MAX_RECORD_MS_GHOST;
}
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
    Date.now() - session.startAt > maxRecordMs(session)
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

/** 采样一次（RakNet 驱动）：统一注入帧时间戳（相对录制开始，v7 落盘）。
 *  帧间真实间隔不等（RakNet ~33ms / 掉线静止帧 100ms / 兜底采样），播放端
 *  按此时间戳精确定位，避免"平均间隔"把掉线段频率摊到全片导致驾驶段放慢。 */
function sample(session: RecordingSession, frame: ReplayFrame): void {
  frame.relTimeMs = Date.now() - session.startAt; // 帧每次采样都是新对象，直接赋值零复制
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
    // 兜底采样没有 DriverSync 包 → 无按键/无附加状态（0/false）；
    // 正常录制以 RakNet 帧为主，兜底仅补帧间隙
    keys: 0,
    lrKey: 0,
    udKey: 0,
    additionalKey: 0,
    landingGearState: false,
    sirenState: false,
    trailerId: 0,
    trainSpeed: 0,
    online: true, // 兜底采样/补帧均为在线帧
  };
}

/**
 * 开始录制：需已认证 + 在车内（v1 仅车内采集）+ 未在录制。
 * 车内指"玩家的爱车实体"（车辆采集源），不要求 putPlayerIn。
 * 回放/影子挑战中禁录在此核心强制拦截（调用方 /rec start、面板也拦截，
 * 双保险防遗漏路径）；比赛录制（type=race）不会在回放时触发，不受影响。
 */
export async function startRecording(
  player: Player,
  opts: {
    type: "ghost" | "race";
    raceId?: string | null;
    raceName?: string | null;
    raceRoomId?: number | null;
  },
): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) {
    player.sendClientMessage(COLOR_ERROR, "请先登录");
    return false;
  }
  if (getReplaySession(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "回放中不能录制，先 /rp stop");
    return false;
  }
  if (isInChallenge(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "影子挑战中不能录制，先 /challenge stop");
    return false;
  }
  if (sessions.has(player.id)) {
    const old = sessions.get(player.id);
    // 挂起的旧会话（掉线/中途退出的比赛录制）不能跨比赛残留：新录制直接
    // 丢弃旧挂起会话再开（挂起语义只用于"同一场比赛重连续录"，玩家开新比赛
    // 意味着旧场已结束/放弃）
    if (old?.suspended) {
      dropRecording(player.id);
    } else {
      player.sendClientMessage(COLOR_ERROR, "你已在录制中");
      return false;
    }
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
    userId: auth.userId, // 落盘不依赖后续 auth（断线/服务器退出时 auth 可能已清）
    recorderName: auth.username,
    raceId: opts.raceId ?? null,
    raceName: opts.raceName ?? null,
    raceRoomId: opts.raceRoomId ?? null,
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
    suspended: false,
    suspendFrame: null,
    suspendedOffline: false,
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
 * discard=true 时作废：落盘后直接删文件、不建 DB 记录（整场无人完成/重开时用，
 * 原子处理避免与"先落盘再查删"的竞态）。
 * 返回创建的记录（含文件名）；失败返回 null。
 */
export async function stopRecording(
  playerId: number,
  opts?: { quiet?: boolean; rank?: number | null; finished?: boolean | null; discard?: boolean },
): Promise<{ id: string; fileName: string } | null> {
  const session = sessions.get(playerId);
  if (!session) return null;
  sessions.delete(playerId);

  const player = Player.getInstance(playerId);
  // 停止瞬间无条件补一帧当前车辆状态：保证尾帧 = 录制结束位置。
  // （补帧用 getRotationQuat 的 {w,x,y,z} 成员序，与 RakNet 拦截帧的
  // quaternion [w,x,y,z] 统一写帧为 qx=x/qy=y/qz=z/qw=w，两路数据同约定，
  // 不会错位。）
  // 身份校验：落盘路径（断线重连窗口到期/房间销毁等）在玩家断线后执行，playerId
  // 可能已被新连接复用——此时 getInstance 返回新玩家，补帧会把新玩家的车写进旧
  // 录制（尾帧坐标/车型错乱）。auth 为空（已断线）或 userId 对不上（被复用）→ 跳过。
  const auth = getAuthState(playerId);
  if (player && player.isConnected() && auth && auth.userId === session.userId) {
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
  // 钳制到 u16 上限（encodeHeader 写 UInt16LE）：车辆失效期间长时间无帧（爱车爆了
  // 步行几分钟再 /rec stop），间隔会超 65535 → writeUInt16LE 抛 RangeError、整个
  // 录制静默丢失。钳制后帧少段播放时间轴轻微缩短，可接受。
  const frameIntervalMs = Math.min(
    0xffff,
    Math.round(durationMs / Math.max(1, session.frames.length - 1)),
  );
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

  // discard 作废：整场无人完成/重开——落盘即删文件、不建 DB 记录（原子，
  // 避免"先落盘再异步查删"的竞态与孤儿残留）
  if (opts?.discard) {
    deleteRecordingFile(fileName);
    logger.info(`[replay] 作废比赛回放 ${fileName}（playerId=${playerId}）`);
    return null;
  }

  // 录制者身份用 session 快照（startRecording 时从 auth 存）：断线/服务器退出后
  // auth 可能已清（getAuthState 为 undefined），但落盘必须成功——退出/掉线玩家的
  // 比赛录像要保留（endRoom/重连超时/onExit 路径）。空 userId 才防御性删文件。
  if (!session.userId) {
    deleteRecordingFile(fileName);
    logger.warn(`[replay] 录制会话无 userId，删除文件 ${fileName}（playerId=${playerId}）`);
    return null;
  }
  try {
    const created = await prisma.replay.create({
      data: {
        type: session.type,
        userId: session.userId,
        recorderName: session.recorderName || "未知",
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
      player.sendClientMessage(
        COLOR_SUCCESS,
        `录制完成：${(durationMs / 1000).toFixed(1)}s / ${session.frames.length} 帧`,
      );
    }
    // 采样来源诊断（定位录制帧数少/0.1s 问题）：
    // - interceptHits=0 → DriverSync 回调从未触发（插件未转发/包未到达）
    // - interceptHits>0 但 raknetFrames=0 → 回调在但采样失败（readSync 抛错，
    //   已单独打 error 日志）
    // - raknetFrames>0 但总量少 → 玩家没在开车（DriverSync 只在司机位产生）
    // - lastRaknetAt 距停止很远 → 录制中后期拦截中断
    const elapsed = durationMs / 1000;
    const lastHitAgo =
      session.lastRaknetAt > 0 ? ((Date.now() - session.lastRaknetAt) / 1000).toFixed(1) : "无";
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

/** 强制停止录制（断线/离开比赛时调用；断线玩家无提示）。
 *  掉线挂起中的会话跳过不落盘（保持挂起等重连续录）；需要落盘挂起会话的
 *  路径（重连超时/服务器退出）直接调 stopRecording。
 *  自定义（ghost）录制断线即作废：无重连/挂起语义，中断的录制无保留意义，
 *  直接丢弃（不落盘、不建 DB 记录）；比赛（race）录制走落盘/无人完成作废。 */
export async function forceStopRecording(playerId: number): Promise<void> {
  const session = sessions.get(playerId);
  if (!session || session.suspended) return;
  if (session.type === "ghost") {
    dropRecording(playerId);
    return;
  }
  await stopRecording(playerId, { quiet: true });
}

/**
 * 挂起录制（掉线进重连窗口/退赛时调用）：标记挂起 + 缓存最近帧作静止帧数据源，
 * 会话保持不落盘；挂起期间 fallbackSample 生成静止帧（车停在原地）。
 * offline：true = 掉线挂起（静止帧标 online=false，回放显示红字"掉线"）；
 * false = 主动退赛挂起（玩家仍在线，静止帧保持 online=true——标掉线会误导）。
 */
export function suspendRecording(playerId: number, offline = true): void {
  const session = sessions.get(playerId);
  if (!session) return;
  session.suspended = true;
  session.suspendFrame = session.last ?? null; // 最近采样帧（位置/姿态/车型/时间天气血量）
  session.suspendedOffline = offline;
}

/** 重连成功续录：清除挂起标记，startWorld 更新为当前世界（重连后玩家已在比赛世界，
 *  否则 checkRecordingBoundary 的"已离开录制世界"会立即误触发自动停止）。 */
export function resumeRecording(playerId: number): void {
  const session = sessions.get(playerId);
  if (!session) return;
  const player = Player.getInstance(playerId);
  session.suspended = false;
  session.suspendFrame = null;
  session.suspendedOffline = false;
  if (player && player.isConnected()) {
    session.startWorld = player.getVirtualWorld();
  }
}

/** 丢弃录制会话（不落盘、不建 DB 记录）：挂起中的 race 会话在房间销毁/房主重开时
 *  直接清掉，防挂起会话永久悬挂。 */
export function dropRecording(playerId: number): void {
  sessions.delete(playerId);
}

/** 兜底采样定时器（每 500ms）：RakNet 中断时补帧，防播放卡顿 */
function fallbackSample(): void {
  for (const session of sessions.values()) {
    // 掉线挂起：玩家不在线，车停在掉线位置，时间继续流逝——每 100ms 生成一帧
    // 静止帧（位置/姿态/车型/时间天气血量保持掉线帧，速度/按键清零）。重连成功
    // 后 resume 续录，回放可看到"掉线后车停在原地那段的帧"（完整不中断）。
    if (session.suspended && session.suspendFrame) {
      // 时长上限：挂起分支不执行 checkRecordingBoundary，这里单独校验——
      // 挂起会话的静止帧以 10Hz 无限累积（掉线窗口可到 5 分钟，但房间可能
      // 持续很久；防挂机超上限内存帧无限膨胀）
      if (Date.now() - session.startAt > maxRecordMs(session)) {
        void stopRecording(session.playerId, { quiet: true });
        continue;
      }
      if (Date.now() - session.lastSampleAt >= FALLBACK_GAP_MS) {
        const f = session.suspendFrame;
        sample(session, {
          ...f, // 位置/姿态/车型/CP/时间天气/血量保持（车没动）
          vx: 0,
          vy: 0,
          vz: 0, // 速度清零：车停在原地
          keys: 0,
          lrKey: 0,
          udKey: 0,
          additionalKey: 0,
          landingGearState: false,
          sirenState: false,
          trailerId: 0,
          trainSpeed: 0,
          // 掉线挂起标 online:false（回放据此识别掉线段）；主动退赛挂起（玩家仍
          // 在线）保持 true——退赛标掉线会误导观看者
          online: !session.suspendedOffline,
        });
      }
      continue;
    }
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
                // InCarSync quaternion 为 [w,x,y,z]（packet 序），写帧统一
                // 为 qx=x/qy=y/qz=z/qw=w，与 getRotationQuat 补帧同约定
                qw: q[0],
                qx: q[1],
                qy: q[2],
                qz: q[3],
                vx: v[0],
                vy: v[1],
                vz: v[2],
                vehicleModel: session.cacheModel,
                cpProgress: session.cpProgress,
                hour: session.cacheHour,
                minute: session.cacheMinute,
                weather: session.cacheWeather,
                vehicleHealth: session.cacheHealth,
                // DriverSync 完整字段（emulate 回放原样写回）：
                // keys=氮气/转向等按键位集；lrKey/udKey 方向；additionalKey 附加键；
                // landingGearState 起落架；sirenState 警笛；trailerId 拖挂；trainSpeed 火车速度
                keys: sync.keys,
                lrKey: sync.lrKey,
                udKey: sync.udKey,
                additionalKey: sync.additionalKey,
                landingGearState: !!sync.landingGearState,
                sirenState: !!sync.sirenState,
                trailerId: sync.trailerId ?? 0,
                trainSpeed: sync.trainSpeed ?? 0,
                online: true, // RakNet 拦截帧 = 玩家在线
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
  // 服务器退出：全部落盘（含挂起中的掉线会话——保留静止段；forceStopRecording
  // 会跳过挂起会话，这里直接用 stopRecording）
  const ids = [...sessions.keys()];
  for (const id of ids) {
    await stopRecording(id, { quiet: true });
  }
}
