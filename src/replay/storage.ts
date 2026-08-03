import { existsSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, renameSync } from "node:fs";
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

/** 文件是否存在 + 大小 */
export function recordingFileInfo(fileName: string): { size: number } | null {
  try {
    const p = join(RECORDING_DIR, fileName);
    if (!existsSync(p)) return null;
    return { size: statSync(p).size };
  } catch {
    return null;
  }
}

/** 列出录制目录全部文件（含大小；临时文件 .tmp 过滤） */
export function listRecordingFiles(): { name: string; size: number }[] {
  try {
    if (!existsSync(RECORDING_DIR)) return [];
    return readdirSync(RECORDING_DIR)
      .filter((f) => !f.endsWith(".tmp"))
      .map((f) => ({ name: f, size: statSync(join(RECORDING_DIR, f)).size }))
      .sort((a, b) => b.size - a.size);
  } catch (e) {
    logger.error(`[replay] 列出录制目录失败`, e);
    return [];
  }
}
