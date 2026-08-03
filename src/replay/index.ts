import { Player } from "@infernus/core";
import { logger } from "@/logger";
import { initReplayCommands } from "./commands";
import { initRecorder, cleanupRecorder, forceStopRecording, isRecording, startRecording, stopRecording } from "./recorder";
import { cleanupPlayback, destroyAllPlaybacks } from "./playback";
import { ensureRecordingDir } from "./storage";

/**
 * 回放系统总入口：
 * - GameMode.onInit 建录制目录
 * - initReplayCommands 注册命令；initRecorder 挂 RakNet 拦截 + 兜底采样
 * - onExit 销毁全部回放会话/NPC/车辆 + 录制强制落盘
 */

/** 初始化回放系统（callbacks init 序列调用） */
export function initReplay(): void {
  ensureRecordingDir();
  initReplayCommands();
  initRecorder();
  logger.info("[replay] 回放系统已初始化");
}

/** 玩家断线清理（callbacks onDisconnect 调用）：录制强制落盘 + 回放会话销毁 */
export function cleanupReplay(playerId: number): void {
  if (isRecording(playerId)) {
    void forceStopRecording(playerId);
  }
  cleanupPlayback(playerId);
}

/**
 * 比赛自动录制钩子（room.ts 调用）：
 * startRace/beginRace 时对每个成员开启录制（type=race）；endRoom 时停止。
 */
export function raceRecordingStart(playerId: number, opts?: { raceId?: string; raceName?: string }): void {
  void forceStopRecording(playerId); // 防残留（重复开赛/重连）
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  void startRecording(p, { type: "race", raceId: opts?.raceId ?? null, raceName: opts?.raceName ?? null });
}

/** 比赛结束/离开时停止录制（落盘 + 元数据含名次） */
export function raceRecordingStop(playerId: number, meta?: { rank?: number | null; finished?: boolean | null }): void {
  if (isRecording(playerId)) {
    void stopRecording(playerId, { quiet: true, ...meta });
  }
}

/** 服务器退出：全部回放销毁 + 录制落盘 */
export function shutdownReplay(): void {
  destroyAllPlaybacks();
  void cleanupRecorder();
}
