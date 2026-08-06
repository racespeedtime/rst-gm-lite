import { BulletHitTypesEnum, Player, PlayerEvent, Vehicle } from "@infernus/core";
import { BulletSync, IPacket, PacketIdList } from "@infernus/raknet";
import { getSetting } from "@/personalize/settings";
import { applyDefaultArmor } from "@/core/armor";
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
 * 与护甲关联：开启无敌/被打/出生时护甲与血量一起回满（护甲也是生命的一部分）。
 *
 * 状态缓存为进程内 Set（伤害回调与 raknet 拦截都是同步热路径，不能查库）。
 */

const invincibleSet = new Set<number>();
/** 无敌提示节流：攻击者-目标 3 秒内只提示一次（防自动武器扫射刷屏） */
const GIVE_NOTIFY_MS = 3000;
const lastGiveNotify = new Map<string, number>();
/** 诊断：BulletSync 拦截触发计数（确认包拦截是否真正生效——0 说明拦截未触发，
 *  与回放录制 DriverSync 同源问题；日志核对用） */
let bulletIntercepts = 0;
let bulletInterceptLogged = false;

/** 玩家是否无敌（同步读取，供伤害事件与 raknet 拦截用） */
export function isInvincible(playerId: number): boolean {
  return invincibleSet.has(playerId);
}

/** 满血 + 满甲（无敌状态下生命值维持） */
function fullHealthAndArmor(player: Player): void {
  player.setHealth(100);
  applyDefaultArmor(player);
}

/** 应用无敌状态：读设置 → 更新缓存 → 开启时立即满血满甲 */
export async function applyInvincibleState(player: Player): Promise<void> {
  try {
    const setting = await getSetting(player);
    const on = setting?.invincible ?? true;
    if (on) {
      invincibleSet.add(player.id);
      fullHealthAndArmor(player);
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
  // 清掉该玩家的节流提示记录（key 含该 playerId，防 Map 累积）
  for (const key of [...lastGiveNotify.keys()]) {
    if (key.startsWith(`${playerId}:`) || key.endsWith(`:${playerId}`)) {
      lastGiveNotify.delete(key);
    }
  }
}

/** 初始化无敌系统：伤害回血 + raknet 子弹包拦截 */
export function initInvincible(): void {
  // 玩家受到伤害（跌落/爆炸/火焰/碰撞等非子弹伤害）：无敌则满血满甲。
  // 同步 handler——回血后 return false（不再转发后续 handler/原生 filterscript），
  // 语义清晰：无敌玩家的伤害在服务端结算前被拦截。open.mp 的 OnPlayerTakeDamage
  // 返回值不阻止伤害，真正的免伤靠立即回满血（fullHealthAndArmor）。
  PlayerEvent.onTakeDamage(({ player, next }) => {
    if (invincibleSet.has(player.id)) {
      fullHealthAndArmor(player);
      return false;
    }
    return next();
  });

  // 玩家对他人造成伤害：目标无敌时本可在此拦截（open.mp 返回值不阻止伤害，仅作提示保留）
  PlayerEvent.onGiveDamage(({ player: attacker, damage: victim, next }) => {
    if (invincibleSet.has(victim.id)) {
      // 提示攻击者目标无敌（视觉反馈，实际拦截由 raknet 层完成）。
      // 节流：自动武器扫射会每帧触发 → 同一攻击者-目标 3 秒内只提示一次
      const key = `${attacker.id}:${victim.id}`;
      const now = Date.now();
      if ((lastGiveNotify.get(key) ?? 0) < now - GIVE_NOTIFY_MS) {
        lastGiveNotify.set(key, now);
        attacker.sendClientMessage("#ffd700", `[无敌] ${victim.getName().name} 处于无敌状态`);
      }
    }
    return next();
  });

  // 出生后满血满甲（无敌状态跨越重生）
  PlayerEvent.onSpawn(({ player, next }) => {
    if (invincibleSet.has(player.id)) {
      fullHealthAndArmor(player);
    }
    return next();
  });

  // raknet 层：子弹同步包拦截——目标为无敌玩家/其车辆时直接丢弃该包。
  // Pawn.RakNet 约定：return false(0) = 拦截包不交给游戏处理（插件 OnEvent
  // 对 false 返回整体拦截，与 replay 的 DriverSync 屏蔽同约定；return true 是
  // 放行）。此前误用 return true 导致拦截从未生效，子弹仍到伤害系统（全靠
  // onTakeDamage 回血兜底）。
  // IPacket 是 samp.on 事件注册（与 PlayerEvent 同构），模块导入期注册即有效。
  // 诊断：首次拦截成功打一条日志——若一直没出现，说明包拦截链路未通。
  try {
    IPacket(PacketIdList.BulletSync, ({ bs, next }) => {
      try {
        const bullet = new BulletSync(bs).readSync();
        bs.resetReadPointer(); // 不拦截时恢复读取位置，让游戏正常处理
        if (!bullet) return next();
        if (bullet.hitType === BulletHitTypesEnum.PLAYER && invincibleSet.has(bullet.hitId)) {
          bulletIntercepts++;
          // 诊断：首次拦截成功打一条日志（确认 IPacket 链路通；后续不刷屏）
          if (!bulletInterceptLogged) {
            bulletInterceptLogged = true;
            logger.info(`[invincible] raknet 子弹拦截已生效（累计 ${bulletIntercepts} 次）`);
          }
          return false; // 丢弃朝无敌玩家飞来的子弹包
        }
        if (bullet.hitType === BulletHitTypesEnum.VEHICLE) {
          const veh = Vehicle.getInstance(bullet.hitId);
          const driver = veh?.getDriver();
          if (driver && invincibleSet.has(driver.id)) {
            bulletIntercepts++;
            if (!bulletInterceptLogged) {
              bulletInterceptLogged = true;
              logger.info(`[invincible] raknet 子弹拦截已生效（累计 ${bulletIntercepts} 次）`);
            }
            return false; // 丢弃朝无敌玩家车辆飞来的子弹包（保护车辆不被击毁）
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
