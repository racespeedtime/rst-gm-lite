import { readFileSync } from "node:fs";

/**
 * 回放文件二进制格式（rec v3，存于 scriptfiles/recordings/）：
 * - 定长 Header + 定长帧 Body；帧 = 位置(3×f32) + 四元数(4×f32) + 速度(3×f32)
 *   + 车型(i32) + CP进度(i32) + 时(u8) + 分(u8) + 天气(u8) + 血量(f32)
 * - 定长帧设计：seek/后退/快进 = O(1) 偏移直取，无需顺序解析；
 *   回放时整文件读入内存 Buffer，纯内存切帧零 IO
 *
 * 为什么帧要带"完整状态"（车型/CP进度/时间/天气/血量）：
 * CP 脚本是离散事件（cveh 换车、time/weather、fix/damage），NPC 回放不会
 * 重新触发 onPlayerReachCp。若只录位置，seek/回退到某帧时"事件顺序"必然
 * 错乱。改为每帧记录那一刻的完整可观测状态——事件的效果已编码进后续帧
 * （换车后的车型、改过的时间/天气），seek = 恢复状态而非重放事件，天然
 * 无时序问题。观战者的比赛 TD（C P/TIME）也从帧状态渲染，不依赖事件。
 *
 * 兼容性设计（向后兼容：新版本读旧文件，旧版本不读新文件）：
 * - 版本号递增；头/帧字段一律"尾部追加"，旧字段偏移永不改动
 * - v3 起 header 末尾自描述 frameBytes（帧字节数）——未来帧加字段时版本
 *   +1 且 frameBytes 写入新值，旧文件按各自帧布局照常解析，零破坏
 * - 读端 parseHeader/parseReplayFile 按版本分支：v2 头 72B / 帧 55B，
 *   v3 头 76B（多 4B frameBytes）/ 帧仍 55B
 */

/** 魔数 + 版本（首个 8 字节签名，兼容性/损坏检测） */
const MAGIC = "RSTREP01";
/** 当前格式版本：v3 引入 header 自描述 frameBytes */
export const FORMAT_VERSION = 3;

/** 录制类型 */
export const REPLAY_TYPE_GHOST = 0;
export const REPLAY_TYPE_RACE = 1;

/** v2：帧 55B = pos12 + quat16 + vel12 + model4 + cp4 + hour1 + min1 + weather1 + health4 */
const FRAME_BYTES_V2 = 55;
/** v2：头 72B = magic8 + ver1 + type1 + interval2 + model4 + pos12 + quat16 + vel12 + count4 + dur4 + totalCp4 + bestMs4 */
const HEADER_BYTES_V2 = 72;
/** v3：头 76B = v2 头 + frameBytes4（自描述，未来帧字段追加零破坏） */
const HEADER_BYTES_V3 = HEADER_BYTES_V2 + 4;

/** 当前帧字节数（v3 帧布局仍 55；未来加字段时版本 +1 并更新此值） */
export const FRAME_BYTES = FRAME_BYTES_V2;
/** 当前头字节数（v3） */
export const HEADER_BYTES = HEADER_BYTES_V3;

/** 版本 → 头字节数（向后兼容 v2） */
export function headerBytesFor(version: number): number {
  return version >= 3 ? HEADER_BYTES_V3 : HEADER_BYTES_V2;
}

/** 版本 → 帧字节数（向后兼容 v2） */
export function frameBytesFor(version: number): number {
  return version >= 3 ? FRAME_BYTES_V2 : FRAME_BYTES_V2;
}

export interface ReplayFrame {
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
  /** 该帧车辆模型（cveh 换车后变化 → 回放据此重建车辆） */
  vehicleModel: number;
  /** 已完成的 CP 数（lap×总数+当前+1；非比赛录制为 0） */
  cpProgress: number;
  hour: number;
  minute: number;
  weather: number;
  vehicleHealth: number;
}

export interface ReplayHeader {
  type: number; // REPLAY_TYPE_*
  frameIntervalMs: number;
  vehicleModelId: number;
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
  frameCount: number;
  durationMs: number;
  /** 赛道 CP 总数（回放 C P TD 的分母；非比赛录制为 0） */
  totalCp: number;
  /** 录制者该赛道个人最佳（毫秒，回放 BEST TD；无则 -1） */
  bestMs: number;
  /** 帧字节数（自描述；v2 兼容 = 55） */
  frameBytes: number;
}

