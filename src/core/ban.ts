import { Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState, getPendingAuthUserId, hasSuperAdminRole } from "@/auth/auth";
import { logger } from "@/logger";
import { sysMsg } from "@/utils/msg";

/**
 * 封禁系统：
 * - 登录时校验封禁（sys_user_ban 表）与账号禁用（sys_user.is_enabled）
 * - OP 通过 /ban <用户名> <时长> <原因> 封禁、/unban <用户名> 解封
 * - 时长：分钟；0 = 永久
 */

/** 同一 IP 允许同时在线的最多账号数（防同 IP 多开小号刷资源/规避封禁；网吧等共享 IP 可调大） */
export const MAX_ACCOUNTS_PER_IP = 2;

/** 查询用户未失效的封禁（返回原因；无封禁返回 null） */
export async function getActiveBan(
  userId: string,
): Promise<{ reason: string; endAt: Date | null } | null> {
  const ban = await prisma.sysUserBan.findFirst({
    where: {
      userId,
      revokedAt: null,
      OR: [{ endAt: null }, { endAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!ban) return null;
  return { reason: ban.reason, endAt: ban.endAt };
}

/** 查询 IP 未失效的封禁（返回原因；无封禁返回 null） */
export async function getActiveIpBan(
  ip: string,
): Promise<{ reason: string; endAt: Date | null } | null> {
  const ban = await prisma.sysUserBan.findFirst({
    where: {
      ip,
      revokedAt: null,
      OR: [{ endAt: null }, { endAt: { gt: new Date() } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!ban) return null;
  return { reason: ban.reason, endAt: ban.endAt };
}

/** 封禁原因文案 */
function banReasonText(reason: string, endAt: Date | null): string {
  const until = endAt ? `，封禁至 ${endAt.toLocaleString()}` : "";
  return `（原因：${reason}）${until}`;
}

/**
 * 同 IP 多账号限制：该 IP 当前在线的不同账号数（sys_user_game_session 在线会话按
 * IP 聚合去重 userId；同账号多会话不算）。超过上限返回拒绝原因，否则 null。
 * 注意：登录流程在密码验证前调用（此时新连接尚未创建会话，统计不含自己）；
 * 注册流程同样生效。
 */
async function checkIpAccountLimit(
  ip?: string,
): Promise<{ reason: string; online: number } | null> {
  if (!ip || ip === "") return null;
  const online = await prisma.sysUserGameSession.groupBy({
    by: ["userId"],
    where: { ip, logoutAt: null, status: "ONLINE" },
    _count: { _all: true },
  });
  // groupBy 按 userId 分组 → 行数即该 IP 在线的不同账号数（同账号多会话聚合为 1）
  const accountCount = online.length;
  if (accountCount >= MAX_ACCOUNTS_PER_IP) {
    return {
      reason: `同一 IP 同时在线账号数已达上限（${MAX_ACCOUNTS_PER_IP}），请使用已登录账号`,
      online: accountCount,
    };
  }
  return null;
}

/** 登录前校验：账号封禁/IP 封禁/禁用/同 IP 多账号 → 返回拒绝原因；允许返回 null。userId 为空（注册流程）时跳过账号维度只查 IP */
export async function checkLoginAllowed(
  userId: string,
  ip?: string,
): Promise<{ reason: string; type: "banned" | "disabled" | "ipLimit" } | null> {
  if (userId) {
    const user = await prisma.sysUser.findUnique({ where: { id: userId } });
    if (!user) return { reason: "账号不存在", type: "disabled" };
    if (!user.isEnabled) return { reason: "账号已被禁用", type: "disabled" };
    const ban = await getActiveBan(userId);
    if (ban) {
      return { reason: `账号已被封禁${banReasonText(ban.reason, ban.endAt)}`, type: "banned" };
    }
  }
  if (ip) {
    const ipBan = await getActiveIpBan(ip);
    if (ipBan) {
      return {
        reason: `当前 IP 已被封禁${banReasonText(ipBan.reason, ipBan.endAt)}`,
        type: "banned",
      };
    }
    // 同 IP 多账号限制（IP 维度，登录/注册统一生效）
    const limit = await checkIpAccountLimit(ip);
    if (limit) {
      return { reason: limit.reason, type: "ipLimit" };
    }
  }
  return null;
}

/** 把账号/IP 对应的在线玩家即时踢出（封禁即时生效）。含认证中途玩家
 * （会话已写库但 authStates 未登记）——否则停在密码对话框的玩家在封禁生效后
 * 仍能完成登录继续在线 */
function kickOnlineForBan(
  target: { userId?: string | null; ip?: string | null },
  reason: string,
): void {
  for (const p of Player.getInstances()) {
    if (p.isNpc() || !p.isConnected()) continue;
    const auth = getAuthState(p.id);
    const pIp = p.getIp().ip;
    const match =
      (target.userId &&
        (auth?.userId === target.userId || getPendingAuthUserId(p.id) === target.userId)) ||
      (target.ip && target.ip !== "" && pIp === target.ip);
    if (match) {
      sysMsg(p, "system", `你已被封禁：${reason}`, "error");
      p.kick();
    }
  }
}

/** 判断用户是否为超管（查角色表，供封禁自我保护；复用 auth 模块的通用实现） */

/** OP 封禁：/ban <用户名> <时长分钟> <原因>；时长 0 = 永久。封禁后即时踢出在线玩家 */
export async function banUser(
  op: Player,
  username: string,
  minutes: number,
  reason: string,
): Promise<void> {
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    sysMsg(op, "system", `用户 ${username} 不存在`, "error");
    return;
  }
  // 自我保护：不能封禁自己或其他 OP（误操作会导致管理失能且难以解封）
  const opUserId = getAuthState(op.id)?.userId ?? null;
  if (user.id === opUserId) {
    sysMsg(op, "system", "不能封禁自己", "error");
    return;
  }
  if (await hasSuperAdminRole(user.id)) {
    sysMsg(op, "system", `不能封禁管理员 ${username}`, "error");
    return;
  }
  const endAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  // 已有未失效封禁 → 更新；否则新增
  const existing = await prisma.sysUserBan.findFirst({
    where: {
      userId: user.id,
      revokedAt: null,
      OR: [{ endAt: null }, { endAt: { gt: new Date() } }],
    },
  });
  if (existing) {
    await prisma.sysUserBan.update({
      where: { id: existing.id },
      data: { reason, endAt },
    });
  } else {
    await prisma.sysUserBan.create({
      data: { userId: user.id, reason, endAt, bannedById: opUserId },
    });
  }
  const untilText = minutes > 0 ? `${minutes} 分钟` : "永久";
  sysMsg(op, "system", `已封禁 ${username}（${untilText}，原因：${reason}）`, "success");
  logger.info(`[ban] OP ${op.getName().name} 封禁 ${username} ${untilText}：${reason}`);
  // 即时踢出在线玩家（无需等其掉线重连）
  kickOnlineForBan({ userId: user.id }, `${reason}（${untilText}）`);
}

/** OP IP 封禁：/banip <IP> <时长分钟> <原因>；时长 0 = 永久 */
export async function banIp(
  op: Player,
  ip: string,
  minutes: number,
  reason: string,
): Promise<void> {
  const endAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  const opUserId = getAuthState(op.id)?.userId ?? null;
  const existing = await prisma.sysUserBan.findFirst({
    where: { ip, revokedAt: null, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
  });
  if (existing) {
    await prisma.sysUserBan.update({ where: { id: existing.id }, data: { reason, endAt } });
  } else {
    await prisma.sysUserBan.create({ data: { ip, reason, endAt, bannedById: opUserId } });
  }
  const untilText = minutes > 0 ? `${minutes} 分钟` : "永久";
  sysMsg(op, "system", `已封禁 IP ${ip}（${untilText}，原因：${reason}）`, "success");
  logger.info(`[ban] OP ${op.getName().name} 封禁 IP ${ip} ${untilText}：${reason}`);
  kickOnlineForBan({ ip }, `${reason}（${untilText}）`);
}

/** OP 解封：/unban <用户名> */
export async function unbanUser(op: Player, username: string): Promise<void> {
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    sysMsg(op, "system", `用户 ${username} 不存在`, "error");
    return;
  }
  const res = await prisma.sysUserBan.updateMany({
    where: {
      userId: user.id,
      revokedAt: null,
      OR: [{ endAt: null }, { endAt: { gt: new Date() } }],
    },
    data: { revokedAt: new Date() },
  });
  op.sendClientMessage(
    res.count > 0 ? "#55ff55" : "#ff5555",
    res.count > 0 ? `已解封 ${username}` : `${username} 当前未被封禁`,
  );
}

/** OP 解封 IP：/unbanip <IP> */
export async function unbanIp(op: Player, ip: string): Promise<void> {
  const res = await prisma.sysUserBan.updateMany({
    where: { ip, revokedAt: null, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
    data: { revokedAt: new Date() },
  });
  op.sendClientMessage(
    res.count > 0 ? "#55ff55" : "#ff5555",
    res.count > 0 ? `已解封 IP ${ip}` : `IP ${ip} 当前未被封禁`,
  );
}
