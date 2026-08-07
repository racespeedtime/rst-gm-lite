import {
  BulletHitTypesEnum,
  GameText,
  KeysEnum,
  isPressed,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  Vehicle,
  VehicleEvent,
} from "@infernus/core";
import { getSetting } from "@/personalize/settings";
import { getOwnedVehicle, addNitro } from "@/vehicles";
import { setIntervalSafe } from "@/core/timers";
import { logger } from "@/logger";

/**
 * 车辆自动系统（对齐 rst-gm 原版 src/components/vehicle/ 实现）：
 * - vehicleFlip 翻车自动翻正：四元数换算 bank 角 >160° 且车速接近 0 → 原位重置（物理重新落正）
 * - vehicleAutoFix 自动修复：onWeaponShot 拦截打向自己车辆的子弹 + 每秒 repair 兜底
 * - vehicleColorCycle 定时换色（变色龙）：每秒随机换色
 * - nitroType 氮气：timer=每 tick 计数、满 15 秒补一次；hold=按加速键补充
 * - showStunt 特技显示：按人调用原生 EnableStuntBonusForPlayer（游戏内建特技
 *   奖励，对齐原版 /stunt 开关——不再自造 GameText 提示）
 *
 * 1 秒定时器驱动（对齐原版 serverInfo.startSecondTimer）。
 */

const VEHICLE_TICK_MS = 1000;
/** 氮气补充：累计 15 次 tick = 15 秒（原版 addNitro） */
const NITRO_TICK_LIMIT = 15;

/** playerId -> 氮气 tick 计数 */
const nitroCount = new Map<number, number>();
/**
 * vehicleAutoFix 的同步缓存（onWeaponShot 是同步热路径，async handler 返回值会被
 * infernus 忽略导致拦截失效——对齐原版 PlayerInfo 内存态，登录/切换时同步写入）。
 */
const autoFixSet = new Set<number>();

/** 同步应用车辆自动状态（登录/设置变更时调用），开启 autoFix 的玩家登记拦截名单 */
export function syncVehicleAutoState(player: Player, setting: { vehicleAutoFix: boolean }): void {
  if (setting.vehicleAutoFix) {
    autoFixSet.add(player.id);
  } else {
    autoFixSet.delete(player.id);
  }
}

/**
 * 应用特技显示（showStunt）：按人调用原生 EnableStuntBonusForPlayer——
 * 游戏内建特技奖励（翻车/腾空时客户端原生弹 "Stunt Bonus"），对齐原版
 * /stunt 开关（EnableStuntBonusForPlayer(playerid, 1/0)）。
 * infernus 未暴露公开方法，用 Player.__inject__.enableStuntBonus 调原生。
 * 登录/切换设置时调用。
 */
export function syncStuntState(player: Player, enabled: boolean): void {
  try {
    Player.__inject__.enableStuntBonus(player.id, enabled);
  } catch (e) {
    logger.warn(`[vehAuto] 设置特技显示失败 ${player.id}`, e);
  }
}

/**
 * 无碰撞（vehicleNoCollision）：隐藏其他玩家车辆的碰撞。
 * 登录/切换设置时按个人设置应用；比赛期间由 race/room 强制开启，结束时按此恢复。
 */
export function syncNoCollisionState(player: Player, enabled: boolean): void {
  try {
    player.disableRemoteVehicleCollisions(enabled);
  } catch (e) {
    logger.warn(`[vehAuto] 设置无碰撞失败 ${player.id}`, e);
  }
}

/** 判断玩家开的是否是自己的爱车（对齐原版 canAutoFix 的 pInfo.veh 语义） */
function isOwnVehicle(player: Player, veh: Vehicle): boolean {
  return getOwnedVehicle(player.id) === veh;
}

/** 翻车检测：四元数换算 bank 角，>160° 视为翻转（对齐原版 autoFlip） */
function isFlipped(veh: Vehicle): boolean {
  const quat = veh.getRotationQuat();
  if (!quat) return false;
  const { w, x, y, z } = quat;
  const sqw = w * w;
  const sqx = x * x;
  const sqy = y * y;
  const sqz = z * z;
  const bank = (Math.atan2(2 * (y * z + x * w), -sqx - sqy + sqz + sqw) * 180) / Math.PI;
  return Math.abs(bank) > 160;
}

/**
 * 翻正车辆（对齐原版两种实现）：
 * - 手动（快捷操作，对齐 /f）：抬升 2 后重置朝向，物理重新落正
 * - 自动（vehicleFlip，对齐 autoFlip）：原位重置位置+朝向
 */
export function flipVehicle(veh: Vehicle, lift = 0): void {
  const { x, y, z } = veh.getPos();
  const zAngle = veh.getZAngle().angle;
  veh.setPos(x, y, z + lift);
  veh.setZAngle(zAngle);
}

/** 玩家断线清理（防 playerId 复用残留计时） */
export function cleanupVehicleAuto(playerId: number): void {
  nitroCount.delete(playerId);
  autoFixSet.delete(playerId);
}

