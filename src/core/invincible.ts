import { BulletHitTypesEnum, Player, PlayerEvent, Vehicle } from "@infernus/core";
import { BulletSync, IPacket, PacketIdList } from "@infernus/raknet";
import { getSetting } from "@/personalize/settings";
import { logger } from "@/logger";

/**
 * 无敌模式（免疫伤害）。
 *
 * 三层防护（open.mp 中 OnPlayerTakeDamage 返回值只控制 filterscripts 转发，不阻止伤害）：
 * 1. raknet 层：拦截其他玩家发出的子弹同步包（BulletSync 206），目标为无敌玩家/其车辆时直接丢弃——
 *    攻击数据包到不了游戏伤害系统（对应「屏蔽 raknet 包」的需求，最彻底）。
 * 2. onTakeDamage 回血：覆盖跌落/爆炸/火焰等非子弹伤害（服务端直接结算），被打后立即回满血。
 * 3. 血量维持：出生时补满，避免无敌状态下死亡后残留残血。
 *
 * 状态缓存为进程内 Set（伤害回调与 raknet 拦截都是同步热路径，不能查库）。
 */

const invincibleSet = new Set<number>();

/** 玩家是否无敌（同步读取，供伤害事件与 raknet 拦截用） */
export function isInvincible(playerId: number): boolean {
  return invincibleSet.has(playerId);
}

/** 应用无敌状态：读设置 → 更新缓存 → 开启时立即回满血 */
export async function applyInvincibleState(player: Player): Promise<void> {
  try {
    const setting = await getSetting(player);
    const on = setting?.invincible ?? true;
    if (on) {
      invincibleSet.add(player.id);
      player.setHealth(100);
    } else {
      invincibleSet.delete(player.id);
    }
  } catch (e) {
    logger.error(`[invincible] 应用无敌状态失败 ${player.getName().name}`, e);
  }
}

/** 玩家断线清理（防 playerId 复用残留） */
export function cleanupInvincible(playerId: number): void {
  invincibleSet.delete(playerId);
}

/** 初始化无敌系统：伤害回血 + raknet 子弹包拦截 */
export function initInvincible(): void {
  // 玩家受到伤害（跌落/爆炸/火焰/碰撞等非子弹伤害）：无敌则回满血。
  // 同步 handler——不依赖返回值，直接结算回血。
  PlayerEvent.onTakeDamage(({ player, next }) => {
    if (invincibleSet.has(player.id)) {
      player.setHealth(100);
    }
    return next();
  });

  // 玩家对他人造成伤害：目标无敌时本可在此拦截（open.mp 返回值不阻止伤害，仅作提示保留）
  PlayerEvent.onGiveDamage(({ player: attacker, damage: victim, next }) => {
    if (invincibleSet.has(victim.id)) {
      // 提示攻击者目标无敌（视觉反馈，实际拦截由 raknet 层完成）
      attacker.sendClientMessage("#ffd700", `[无敌] ${victim.getName().name} 处于无敌状态`);
    }
    return next();
  });

  // 出生后补满血（无敌状态跨越重生）
  PlayerEvent.onSpawn(({ player, next }) => {
    if (invincibleSet.has(player.id)) {
      player.setHealth(100);
    }
    return next();
  });

  // raknet 层：子弹同步包拦截——目标为无敌玩家/其车辆时直接丢弃该包。
  // Pawn.RakNet 约定：return true(1) = 拦截包不交给游戏处理。
  try {
    IPacket(PacketIdList.BulletSync, ({ bs, next }) => {
      try {
        const bullet = new BulletSync(bs).readSync();
        bs.resetReadPointer(); // 不拦截时恢复读取位置，让游戏正常处理
        if (!bullet) return next();
        if (bullet.hitType === BulletHitTypesEnum.PLAYER && invincibleSet.has(bullet.hitId)) {
          return true; // 丢弃朝无敌玩家飞来的子弹包
        }
        if (bullet.hitType === BulletHitTypesEnum.VEHICLE) {
          const veh = Vehicle.getInstance(bullet.hitId);
          const driver = veh?.getDriver();
          if (driver && invincibleSet.has(driver.id)) {
            return true; // 丢弃朝无敌玩家车辆飞来的子弹包（保护车辆不被击毁）
          }
        }
        return next();
      } catch {
        return next(); // 异常包不拦截，放行给游戏处理
      }
    });
  } catch (e) {
    logger.warn(`[invincible] raknet 插件未加载，无敌仅靠回血兜底: ${e}`);
  }
}
