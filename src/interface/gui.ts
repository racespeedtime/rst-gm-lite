import { DynamicObject, Player, TextDraw, Vehicle } from "@infernus/core";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { setIntervalSafe } from "@/core/timers";
import { getObserveTarget } from "@/core/observe";
import {
  getCachedSetting,
  getCachedSettingByUserId,
  preloadSettingsBatch,
} from "@/personalize/settings";
import {
  createSpeed2d,
  createSpeed3d,
  destroySpeed2d,
  destroySpeed3d,
  updateSpeed2d,
  updateSpeed3d,
} from "./speedometer";
import { createNetstat, destroyNetstat, updateNetstat } from "./netstat";
import type { NetstatState } from "./netstat";
import {
  createDebugInfo,
  destroyDebugInfo,
  updateDebugInfo,
  createBuildVersionTd,
  destroyBuildVersionTd,
  type DebugInfoState,
} from "./debugInfo";
import type { SysUserSettingModel } from "@/prisma/generated/prisma/models/SysUserSetting";

/** 刷新频率（原版 updateSpeedometer 定时器为 200ms） */
const REFRESH_INTERVAL_MS = 200;

/** 单个玩家的 GUI 运行时状态 */
interface PlayerGui {
  speedoTd: TextDraw[];
  speedo3d: DynamicObject | null;
  /** 3d 速度表当前 attach 到的车辆 id（换车时据此重建） */
  speedo3dVehId: number | null;
  netstat: NetstatState | null;
  debugInfo: DebugInfoState | null;
  /** 构建版本 TD（与 debug 联动：showDebugInfo 开关一并创建/销毁） */
  buildTd: TextDraw | null;
  /** 上次更新网络面板的时间戳（网络面板每秒更新，与 200ms 速度表 tick 分离） */
  netstatAt: number;
}

const guis = new Map<number, PlayerGui>();
/** 刷新重入锁：DB 延迟 > 200ms 时防止两个 tick 并发重复创建 GUI */
let refreshing = false;

/** 玩家当前所在车辆（在车内返回 Vehicle，否则 null） */
function getPlayerVehicle(player: Player): Vehicle | null {
  return player.getVehicle() ?? null;
}

/**
 * 根据玩家设置同步 GUI 的创建/销毁/显示状态。
 * hideAllGui 覆盖优先：所有 GUI 隐藏（不销毁，保留引用以便重新开启）。
 */
async function syncGui(player: Player, setting: SysUserSettingModel) {
  // 断线防护：清理后不允许重建
  if (!player.isConnected()) return;
  const gui = guis.get(player.id) ?? {
    speedoTd: [],
    speedo3d: null,
    speedo3dVehId: null,
    netstat: null,
    debugInfo: null,
    buildTd: null,
    netstatAt: 0,
  };
  guis.set(player.id, gui);

  // hideAllGui 覆盖优先：全部隐藏（debugInfo 与 buildTd 也销毁）
  if (setting.hideAllGui) {
    gui.speedoTd.forEach((t) => t.hide(player));
    destroySpeed3d(gui.speedo3d);
    gui.speedo3d = null;
    gui.speedo3dVehId = null;
    gui.netstat?.tds.forEach((t) => t.hide(player));
    if (gui.debugInfo) {
      destroyDebugInfo(gui.debugInfo);
      gui.debugInfo = null;
    }
    if (gui.buildTd) {
      destroyBuildVersionTd(gui.buildTd);
      gui.buildTd = null;
    }
    return;
  }

  // 2d 速度表（总开关 + showSpeed2d）
  const want2d = setting.showSpeed && setting.showSpeed2d;
  if (want2d && gui.speedoTd.length === 0) {
    gui.speedoTd = createSpeed2d(player);
  } else if (gui.speedoTd.length > 0 && !want2d) {
    destroySpeed2d(gui.speedoTd);
    gui.speedoTd = [];
  } else if (want2d) {
    gui.speedoTd.forEach((t) => t.show(player));
  }

  // 3d 速度表（总开关 + showSpeed3d + 需在车内 attach 车辆；换车时重建）
  const want3d = setting.showSpeed && setting.showSpeed3d;
  const vehicle = want3d ? getPlayerVehicle(player) : null;
  if (want3d && vehicle && (!gui.speedo3d || gui.speedo3dVehId !== vehicle.id)) {
    destroySpeed3d(gui.speedo3d);
    gui.speedo3d = createSpeed3d(player, vehicle);
    gui.speedo3dVehId = vehicle.id;
  } else if ((!want3d || !vehicle) && gui.speedo3d) {
    destroySpeed3d(gui.speedo3d);
    gui.speedo3d = null;
    gui.speedo3dVehId = null;
  }

  // 网络信息 GUI
  if (setting.showNetstat && !gui.netstat) {
    gui.netstat = createNetstat(player);
  } else if (gui.netstat && !setting.showNetstat) {
    destroyNetstat(gui.netstat);
    gui.netstat = null;
  } else if (gui.netstat) {
    gui.netstat.tds.forEach((t) => t.show(player));
  }

  // 调试信息 GUI（底部居中，数据库开关 showDebugInfo 控制）。
  // 构建版本 TD（右下角）与 debug 联动：同开同关——版本属于调试信息，
  // 玩家关 debug 时右下角版本号一并收起（避免残留角落 UI）
  if (setting.showDebugInfo && !gui.debugInfo) {
    gui.debugInfo = createDebugInfo(player);
    gui.buildTd = createBuildVersionTd(player);
  } else if (gui.debugInfo && !setting.showDebugInfo) {
    destroyDebugInfo(gui.debugInfo);
    gui.debugInfo = null;
    destroyBuildVersionTd(gui.buildTd);
    gui.buildTd = null;
  } else if (gui.debugInfo) {
    // 已创建：隐藏所有 GUI 关闭后重新显示
  }
}

