import { Dialog, DialogStylesEnum, Player, PlayerEvent, PlayerStateEnum } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState, hasSuperAdminRole } from "@/auth/auth";
import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { pickOption } from "@/personalize/settings";
import { startObservePlayer } from "@/core/observe";
import { requestTpa, acceptsTeleport } from "@/teleport";
import { sessionManager } from "@/sessions/manager";
import { isInRace } from "@/race/room";
import { openReplayActions } from "@/replay/menu";
import { showPagedDialog } from "@/utils/pagedDialog";
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
    isAdmin: await hasSuperAdminRole(userId),
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

/** 按用户名精确查并展示玩家信息（不要求在线）。返回是否查到 */
async function showProfileByName(player: Player, username: string): Promise<boolean> {
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    player.sendClientMessage(COLOR_ERROR, `用户 ${username} 不存在`);
    return false;
  }
  await showProfile(player, user.id, `${username} 的信息`);
  return true;
}

/** 分页列出全部玩家（在线优先，含离线），选中查看信息 */
async function listAllPlayers(player: Player, back?: MenuBack): Promise<void> {
  const users = await prisma.sysUser.findMany({
    where: { deletedAt: null },
    orderBy: { username: "asc" },
    take: 200, // 上限防全表拉取；名字升序便于浏览
    select: { id: true, username: true },
  });
  if (users.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无玩家");
    return back?.();
  }
  // 在线集（status=ONLINE 的会话）：在线优先排序，列表标注状态
  const onlineSessions = await prisma.sysUserGameSession.findMany({
    where: { status: "ONLINE" },
    select: { userId: true },
  });
  const online = new Set(onlineSessions.map((s) => s.userId));
  users.sort((a, b) => {
    const ao = online.has(a.id) ? 1 : 0;
    const bo = online.has(b.id) ? 1 : 0;
    return bo - ao || a.username.localeCompare(b.username, "zh-CN");
  });
  const r = await showPagedDialog(player, {
    caption: `玩家列表（${users.length}，在线优先）`,
    data: users,
    headers: ["玩家", "状态"],
    format: (u) => [u.username, online.has(u.id) ? "{00FF00}在线" : "{808080}离线"],
    button1: "查看信息",
    button2: "返回",
  });
  if (!r) return back?.();
  await showProfile(player, r.item.id, `${r.item.username} 的信息`);
  return back?.();
}

/** 查看任意玩家信息（全员可用，不要求在线）：输入用户名，或留空列出全部玩家分页选。
 *  取消返回上一层。OP 面板与 /info 命令、/p 面板「查看玩家信息」共用 */
export async function openLookupPlayerInfo(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "查看玩家信息",
      info: "输入要查询的玩家名（留空 = 列出全部玩家）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const username = res.inputText.trim();
  if (!username) {
    await listAllPlayers(player, back);
    return;
  }
  await showProfileByName(player, username);
  return back?.();
}

/** OP 面板入口（历史名称，行为同 openLookupPlayerInfo）：按用户名查看任意玩家信息 */
export async function showProfileByUsername(player: Player, back?: MenuBack): Promise<void> {
  await openLookupPlayerInfo(player, back);
}

/**
 * 点击玩家操作菜单：查看信息 / 观战 / 请求传送到身边（对齐原版 ClickPlayer 列表）。
 * 无效操作不展示：点自己只留"查看信息"（观战/传送自己本就不可用）；
 * 观战项仅目标可被观看时显示；传送项仅双方不在比赛且同战局且目标接受传送时显示。
 */
