import { DynamicObject, Player, TextDraw, Vehicle } from "@infernus/core";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { setIntervalSafe } from "@/core/timers";
import { getObserveTarget } from "@/core/observe";
import { getReplaySpeedScaleForVehicle } from "@/replay/playback";
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
import { createTimeTd, destroyTimeTd, updateTimeTd, type TimeGuiState } from "./timeGui";
import { createDriftTd, destroyDriftTd, updateDriftTd, type DriftTdState } from "./driftTd";
import { resetDriftCombo, tickDriftScore } from "@/core/driftScore";
import type { SysUserSettingModel } from "@/prisma/generated/prisma/models/SysUserSetting";

/** 刷新频率（原版 updateSpeedometer 定时器为 200ms；提升到 100ms 对齐回放
 *  观战的流畅度——速度数字/刻度在 60fps 观战视角下平滑跳表，实际驾驶同样
 *  更跟手。100ms = 10Hz，文本类 TextDraw setString 开销可忽略） */
const REFRESH_INTERVAL_MS = 100;

/** 单个玩家的 GUI 运行时状态 */
interface PlayerGui {
  speedoTd: TextDraw[];
  speedo3d: DynamicObject | null;
  /** 3d 速度表当前 attach 到的车辆 id（换车时据此重建） */
  speedo3dVehId: number | null;
  /** 上次 2d 速度表渲染的整数 kmh（100ms 刷新去重：刻度颜色只在跨 10 分档变化
   *  才重绘，静止玩家一个都不变——避免每 tick 无条件 21 次 native setString+setColor） */
  speedoKmh: number;
  /** 上次 2d 速度表强制重刷的时间戳（去重之外的安全网：无论何因（TD 状态重置/
   *  某轮异常吞掉）导致 speedoKmh 与实际速度粘住，每 3 秒无条件重绘一次，
   *  保证刻度颜色最坏 3 秒内恢复，不会永远停灰） */
  speedoAt: number;
  /** 上次 3d 速度表贴图文本（去重：材质文字重渲染是重型 native，文本不变跳过） */
  speedo3dText: string;
  /** hideAllGui 隐藏中（hideAllGui=true 时置位，恢复时据此重 show 所有 TD——
   *  避免每 tick 无条件 show 一整套 TD（2d 22 个 + netstat 11 个 + 其余），
   *  TextDrawShowForPlayer 无内部去重，10Hz×N 人会是常驻 native 开销） */
  hidden: boolean;
  netstat: NetstatState | null;
  debugInfo: DebugInfoState | null;
  /** 构建版本 TD（与 debug 联动：showDebugInfo 开关一并创建/销毁） */
  buildTd: TextDraw | null;
  /** 右上角时间 TD（showTimeGui 控制） */
  timeTd: TimeGuiState | null;
  /** 漂移积分 TD（showDriftScore 控制，纯展示） */
  driftTd: DriftTdState | null;
  /** 上次更新网络面板的时间戳（网络面板每秒更新，与 100ms 速度表 tick 分离） */
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
    speedoKmh: -1,
    speedoAt: 0,
    speedo3dText: "",
    hidden: false,
    netstat: null,
    debugInfo: null,
    buildTd: null,
    timeTd: null,
    driftTd: null,
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
    if (gui.timeTd) {
      destroyTimeTd(gui.timeTd);
      gui.timeTd = null;
    }
    if (gui.driftTd) {
      destroyDriftTd(gui.driftTd);
      gui.driftTd = null;
    }
    gui.hidden = true;
    return;
  }
  // 从 hideAllGui 恢复：重新显示所有存活 TD（2d/netstat 是唯二 hide 不 destroy 的
  // 两组；timeTd/driftTd 在 hideAllGui 时被 destroy，恢复时由下方创建分支重建且
  // 创建自带 show——此处无需处理），之后 tick 不再重复 show（TextDrawShowForPlayer
  // 无内部去重）
  if (gui.hidden) {
    gui.hidden = false;
    gui.speedoTd.forEach((t) => t.show(player));
    gui.netstat?.tds.forEach((t) => t.show(player));
    // 重置速度分档缓存：恢复后首刷强制重绘刻度颜色（隐藏期间可能因引擎/显示
    // 状态变化丢了颜色状态，而 speedoKmh 残留旧值会跳过 updateSpeed2d）
    gui.speedoKmh = -1;
  }

  // 2d 速度表（总开关 + showSpeed2d）。show 只在创建/从 hideAllGui 恢复时发
  //（见上 hidden 恢复块）——TD 已可见时每 tick 再 show 是纯冗余 native。
  // isValid 守卫：gmx 等场景下 infernus 销毁 TD 但缓存数组仍在（_id 回 65535），
  // 非空数组跳过重建会让 UI 永久消失——失效即清空重建
  const want2d = setting.showSpeed && setting.showSpeed2d;
  const speedoAlive = gui.speedoTd.length > 0 && gui.speedoTd[0].isValid();
  if (want2d && !speedoAlive) {
    if (gui.speedoTd.length > 0) destroySpeed2d(gui.speedoTd); // 失效残留句柄：先销毁
    gui.speedoTd = createSpeed2d(player);
  } else if (speedoAlive && !want2d) {
    destroySpeed2d(gui.speedoTd);
    gui.speedoTd = [];
    // 销毁时重置分档缓存：重建后首次刷新必调 updateSpeed2d——否则残留旧值
    // 恰好等于重建后速度时被去重跳过，刻度永远停在创建时的灰色不变色
    gui.speedoKmh = -1;
  }

  // 3d 速度表（总开关 + showSpeed3d + 需在车内 attach 车辆；换车时重建）
  const want3d = setting.showSpeed && setting.showSpeed3d;
  const vehicle = want3d ? getPlayerVehicle(player) : null;
  // alive = "已存在且未失效"：null（未创建）不算存活，应创建；gmx 等场景 TD 被
  // 销毁但引用残留（_id 回 65535），isValid()=false 同样触发重建
  const speedo3dAlive = gui.speedo3d != null && gui.speedo3d.isValid();
  if (want3d && vehicle && (!speedo3dAlive || gui.speedo3dVehId !== vehicle.id)) {
    destroySpeed3d(gui.speedo3d);
    gui.speedo3d = createSpeed3d(player, vehicle);
    gui.speedo3dVehId = vehicle.id;
  } else if ((!want3d || !vehicle) && gui.speedo3d && speedo3dAlive) {
    destroySpeed3d(gui.speedo3d);
    gui.speedo3d = null;
    gui.speedo3dVehId = null;
  }

  // 网络信息 GUI
  const netstatAlive =
    gui.netstat != null && gui.netstat.tds.length > 0 && gui.netstat.tds[0].isValid();
  if (setting.showNetstat && !netstatAlive) {
    if (gui.netstat) destroyNetstat(gui.netstat); // 失效残留：先销毁再重建
    gui.netstat = createNetstat(player);
  } else if (gui.netstat && netstatAlive && !setting.showNetstat) {
    destroyNetstat(gui.netstat);
    gui.netstat = null;
  }

  // 调试信息 GUI（底部居中，数据库开关 showDebugInfo 控制）。
  // 构建版本 TD（右下角）与 debug 联动：同开同关——版本属于调试信息，
  // 玩家关 debug 时右下角版本号一并收起（避免残留角落 UI）
  const debugAlive = gui.debugInfo != null && gui.debugInfo.td.isValid();
  if (setting.showDebugInfo && !debugAlive) {
    if (gui.debugInfo) destroyDebugInfo(gui.debugInfo); // 失效残留：先销毁再重建
    if (gui.buildTd) destroyBuildVersionTd(gui.buildTd); // 失效残留 buildTd 一并清
    gui.debugInfo = createDebugInfo(player);
    gui.buildTd = createBuildVersionTd(player);
  } else if (gui.debugInfo && debugAlive && !setting.showDebugInfo) {
    destroyDebugInfo(gui.debugInfo);
    gui.debugInfo = null;
    destroyBuildVersionTd(gui.buildTd);
    gui.buildTd = null;
  }

  // 右上角时间 TD（showTimeGui 控制）
  const timeAlive = gui.timeTd != null && gui.timeTd.td.isValid();
  if (setting.showTimeGui && !timeAlive) {
    if (gui.timeTd) destroyTimeTd(gui.timeTd); // 失效残留：先销毁再重建
    gui.timeTd = createTimeTd(player);
  } else if (gui.timeTd && timeAlive && !setting.showTimeGui) {
    destroyTimeTd(gui.timeTd);
    gui.timeTd = null;
  }

  // 漂移积分 TD（showDriftScore 控制，纯展示；关闭期间不 tick 不累计，
  // 重开保留战果但重置连击——连击是进行时，关了再开重新起连击）
  const driftAlive =
    gui.driftTd != null && gui.driftTd.scoreTd.isValid() && gui.driftTd.badgeTd.isValid();
  if (setting.showDriftScore && !driftAlive) {
    resetDriftCombo(player.id);
    if (gui.driftTd) destroyDriftTd(gui.driftTd); // 失效残留：先销毁再重建
    gui.driftTd = createDriftTd(player);
  } else if (gui.driftTd && driftAlive && !setting.showDriftScore) {
    destroyDriftTd(gui.driftTd);
    gui.driftTd = null;
  }
}

