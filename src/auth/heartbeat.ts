import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { setIntervalSafe } from "@/core/timers";
import { getOnlineSessionIds } from "./auth";

/** 心跳间隔（毫秒） */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** 失活阈值：超过该时长未收到心跳视为异常掉线（3 次心跳未到） */
export const STALE_THRESHOLD_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * 把 status=ONLINE 且最后心跳早于 cutoff 的会话更正为 OFFLINE。
 * 计算 duration（用最后心跳时间作为下线时间的近似）。
 * 幂等：正常断线已关闭的会话不在结果里。
 * onlineIds：进程内仍认为在线的 sessionId（authStates + pendingSessions）——
 * 必须排除它们：心跳写入（步骤1）若因 DB 抖动失败，在线玩家的 last_heartbeat_at
 * 仍是旧值，不排除会被误标 OFFLINE 且不可逆（后续心跳只刷心跳时间、不碰 status）。
 */
async function markStaleSessionsOffline(cutoff: Date, onlineIds?: string[]): Promise<number> {
  const stale = await prisma.sysUserGameSession.findMany({
    where: {
      status: "ONLINE",
      lastHeartbeatAt: { lt: cutoff },
      ...(onlineIds && onlineIds.length > 0 ? { id: { notIn: onlineIds } } : {}),
    },
  });
  if (stale.length === 0) return 0;
  // 批量更正（事务内逐条算 duration = 最后心跳 - 登录时间）
  await prisma.$transaction(
    stale.map((s) =>
      prisma.sysUserGameSession.update({
        where: { id: s.id },
        data: {
          status: "OFFLINE",
          logoutAt: s.lastHeartbeatAt,
          duration: Math.max(
            0,
            Math.floor((s.lastHeartbeatAt.getTime() - s.loginAt.getTime()) / 1000),
          ),
        },
      }),
    ),
  );
  return stale.length;
}

/**
 * 心跳 tick：
 * 1. 批量更新所有在线玩家（authStates + pendingSessions）的 last_heartbeat_at
 * 2. 把超时未心跳的 ONLINE 会话更正为 OFFLINE（排除进程内仍在线者——防
 *    步骤1 因 DB 抖动失败时把在线玩家误标离线）
 */
async function heartbeatTick(): Promise<void> {
  // 进程内在线会话集合（步骤1 刷新用 + 步骤2 排除用）
  const ids = getOnlineSessionIds();
  // 1. 心跳写入（一条批量 SQL）
  if (ids.length > 0) {
    try {
      await prisma.sysUserGameSession.updateMany({
        where: { id: { in: ids } },
        data: { lastHeartbeatAt: new Date() },
      });
    } catch (e) {
      logger.error("[heartbeat] 心跳写入失败", e);
    }
  }
  // 2. 失活更正（覆盖 onDisconnect 未触发的异常掉线 / 服务器崩溃残留）。
  // 排除进程内在线会话：心跳写失败时在线玩家的 DB 心跳时间未刷新，若不排除
  // 会被误标 OFFLINE（见 markStaleSessionsOffline 注释）
  try {
    const corrected = await markStaleSessionsOffline(
      new Date(Date.now() - STALE_THRESHOLD_MS),
      ids,
    );
    if (corrected > 0) {
      logger.warn(`[heartbeat] 检测到 ${corrected} 个异常掉线会话，已更正为离线`);
    }
  } catch (e) {
    logger.error("[heartbeat] 会话更正失败", e);
  }
}

/**
 * 服务器启动时清理残留：上次崩溃/异常退出留下的 ONLINE 会话全部置离线。
 * 必须在连接认证之前完成（GameMode.onInit 内调用）。
 */
export async function cleanupStaleSessionsOnBoot(): Promise<void> {
  try {
    // 启动瞬间所有 ONLINE 都是上次进程的残留（本次启动尚无玩家认证，
    // 无需传 onlineIds——authStates 为空）
    const cleaned = await markStaleSessionsOffline(new Date());
    if (cleaned > 0) {
      logger.warn(`[heartbeat] 启动清理：${cleaned} 个残留在线会话已标记离线`);
    }
  } catch (e) {
    logger.error("[heartbeat] 启动清理失败", e);
  }
}

/** 启动心跳系统（timer 由 GameMode.onExit 统一清理） */
export function startSessionHeartbeat(): void {
  setIntervalSafe(async () => {
    try {
      await heartbeatTick();
    } catch (e) {
      logger.error("[heartbeat] 心跳 tick 异常", e);
    }
  }, HEARTBEAT_INTERVAL_MS);
}