async function openClickPlayerMenu(player: Player, target: Player): Promise<void> {
  lockPlayer(player.id); // 菜单对话框流程期间锁定，防重复触发/覆盖当前对话框
  try {
    const name = target.getName().name;
    // userId 在进入菜单前取出存闭包：菜单打开期间目标可能断线，届时
    // getAuthState(target.id) 已清空，直接非空断言会崩（H4 类问题）
    const targetUserId = getAuthState(target.id)?.userId;
    const rows: { label: string; run: () => void | Promise<void> }[] = [
      {
        label: "查看个人信息",
        run: () => {
          if (!targetUserId) {
            player.sendClientMessage(COLOR_ERROR, "对方已下线，无法查看信息");
            return;
          }
          showProfile(player, targetUserId, `${name} 的信息`);
        },
      },
    ];
    const isSelf = player.id === target.id;
    if (!isSelf) {
      // 查看 TA 的回放（比赛回放列表 → 观看/分身/影子挑战）：目标已认证才有 userId
      if (targetUserId) {
        rows.push({
          label: "查看TA的回放",
          run: () => {
            void listPlayerReplays(player, targetUserId, name);
          },
        });
      }
      // 观战：目标可观看（非观战/未连接等状态）才显示
      const watchable =
        target.isConnected() &&
        ![PlayerStateEnum.NONE, PlayerStateEnum.SPECTATING].includes(target.getState());
      if (watchable) {
        rows.push({ label: "观战玩家", run: () => startObservePlayer(player, target) });
      }
      // 传送到身边：双向不在比赛中 + 同战局 + 目标接受传送 才显示（完整校验 requestTpa 仍兜底）
      const tpaOk =
        !isInRace(player.id) &&
        !isInRace(target.id) &&
        getAuthState(target.id) != null &&
        sessionManager.getPlayerSession(player).id === sessionManager.getPlayerSession(target).id &&
        (await acceptsTeleport(target));
      if (tpaOk) {
        rows.push({
          label: "请求传送到TA身边",
          run: () => {
            void requestTpa(player, target.id);
          },
        });
      }
    }
    const index = await pickOption(
      player,
      `${name} 的操作`,
      rows.map((r) => r.label),
    );
    if (index < 0) return; // 取消/关闭
    await rows[index].run();
  } finally {
    unlockPlayer(player.id);
  }
}

/** 时长格式化（mm:ss 或 ss，回放列表用，与 replay/menu 同口径） */
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 时间格式化（MM-DD HH:MM，回放列表用，与 replay/menu 同口径） */
function fmtTime(d: Date): string {
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 查看某玩家的比赛回放列表（分页）→ 观看/分身/影子挑战（非本人，公开可看不可删） */
async function listPlayerReplays(
  player: Player,
  targetUserId: string,
  targetName: string,
): Promise<void> {
  const list = await prisma.replay.findMany({
    where: { userId: targetUserId, type: "race", deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (list.length === 0) {
    player.sendClientMessage(COLOR_ERROR, `${targetName} 还没有比赛回放`);
    return;
  }
  const r = await showPagedDialog(player, {
    caption: `${targetName} 的比赛回放（${list.length}）`,
    data: list,
    headers: ["赛道", "名次", "时长", "时间"],
    format: (v) => [
      v.raceName || "—",
      v.rank != null ? `No.${v.rank}` : "{FF0000}未完成",
      fmtDur(v.durationMs),
      fmtTime(v.createdAt),
    ],
    button1: "操作",
    button2: "关闭",
  });
  if (!r) return;
  await openReplayActions(player, r.item, { allowDelete: false });
}

/** 初始化：点击玩家（Tab 记分板双击）→ 操作菜单 + /info 命令（全员可查任意玩家） */
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
    void openClickPlayerMenu(player, clickedPlayer);
    return true;
  });

  // /info 查看任意玩家信息（不要求在线，不限于点击在线玩家）：
  // /info 无参 → 列出全部玩家分页（在线优先）；/info 名字 → 按用户名直接查
  PlayerEvent.onCommandText("info", ({ player, subcommand, next }) => {
    const arg = subcommand[0];
    if (arg) {
      void showProfileByName(player, arg.trim());
    } else {
      void listAllPlayers(player);
    }
    return next();
  });
}
