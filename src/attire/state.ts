import { Dialog, DynamicObject, Player, Streamer } from "@infernus/core";
import { clearIntervalSafe } from "@/core/timers";
import type { AttireEditState, VehEditState } from "./types";

/** 装扮数量上限：人物 10 槽（平台 SetPlayerAttachedObject 上限 MAX_PLAYER_ATTACHED_OBJECTS=10）/ 车辆 15 槽 */
export const MAX_PLAYER_ATTIRE = 10;
export const MAX_VEHICLE_ATTIRE = 15;

/** 人物骨骼列表（对齐原版 bone 目录，两处使用共用一份） */
export const PLAYER_BONES = [
  "1 脊柱",
  "2 头",
  "3 左上臂",
  "4 右上臂",
  "5 左手",
  "6 右手",
  "7 左大腿",
  "8 右大腿",
  "9 左脚",
  "10 右脚",
  "11 右小腿",
  "12 左小腿",
  "13 左小臂",
  "14 右小臂",
  "15 左肩",
  "16 右肩",
  "17 颈",
  "18 下巴",
];

/** 玩家已应用的人物装扮对象（applyPlayerPreset 管理，清理用） */
export const appliedPlayerObjs = new Map<number, DynamicObject[]>();
/** 玩家已应用的车辆挂件对象（applyVehiclePreset 管理，清理用）——与人物装扮分开，
 *  否则应用人物预设会误删当前爱车的挂件（反之亦然） */
export const appliedVehicleObjs = new Map<number, DynamicObject[]>();

/** 人物挂件编辑映射：playerId -> (slot -> presetItemId)。实时编辑（EditAttachedObject）
 *  需要知道某件装扮占哪个槽位；应用预设时重建 */
export const playerSlotMap = new Map<number, Map<number, string>>();
/** 车辆挂件编辑映射：playerId -> (presetItemId -> DynamicObject)。实时编辑（obj.edit）
 *  需要拿到该挂件实体 */
export const vehicleObjMap = new Map<number, Map<string, DynamicObject>>();
/** 玩家当前应用的人物预设（playerId -> presetId，null=清空）。
 *  死亡重生/重连时重新应用（对齐原版 OnPlayerSpawn → SpawnAttire：open.mp 重生会清挂件） */
export const appliedPresetByPlayer = new Map<number, string | null>();

/** 实时编辑中的状态（open.mp 一次只编辑一个对象，per-player 串行） */
export const playerEditing = new Map<number, AttireEditState>();
export const vehicleEditing = new Map<number, VehEditState>();
/** 车辆挂件按键微调轮询定时器（keyed by playerId；登记制，onExit 统一清理） */
export const vehEditTimers = new Map<number, NodeJS.Timeout>();

/** 刷新类操作（Streamer_Update）infernus 提供了 Streamer.update，见 updateStreamerForPlayer */

/**
 * 请求 streamer 立即为玩家刷新（Streamer.update = Streamer_Update）。
 * streamer 默认只在玩家移动/物体进出时更新流式对象——给静止玩家身上/车上
 * 挂装扮（DynamicObject attach 到车 / attached object）后若不更新，新对象可能
 * 不显示或错位，直到玩家移动才触发。所有装扮应用路径（applyPlayerPreset /
 * applyVehiclePreset）末尾调用，保证挂件即刻可见。低频调用（刷车/应用预设/
 * 编辑保存），开销可忽略。
 */
export function updateStreamerForPlayer(playerId: number): void {
  try {
    const p = Player.getInstance(playerId);
    if (p && p.isConnected()) Streamer.update(p);
  } catch {
    /* streamer 更新失败不影响挂件本身（玩家移动时会自然刷新） */
  }
}

/** 停止按键微调轮询 */
export function stopVehEditPoll(playerId: number): void {
  const t = vehEditTimers.get(playerId);
  if (t) clearIntervalSafe(t);
  vehEditTimers.delete(playerId);
}

/** 清理玩家全部装扮对象（断线/重生时，人物 + 车辆挂件都清） */
export function cleanupAttire(playerId: number): void {
  for (const obj of appliedPlayerObjs.get(playerId) ?? []) {
    if (obj.isValid()) obj.destroy();
  }
  appliedPlayerObjs.delete(playerId);
  for (const obj of appliedVehicleObjs.get(playerId) ?? []) {
    if (obj.isValid()) obj.destroy();
  }
  appliedVehicleObjs.delete(playerId);
  playerSlotMap.delete(playerId);
  vehicleObjMap.delete(playerId);
  appliedPresetByPlayer.delete(playerId);
  cleanupAttireEditing(playerId); // 含销毁编辑中的独立对象（防断线泄漏）
}

/**
 * 编辑态兜底清理（死亡/重生时调用）：编辑期间玩家死亡/离开/车辆被销毁等
 * 导致回调不来 → 编辑态残留，下次菜单点"实时编辑"会沿用旧状态。onSpawn
 * 时清一次（死亡重生挂件由 spawn 流程重应用）。导出供比赛系统在进比赛时
 * 主动调用（编辑态与比赛状态互斥，进比赛先清编辑态）。
 */
export function cleanupAttireEditing(playerId: number): void {
  playerEditing.delete(playerId);
  const st = vehicleEditing.get(playerId);
  stopVehEditPoll(playerId); // 停按键微调轮询（编辑态随断线/重生清除）
  vehicleEditing.delete(playerId);
  // 编辑中的车辆操作框还开着：关掉客户端对话框（进比赛/重生后旧框残留会遮挡）
  if (st?.dialogOpen) {
    const p = Player.getInstance(playerId);
    if (p) {
      try {
        Dialog.close(p);
      } catch {
        /* 已失效 */
      }
    }
  }
}
