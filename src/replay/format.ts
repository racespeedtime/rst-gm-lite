import { readFileSync } from "node:fs";

/**
 * 回放文件二进制格式（rec v1，存于 scriptfiles/recordings/）：
 * - 定长 Header（64 字节）+ 定长帧 Body（每帧 40 字节）
 * - 帧 = 位置(3×f32) + 四元数(4×f32) + 速度(3×f32)
 * - 定长帧设计：seek/后退/快进 = O(1) 偏移直取，无需顺序解析；
 *   回放时整文件读入内存 Buffer，纯内存切帧零 IO
 *
 * 四元数为 SA 引擎标准（记录与回放同一约定，方向自洽）；
 * 回放侧的旋转写入在 playback.ts 里做四元数→欧拉转换。
 */

/** 魔数 + 版本（首个 8 字节签名，兼容性/损坏检测） */
const MAGIC = "RSTREP01";

/** 录制类型 */
export const REPLAY_TYPE_GHOST = 0;
export const REPLAY_TYPE_RACE = 1;

export const FRAME_BYTES = 40; // position 3×f32 + quaternion 4×f32 + velocity 3×f32
export const HEADER_BYTES = 64; // magic8 + ver1 + type1 + interval2 + model4 + pos12 + quat16 + vel12 + count4 + dur4

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
}

/** 已解析的回放文件（整文件读入内存，帧为纯内存切片） */
export interface ReplayData {
  header: ReplayHeader;
  frames: Buffer; // Body 切片（从 header 末尾开始）
}

const V = (n: number): number => (Number.isFinite(n) ? n : 0);

/** 编码 Header → Buffer（录制结束写文件用） */
export function encodeHeader(h: ReplayHeader): Buffer {
  const buf = Buffer.allocUnsafe(HEADER_BYTES);
  buf.write(MAGIC, 0, "ascii");
  let o = 8;
  buf.writeUInt8(1, o); // version
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
  return buf;
}

/** 解析 Header（从文件前 HEADER_BYTES 字节）。格式损坏抛 Error。 */
export function parseHeader(buf: Buffer): ReplayHeader {
  if (buf.length < HEADER_BYTES) throw new Error("回放文件头损坏");
  if (buf.toString("ascii", 0, 8) !== MAGIC) throw new Error("不是有效的回放文件");
  const version = buf.readUInt8(8);
  if (version !== 1) throw new Error(`不支持的版本 ${version}`);
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
  return { type, frameIntervalMs, vehicleModelId, startX, startY, startZ, qx, qy, qz, qw, vx, vy, vz, frameCount, durationMs };
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
  };
}

/** 帧间线性插值（t∈[0,1]） */
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
  };
}