/** 刷新单个玩家 GUI 的文本 */
function refreshGuiText(player: Player, gui: PlayerGui, setting: SysUserSettingModel): void {
  if (setting.hideAllGui) return;
  const kmh = getDisplaySpeed(player);
  // 2d 速度表：整数 kmh 分档去重——刻度颜色只在跨 10 的分档变化（静止玩家一次
  // 都不变），避免每 100ms 无条件 1 setString + 20 setColor（全库最高 native 源）。
  // 安全网：speedoAt 每 1 秒强制重刷一次——防 speedoKmh 因任何原因（TD 状态
  // 重置/某轮异常吞掉）与实际速度粘住，刻度颜色永远停灰
  if (gui.speedoTd.length > 0) {
    const kmhInt = Math.floor(kmh);
    const nowTs = Date.now();
    // 兜底周期 3s：安全网只需保证"最坏 3 秒内恢复"，1s 会让静止玩家也每秒
    // 无条件 1 setString + 20 setColor + 20 show = 41 native/s/人（500 人
    // ≈2 万 native/s 走 JS→FFI 桥，规模性开销）
    if (kmhInt !== gui.speedoKmh || nowTs - gui.speedoAt >= 3000) {
      gui.speedoKmh = kmhInt;
      gui.speedoAt = nowTs;
      updateSpeed2d(player, gui.speedoTd, kmh);
    }
  }
  // 3d 速度表：贴图材质文字重渲染昂贵，文本不变跳过
  if (gui.speedo3d) {
    const text = `${String(Math.floor(kmh)).padStart(3, "0")} KMH`;
    if (text !== gui.speedo3dText) {
      gui.speedo3dText = text;
      updateSpeed3d(player, gui.speedo3d, kmh);
    }
  }
  if (gui.debugInfo) updateDebugInfo(player, gui.debugInfo, kmh);
  // 右上角时间（文本 diff，时间未变零 native）
  if (gui.timeTd) updateTimeTd(gui.timeTd, player);
  // 漂移积分：先推进计分（100ms tick，仅开关开启时创建了 TD 才累计——开关关
  // 时不调 tickDriftScore，积分不累计；重开保留战果、连击已由 resetDriftCombo 重置）
  if (gui.driftTd) {
    tickDriftScore(player);
    updateDriftTd(gui.driftTd, player);
  }
  // 网络面板速率是每秒增量（KB/s），须每秒更新（对齐原版 network GUI）；
  // 不跟 100ms 速度表 tick 一起刷，否则速率数值偏小且刷新过快看不清
  if (gui.netstat && Date.now() - gui.netstatAt >= 1000) {
    updateNetstat(gui.netstat, player);
    gui.netstatAt = Date.now();
  }
}

