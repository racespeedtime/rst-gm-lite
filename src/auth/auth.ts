import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { checkLoginAllowed } from "@/core/ban";
import type { MenuBack } from "@/core/panel";
import { hashPassword, verifyPassword, isLegacyPassword } from "./password";
import { showDialog } from "@/utils/dialog";

const MAX_NAME_LEN = 24;
const MAX_PASSWORD_LEN = 32;
const MIN_PASSWORD_LEN = 4;

import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";

/** 单个玩家认证状态（内存态） */
export interface AuthState {
  userId: string;
  username: string;
  sessionId: string;
  isSuperAdmin: boolean;
}

const authStates = new Map<number, AuthState>();
const sessionStartedAt = new Map<number, Date>();
/** 会话已写库但认证状态尚未登记期间的中间态（防断线导致会话行永久 OPEN） */
const pendingSessions = new Map<number, { sessionId: string; userId: string }>();

export function getAuthState(playerId: number): AuthState | undefined {
  return authStates.get(playerId);
}

export function clearAuthState(playerId: number): void {
  authStates.delete(playerId);
  sessionStartedAt.delete(playerId);
  pendingSessions.delete(playerId);
}

/** 收集所有在线会话 id（含认证中途的 pending 会话），供心跳批量更新 last_heartbeat_at */
export function getOnlineSessionIds(): string[] {
  const ids = new Set<string>();
  for (const auth of authStates.values()) {
    ids.add(auth.sessionId);
  }
  for (const pending of pendingSessions.values()) {
    ids.add(pending.sessionId);
  }
  return [...ids];
}

/** 查找某 userId 当前在线的玩家 id（用于同账号多开检测）。
 * 同时扫 authStates（已认证）与 pendingSessions（认证中途，key 即 playerId）——
 * 否则两个同昵称连接同时处于密码对话框时，后完成者查不到先完成者而双双登入 */
export function findOnlinePlayerIdByUserId(userId: string): number | null {
  for (const [pid, auth] of authStates) {
    if (auth.userId === userId) return pid;
  }
  for (const [pid, pending] of pendingSessions) {
    if (pending.userId === userId) return pid;
  }
  return null;
}

/** 玩家断开时关闭游戏会话（记录登出时间与时长） */
export async function closePlayerSession(playerId: number): Promise<void> {
  let auth = authStates.get(playerId);
  let sessionId = auth?.sessionId;
  // 认证状态尚未登记但会话已写库（认证中途断线）→ 从 pendingSessions 兜底关闭
  if (!sessionId) {
    const pending = pendingSessions.get(playerId);
    if (pending) {
      sessionId = pending.sessionId;
      auth = { userId: pending.userId, username: "", sessionId, isSuperAdmin: false };
    }
  }
  if (auth && sessionId) {
    const startedAt = sessionStartedAt.get(playerId);
    try {
      await prisma.sysUserGameSession.update({
        where: { id: sessionId },
        data: {
          logoutAt: new Date(),
          status: "OFFLINE",
          duration: startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : undefined,
        },
      });
    } catch (e) {
      logger.error(`[auth] 关闭会话失败 ${auth.username || auth.userId}`, e);
    }
  }
  clearAuthState(playerId);
}

/** 校验昵称是否可作为账号名：非空 + 字节数 ≤ 24（SA-MP 昵称按字节计，支持中文/Unicode） */
function isValidName(name: string): boolean {
  return name.length > 0 && Buffer.byteLength(name, "utf8") <= MAX_NAME_LEN;
}

/** 校验密码强度 */
function isValidPassword(pwd: string): boolean {
  return pwd.length >= MIN_PASSWORD_LEN && pwd.length <= MAX_PASSWORD_LEN;
}

/** 判断用户是否拥有超级管理员角色 */
async function hasSuperAdminRole(userId: string): Promise<boolean> {
  const roles = await prisma.sysUserRole.findMany({
    where: { sysUserId: userId },
    include: { sysRole: true },
  });
  return roles.some((r) => r.sysRole.code === "SUPER_ADMIN");
}