/** 已解析的回放文件（整文件读入内存，帧为纯内存切片） */
export interface ReplayData {
  header: ReplayHeader;
  /** 该文件的头字节数（按版本） */
  headerBytes: number;
  frames: Buffer; // Body 切片（从 header 末尾开始）
}

const V = (n: number): number => (Number.isFinite(n) ? n : 0);
const U8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** 编码 Header（当前版本 v3：末尾带 frameBytes）→ Buffer */
export function encodeHeader(h: ReplayHeader): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_BYTES);
  buf.write(MAGIC, 0, "ascii");
  let o = 8;
  buf.writeUInt8(FORMAT_VERSION, o);
  o += 1;
  buf.writeUInt8(h.type, o);
  o += 1;
  buf.writeUInt16LE(h.frameIntervalMs, o);
  o += 2;
  buf.writeInt32LE(h.vehicleModelId, o);
  o += 4;
  buf.writeFloatLE(V(h.startX), o);
  o += 4;
  buf.writeFloatLE(V(h.startY), o);
  o += 4;
  buf.writeFloatLE(V(h.startZ), o);
  o += 4;
  buf.writeFloatLE(V(h.qx), o);
  o += 4;
  buf.writeFloatLE(V(h.qy), o);
  o += 4;
  buf.writeFloatLE(V(h.qz), o);
  o += 4;
  buf.writeFloatLE(V(h.qw), o);
  o += 4;
  buf.writeFloatLE(V(h.vx), o);
  o += 4;
  buf.writeFloatLE(V(h.vy), o);
  o += 4;
  buf.writeFloatLE(V(h.vz), o);
  o += 4;
  buf.writeUInt32LE(h.frameCount, o);
  o += 4;
  buf.writeUInt32LE(h.durationMs, o);
  o += 4;
  buf.writeInt32LE(h.totalCp, o);
  o += 4;
  buf.writeInt32LE(h.bestMs, o);
  o += 4;
  buf.writeUInt32LE(h.frameBytes, o); // v3：自描述帧字节数
  return buf;
}

/** 编码单帧 → Buffer（当前帧布局 55B） */
export function encodeFrame(f: ReplayFrame): Buffer {
  const buf = Buffer.allocUnsafe(FRAME_BYTES);
  buf.writeFloatLE(V(f.x), 0);
  buf.writeFloatLE(V(f.y), 4);
  buf.writeFloatLE(V(f.z), 8);
  buf.writeFloatLE(V(f.qx), 12);
  buf.writeFloatLE(V(f.qy), 16);
  buf.writeFloatLE(V(f.qz), 20);
  buf.writeFloatLE(V(f.qw), 24);
  buf.writeFloatLE(V(f.vx), 28);
  buf.writeFloatLE(V(f.vy), 32);
  buf.writeFloatLE(V(f.vz), 36);
  buf.writeInt32LE(f.vehicleModel | 0, 40);
  buf.writeInt32LE(f.cpProgress | 0, 44);
  buf.writeUInt8(U8(f.hour), 48);
  buf.writeUInt8(U8(f.minute), 49);
  // 天气 0-255：必须用 UInt8（writeInt8 范围 -128..127，weather>127 会抛 RangeError 导致录制丢失）
  buf.writeUInt8(U8(f.weather), 50);
  buf.writeFloatLE(V(f.vehicleHealth), 51);
  return buf;
}

/** 解析 Header（按版本分支：v2 头 72B 无 frameBytes，v3 头 76B 带 frameBytes）。格式损坏抛 Error。 */
export function parseHeader(buf: Buffer): ReplayHeader {
  if (buf.length < HEADER_BYTES_V2) throw new Error("回放文件头损坏");
  if (buf.toString("ascii", 0, 8) !== MAGIC) throw new Error("不是有效的回放文件");
  const version = buf.readUInt8(8);
  if (version < 2) throw new Error(`不支持的版本 ${version}`);
  let o = 9;
  const type = buf.readUInt8(o);
  o += 1;
  const frameIntervalMs = buf.readUInt16LE(o);
  o += 2;
  const vehicleModelId = buf.readInt32LE(o);
  o += 4;
  const startX = buf.readFloatLE(o);
  o += 4;
  const startY = buf.readFloatLE(o);
  o += 4;
  const startZ = buf.readFloatLE(o);
  o += 4;
  const qx = buf.readFloatLE(o);
  o += 4;
  const qy = buf.readFloatLE(o);
  o += 4;
  const qz = buf.readFloatLE(o);
  o += 4;
  const qw = buf.readFloatLE(o);
  o += 4;
  const vx = buf.readFloatLE(o);
  o += 4;
  const vy = buf.readFloatLE(o);
  o += 4;
  const vz = buf.readFloatLE(o);
  o += 4;
  const frameCount = buf.readUInt32LE(o);
  o += 4;
  const durationMs = buf.readUInt32LE(o);
  o += 4;
  const totalCp = buf.readInt32LE(o);
  o += 4;
  const bestMs = buf.readInt32LE(o);
  // 版本分支：v3 起末尾多 4B frameBytes（自描述）；v2 无该字段用固定 55
  const frameBytes = version >= 3 ? buf.readUInt32LE(o + 4) : FRAME_BYTES_V2;
  return { type, frameIntervalMs, vehicleModelId, startX, startY, startZ, qx, qy, qz, qw, vx, vy, vz, frameCount, durationMs, totalCp, bestMs, frameBytes };
}

