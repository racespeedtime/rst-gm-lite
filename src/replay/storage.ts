import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  renameSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "@/logger";

/**
 * 回放文件存储（数据本体存文件，元数据存 DB replay 表）。
 * 目录：scriptfiles/recordings/（与 npcmodes/recordings 并列，随服务器根目录运行）。
 */

export const RECORDING_DIR = "scriptfiles/recordings";

/**
 * 待落库索引文件（recordings/index.json）：
 * 落盘但 DB 记录未确认（create 未 settle / 抛异常）的录像条目。同步 fs 写——
 * 服务器退出瞬间（onExit 同步钩子）也能可靠写完；重启时补建 DB 记录后清条目，
 * 防"文件写了但无索引 → 孤儿清理误删"（DB 抖动/退出即丢录像）。
 */
export const PENDING_INDEX = join(RECORDING_DIR, "index.json");

/** 待落库条目字段 = 重建 DB replay 记录所需的全部 */
export interface PendingReplayEntry {
  type: string;
  userId: string;
  recorderName: string;
  raceId: string | null;
  raceName: string | null;
  vehicleModelId: number;
  fileName: string;
  durationMs: number;
  frameCount: number;
  fileSize: number;
  rank: number | null;
  finished: boolean | null;
  raceRoomId: number | null;
}

/** 读取待落库索引（文件不存在/损坏返回空数组） */
export function readPendingIndex(): PendingReplayEntry[] {
  try {
    if (!existsSync(PENDING_INDEX)) return [];
    const raw = readFileSync(PENDING_INDEX, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    logger.error(`[replay] 读待落库索引失败`, e);
    return [];
  }
}

/** 写待落库索引（整体覆写，原子：临时文件 + rename——防进程中断留下截断 JSON，
 *  否则下次读失败返回 [] 会把既有 pending 条目静默清掉、对应 .rec 被孤儿清理删） */
export function writePendingIndex(entries: PendingReplayEntry[]): void {
  try {
    ensureRecordingDir();
    const tmp = `${PENDING_INDEX}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    rmSync(PENDING_INDEX, { force: true }); // Windows rename 无法覆盖已存在文件
    renameSync(tmp, PENDING_INDEX);
  } catch (e) {
    logger.error(`[replay] 写待落库索引失败`, e);
  }
}

/** 新增一条待落库条目（落盘后、create 前调用；同步写防退出丢索引） */
export function addPendingEntry(entry: PendingReplayEntry): void {
  const entries = readPendingIndex();
  if (!entries.some((x) => x.fileName === entry.fileName)) {
    entries.push(entry);
  }
  writePendingIndex(entries);
}

/** 移除一条待落库条目（create 成功后调用，零残留） */
export function removePendingEntry(fileName: string): void {
  const entries = readPendingIndex();
  const next = entries.filter((x) => x.fileName !== fileName);
  if (next.length !== entries.length) {
    writePendingIndex(next);
  }
}

/** 建目录（递归）。GameMode.onInit 时调用；失败仅告警不崩溃 */
export function ensureRecordingDir(): void {
  try {
    if (!existsSync(RECORDING_DIR)) {
      mkdirSync(RECORDING_DIR, { recursive: true });
    }
  } catch (e) {
    logger.error(`[replay] 创建录制目录失败`, e);
  }
}

/**
 * 写回放文件（原子性：先写临时文件再 rename，防录制中断留下半个文件）。
 * 返回文件名（不含目录）；失败返回 null。
 */
export function saveRecordingFile(fileName: string, data: Buffer): boolean {
  try {
    ensureRecordingDir();
    const tmp = join(RECORDING_DIR, `${fileName}.tmp`);
    writeFileSync(tmp, data);
    const final = join(RECORDING_DIR, fileName);
    rmSync(final, { force: true }); // Windows rename 无法覆盖已存在文件
    renameSync(tmp, final);
    return true;
  } catch (e) {
    logger.error(`[replay] 写回放文件失败 ${fileName}`, e);
    return false;
  }
}

/** 删除回放文件（软删记录时同步清文件） */
export function deleteRecordingFile(fileName: string): void {
  try {
    rmSync(join(RECORDING_DIR, fileName), { force: true });
  } catch (e) {
    logger.error(`[replay] 删除回放文件失败 ${fileName}`, e);
  }
}

/**
 * 清理孤儿回放文件 + .tmp 残留：
 * - knownNames：DB 中仍有效（deletedAt=null）的文件名集合 = 磁盘上应保留的合法文件
 * - 磁盘文件不在 knownNames 里 → 孤儿（录制写文件后 DB 失败、软删时删文件失败等
 *   历史残留）→ 删除；在 knownNames 里的合法文件一律保留
 * - 所有 .tmp：上次写文件中断留下的半成品 → 删除
 * 服务器启动时调用（GameMode.onInit）。
 */
export function cleanupOrphanFiles(knownNames: string[]): void {
  const known = new Set(knownNames);
  try {
    if (!existsSync(RECORDING_DIR)) return;
    for (const f of readdirSync(RECORDING_DIR)) {
      const full = join(RECORDING_DIR, f);
      if (f.endsWith(".tmp")) {
        rmSync(full, { force: true });
        logger.warn(`[replay] 清理残留临时文件 ${f}`);
      } else if (!known.has(f)) {
        rmSync(full, { force: true });
        logger.warn(`[replay] 清理孤儿回放文件 ${f}`);
      }
    }
  } catch (e) {
    logger.error(`[replay] 清理孤儿文件失败`, e);
  }
}
