import { Player } from "@infernus/core";
import { getSetting } from "@/personalize/settings";
import { logger } from "@/logger";

/**
 * 玩家外观/标识设置（showName NameTag 显隐 + prefix/suffix 聊天名前后缀）。
 *
 * 进程内同步缓存：聊天渲染是同步热路径（async handler 返回值会被 infernus 忽略，
 * 导致默认聊天重复显示），所以登录/设置变更时同步写缓存，渲染时同步读。
 */

/** showName=false 的玩家（其余玩家看不到其 NameTag） */
const hiddenNameTag = new Set<number>();
/** playerId -> 聊天名样式（prefix/suffix 前后缀 + playerColor 玩家颜色） */
const chatStyle = new Map<number, { prefix: string; suffix: string; playerColor: string }>();

/**
 * 读取聊天显示名（同步）：
 * 名字本体包玩家颜色（对齐原版 GetPlayerColor >>> 8 用于聊天名），
 * prefix/suffix 前后缀独立保留（用户自定义颜色码不受影响）。
 */
export function getChatDisplayName(playerId: number, baseName: string): string {
  const s = chatStyle.get(playerId);
  if (!s) return baseName;
  const color = s.playerColor || "#ffffff";
  return `${s.prefix}{${color.replace("#", "")}}${baseName}{FFFFFF}${s.suffix}`;
}

/** 玩家是否隐藏了自己的 NameTag（同步，供登录时同步给新玩家用） */
export function isNameTagHidden(playerId: number): boolean {
  return hiddenNameTag.has(playerId);
}

/** 让某玩家对目标显示/隐藏自己的 NameTag */
function setOwnNameTagVisibility(player: Player, target: Player, show: boolean): void {
  player.showNameTag(target, show);
}

/** 应用设置：showName → 对全部在线玩家设置 NameTag 显隐；prefix/suffix → 写入聊天名缓存 */
export async function applyPlayerStyle(player: Player): Promise<void> {
  try {
    const setting = await getSetting(player);
    const hide = setting ? !setting.showName : false;
    if (hide) {
      hiddenNameTag.add(player.id);
      for (const other of Player.getInstances()) {
        if (other.isNpc() || other.id === player.id || !other.isConnected()) continue;
        setOwnNameTagVisibility(player, other, false);
      }
    } else {
      hiddenNameTag.delete(player.id);
      for (const other of Player.getInstances()) {
        if (other.isNpc() || other.id === player.id || !other.isConnected()) continue;
        setOwnNameTagVisibility(player, other, true);
      }
    }
    chatStyle.set(player.id, {
      prefix: setting?.prefix ?? "",
      suffix: setting?.suffix ?? "",
      playerColor: setting?.playerColor ?? "#ffffff",
    });
  } catch (e) {
    logger.error(`[style] 应用玩家标识设置失败 ${player.getName().name}`, e);
  }
}

/** 新玩家认证完成：让已隐藏 NameTag 的玩家对新人隐藏（保持一致性） */
export function applyStyleToNewPlayer(newPlayer: Player): void {
  for (const hid of hiddenNameTag) {
    const hp = Player.getInstance(hid);
    if (hp && hp.isConnected()) {
      setOwnNameTagVisibility(hp, newPlayer, false);
    }
  }
}

/** 玩家断线清理 */
export function cleanupPlayerStyle(playerId: number): void {
  hiddenNameTag.delete(playerId);
  chatStyle.delete(playerId);
}
