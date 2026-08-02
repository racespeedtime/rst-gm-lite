import { Player, Vehicle } from "@infernus/core";
import { destroyPlayerVehicle } from "@/vehicles";
import { syncNoCollisionState } from "@/core/vehicleAuto";
import { getSetting } from "@/personalize/settings";
import { getFirstCvehModel } from "./scripts";

/**
 * 比赛用车工具（供 race/room 与 race/editor 共用，独立模块避免两者循环依赖）。
 */

/**
 * 无碰撞开关（disableRemoteVehicleCollisions = 隐藏其他玩家车辆的碰撞）。
 * 比赛中强制开启（防他人车辆穿模阻挡），结束/离开时按个人设置恢复。
 * 实现统一走 vehicleAuto.syncNoCollisionState（非比赛切换设置也用同一入口）。
 */
export function applyRaceNoCollision(player: Player, enabled: boolean): void {
  syncNoCollisionState(player, enabled);
}

/** 恢复玩家个人无碰撞设置（比赛结束/离开时调用） */
export async function restorePersonalNoCollision(player: Player): Promise<void> {
  if (!player.isConnected()) return;
  const setting = await getSetting(player);
  syncNoCollisionState(player, setting?.vehicleNoCollision ?? false);
}

/**
 * 赛道默认车型：第一个 CP 的 cveh 换车脚本优先（以换车模型为基础），否则默认 411。
 */
export function getDefaultRaceModel(cps: { scripts: string[] }[]): number {
  for (const cp of cps) {
    const model = getFirstCvehModel(cp.scripts);
    if (model != null) return model;
  }
  return 411;
}

/**
 * 在指定位置刷出比赛用车并放入玩家（一人一车：先销毁现有车辆，带氮气）。
 * 用于赛道创建/测试与开赛时无车玩家的默认发车。
 */
export function spawnRaceVehicleAt(
  player: Player,
  modelId: number,
  x: number,
  y: number,
  z: number,
  angle: number,
): void {
  destroyPlayerVehicle(player.id);
  const veh = new Vehicle({ modelId, x, y, z, zAngle: angle, color: [-1, -1], respawnDelay: 0 });
  veh.create();
  veh.setVirtualWorld(player.getVirtualWorld());
  veh.linkToInterior(player.getInterior());
  veh.addComponent(1010); // 氮气
  veh.putPlayerIn(player, 0);
}
