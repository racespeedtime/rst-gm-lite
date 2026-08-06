import { Dialog, DialogStylesEnum, GameText, Player, PlayerEvent } from "@infernus/core";
import { sessionManager } from "@/sessions/manager";
import { getAuthState } from "@/auth/auth";
import { allowChat } from "@/core/ratelimit";
import { COLOR_ERROR } from "@/utils/colors";
import { getChatDisplayName } from "@/core/playerStyle";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";
import { containsSensitiveWord } from "@/utils/sensitive";

export type ChatRange = "session" | "public";

const chatRanges = new Map<number, ChatRange>();
const SESSION_CHAT_COLOR = "#ffffff";
const PUBLIC_CHAT_COLOR = "#ffd700";
const PM_COLOR = "#aaccff";

/** 剥离 SA-MP 颜色码（{RRGGBB}）与控制字符，防止伪造颜色/样式注入 */
function sanitizeChatText(text: string): string {
  const noColor = text.replace(/\{[0-9a-fA-F]{6}\}/g, "");
  // 去掉 C0 控制字符（\u0000-\u001F 中除 \t \n \r 外）
  let out = "";
  for (const ch of noColor) {
    const code = ch.charCodeAt(0);
    if (code >= 32 || code === 9 || code === 10 || code === 13) {
      out += ch;
    }
  }
  return out;
}

/** 玩家认证成功后初始化聊天范围（默认跟随战局） */
export function initChatState(playerId: number): void {
  chatRanges.set(playerId, "session");
}

/** 获取玩家聊天范围（默认跟随当前战局） */
export function getChatRange(playerId: number): ChatRange {
  return chatRanges.get(playerId) ?? "session";
}

/** 设置聊天范围 */
export function setChatRange(playerId: number, range: ChatRange): void {
  chatRanges.set(playerId, range);
}

/** 玩家断开时清理 */
export function cleanupChat(playerId: number): void {
  chatRanges.delete(playerId);
}

/** 聊天范围的中文名 */
export function chatRangeName(range: ChatRange): string {
  return range === "public" ? "全局（所有战局）" : "当前战局";
}

/** 万能面板入口：切换聊天范围 */
export async function changeChatRangeFlow(player: Player, back?: MenuBack): Promise<void> {
  const current = getChatRange(player.id);
  const info = [
    `1. 当前战局${current === "session" ? "（当前）" : ""} —— 只发给同一战局的玩家`,
    `2. 全局${current === "public" ? "（当前）" : ""} —— 发给所有战局的玩家`,
  ].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "聊天范围",
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const range: ChatRange = res.listItem === 1 ? "public" : "session";
  setChatRange(player.id, range);
  player.sendClientMessage(SESSION_CHAT_COLOR, `聊天范围已切换为：${chatRangeName(range)}`);
  return back?.();
}

/**
 * 初始化聊天系统。
 * 拦截 onText 按玩家范围分发：
 * - "session"（默认）：只发给同一战局的玩家
 * - "public"：发给所有玩家（全局公屏）
 * return false 抑制原生默认聊天显示（onText 返回 true 会同时输出 SA-MP 默认格式，造成重复）。
 */
export function initChat(): void {
  PlayerEvent.onText(({ player, text, next }) => {
    // 排除 NPC
    if (player.isNpc()) {
      return next();
    }
    // 未认证玩家不参与聊天（正常流程中认证期间也不会发出文本）
    if (!getAuthState(player.id)) {
      // B9：认证对话框期间打字被静默丢弃 → 给反馈，避免玩家以为发出去了
      player.sendClientMessage(COLOR_ERROR, "请先完成登录（正在登录中）");
      return false;
    }
    // 全局限频：发言过快则提示并忽略本次
    if (!allowChat(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "发言过于频繁，请稍后再试");
      return false;
    }
    // 名字本体剥离颜色码（supportAllNickname 允许昵称含 {RRGGBB}，防聊天注入），prefix/suffix 彩色装饰保留
    const name = getChatDisplayName(player.id, sanitizeChatText(player.getName().name));
    const range = getChatRange(player.id);
    // 敏感词拦截：含敏感词的消息拒绝发送（对齐 backend 聊天审/安全约定）。
    // 必须在 sanitize 之后的净文本上检测——剥离颜色码/控制字符后再查，防
    // "{RRGGBB}" 之类中缀把 AC 自动机匹配链拆断、绕过拦截（拆词攻击）
    const safeText = sanitizeChatText(text);
    if (containsSensitiveWord(safeText)) {
      player.sendClientMessage(COLOR_ERROR, "消息包含敏感内容，已拒绝发送");
      return false;
    }
    if (range === "public") {
      // 全局：发给所有在线玩家（含自己），NPC 除外
      for (const p of Player.getInstances()) {
        if (!p.isNpc()) {
          p.sendClientMessage(PUBLIC_CHAT_COLOR, `[全局] ${name}: ${safeText}`);
        }
      }
    } else {
      // 战局内（members 含玩家自己）
      const session = sessionManager.getPlayerSession(player);
      for (const p of session.members.values()) {
        p.sendClientMessage(SESSION_CHAT_COLOR, `[战局] ${name}: ${safeText}`);
      }
    }
    return false;
  });

  // /pm <ID> <消息>：私人聊天（任何模式下可用）
  PlayerEvent.onCommandText("pm", ({ player, subcommand, next }) => {
    const targetId = +subcommand[0];
    const msg = subcommand.slice(1).join(" ").trim();
    if (!targetId || !msg) {
      player.sendClientMessage(COLOR_ERROR, "用法: /pm 玩家ID 消息内容");
      return next();
    }
    // 私聊同样受聊天限频约束（防高频骚扰）
    if (!allowChat(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "发言过于频繁，请稍后再试");
      return next();
    }
    const target = Player.getInstance(targetId);
    if (!target || target.isNpc() || !target.isConnected()) {
      player.sendClientMessage(COLOR_ERROR, "无效的玩家ID");
      return next();
    }
    if (target.id === player.id) {
      player.sendClientMessage(COLOR_ERROR, "不能给自己发私聊");
      return next();
    }
    if (!getAuthState(target.id)) {
      player.sendClientMessage(COLOR_ERROR, "对方尚未登录");
      return next();
    }
    // 私聊同样拦截敏感词（对齐公共聊天口径）
    if (containsSensitiveWord(msg)) {
      player.sendClientMessage(COLOR_ERROR, "消息包含敏感内容，已拒绝发送");
      return next();
    }
    const safeMsg = sanitizeChatText(msg);
    // 昵称同样 sanitize：supportAllNickname 允许昵称含 {RRGGBB} 颜色码，
    // 不处理会被注入伪造 PM 颜色/格式（公共聊天 onText 已对名字 sanitize，这里对齐）
    const senderName = sanitizeChatText(player.getName().name);
    const targetName = sanitizeChatText(target.getName().name);
    target.sendClientMessage(PM_COLOR, `[pm] ${senderName}(${player.id}) 对你说: ${safeMsg}`);
    player.sendClientMessage(PM_COLOR, `[pm] 你对 ${targetName}(${target.id}) 说: ${safeMsg}`);
    new GameText("Private message Sent", 1000, 3).forPlayer(player);
    new GameText("Private message Received", 1000, 3).forPlayer(target);
    target.playSound(1057);
    return next();
  });
}
