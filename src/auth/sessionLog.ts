import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import type { MenuBack } from "@/core/panel";
import { showPagedDialog } from "@/utils/pagedDialog";
import { showDialog } from "@/utils/dialog";

import { sysMsg } from "@/utils/msg";
/** 分页浏览最近 50 条登录记录（每页 10 条） */
const RECENT_LIMIT = 50;
const PAGE_SIZE = 10;

/** 格式化会话时长（**秒** → 可读；入参来自 sys_user_game_session.duration，单位为秒，
 *  与 utils/format 的 formatDuration（毫秒）单位不同，故本地独立实现并显式命名避免混淆） */
function formatSessionDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 登录记录表头（TABLIST_HEADERS 多列展示，\t 分隔） */
const SESSION_LOG_HEADERS = ["#", "登录时间", "登出时间", "时长", "IP", "状态"];

/** 登录记录行（多列，与表头列数一致） */
function formatSessionLine(
  s: {
    loginAt: Date | null;
    logoutAt: Date | null;
    duration: number | null;
    ip: string | null;
    status: string;
  },
  index: number,
): string[] {
  return [
    String(index + 1),
    formatDate(s.loginAt),
    s.logoutAt ? formatDate(s.logoutAt) : "—",
    formatSessionDuration(s.duration),
    s.ip ?? "—",
    s.status === "ONLINE" ? "{00FF00}在线" : "{808080}离线",
  ];
}

/** 展示登录记录（分页多列对话框，浏览模式） */
async function showSessionLog(player: Player, userId: string, title: string): Promise<void> {
  const logs = await prisma.sysUserGameSession.findMany({
    where: { userId },
    orderBy: { loginAt: "desc" },
    take: RECENT_LIMIT,
  });
  if (logs.length === 0) {
    sysMsg(player, "auth", "暂无登录记录", "plain");
    return;
  }
  await showPagedDialog(player, {
    caption: title,
    data: logs,
    pageSize: PAGE_SIZE,
    selectable: false, // 纯浏览：点普通条目忽略，只翻页/关闭
    button2: "关闭",
    headers: SESSION_LOG_HEADERS,
    format: formatSessionLine,
  });
}

/** 面板入口：我的登录记录（所有人）。关闭记录后返回上一层 */
export async function showMySessionLogs(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  await showSessionLog(player, auth.userId, "我的登录记录");
  return back?.();
}

/** OP 面板入口：按用户名查看任意用户登录记录（不要求在线）。取消返回上一层 */
export async function showUserSessionLogs(player: Player, back?: MenuBack): Promise<void> {
  if (!isSuperAdmin(player)) {
    sysMsg(player, "auth", "仅管理员可查看他人登录记录", "error");
    return back?.();
  }
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "查看登录记录",
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
    sysMsg(player, "auth", `用户 ${username} 不存在`, "error");
    return back?.();
  }
  await showSessionLog(player, user.id, `${username} 的登录记录`);
  return back?.();
}
