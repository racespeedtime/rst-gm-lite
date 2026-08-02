import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { isSuperAdmin } from "@/admin/op";
import { showDialog } from "@/utils/dialog";

import { COLOR_WHITE, COLOR_ERROR } from "@/utils/colors";
const RECENT_LIMIT = 10;

/** 格式化会话时长（秒 → 可读） */
function formatDuration(seconds: number | null): string {
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

/** 展示登录记录列表（对话框） */
async function showSessionLog(player: Player, userId: string, title: string): Promise<void> {
  const logs = await prisma.sysUserGameSession.findMany({
    where: { userId },
    orderBy: { loginAt: "desc" },
    take: RECENT_LIMIT,
  });
  if (logs.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "暂无登录记录");
    return;
  }
  const lines = logs.map(
    (s, i) =>
      `${RECENT_LIMIT - i}. 登录 ${formatDate(s.loginAt)}${s.logoutAt ? ` → ${formatDate(s.logoutAt)}` : ""}` +
      ` 时长 ${formatDuration(s.duration)}${s.ip ? ` IP:${s.ip}` : ""} ${s.status === "ONLINE" ? "{00FF00}在线" : "{808080}离线"}`,
  );
  await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: title,
      info: lines.join("\n"),
      button1: "关闭",
    }),
  );
}

/** 面板入口：我的登录记录（所有人） */
export async function showMySessionLogs(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  await showSessionLog(player, auth.userId, "我的登录记录（最近 10 次）");
}

/** OP 面板入口：按用户名查看任意用户登录记录（不要求在线） */
export async function showUserSessionLogs(player: Player): Promise<void> {
  if (!isSuperAdmin(player)) {
    player.sendClientMessage(COLOR_ERROR, "仅管理员可查看他人登录记录");
    return;
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
  if (!res || res.response !== 1) return;
  const username = res.inputText.trim();
  if (!username) return;
  const user = await prisma.sysUser.findUnique({ where: { username } });
  if (!user) {
    player.sendClientMessage(COLOR_ERROR, `用户 ${username} 不存在`);
    return;
  }
  await showSessionLog(player, user.id, `${username} 的登录记录（最近 10 次）`);
}