/**
 * 获取速度表显示速度（对齐原版 RST）：
 * - 观战中：取被观战者速度（观战玩家 → 其自身；观战车辆 → 车辆速度）
 * - 非观战：车内取车辆速度，步行取玩家自身速度
 * - 回放 ghost 车：velocity 已被倍速缩放（emulate 物理与位置推进一致），
 *   getSpeed() 是倍速后的速度——显示要反向除回倍速 = 录制原始 1 倍速
 *   （4× 播时车速表显示真实车速而非 4 倍；0.5× 同理显示原速）
 */
function getDisplaySpeed(player: Player): number {
  const st = getObserveTarget(player.id);
  if (st) {
    if (st.kind === "vehicle") {
      const veh = Vehicle.getInstance(st.targetId);
      if (veh && veh.isValid()) {
        const sp = veh.getSpeed();
        const scale = getReplaySpeedScaleForVehicle(veh.id);
        return scale ? sp / scale : sp;
      }
      // 观战车辆已销毁（幽灵车/回放结束残留条目）：回退真实速度——
      // 否则速度表恒 0，刻度永远灰
    } else {
      const target = Player.getInstance(st.targetId);
      if (target && target.isConnected()) return target.getSpeed();
      // 观战目标不在线：同样回退
    }
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
    destroyTimeTd(gui.timeTd);
    destroyDriftTd(gui.driftTd);
  } catch (e) {
    logger.error(`[gui] 清理 ${playerId} 的 GUI 失败`, e);
  }
  guis.delete(playerId);
}

/** 启动 GUI 刷新 tick（100ms 轮询，持久 interval：onInit 注册、onExit 统一清理） */
export function startGuiTicks(): void {
  setIntervalSafe(() => {
    void refreshAllGuis();
  }, REFRESH_INTERVAL_MS);
}

/** 初始化 GUI 系统（事件注册，模块加载时注册一次；刷新 tick 由 startGuiTicks 在 onInit 注册） */
export function initGui(): void {
  // 事件注册（断线清理等）在此；tick 启动拆到 startGuiTicks——gmx 的 onExit
  // 会 clearAllTimers，若 tick 只在顶层注册一次则 gmx 后 GUI 永不刷新
}
