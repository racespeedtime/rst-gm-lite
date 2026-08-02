import {
  BulletHitTypesEnum,
  GameText,
  KeysEnum,
  isPressed,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  Vehicle,
} from "@infernus/core";
import { getSetting } from "@/personalize/settings";
import { getOwnedVehicle } from "@/vehicles";
import { setIntervalSafe } from "@/core/timers";
import { logger } from "@/logger";

/**
 * 车辆自动系统（对齐 rst-gm 原版 src/components/vehicle/ 实现）：
 * - vehicleFlip 翻车自动翻正：四元数换算 bank 角 >160° 且车速接近 0 → 原位重置（物理重新落正）
 * - vehicleAutoFix 自动修复：onWeaponShot 拦截打向自己车辆的子弹 + 每秒 repair 兜底
 * - vehicleColorCycle 定时换色（变色龙）：每秒随机换色
 * - nitroType 氮气：timer=每 tick 计数、满 15 秒补一次；hold=按加速键补充
 * - showStunt 特技显示：车辆腾空提示
 *
 * 1 秒定时器驱动（对齐原版 serverInfo.startSecondTimer）。
 */

const VEHICLE_TICK_MS = 1000;
/** 氮气补充：累计 15 次 tick = 15 秒（原版 addNitro） */
const NITRO_TICK_LIMIT = 15;
/** 特技显示冷却（防刷屏） */
const STUNT_COOLDOWN_MS = 2000;
/** 视为腾空的 z 速度阈值（SA-MP 单位） */
const STUNT_AIR_SPEED = 1.2;

/** playerId -> 氮气 tick 计数 */
const nitroCount = new Map<number, number>();
/** playerId -> 上次特技提示时间 */
const lastStuntAt = new Map<number, number>();
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
  lastStuntAt.delete(playerId);
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
      veh.addComponent(1010);
    } else {
      nitroCount.set(player.id, n);
    }
  }
  // 特技显示：车辆腾空（z 速度大）提示，带冷却防刷屏
  if (setting.showStunt && (lastStuntAt.get(player.id) ?? 0) + STUNT_COOLDOWN_MS < Date.now()) {
    const vel = veh.getVelocity();
    if (Math.abs(vel.z) > STUNT_AIR_SPEED) {
      lastStuntAt.set(player.id, Date.now());
      new GameText("~r~STUNT!~w~ +1", 1200, 6).forPlayer(player);
    }
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
      veh.addComponent(1010);
    })();
    return next();
  });
}
