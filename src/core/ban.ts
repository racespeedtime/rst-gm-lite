import { Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { logger } from "@/logger";

/**
 * 封禁系统：
 * - 登录时校验封禁（sys_user_ban 表）与账号禁用（sys_user.is_enabled）
 * - OP 通过 /ban <用户名> <时长> <原因> 封禁、/unban <用户名> 解封
 * - 时长：分钟；0 = 永久
 */

/** 查询用户未失效的封禁（返回原因；无封禁返回 null） */
export async function getActiveBan(userId: string): Promise<{ reason: string; endAt: Date | null } | null> {
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
export async function getActiveIpBan(ip: string): Promise<{ reason: string; endAt: Date | null } | null> {
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

/** 登录前校验：账号封禁/IP 封禁/禁用 → 返回拒绝原因；允许返回 null */
export async function checkLoginAllowed(
  userId: string,
  ip?: string,
): Promise<{ reason: string; type: "banned" | "disabled" } | null> {
  const user = await prisma.sysUser.findUnique({ where: { id: userId } });
  if (!user) return { reason: "账号不存在", type: "disabled" };
  if (!user.isEnabled) return { reason: "账号已被禁用", type: "disabled" };
  const ban = await getActiveBan(userId);
  if (ban) {
    return { reason: `账号已被封禁${banReasonText(ban.reason, ban.endAt)}`, type: "banned" };
  }
  if (ip) {
    const ipBan = await getActiveIpBan(ip);
    if (ipBan) {
      return { reason: `当前 IP 已被封禁${banReasonText(ipBan.reason, ipBan.endAt)}`, type: "banned" };
    }
  }
  return null;
}

/** 把账号/IP 对应的在线玩家即时踢出（封禁即时生效） */
function kickOnlineForBan(target: { userId?: string | null; ip?: string | null }, reason: string): void {
  for (const p of Player.getInstances()) {
    if (p.isNpc() || !p.isConnected()) continue;
    const auth = getAuthState(p.id);
    const pIp = p.getIp().ip;
    const match = (target.userId && auth?.userId === target.userId) || (target.ip && target.ip !== "" && pIp === target.ip);
    if (match) {
      p.sendClientMessage("#ff5555", `[系统] 你已被封禁：${reason}`);
      p.kick();
    }
  }
}

/** OP 封禁：/ban <用户名> <时长分钟> <原因>；时长 0 = 永久。封禁后即时踢出在线玩家 */
export async function banUser(op: Player, username: string, minutes: number, reason: string): Promise<void> {
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    op.sendClientMessage("#ff5555", `用户 ${username} 不存在`);
    return;
  }
  const endAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  const opUserId = getAuthState(op.id)?.userId ?? null;
  // 已有未失效封禁 → 更新；否则新增
  const existing = await prisma.sysUserBan.findFirst({
    where: { userId: user.id, revokedAt: null, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
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
  op.sendClientMessage("#55ff55", `已封禁 ${username}（${untilText}，原因：${reason}）`);
  logger.info(`[ban] OP ${op.getName().name} 封禁 ${username} ${untilText}：${reason}`);
  // 即时踢出在线玩家（无需等其掉线重连）
  kickOnlineForBan({ userId: user.id }, `${reason}（${untilText}）`);
}

/** OP IP 封禁：/banip <IP> <时长分钟> <原因>；时长 0 = 永久 */
export async function banIp(op: Player, ip: string, minutes: number, reason: string): Promise<void> {
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
  op.sendClientMessage("#55ff55", `已封禁 IP ${ip}（${untilText}，原因：${reason}）`);
  logger.info(`[ban] OP ${op.getName().name} 封禁 IP ${ip} ${untilText}：${reason}`);
  kickOnlineForBan({ ip }, `${reason}（${untilText}）`);
}

/** OP 解封：/unban <用户名> */
export async function unbanUser(op: Player, username: string): Promise<void> {
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    op.sendClientMessage("#ff5555", `用户 ${username} 不存在`);
    return;
  }
  const res = await prisma.sysUserBan.updateMany({
    where: { userId: user.id, revokedAt: null, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
    data: { revokedAt: new Date() },
  });
  op.sendClientMessage(res.count > 0 ? "#55ff55" : "#ff5555", res.count > 0 ? `已解封 ${username}` : `${username} 当前未被封禁`);
}

/** OP 解封 IP：/unbanip <IP> */
export async function unbanIp(op: Player, ip: string): Promise<void> {
  const res = await prisma.sysUserBan.updateMany({
    where: { ip, revokedAt: null, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
    data: { revokedAt: new Date() },
  });
  op.sendClientMessage(res.count > 0 ? "#55ff55" : "#ff5555", res.count > 0 ? `已解封 IP ${ip}` : `IP ${ip} 当前未被封禁`);
}