/** 创建游戏会话并记录起始时间，返回 sessionId */
async function openGameSession(player: Player, userId: string): Promise<string> {
  const session = await prisma.sysUserGameSession.create({
    data: {
      userId,
      ip: player.getIp().ip || null,
    },
  });
  sessionStartedAt.set(player.id, new Date());
  // 立即登记中间态：写库到 authStates.set 之间的断线窗口由 closePlayerSession 兜底关闭
  pendingSessions.set(player.id, { sessionId: session.id, userId });
  return session.id;
}

/**
 * 玩家连入后的认证流程：登录（老用户）或注册（新用户名）。
 * 账号名 = 玩家连接的昵称（player.getName()），无需再输入用户名。
 */
export async function runAuthFlow(player: Player): Promise<AuthState | null> {
  // 直接用玩家连接的昵称作为账号名（SA-MP 玩家名即账号，改名连接即新账号）
  const name = player.getName().name;
  if (!isValidName(name)) {
    player.sendClientMessage(COLOR_ERROR, "你的昵称包含非法字符或长度不正确，无法注册账号");
    player.kick();
    return null;
  }

  const user = await prisma.sysUser.findUnique({ where: { username: name } });
  if (user) {
    // 老用户 → 登录
    const sessionId = await doLogin(player, user.id, name);
    if (!sessionId) return null;
    // 同账号多开检测：该账号已在别处登录 → 踢掉旧的（后登入优先，防账号共用）
    const oldId = findOnlinePlayerIdByUserId(user.id);
    if (oldId != null && oldId !== player.id) {
      const old = Player.getInstance(oldId);
      if (old) {
        old.sendClientMessage(COLOR_ERROR, "你的账号在别处登录，你已被挤下线");
        old.kick();
      }
    }
    const auth: AuthState = {
      userId: user.id,
      username: name,
      sessionId,
      isSuperAdmin: await hasSuperAdminRole(user.id),
    };
    authStates.set(player.id, auth);
    return auth;
  }
  // 新用户 → 注册（密码二次验证）
  const result = await doRegister(player, name);
  if (!result) return null;
  const auth: AuthState = {
    userId: result.userId,
    username: name,
    sessionId: result.sessionId,
    isSuperAdmin: false,
  };
  authStates.set(player.id, auth);
  return auth;
}

/**
 * 登录流程：密码 → 旧格式自动升级 bcrypt → 创建会话
 * 返回 sessionId，失败返回 null
 */
async function doLogin(player: Player, userId: string, name: string): Promise<string | null> {
  const user = await prisma.sysUser.findUnique({ where: { id: userId } });
  if (!user) return null;
  // 登录前校验：封禁（账号/IP）/ 账号禁用 → 直接拒绝（不进入密码流程）
  const denied = await checkLoginAllowed(userId, player.getIp().ip);
  if (denied) {
    player.sendClientMessage(COLOR_ERROR, `[系统] ${denied.reason}`);
    player.kick();
    return null;
  }
  // 输入密码（最多尝试 3 次）
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption: "登录",
        info: "请输入密码：",
        button1: "确定",
        button2: "离开",
      }),
    );
    if (!res) return null;
    if (res.response !== 1) {
      // UX-1：按"离开"/ESC 关闭 → 明确提示，防误触被踢被当成服务器故障
      player.sendClientMessage(COLOR_WHITE, "已取消登录，再见");
      return null;
    }
    const pwd = res.inputText;
    const ok = await verifyPassword(pwd, user.password, user.salt);
    if (!ok) {
      player.sendClientMessage(COLOR_ERROR, "密码错误，请重试");
      continue;
    }
    // 旧格式密码登录成功 → 升级为 bcrypt（自动升级）
    if (isLegacyPassword(user.password)) {
      const newHash = await hashPassword(pwd);
      await prisma.sysUser.update({
        where: { id: user.id },
        data: { password: newHash, salt: null },
      });
      logger.info(`[auth] ${name} 密码已从旧格式自动升级为 bcrypt`);
    }
    // 创建游戏会话
    const sessionId = await openGameSession(player, user.id);
    player.sendClientMessage(COLOR_SUCCESS, `欢迎回来，${name}`);
    return sessionId;
  }
  player.sendClientMessage(COLOR_ERROR, "密码错误次数过多，已断开连接");
  return null;
}

/**
 * 询问并确认新密码（设置密码 + 二次确认，最多 3 次）。
 * 返回确认后的密码；玩家取消/中断返回 null。
 */
