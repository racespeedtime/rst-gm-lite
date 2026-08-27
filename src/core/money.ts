import { Player, PlayerEvent } from "@infernus/core";
import { logger } from "@/logger";
import { setIntervalSafe } from "@/core/timers";

/**
 * 无限金钱系统。
 * 对齐原版登录时 GivePlayerMoney(99999999)：玩家不需要经济系统，
 * 钱只用于改装店/消费——登录给足 + 全局锁钱，金额恒定"花不完、不变动"。
 * open.mp GivePlayerMoney 上限 0x7FFFFFFF，99999999 足够所有改装消费。
 */
const INFINITE_MONEY = 99_999_999;

/** 锁钱轮询间隔：特技奖励（stuntBonus）加分/改装店消费扣款等任何来源的
 *  money 变动在半个间隔内被拉回固定值 */
const LOCK_INTERVAL_MS = 500;

/** 给玩家补足无限金钱（登录/进改装店时调用） */
export function giveInfinityMoney(player: Player): void {
  try {
    // 封顶补给：已有足额不重复累加（giveMoney 累加会超 open.mp Int32 上限变负）
    if (player.getMoney() < INFINITE_MONEY) {
      player.resetMoney();
      player.giveMoney(INFINITE_MONEY);
    }
  } catch (e) {
    logger.warn(`[money] 补发金钱失败 ${player.id}`, e);
  }
}

/** 锁钱轮询：money 恒定锁定在 INFINITE_MONEY，不动态变化。
 * 覆盖特技奖励加分、改装店消费扣款等所有改变钱数的路径（open.mp 无 money
 * 变化事件，轮询是唯一可靠兜底）。仅当值偏离目标才重置——正常恒定零开销；
 * resetMoney+giveMoney 会触发全局 money 同步广播，偏离场景下一次重置可接受。 */
function lockPlayerMoney(): void {
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    try {
      if (player.getMoney() !== INFINITE_MONEY) {
        player.resetMoney();
        player.giveMoney(INFINITE_MONEY);
      }
    } catch (e) {
      logger.warn(`[money] 锁钱失败 ${player.id}`, e);
    }
  }
}

/** 启动锁钱 tick（持久 interval：onInit 注册、onExit 统一清理） */
export function startMoneyTicks(): void {
  // 全局锁钱：定时校正任何 money 变动（特技/改装等），timer 登记制随 onExit 清理
  setIntervalSafe(lockPlayerMoney, LOCK_INTERVAL_MS);
}

/** 初始化金钱系统（事件注册，模块加载时注册一次） */
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
