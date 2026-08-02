import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState, askNewPassword } from "@/auth/auth";
import { showUserSessionLogs } from "@/auth/sessionLog";
import { showProfileByUsername } from "@/core/profile";
import type { MenuBack } from "@/core/panel";
import { hashPassword } from "@/auth/password";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { banUser, unbanUser, banIp, unbanIp } from "@/core/ban";
import { showDialog } from "@/utils/dialog";

import { COLOR_ERROR, COLOR_SUCCESS } from "@/utils/colors";

/** 判断当前玩家是否为超级管理员（OP） */
export function isSuperAdmin(player: Player): boolean {
  return getAuthState(player.id)?.isSuperAdmin ?? false;
}

/**
 * 重置指定用户的密码（管理员操作）。
 * 流程：输入目标用户名 → 确认 → 输入新密码 → 二次确认 → 更新（bcrypt，清空旧 salt）
 * 取消/完成后返回上一层（管理员面板）
 */
export async function resetUserPassword(player: Player, back?: MenuBack): Promise<void> {
  // 1. 输入目标用户名
  const targetRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "重置密码",
      info: "请输入要重置密码的用户名：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!targetRes) return;
  if (targetRes.response !== 1) return back?.();
  const target = targetRes.inputText.trim();
  if (!target) {
    player.sendClientMessage(COLOR_ERROR, "用户名不能为空");
    return back?.();
  }
  // 2. 查用户
  const user = await prisma.sysUser.findUnique({ where: { username: target } });
  if (!user) {
    player.sendClientMessage(COLOR_ERROR, `用户 ${target} 不存在`);
    return back?.();
  }
  // 3. 操作确认
  const confirmRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "重置密码",
      info: `确定要为 ${target} 重置密码吗？`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!confirmRes) return;
  if (confirmRes.response !== 1) return back?.();
  // 4. 新密码 + 二次确认
  const pwd = await askNewPassword(player, "重置密码", `为 ${target} 设置新密码`);
  if (!pwd) return back?.();
  // 5. 更新密码（bcrypt，清空旧 salt）
  try {
    await prisma.sysUser.update({
      where: { id: user.id },
      data: { password: await hashPassword(pwd), salt: null },
    });
    player.sendClientMessage(COLOR_SUCCESS, `用户 ${target} 的密码已重置`);
    logger.info(`[op] ${player.getName().name} 重置了用户 ${target} 的密码`);
  } catch (e) {
    logger.error(`[op] 重置 ${target} 密码失败`, e);
    player.sendClientMessage(COLOR_ERROR, "重置失败，请稍后重试");
  }
  return back?.();
}

/** 打开管理员面板（对话框菜单）。子功能取消时返回本面板，本面板"关闭"返回上一层 */
export async function openOpPanel(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "管理员面板",
      info: "1. 重置用户密码\n2. 查看玩家信息\n3. 查看用户登录记录",
      button1: "执行",
      button2: "关闭",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await resetUserPassword(player, () => openOpPanel(player, back));
  } else if (res.listItem === 1) {
    await showProfileByUsername(player, () => openOpPanel(player, back));
  } else if (res.listItem === 2) {
    await showUserSessionLogs(player, () => openOpPanel(player, back));
  }
}

/** 对无权限玩家的统一拒绝提示 */
export function sendNoPermission(player: Player): void {
  player.sendClientMessage(COLOR_ERROR, "你没有执行此操作的权限");
}

/** 初始化命令（命令为辅）：/op 打开管理员面板；/ban /unban 封禁管理 */
export function initOpCommands(): void {
  PlayerEvent.onCommandText("op", ({ player, next }) => {
    if (!isSuperAdmin(player)) {
      sendNoPermission(player);
      return next();
    }
    if (isPlayerLocked(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "当前正在其他流程中，请稍后再试");
      return next();
    }
    // 锁由调用方负责（嵌套进万能面板时外层已锁，不能重复解锁）
    lockPlayer(player.id);
    void openOpPanel(player).finally(() => unlockPlayer(player.id));
    return next();
  });

  // 封禁：/ban 用户名 时长(分钟,0=永久) 原因
  PlayerEvent.onCommandText("ban", async ({ player, subcommand, next }) => {
    if (!isSuperAdmin(player)) {
      sendNoPermission(player);
      return next();
    }
    const username = subcommand[0];
    const minutes = Number(subcommand[1]);
    const reason = subcommand.slice(2).join(" ").trim() || "无";
    if (!username || !Number.isInteger(minutes) || minutes < 0) {
      player.sendClientMessage(COLOR_ERROR, "用法: /ban 用户名 时长分钟(0=永久) 原因");
      return next();
    }
    await banUser(player, username, minutes, reason);
    return next();
  });

  // 解封：/unban 用户名
  PlayerEvent.onCommandText("unban", async ({ player, subcommand, next }) => {
    if (!isSuperAdmin(player)) {
      sendNoPermission(player);
      return next();
    }
    const username = subcommand[0];
    if (!username) {
      player.sendClientMessage(COLOR_ERROR, "用法: /unban 用户名");
      return next();
    }
    await unbanUser(player, username);
    return next();
  });

  // IP 封禁：/banip IP 时长(分钟,0=永久) 原因
  PlayerEvent.onCommandText("banip", async ({ player, subcommand, next }) => {
    if (!isSuperAdmin(player)) {
      sendNoPermission(player);
      return next();
    }
    const ip = subcommand[0];
    const minutes = Number(subcommand[1]);
    const reason = subcommand.slice(2).join(" ").trim() || "无";
    if (!ip || !Number.isInteger(minutes) || minutes < 0) {
      player.sendClientMessage(COLOR_ERROR, "用法: /banip IP 时长分钟(0=永久) 原因");
      return next();
    }
    await banIp(player, ip, minutes, reason);
    return next();
  });

  // IP 解封：/unbanip IP
  PlayerEvent.onCommandText("unbanip", async ({ player, subcommand, next }) => {
    if (!isSuperAdmin(player)) {
      sendNoPermission(player);
      return next();
    }
    const ip = subcommand[0];
    if (!ip) {
      player.sendClientMessage(COLOR_ERROR, "用法: /unbanip IP");
      return next();
    }
    await unbanIp(player, ip);
    return next();
  });
}