export async function askNewPassword(
  player: Player,
  caption: string,
  hint: string,
): Promise<string | null> {
  let pwd = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res1 = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption,
        info: `${hint}（${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN}位）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res1) return null;
    if (res1.response !== 1) {
      return null;
    }
    pwd = res1.inputText;
    if (!isValidPassword(pwd)) {
      player.sendClientMessage(COLOR_ERROR, "密码长度需为 4-32 位，请重新输入");
      continue;
    }
    // 二次确认
    const res2 = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption,
        info: "请再次输入密码确认：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res2) return null;
    if (res2.response !== 1) {
      return null;
    }
    if (res2.inputText !== pwd) {
      player.sendClientMessage(COLOR_ERROR, "两次输入的密码不一致，请重新输入");
      continue;
    }
    return pwd;
  }
  return null;
}

/**
 * 玩家自助修改自己的密码（万能面板入口）。
 * 流程：验证当前密码 → 新密码 + 二次确认 → 更新为 bcrypt。
 */
export async function changeOwnPassword(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const user = await prisma.sysUser.findUnique({ where: { id: auth.userId } });
  if (!user) return;

  // 1. 验证当前密码（最多 3 次）
  let verified = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption: "修改密码",
        info: "请输入当前密码：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res) return;
    if (res.response !== 1) {
      return back?.();
    }
    if (await verifyPassword(res.inputText, user.password, user.salt)) {
      verified = true;
      break;
    }
    player.sendClientMessage(COLOR_ERROR, "当前密码错误，请重试");
  }
  if (!verified) {
    player.sendClientMessage(COLOR_ERROR, "当前密码验证失败，操作已取消");
    return back?.();
  }

  // 2. 新密码 + 二次确认
  const pwd = await askNewPassword(player, "修改密码", "输入新密码");
  if (!pwd) return back?.();

  // 3. 更新（bcrypt，清空旧 salt）
  try {
    await prisma.sysUser.update({
      where: { id: user.id },
      data: { password: await hashPassword(pwd), salt: null },
    });
    player.sendClientMessage(COLOR_SUCCESS, "密码修改成功");
    logger.info(`[auth] ${auth.username} 修改了自己的密码`);
  } catch (e) {
    logger.error(`[auth] ${auth.username} 修改密码失败`, e);
    player.sendClientMessage(COLOR_ERROR, "修改失败，请稍后重试");
  }
  return back?.();
}

/**
 * 注册流程：密码 + 确认密码 → 创建用户与默认设置 → 创建会话
 * 返回 { userId, sessionId }，失败返回 null
 */
async function doRegister(
  player: Player,
  name: string,
): Promise<{ userId: string; sessionId: string } | null> {
  // 注册前校验 IP 封禁（新用户无 userId，走 IP 维度）——防止被 IP 封禁者注册新号绕过
  const ip = player.getIp().ip;
  const denied = await checkLoginAllowed("", ip);
  if (denied) {
    player.sendClientMessage(COLOR_ERROR, `[系统] ${denied.reason}`);
    player.kick();
    return null;
  }
  const pwd = await askNewPassword(player, "注册", "设置密码");
  if (!pwd) {
    return null;
  }
  const sessionIp = player.getIp().ip || null;
  // 创建用户 + 默认设置 + 游戏会话（事务：任一步失败整体回滚，不留"无会话的半成品用户"）
  try {
    const { userId, sessionId } = await prisma.$transaction(async (tx) => {
      const user = await tx.sysUser.create({
        data: {
          username: name,
          password: await hashPassword(pwd),
          sysUserSetting: { create: {} },
        },
      });
      const session = await tx.sysUserGameSession.create({
        data: { userId: user.id, ip: sessionIp },
      });
      return { userId: user.id, sessionId: session.id };
    });
    // 事务外登记会话起始与中间态（内存态不参与事务）
    sessionStartedAt.set(player.id, new Date());
    pendingSessions.set(player.id, { sessionId, userId });
    player.sendClientMessage(COLOR_SUCCESS, `注册成功，欢迎你，${name}`);
    return { userId, sessionId };
  } catch (e) {
    logger.error(`[auth] 注册失败 ${name}`, e);
    player.sendClientMessage(COLOR_ERROR, "注册失败，请重试");
    return null;
  }
}
