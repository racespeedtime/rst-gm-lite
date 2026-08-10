import { Player, Vehicle } from "@infernus/core";
import { destroyPlayerVehicle, addNitro } from "@/vehicles";
import { syncNoCollisionState } from "@/core/vehicleAuto";
import { getSetting } from "@/personalize/settings";
import { getFirstCvehModel, registerScriptVehicle } from "./scripts";

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
 * 赛道默认车型：仅看第一个 CP 的 cveh 换车脚本（首个 CP 有换车则用它，否则默认 411）。
 * 不扫描整条赛道——cveh 是经过该 CP 时触发的中途换车（如 Car 赛道的 562 在 CP11），
 * 不是开赛车型；开赛车型只应跟随起点 CP 的脚本。
 */
export function getDefaultRaceModel(cps: { scripts: string[] }[]): number {
  const first = cps[0];
  const model = first ? getFirstCvehModel(first.scripts) : null;
  return model ?? 411;
}

/**
 * 起点朝向校正阈值（度）：CP1 记录角度与"CP1→CP2 走向方向"偏差超过此值即判定
 * 朝向失真，用计算值替代并提示（作者放置 CP1 时车内 getFacingAngle 可能滞后/
 * 车头没对准赛道走向，导致车头朝向与赛道走向不符）。
 */
const START_ANGLE_CORRECT_THRESHOLD = 45;

/**
 * 起点朝向：优先用 CP1→CP2 方向计算的理论朝向（标准 SA 朝向公式 atan2(Ax-Bx, Ay-By)，
 * 0=北/90=西/180=南/270=东）。CP1 记录角度（作者放置时的 getFacingAngle 快照）与
 * 计算值偏差 > 阈值 → 返回 corrected=true，调用方用计算值并提示。
 * 只有 1 个 CP（无方向可算）→ 沿用记录角度。
 */
export function getFirstCpStartAngle(cps: { x: number; y: number; angle: number }[]): {
  angle: number;
  corrected: boolean;
} {
  const first = cps[0];
  if (!first) return { angle: 0, corrected: false };
  const second = cps[1];
  if (!second) return { angle: first.angle, corrected: false };
  const rad = Math.atan2(first.x - second.x, first.y - second.y);
  const computed = ((((rad * 180) / Math.PI) % 360) + 360) % 360;
  const d = Math.abs(((first.angle - computed) % 360) + 360) % 360;
  const diff = Math.min(d, 360 - d); // 环形角度差（0 与 359 差 1°）
  if (diff > START_ANGLE_CORRECT_THRESHOLD) {
    return { angle: computed, corrected: true };
  }
  return { angle: first.angle, corrected: false };
}

/**
 * 在指定位置刷出比赛用车并放入玩家（一人一车：先销毁现有车辆，带氮气）。
 * 用于赛道创建/测试与开赛时无车玩家的默认发车。
 * 车辆登记进脚本车辆生命周期表：离开比赛/结束/断线时统一销毁，防泄漏。
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
  registerScriptVehicle(player.id, veh);
  veh.setVirtualWorld(player.getVirtualWorld());
  veh.linkToInterior(player.getInterior());
  addNitro(veh); // 氮气
  veh.putPlayerIn(player, 0);
}
