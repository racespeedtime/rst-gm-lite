import { CA_Object } from "@infernus/colandreas";
import { isColandreasReady } from "./colandreas";
import { logger } from "@/logger";

/**
 * 动态物体注册进 colandreas 碰撞系统。
 *
 * 背景：colandreas 默认只有静态地图数据（SA 建筑），运行时创建的房屋 obj 等
 * 不参与射线检测——玩家传送/出生到这些物体位置会"卡进物体里"。
 * 通过 CA_CreateObject（CA_Object 封装）把物体注册进碰撞网格，之后
 * findZ_For2DCoord / rayCastLine 就能命中它们：
 * - 出生/重生定位 getSafeGroundZ → 落在物体表面而非穿透
 * - 传送点落地修正 → 不卡进房屋
 *
 * 注意：CA_Object(newObject=false) 不重复创建 DynamicObject（调用方已有实例），
 * 仅注册碰撞并保留碰撞 id（dc=true）供销毁。上限 50000（colandreas 常量）。
 */

const registered = new Set<CA_Object>();

/**
 * 把房屋 obj 注册进 colandreas 碰撞网格（world 0 静态物体，位置/旋转固定）。
 * 返回是否注册成功（colandreas 不可用/超上限/异常返回 false，不影响其他功能）。
 */
export function registerObjectCollision(
  modelId: number,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): boolean {
  if (!isColandreasReady()) return false;
  try {
    const ca = new CA_Object({ modelId, x, y, z, rx, ry, rz }, true, false);
    // getCollisionID() 有效（-2 无效/-1 未保留）才登记；无效则立即销毁
    if (ca.getCollisionID() !== -2) {
      registered.add(ca);
      return true;
    }
    ca.destroy();
  } catch (e) {
    logger.warn(`[collision] 注册物体碰撞失败 model=${modelId}`, e);
  }
  return false;
}

/** 销毁全部已注册碰撞（GameMode 退出时调用） */
export function clearObjectCollisions(): void {
  for (const ca of registered) {
    try {
      ca.destroy();
    } catch (e) {
      logger.warn("[collision] 销毁碰撞失败", e);
    }
  }
  registered.clear();
}
