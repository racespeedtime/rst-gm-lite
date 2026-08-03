import { Player, PlayerEvent } from "@infernus/core";
import { logger } from "@/logger";

/**
 * 无限金钱系统。
 * 对齐原版登录时 GivePlayerMoney(99999999)：玩家不需要经济系统，
 * 钱只用于改装店/消费——登录给足 + 进入改装店补给，实现"花不完"。
 * open.mp GivePlayerMoney 上限 0x7FFFFFFF，99999999 足够所有改装消费。
 */
const INFINITE_MONEY = 99_999_999;

/** 给玩家补足无限金钱（登录/进改装店时调用） */
export function giveInfinityMoney(player: Player): void {
  try {
    player.giveMoney(INFINITE_MONEY);
  } catch (e) {
    logger.warn(`[money] 补发金钱失败 ${player.id}`, e);
  }
}

/** 初始化金钱系统（timer/事件由 GameMode 统一管理） */
export function initMoneySystem(): void {
  // 进入改装店时补给：改装是扣钱场景，确保任何时候都有钱改装
  PlayerEvent.onEnterExitModShop(({ player, enterExit, next }) => {
    if (player.isNpc()) return next();
    if (enterExit === 1) {
      // enterExit=1 进入改装店
      giveInfinityMoney(player);
    }
    return next();
  });
}
