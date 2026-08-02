import { Player, PlayerEvent } from "@infernus/core";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";

/**
 * 默认护甲系统。
 * 玩家每次出生/重生默认补满护甲（即使不开无敌也有甲），
 * 无敌状态关联：开启/被打时护甲与血量一起回满（见 invincible.ts）。
 */
const DEFAULT_ARMOR = 100;

/** 给玩家补满默认护甲（出生/重生/无敌回满共用） */
export function applyDefaultArmor(player: Player): void {
  try {
    player.setArmour(DEFAULT_ARMOR);
  } catch (e) {
    logger.warn(`[armor] 设置护甲失败 ${player.id}`, e);
  }
}

/** 初始化：每次出生/重生统一补默认护甲（覆盖登录出生、/kill 重生、死亡重生、比赛重生等一切 spawn 路径） */
export function initArmor(): void {
  PlayerEvent.onSpawn(({ player, next }) => {
    if (player.isNpc()) return next();
    // 认证玩家的出生/重生默认给甲；认证流程前的 spawn（未登录）不给
    if (getAuthState(player.id)) {
      applyDefaultArmor(player);
    }
    return next();
  });
}
