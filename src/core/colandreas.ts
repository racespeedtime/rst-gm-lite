import { init, findZ_For2DCoord } from "@infernus/colandreas";
import { logger } from "@/logger";
import { isInsideMap } from "@/utils/map";

/** colandreas 是否已成功初始化（插件缺失时为 false，不影响其他功能） */
let colandreasReady = false;

/**
 * 初始化 colandreas（插件可能未安装/未加载，失败仅记录日志不崩溃）。
 * 必须在 GameMode.onInit 内调用。
 */
export function initColandreas(): void {
  try {
    colandreasReady = init();
    if (colandreasReady) {
      logger.info("[colandreas] 碰撞检测插件已初始化");
    } else {
      logger.warn("[colandreas] 初始化失败，将跳过碰撞检测相关逻辑");
    }
  } catch (e) {
    colandreasReady = false;
    logger.warn(`[colandreas] 初始化异常（插件可能未安装）: ${e}`);
  }
}

/**
 * 获取坐标的安全落地高度：
 * - 超出游戏地图范围 → 不走 colandreas，返回 fallbackZ
 * - 地图内且 colandreas 可用 → 用 findZ_For2DCoord 找实际地面高度
 * - 失败/无数据 → 回退 fallbackZ
 */
export function getSafeGroundZ(x: number, y: number, fallbackZ: number): number {
  if (!isInsideMap(x, y, fallbackZ) || !colandreasReady) {
    return fallbackZ;
  }
  try {
    const ground = findZ_For2DCoord(x, y);
    if (typeof ground === "number" && Number.isFinite(ground)) {
      return ground;
    }
  } catch (e) {
    logger.warn(`[colandreas] findZ_For2DCoord 异常: ${e}`);
  }
  return fallbackZ;
}
