import { DynamicObject, Player, Vehicle } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { applyPlayerPreset } from "@/attire";
import { MAX_VEHICLE_ATTIRE } from "@/attire/state";

/**
 * 回放 ghost 的装扮应用（按玩家**当前**设置查库，不按回放当时存储——装扮变动
 * 无所谓，每次进回放用最新设置套）。
 * - 车辆：user_vehicle.defaultPresetId → vehiclePreset（颜色/paintjob/改装件 + 挂件）
 * - 人物（NPC）：sysUserSetting.skinId + defaultPlayerPresetId → applyPlayerPreset
 * 关键约束：ghost 车挂件**独立管理**（返回数组、调用方随车销毁），不登记进玩家的
 * 爱车挂件 map（appliedVehicleObjs/vehicleObjMap 按 playerId 键控——登记进去会把
 * 玩家自己爱车的挂件 destroy 掉）。
 * 注：目前仅回放（playback）接入；挑战影子（challenge.ts）不套装扮，若要让影子
 * 与回放一致可在此复用。
 */

/** 销毁 ghost 车挂件对象数组（换车型/会话销毁时清理挂件实体，车 destroy 不会带挂件） */
export function destroyAttireObjs(objs: DynamicObject[] | undefined): void {
  for (const obj of objs ?? []) {
    try {
      if (obj.isValid()) obj.destroy();
    } catch {
      /* 已失效 */
    }
  }
}

/**
 * 给 ghost 车套玩家当前爱车装扮：颜色/paintjob/挂件（DynamicObject attach）。
 * 挂件返回数组由调用方随车销毁。无该车型爱车或未设默认预设 → 不套（保持默认外观）。
 */
export async function applyReplayVehicleAttire(
  veh: Vehicle,
  modelId: number,
  playerId: number,
): Promise<DynamicObject[]> {
  const auth = getAuthState(playerId);
  if (!auth || !veh.isValid()) return [];
  const uv = await prisma.userVehicle.findUnique({
    where: { userId_modelId: { userId: auth.userId, modelId } },
  });
  if (!uv?.defaultPresetId) return [];
  const preset = await prisma.vehiclePreset.findUnique({
    where: { id: uv.defaultPresetId },
    include: { items: { include: { attire: true } } },
  });
  if (!preset) return [];
  if (preset.color1 > 0 || preset.color2 > 0) {
    veh.changeColors(Number(preset.color1), Number(preset.color2));
  }
  if (preset.paintjob != null) veh.changePaintjob(Number(preset.paintjob));
  // 不套预设的 modComponents（改装件/氮气）：观战中给被观战车**再次**
  // addComponent（ghost 车创建时已 addNitro）会触发客户端车辆状态变化 →
  // spectate 镜头跟着重置 → 观战上下转一抽一抽（实机二分定位的根因）。
  // 换色/涂装/挂件在观战中安全（实测不抽）；创建时的一次 addNitro 也无害
  //（drift NPC 车同样创建时加氮气，观战正常）。
  const objs: DynamicObject[] = [];
  let slot = 0;
  for (const item of preset.items) {
    if (slot >= MAX_VEHICLE_ATTIRE) break;
    try {
      const obj = new DynamicObject({
        modelId: item.attire.modelId,
        x: Number(item.x),
        y: Number(item.y),
        z: Number(item.z),
        rx: Number(item.rX),
        ry: Number(item.rY),
        rz: Number(item.rZ),
      });
      obj.create();
      obj.attachToVehicle(
        veh,
        Number(item.x),
        Number(item.y),
        Number(item.z),
        Number(item.rX),
        Number(item.rY),
        Number(item.rZ),
      );
      objs.push(obj);
    } catch (e) {
      logger.error(`[replay] ghost 车挂件创建失败 ${item.attire.name}`, e);
    }
    slot++;
  }
  return objs;
}

/**
 * 给 ghost NPC 套玩家当前人物装扮：皮肤 skinId + 默认人物装扮预设。
 * 原生 attached object 随 NPC 销毁清理；NPC playerId 的装扮 map 残留由
 * cleanupAttire（attire/state）在会话销毁时清理。
 */
export async function applyReplayPlayerAttire(npcPlayer: Player, playerId: number): Promise<void> {
  const auth = getAuthState(playerId);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  if (!setting) return;
  if (npcPlayer.isConnected()) {
    npcPlayer.setSkin(setting.skinId);
  }
  if (setting.defaultPlayerPresetId) {
    await applyPlayerPreset(npcPlayer, setting.defaultPlayerPresetId);
  }
}
