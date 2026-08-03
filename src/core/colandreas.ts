import { init, findZ_For2DCoord } from "@infernus/colandreas";
import { logger } from "@/logger";
import { isInsideMap } from "@/utils/map";

/** colandreas 是否已成功初始化（插件缺失时为 false，不影响其他功能） */
let colandreasReady = false;

/** colandreas 是否可用（其他模块注册碰撞前判断） */
export function isColandreasReady(): boolean {
  return colandreasReady;
}

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

/**
 * 出生/落地 Z 修正（防半身入地 + 防被抬到遮挡物顶）：
 * - findZ_For2DCoord 是射线从上方打到的最顶面——若出生点在有屋檐/雨棚/立交
 *   遮挡的下方，命中的是遮挡物顶而非实际站的地面，直接取 ground 会把玩家
 *   抬到屋顶上。配置点 z 明显低于 ground（>2.5）时信配置点。
 * - colandreas 地面与流式物件地表常有微小落差，玩家脚底正好在 ground 会
 *   沉进去半身（模型原点在脚底 vs 地表高度差异），统一 +0.5 抬起。
 */
export function getSpawnGroundZ(x: number, y: number, pointZ: number): number {
  const ground = getSafeGroundZ(x, y, pointZ);
  // ground 远高于配置点 → 配置点在被遮挡物覆盖的下方，用配置点（+0.5 防入地）
  const base = ground > pointZ + 2.5 ? pointZ : Math.max(pointZ, ground);
  return base + 0.5;
}
