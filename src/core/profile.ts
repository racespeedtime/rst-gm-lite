import { Dialog, DialogStylesEnum, Player, PlayerEvent } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { isPlayerLocked } from "@/core/interaction";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";

import { COLOR_ERROR } from "@/utils/colors";

/** 汇总一行内的统计信息（查库一次完成） */
interface ProfileStats {
  username: string;
  isAdmin: boolean;
  registeredAt: Date;
  skinId: number;
  /** 总在线时长（秒）：历史会话累计 + 当前在线会话 */
  totalDuration: number;
  /** 当前是否在线 + 本次在线起始时间 */
  currentSessionStart: Date | null;
  lastLogoutAt: Date | null;
  /** 比赛完成次数 */
  raceCount: number;
  /** 总里程（米）= Σ 完成比赛的 赛道长度 × 圈数 */
  totalDistance: number;
  /** 最近一次比赛时间 */
  lastRaceAt: Date | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 秒 → "X天X时X分"（长时长效用） */
function formatTotalSeconds(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}天${h}时${m}分`;
  if (h > 0) return `${h}时${m}分`;
  return `${m}分`;
}

/** 毫秒 → mm:ss.SSS（比赛成绩展示，对齐 formatTime） */
/** 判断用户是否为超管（查角色表，支持查看不在线用户） */
async function isUserSuperAdmin(userId: string): Promise<boolean> {
  const roles = await prisma.sysUserRole.findMany({
    where: { sysUserId: userId },
    include: { sysRole: true },
  });
  return roles.some((r) => r.sysRole.code === "SUPER_ADMIN");
}

/** 汇总某用户的信息统计（一次聚合查询，零迁移） */
async function collectProfileStats(userId: string): Promise<ProfileStats | null> {
  const [user, sessions, raceRecords, lastSession] = await Promise.all([
    prisma.sysUser.findUnique({ where: { id: userId }, include: { sysUserSetting: true } }),
    // 在线时长：历史离线会话累计时长（null 时长按 0 计，异常掉线由心跳更正）
    prisma.sysUserGameSession.findMany({
      where: { userId, status: "OFFLINE" },
      select: { duration: true },
    }),
    // 比赛统计：完成次数 + 总里程（每次完成 = 跑完 赛道长度×圈数）+ 最近比赛时间
    prisma.raceRecord.findMany({
      where: { userId, deletedAt: null },
      select: { createdAt: true, race: { select: { totalLength: true, laps: true } } },
    }),
    // 最近登录会话（判断在线状态/本次在线起始/最近登出）
    prisma.sysUserGameSession.findFirst({
      where: { userId },
      orderBy: { loginAt: "desc" },
      select: { loginAt: true, logoutAt: true, status: true },
    }),
  ]);
  if (!user) return null;

  const historicalSeconds = sessions.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  const isOnline = lastSession?.status === "ONLINE";
  const currentSessionStart = isOnline && lastSession ? lastSession.loginAt : null;
  // 当前在线：本次时长 = 登录起至今，叠加进总时长
  const liveSeconds = currentSessionStart
    ? Math.floor((Date.now() - currentSessionStart.getTime()) / 1000)
    : 0;

  const raceCount = raceRecords.length;
  const totalDistance = raceRecords.reduce(
    (sum, r) => sum + (r.race ? Number(r.race.totalLength) * Math.max(1, r.race.laps) : 0),
    0,
  );
  const lastRaceAt =
    raceRecords.length > 0
      ? raceRecords.reduce(
          (latest, r) => (r.createdAt > latest ? r.createdAt : latest),
          raceRecords[0].createdAt,
        )
      : null;

  return {
    username: user.username,
    isAdmin: await isUserSuperAdmin(userId),
    registeredAt: user.createdAt,
    skinId: user.sysUserSetting?.skinId ?? 0,
    totalDuration: historicalSeconds + liveSeconds,
    currentSessionStart,
    lastLogoutAt: lastSession?.logoutAt ?? null,
    raceCount,
    totalDistance,
    lastRaceAt,
  };
}

/** 组装信息展示行（对齐原版 ClickPlayer 风格） */
function buildProfileLines(s: ProfileStats): string[] {
  const liveLabel = s.currentSessionStart
    ? `{00FF00}在线（本次已玩 ${formatTotalSeconds(Math.floor((Date.now() - s.currentSessionStart.getTime()) / 1000))}）`
    : `{808080}离线（最近登录 ${formatDate(s.lastLogoutAt)}）`;
  return [
    `{98CDFE}用户名: {FFFFFF}${s.username}${s.isAdmin ? " {FF5500}[管理员]" : ""}`,
    `{98CDFE}在线状态: {FFFFFF}${liveLabel}`,
    `{98CDFE}总在线时长: {FFFFFF}${formatTotalSeconds(s.totalDuration)}`,
    `{98CDFE}注册日期: {FFFFFF}${formatDate(s.registeredAt)}`,
    `{98CDFE}皮肤: {FFFFFF}${s.skinId}`,
    `{98CDFE}比赛次数: {FFFFFF}${s.raceCount}`,
    `{98CDFE}比赛总里程: {FFFFFF}${s.totalDistance >= 1000 ? `${(s.totalDistance / 1000).toFixed(2)} km` : `${Math.round(s.totalDistance)} m`}`,
    `{98CDFE}最近比赛: {FFFFFF}${formatDate(s.lastRaceAt)}`,
  ];
}

/** 展示玩家信息汇总（对话框） */
async function showProfile(player: Player, userId: string, title: string): Promise<void> {
  const stats = await collectProfileStats(userId);
  if (!stats) {
    player.sendClientMessage(COLOR_ERROR, "玩家不存在");
    return;
  }
  await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: title,
      info: buildProfileLines(stats).join("\n"),
      button1: "关闭",
    }),
  );
}

/** 万能面板入口：我的信息（所有人，比赛中可用）。关闭信息后返回上一层 */
export async function showMyProfile(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  await showProfile(player, auth.userId, "我的信息");
  return back?.();
}

/** OP 入口：按用户名查看任意玩家信息（不要求在线）。取消返回上一层 */
export async function showProfileByUsername(player: Player, back?: MenuBack): Promise<void> {
  if (!isSuperAdmin(player)) {
    player.sendClientMessage(COLOR_ERROR, "仅管理员可查看他人信息");
    return back?.();
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "查看玩家信息",
      info: "输入要查询的用户名：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const username = res.inputText.trim();
  if (!username) return back?.();
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    player.sendClientMessage(COLOR_ERROR, `用户 ${username} 不存在`);
    return back?.();
  }
  await showProfile(player, user.id, `${username} 的信息`);
  return back?.();
}

/** 初始化：点击玩家 → 查看其信息（对齐原版 ClickPlayer） */
export function initPlayerInfo(): void {
  PlayerEvent.onClickPlayer(({ player, clickedPlayer, next }) => {
    // 点击者正处在其他对话框流程（万能面板等）→ 忽略，避免覆盖当前对话框
    if (isPlayerLocked(player.id)) {
      return next();
    }
    // 排除 NPC 与未认证玩家
    if (clickedPlayer.isNpc() || !getAuthState(clickedPlayer.id)) {
      return next();
    }
    const auth = getAuthState(clickedPlayer.id);
    if (auth) {
      void showProfile(player, auth.userId, `${clickedPlayer.getName().name} 的信息`);
    }
    return true;
  });
}
