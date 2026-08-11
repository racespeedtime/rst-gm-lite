import { Dynamic3DTextLabel, DynamicObject, Player, Vehicle } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { addVehicleComponentIfPossible } from "@/vehicles";
import { applyPlayerPreset } from "@/attire";
import { MAX_VEHICLE_ATTIRE } from "@/attire/state";
import { filterSensitiveWords } from "@/utils/sensitive";
import { DEFAULT_CHARSET } from "@/utils/constants";

/**
 * 回放 ghost 的装扮应用（按玩家**当前**设置查库，不按回放当时存储——装扮变动
 * 无所谓，每次进回放用最新设置套）。
 * - 车辆：user_vehicle.defaultPresetId → vehiclePreset（颜色/paintjob/改装件 + 挂件）
 *   + 爱车 description 3D 文字标签（对齐 vehicles spawnVehicle：有描述才挂）
 * - 人物（NPC）：sysUserSetting.skinId + defaultPlayerPresetId → applyPlayerPreset
 * 关键约束：ghost 车挂件**独立管理**（返回数组、调用方随车销毁），不登记进玩家的
 * 爱车挂件 map（appliedVehicleObjs/vehicleObjMap 按 playerId 键控——登记进去会把
 * 玩家自己爱车的挂件 destroy 掉）。
 * 注：目前仅回放（playback）接入；挑战影子（challenge.ts）不套装扮，若要让影子
 * 与回放一致可在此复用。
 */

/** 销毁 ghost 车挂件/3D 标签对象数组（换车型/会话销毁时清理实体，车 destroy 不会带） */
export function destroyAttireObjs(objs: (DynamicObject | Dynamic3DTextLabel)[] | undefined): void {
  for (const obj of objs ?? []) {
    try {
      if (obj.isValid()) obj.destroy();
    } catch {
      /* 已失效 */
    }
  }
}

/**
 * 给 ghost 车套玩家当前爱车装扮：颜色/paintjob/改装件 + 挂件（DynamicObject attach）
 * + description 3D 文字标签（对齐刷车 spawnVehicle：有描述才挂）。
 * 返回创建的对象数组由调用方随车销毁。无该车型爱车或未设默认预设 → 不套（保持默认外观）。
 */
export async function applyReplayVehicleAttire(
  veh: Vehicle,
  modelId: number,
  playerId: number,
): Promise<(DynamicObject | Dynamic3DTextLabel)[]> {
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
  // 套预设改装件（含氮气）。1087 除外：黑名单在 addVehicleComponentIfPossible
  // 内过滤（实机二分定位 1087 观战中 addComponent 会触发 spectate 镜头抽动，
  // 见 vehicles/index.ts VEHICLE_COMPONENT_BLACKLIST）
  if (preset.modComponents) {
    for (const c of preset.modComponents.split(" ")) {
      const id = Number(c);
      if (Number.isInteger(id) && id > 0) addVehicleComponentIfPossible(veh, id);
    }
  }
  const objs: (DynamicObject | Dynamic3DTextLabel)[] = [];
  // 爱车 description 3D 文字标签（对齐 vehicles spawnVehicle：附着车辆时
  // x/y/z 是相对偏移，传 0,0,0；有描述才挂；敏感词掩码展示）
  if (uv.description) {
    try {
      const label = new Dynamic3DTextLabel({
        text: filterSensitiveWords(uv.description),
        color: "#ffd700",
        x: 0,
        y: 0,
        z: 0,
        drawDistance: 30,
        testLOS: false,
        attachedVehicle: veh.id,
        charset: DEFAULT_CHARSET,
      });
      label.create();
      objs.push(label);
    } catch (e) {
      logger.error(`[replay] ghost 车 description 3D 标签创建失败`, e);
    }
  }
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
