import { Player } from "@infernus/core";
import { IPacket, PacketIdList } from "@infernus/raknet";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { setTimeoutSafe } from "@/core/timers";
import { deleteRecordingFile } from "./storage";
import { initReplayCommands } from "./commands";
import {
  initRecorder,
  cleanupRecorder,
  forceStopRecording,
  isRecording,
  startRecording,
  stopRecording,
} from "./recorder";
import {
  cleanupPlayback,
  destroyAllPlaybacks,
  stopReplaySession,
  getReplaySession,
  isReplayNpc,
} from "./playback";
import {
  initChallenge,
  destroyAllChallenges,
  challengeDisconnect,
  cleanupChallenge,
} from "./challenge";
import { ensureRecordingDir, cleanupOrphanFiles } from "./storage";

/**
 * 回放系统总入口：
 * - GameMode.onInit 建录制目录 + 清理孤儿文件/.tmp 残留
 * - initReplayCommands 注册命令；initRecorder 挂 RakNet 拦截 + 兜底采样
 * - initChallenge 注册影子挑战 CP 检测（与比赛共用 RaceCpEvent 入口）
 * - onExit 销毁全部回放/挑战会话/NPC/车辆 + 录制强制落盘
 */

/** 初始化回放系统（callbacks init 序列调用） */
export function initReplay(): void {
  ensureRecordingDir();
  // 启动清理：孤儿回放文件（DB 无记录但文件在）与 .tmp 残留（写文件中断半成品）
  void (async () => {
    try {
      const recorded = await prisma.replay.findMany({
        where: { deletedAt: null },
        select: { fileName: true },
      });
      const names = new Set(recorded.map((r) => r.fileName));
      cleanupOrphanFiles([...names]);
    } catch (e) {
      logger.error(`[replay] 孤儿文件扫描失败`, e);
    }
  })();
  initReplayCommands();
  initRecorder();
  initChallenge();
  // 屏蔽回放 NPC 的真实 sync 包：回放驱动改为 emulateIncomingPacket 模拟
  // DriverSync 传入（emulate 的包不会进 onIncomingPacket 回调），但 NPC 自身/
  // 残留状态（putInVehicle/setVehiclePos immediate 等）可能发真实 sync，
  // 会与模拟广播冲突（位置/速度打架）——直接丢弃不交给游戏处理。
  // Pawn.RakNet 修复版约定：return false(0) = 舍弃该包（不交给游戏/后续 handler）。
  // IPacket 是 samp.on 事件注册（与 PlayerEvent 同构），模块导入期注册即有效。
  try {
    IPacket(PacketIdList.DriverSync, ({ playerId, next }) => {
      if (isReplayNpc(playerId)) return false; // 舍弃（不转发给游戏）
      return next();
    });
    IPacket(PacketIdList.OnFootSync, ({ playerId, next }) => {
      if (isReplayNpc(playerId)) return false;
      return next();
    });
  } catch (e) {
    logger.warn(`[replay] 回放 NPC sync 屏蔽注册失败`, e);
  }
  logger.info("[replay] 回放系统已初始化");
}

/** 玩家断线清理（callbacks onDisconnect 调用）：录制强制落盘 + 回放/挑战会话销毁 */
export function cleanupReplay(playerId: number): void {
  if (isRecording(playerId)) {
    void forceStopRecording(playerId);
  }
  cleanupPlayback(playerId);
  challengeDisconnect(playerId);
}

/**
 * 玩家离开当前活动状态（进入比赛/房间切换）：停止其回放会话 + 影子挑战。
 * 比赛中 /rp 命令被白名单拦截无法主动停回放，且挑战世界与比赛世界隔离——
 * 不清理会留下挂机 ghost（进比赛时自动清理，防 ghost 残留/挑战残留）。
 */
export function stopReplayForPlayer(playerId: number): void {
  if (getReplaySession(playerId)) {
    stopReplaySession(playerId);
  }
  cleanupChallenge(playerId);
}

/**
 * 比赛自动录制钩子（room.ts 调用）：
 * startRace/beginRace 时对每个成员开启录制（type=race）；endRoom 时停止。
 */
export function raceRecordingStart(
  playerId: number,
  opts?: { raceId?: string; raceName?: string },
): void {
  void forceStopRecording(playerId); // 防残留（重复开赛/重连）
  const p = Player.getInstance(playerId);
  if (!p || !p.isConnected()) return;
  void startRecording(p, {
    type: "race",
    raceId: opts?.raceId ?? null,
    raceName: opts?.raceName ?? null,
  });
}

/** 比赛结束/离开时停止录制（落盘 + 元数据含名次） */
export function raceRecordingStop(
  playerId: number,
  meta?: { rank?: number | null; finished?: boolean | null },
): void {
  if (isRecording(playerId)) {
    void stopRecording(playerId, { quiet: true, ...meta });
  }
}

/**
 * 作废一次已落盘的比赛回放（整场无人完成）：删录像文件 + 软删 DB 记录。
 * 用于"房间销毁且无人完成"和"掉线重连成功删掉线段"——删除前留 800ms
 * 让刚触发的 stopRecording 落盘完成（断线走 forceStopRecording 是异步的，
 * 立即查可能查到旧记录）。raceId 限定该场比赛，防误删同用户其他比赛记录。
 * userId 为可选快照（room.raceMembersLast 存）：掉线/重连超时玩家 auth 已清，
 * 必须靠快照才能离线作废其未完成录像，否则文件 + DB 记录永久泄漏。
 */
export function discardRaceReplay(playerId: number, raceId?: string | null, userId?: string): void {
  setTimeoutSafe(async () => {
    // 优先用快照 userId；无快照（历史调用）回退在线 auth
    const uid = userId ?? getAuthState(playerId)?.userId;
    if (!uid) return;
    try {
      const row = await prisma.replay.findFirst({
        where: {
          userId: uid,
          type: "race",
          deletedAt: null,
          ...(raceId ? { raceId } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      // 只作废"未完成"段（rank==null）；有 rank 说明该段有人冲线，保留
      if (!row || row.rank != null) return;
      deleteRecordingFile(row.fileName);
      await prisma.replay.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
      logger.info(`[replay] 作废无人完成的比赛回放 ${row.fileName}（playerId=${playerId}）`);
    } catch (e) {
      logger.error(`[replay] 作废比赛回放失败 playerId=${playerId}`, e);
    }
  }, 800);
}

/** 服务器退出：全部回放/挑战销毁 + 录制落盘 */
export function shutdownReplay(): void {
  destroyAllPlaybacks();
  destroyAllChallenges();
  void cleanupRecorder();
}