/** 刷新单个玩家 GUI 的文本 */
function refreshGuiText(player: Player, gui: PlayerGui, setting: SysUserSettingModel): void {
  if (setting.hideAllGui) return;
  const kmh = getDisplaySpeed(player);
  if (gui.speedoTd.length > 0) updateSpeed2d(gui.speedoTd, kmh);
  if (gui.speedo3d) updateSpeed3d(player, gui.speedo3d, kmh);
  if (gui.debugInfo) updateDebugInfo(player, gui.debugInfo, kmh);
  // 网络面板速率是每秒增量（KB/s），须每秒更新（对齐原版 network GUI）；
  // 不跟 200ms 速度表 tick 一起刷，否则速率数值偏小且刷新过快看不清
  if (gui.netstat && Date.now() - gui.netstatAt >= 1000) {
    updateNetstat(gui.netstat, player);
    gui.netstatAt = Date.now();
  }
}

/**
 * 获取速度表显示速度（对齐原版 RST）：
 * - 观战中：取被观战者速度（观战玩家 → 其自身；观战车辆 → 车辆速度）
 * - 非观战：车内取车辆速度，步行取玩家自身速度
 * - 回放 ghost 车：ghost 车 setVelocity 赋录制速度，getSpeed() 即真实速度，
 *   观战直接读车辆速度（无需旁路）
 */
function getDisplaySpeed(player: Player): number {
  const st = getObserveTarget(player.id);
  if (st) {
    const inst =
      st.kind === "player" ? Player.getInstance(st.targetId) : Vehicle.getInstance(st.targetId);
    return inst ? inst.getSpeed() : 0;
  }
  const veh = player.isInAnyVehicle() ? player.getVehicle() : null;
  return veh ? veh.getSpeed() : player.getSpeed();
}

/** 刷新所有在线玩家 GUI（创建/销毁 + 文本更新） */
async function refreshAllGuis(): Promise<void> {
  if (refreshing) return; // 防止并发 tick
  refreshing = true;
  try {
    const online = Player.getInstances().filter(
      (p) => !p.isNpc() && p.isConnected() && !!getAuthState(p.id),
    );
    // 批量预取：缓存冷启动/大量失效（首登、改设置后）时一次 findMany 拿回全部
    // 缺失设置，避免每玩家一条 findUnique 串行往返（1000 人冷启动 = 1000 次 DB）。
    // 正常在线玩家缓存已热（登录时 getSetting 预热），此批通常为空
    const missing = online
      .map((p) => getAuthState(p.id)!.userId)
      .filter((uid) => getCachedSettingByUserId(uid) === undefined);
    if (missing.length > 0) {
      try {
        await preloadSettingsBatch(missing);
      } catch (e) {
        logger.error(`[gui] 批量预取设置失败（${missing.length} 人）`, e);
      }
    }
    for (const player of online) {
      try {
        // 全部走内存缓存（上面的批量预取已填缺失），零 DB
        const setting = getCachedSetting(player);
        if (!setting) continue;
        await syncGui(player, setting);
        const gui = guis.get(player.id);
        if (gui) refreshGuiText(player, gui, setting);
      } catch (e) {
        logger.error(`[gui] 刷新 ${player.getName().name} 的 GUI 失败`, e);
      }
    }
  } finally {
    refreshing = false;
  }
}

/** 玩家断线时销毁其 GUI */
export function cleanupGui(playerId: number): void {
  const gui = guis.get(playerId);
  if (!gui) return;
  try {
    destroySpeed2d(gui.speedoTd);
    destroySpeed3d(gui.speedo3d);
    if (gui.netstat) destroyNetstat(gui.netstat);
    destroyDebugInfo(gui.debugInfo);
    destroyBuildVersionTd(gui.buildTd);
  } catch (e) {
    logger.error(`[gui] 清理 ${playerId} 的 GUI 失败`, e);
  }
  guis.delete(playerId);
}

/** 初始化 GUI 系统：定时刷新所有在线玩家的 GUI（timer 由 GameMode.onExit 统一清理） */
export function initGui(): void {
  setIntervalSafe(() => {
    void refreshAllGuis();
  }, REFRESH_INTERVAL_MS);
}