/** 单玩家车辆自动 tick（1 秒一次，对齐原版 addNitro/autoFix/randomVehColor/autoFlip） */
async function vehicleTick(player: Player): Promise<void> {
  if (!player.isInAnyVehicle()) return;
  const veh = player.getVehicle();
  if (!veh) return;
  const setting = await getSetting(player);
  if (!setting) return;
  const isDriver = player.getState() === PlayerStateEnum.DRIVER;

  // autoFix：每秒修复兜底（主防护在 onWeaponShot 拦截子弹）——仅自己的车
  if (setting.vehicleAutoFix && isDriver && isOwnVehicle(player, veh)) {
    veh.repair();
  }
  // 变色龙换色：每秒随机换色（对齐原版 hys）——仅自己的车
  if (setting.vehicleColorCycle && isDriver && isOwnVehicle(player, veh)) {
    veh.changeColors(Math.floor(Math.random() * 256), Math.floor(Math.random() * 256));
  }
  // autoFlip：四元数 bank 角 + 车速接近 0 才翻正（防行驶中误翻）
  if (setting.vehicleFlip && veh.getSpeed() <= 0.1 && isFlipped(veh)) {
    flipVehicle(veh);
    new GameText("~w~vehicle ~g~fl~h~ip~h~pe~h~d", 2000, 4).forPlayer(player);
    return;
  }
  // nitro（timer 模式）：每秒计数，满 15 秒补一次——仅自己的车
  if (setting.nitroType === "timer" && isDriver && isOwnVehicle(player, veh)) {
    const n = (nitroCount.get(player.id) ?? 0) + 1;
    if (n >= NITRO_TICK_LIMIT) {
      nitroCount.set(player.id, 0);
      addNitro(veh);
    } else {
      nitroCount.set(player.id, n);
    }
  }
  // nitro（hold 模式）冷却递减：SPRINT 补氮气后置 15 占位，这里每秒 -1，
  // 15 秒后归零才允许再次补充——否则占位永远不清零，hold 氮气一次上车只能用一次
  if (setting.nitroType === "hold") {
    const n = nitroCount.get(player.id) ?? 0;
    if (n > 0) nitroCount.set(player.id, n - 1);
  }
}

/** 初始化车辆自动系统（timer 由 GameMode.onExit 统一清理） */
export function initVehicleAuto(): void {
  // 1 秒轮询：所有在线玩家车辆的自动逻辑（对齐原版 startSecondTimer）
  setIntervalSafe(() => {
    void (async () => {
      for (const player of Player.getInstances()) {
        if (player.isNpc() || !player.isConnected()) continue;
        try {
          await vehicleTick(player);
        } catch (e) {
          logger.error(`[vehAuto] ${player.getName().name} 车辆自动逻辑异常`, e);
        }
      }
    })();
  }, VEHICLE_TICK_MS);

  // autoFix 主防护：拦截打向玩家车辆的子弹（对齐原版 autoFix 的 onWeaponShot）
  // 同步读取 autoFixSet 缓存（async handler 返回值会被 infernus 忽略，必须同步 return false）
  PlayerEvent.onWeaponShot(({ hitType, hitId, next }) => {
    if (hitType !== BulletHitTypesEnum.VEHICLE) return next();
    const veh = Vehicle.getInstance(hitId);
    if (!veh) return next();
    // getLastDriver 而非 getDriver：司机刚下车瞬间仍算该车
    const driver = veh.getLastDriver();
    if (driver && driver.isConnected() && !driver.isNpc() && autoFixSet.has(driver.id)) {
      if (isOwnVehicle(driver, veh)) {
        return false; // 对齐原版：阻止这次射击对车辆造成的伤害（直接返回，不调用 next 避免语义干扰）
      }
    }
    return next();
  });

  // autoFix 即时修复：车辆损坏状态更新（受击/碰撞/爆炸瞬间触发）→ 立即修复。
  // 对齐原版 OnVehicleDamageStatusUpdate + AutoFix 的 RepairVehicle；
  // 与 onWeaponShot 互补——子弹拦截是阻止伤害结算，这里是伤害已发生（碰撞/爆炸等）时立刻修回，
  // 不等每秒 tick 兜底。事件 player 为车内玩家，用 getLastDriver 兜底。
  VehicleEvent.onDamageStatusUpdate(({ vehicle, player, next }) => {
    const driver = vehicle.getLastDriver() ?? player;
    if (driver && driver.isConnected() && !driver.isNpc() && autoFixSet.has(driver.id)) {
      if (isOwnVehicle(driver, vehicle)) {
        vehicle.repair();
      }
    }
    return next();
  });

  // 上车即给氮气（对齐原版 OnPlayerStateChange → PLAYER_STATE_DRIVER → AddVehicleComponent 1010）：
  // 成为司机进入自己的爱车时立即补一次氮气，避免等 timer 计满 15 秒才第一次补
  PlayerEvent.onStateChange(({ player, newState, next }) => {
    if (player.isNpc()) return next();
    if (newState !== PlayerStateEnum.DRIVER) return next();
    const veh = player.getVehicle();
    if (!veh || !isOwnVehicle(player, veh)) return next();
    addNitro(veh); // 氮气
    // 重置计时：上车即补，之后的 15 秒计数从上车时刻重新开始（timer/hold 共用）
    nitroCount.set(player.id, 0);
    return next();
  });

  // hold 氮气：按加速键（SPRINT/W）补氮气（有 15 秒冷却）
  PlayerEvent.onKeyStateChange(({ player, newKeys, oldKeys, next }) => {
    if (player.isNpc()) return next();
    const pressed = isPressed(newKeys, oldKeys, KeysEnum.SPRINT); // 按下瞬间
    if (!pressed || !player.isInAnyVehicle()) return next();
    void (async () => {
      const setting = await getSetting(player);
      if (!setting || setting.nitroType !== "hold") return;
      if ((nitroCount.get(player.id) ?? 0) > 0) return;
      const veh = player.getVehicle();
      if (!veh || !isOwnVehicle(player, veh)) return;
      nitroCount.set(player.id, NITRO_TICK_LIMIT); // 占位：15 秒内不重复补
      addNitro(veh);
    })();
    return next();
  });
}
