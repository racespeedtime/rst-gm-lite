import { readFileSync } from "node:fs";

/**
 * 回放文件二进制格式（rec v2，存于 scriptfiles/recordings/）：
 * - 定长 Header（72 字节）+ 定长帧 Body（每帧 55 字节）
 * - 帧 = 位置(3×f32) + 四元数(4×f32) + 速度(3×f32) + 车型(i32) +
 *       CP进度(i32) + 时(u8) + 分(u8) + 天气(i8) + 血量(f32)
 * - 定长帧设计：seek/后退/快进 = O(1) 偏移直取，无需顺序解析；
 *   回放时整文件读入内存 Buffer，纯内存切帧零 IO
 *
 * 为什么帧要带"完整状态"（车型/CP进度/时间/天气/血量）：
 * CP 脚本是离散事件（cveh 换车、time/weather、fix/damage），NPC 回放不会
 * 重新触发 onPlayerReachCp。若只录位置，seek/回退到某帧时"事件顺序"必然
 * 错乱。改为每帧记录那一刻的完整可观测状态——事件的效果已编码进后续帧
 * （换车后的车型、改过的时间/天气），seek = 恢复状态而非重放事件，天然
 * 无时序问题。观战者的比赛 TD（C P/TIME）也从帧状态渲染，不依赖事件。
 */

/** 魔数 + 版本（首个 8 字节签名，兼容性/损坏检测） */
const MAGIC = "RSTREP01";
/** 格式版本：v2 引入帧内完整状态（车型/CP进度/时间天气/血量） */
const FORMAT_VERSION = 2;

/** 录制类型 */
export const REPLAY_TYPE_GHOST = 0;
export const REPLAY_TYPE_RACE = 1;

/** 帧字节数 = 12+16+12 + 4+4 + 1+1+1 + 4 = 55 */
export const FRAME_BYTES = 55;
/** 头字节数 = magic8 + ver1 + type1 + interval2 + model4 + pos12 + quat16 + vel12 + count4 + dur4 + totalCp4 + bestMs4 = 72 */
export const HEADER_BYTES = 72;

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
}

/** 已解析的回放文件（整文件读入内存，帧为纯内存切片） */
export interface ReplayData {
  header: ReplayHeader;
  frames: Buffer; // Body 切片（从 header 末尾开始）
}

const V = (n: number): number => (Number.isFinite(n) ? n : 0);
const U8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** 编码 Header → Buffer（录制结束写文件用） */
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
  return buf;
}

/** 编码单帧 → Buffer（录制结束写文件用） */
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

/** 解析 Header（从文件前 HEADER_BYTES 字节）。格式损坏抛 Error。 */
export function parseHeader(buf: Buffer): ReplayHeader {
  if (buf.length < HEADER_BYTES) throw new Error("回放文件头损坏");
  if (buf.toString("ascii", 0, 8) !== MAGIC) throw new Error("不是有效的回放文件");
  const version = buf.readUInt8(8);
  if (version !== FORMAT_VERSION) throw new Error(`不支持的版本 ${version}`);
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
  return { type, frameIntervalMs, vehicleModelId, startX, startY, startZ, qx, qy, qz, qw, vx, vy, vz, frameCount, durationMs, totalCp, bestMs };
}

/** 读取并解析回放文件（整文件入内存；帧体切片供 O(1) 随机访问）。损坏抛 Error。 */
export function parseReplayFile(filePath: string): ReplayData {
  const buf = readFileSync(filePath);
  const header = parseHeader(buf);
  const frames = buf.subarray(HEADER_BYTES);
  // 帧数与文件长度一致性校验（防截断/损坏）
  if (frames.length < header.frameCount * FRAME_BYTES) {
    throw new Error("回放文件数据不完整");
  }
  return { header, frames };
}

/** 第 index 帧的起始偏移（帧体切片内） */
export function frameOffset(index: number): number {
  return index * FRAME_BYTES;
}

/** 解码帧体切片（越界返回 null） */
export function decodeFrame(buf: Buffer, index: number): ReplayFrame | null {
  const o = frameOffset(index);
  if (o + FRAME_BYTES > buf.length) return null;
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
