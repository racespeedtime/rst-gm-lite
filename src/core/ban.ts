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

/** 登录前校验：封禁或账号禁用 → 返回拒绝原因；允许返回 null */
export async function checkLoginAllowed(userId: string): Promise<{ reason: string; type: "banned" | "disabled" } | null> {
  const user = await prisma.sysUser.findUnique({ where: { id: userId } });
  if (!user) return { reason: "账号不存在", type: "disabled" };
  if (!user.isEnabled) return { reason: "账号已被禁用", type: "disabled" };
  const ban = await getActiveBan(userId);
  if (ban) {
    const until = ban.endAt ? `，封禁至 ${ban.endAt.toLocaleString()}` : "";
    return { reason: `账号已被封禁${until}（原因：${ban.reason}）`, type: "banned" };
  }
  return null;
}

/** OP 封禁：/ban <用户名> <时长分钟> <原因>；时长 0 = 永久 */
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