/** 读取并解析回放文件（整文件入内存；帧体切片供 O(1) 随机访问）。损坏抛 Error。 */
export function parseReplayFile(filePath: string): ReplayData {
  const buf = readFileSync(filePath);
  const header = parseHeader(buf);
  const headerBytes = headerBytesFor(readVersion(buf));
  const frames = buf.subarray(headerBytes);
  // 帧数与文件长度一致性校验（用文件内自描述的 frameBytes，兼容未来帧加字段）
  if (frames.length < header.frameCount * header.frameBytes) {
    throw new Error("回放文件数据不完整");
  }
  return { header, headerBytes, frames };
}

/** 读魔数后的版本号（parseHeader 内部用，避免二次解析） */
function readVersion(buf: Buffer): number {
  return buf.readUInt8(8);
}

/** 第 index 帧的起始偏移（帧体切片内） */
export function frameOffset(index: number, frameBytes: number): number {
  return index * frameBytes;
}

/** 解码帧体切片（越界返回 null）。frameBytes 用文件内自描述值（兼容未来版本）。 */
export function decodeFrame(buf: Buffer, index: number, frameBytes: number): ReplayFrame | null {
  const o = index * frameBytes;
  if (o + frameBytes > buf.length) return null;
  // 帧字段均为尾部追加设计：旧字段固定在前部偏移（55B 内），
  // 未来帧加字段只会追加在尾部，不影响旧字段读取
  return {
    x: buf.readFloatLE(o),
    y: buf.readFloatLE(o + 4),
    z: buf.readFloatLE(o + 8),
    qx: buf.readFloatLE(o + 12),
    qy: buf.readFloatLE(o + 16),
    qz: buf.readFloatLE(o + 20),
    qw: buf.readFloatLE(o + 24),
    vx: buf.readFloatLE(o + 28),
    vy: buf.readFloatLE(o + 32),
    vz: buf.readFloatLE(o + 36),
    vehicleModel: buf.readInt32LE(o + 40),
    cpProgress: buf.readInt32LE(o + 44),
    hour: buf.readUInt8(o + 48),
    minute: buf.readUInt8(o + 49),
    weather: buf.readUInt8(o + 50),
    vehicleHealth: buf.readFloatLE(o + 51),
  };
}

/** 帧间线性插值（t∈[0,1]；离散状态字段取最近帧不做插值） */
export function lerpFrame(a: ReplayFrame, b: ReplayFrame, t: number): ReplayFrame {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    qx: a.qx + (b.qx - a.qx) * t,
    qy: a.qy + (b.qy - a.qy) * t,
    qz: a.qz + (b.qz - a.qz) * t,
    qw: a.qw + (b.qw - a.qw) * t,
    vx: a.vx + (b.vx - a.vx) * t,
    vy: a.vy + (b.vy - a.vy) * t,
    vz: a.vz + (b.vz - a.vz) * t,
    // 离散状态：取最近帧（t<0.5 用 a，否则用 b）——不插值避免中间状态错乱
    vehicleModel: t < 0.5 ? a.vehicleModel : b.vehicleModel,
    cpProgress: t < 0.5 ? a.cpProgress : b.cpProgress,
    hour: t < 0.5 ? a.hour : b.hour,
    minute: t < 0.5 ? a.minute : b.minute,
    weather: t < 0.5 ? a.weather : b.weather,
    vehicleHealth: t < 0.5 ? a.vehicleHealth : b.vehicleHealth,
  };
}
