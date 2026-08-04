import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@/logger";

/**
 * 回放文件存储（数据本体存文件，元数据存 DB replay 表）。
 * 目录：scriptfiles/recordings/（与 npcmodes/recordings 并列，随服务器根目录运行）。
 */

export const RECORDING_DIR = "scriptfiles/recordings";

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
