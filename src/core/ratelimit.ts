import { PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";

/** 聊天最小间隔（毫秒） */
export const CHAT_COOLDOWN_MS = 1500;
/** 指令最小间隔（毫秒） */
export const COMMAND_COOLDOWN_MS = 500;

import { COLOR_ERROR } from "@/utils/colors";

const lastChatAt = new Map<number, number>();
const lastCommandAt = new Map<number, number>();

/** 是否允许发言（过快返回 false 并忽略，不重置冷却） */
export function allowChat(playerId: number): boolean {
  const now = Date.now();
  const last = lastChatAt.get(playerId) ?? 0;
  if (now - last < CHAT_COOLDOWN_MS) return false;
  lastChatAt.set(playerId, now);
  return true;
}

/** 是否允许执行指令（过快返回 false 并忽略，不重置冷却） */
export function allowCommand(playerId: number): boolean {
  const now = Date.now();
  const last = lastCommandAt.get(playerId) ?? 0;
  if (now - last < COMMAND_COOLDOWN_MS) return false;
  lastCommandAt.set(playerId, now);
  return true;
}

/** 玩家断开时清理限频状态 */
export function cleanupRateLimit(playerId: number): void {
  lastChatAt.delete(playerId);
  lastCommandAt.delete(playerId);
}

/**
 * 初始化指令限频：
 * - 未认证玩家拒绝一切命令（认证是对话框驱动的，无需命令）
 * - onCommandReceived 返回 false 拒绝过快指令（触发 RECEIVED_REJECTED）
 * - onCommandError 对 RECEIVED_REJECTED 抑制默认提示（提示已由限频处发出）
 */
export function initRateLimit(): void {
  PlayerEvent.onCommandReceived(({ player, next }) => {
    // 排除 NPC
    if (player.isNpc()) {
      return next();
    }
    // 未认证玩家（登录/注册对话框期间）拒绝一切命令
    if (!getAuthState(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "请先完成登录或注册");
      return false;
    }
    if (!allowCommand(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "操作过于频繁，请稍后再试");
      return false;
    }
    return next();
  });

  PlayerEvent.onCommandError(({ error, next }) => {
    // 限频拒绝产生的错误提示已单独发出，抑制默认错误显示
    if (error.type === "RECEIVED_REJECTED") {
      return true;
    }
    return next();
  });
}
