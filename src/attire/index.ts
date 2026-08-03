import {
  BoneIdsEnum,
  Dialog,
  DialogStylesEnum,
  DynamicObject,
  EditResponseTypesEnum,
  ObjectMpEvent,
  Player,
  PlayerEvent,
  Vehicle,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { invalidateSettingCache, getSetting } from "@/personalize/settings";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";
import { swapSortIndex, compactSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";

/** 装扮数量上限：人物 10 槽（平台 SetPlayerAttachedObject 上限 MAX_PLAYER_ATTACHED_OBJECTS=10）/ 车辆 15 槽 */
export const MAX_PLAYER_ATTIRE = 10;
export const MAX_VEHICLE_ATTIRE = 15;

/** 玩家已应用的人物装扮对象（applyPlayerPreset 管理，清理用） */
const appliedPlayerObjs = new Map<number, DynamicObject[]>();
/** 玩家已应用的车辆挂件对象（applyVehiclePreset 管理，清理用）——与人物装扮分开，
 *  否则应用人物预设会误删当前爱车的挂件（反之亦然） */
const appliedVehicleObjs = new Map<number, DynamicObject[]>();

/** 人物挂件编辑映射：playerId -> (slot -> presetItemId)。实时编辑（EditAttachedObject）
 *  需要知道某件装扮占哪个槽位；应用预设时重建 */
const playerSlotMap = new Map<number, Map<number, string>>();
/** 车辆挂件编辑映射：playerId -> (presetItemId -> DynamicObject)。实时编辑（obj.edit）
 *  需要拿到该挂件实体 */
const vehicleObjMap = new Map<number, Map<string, DynamicObject>>();
/** 玩家当前应用的人物预设（playerId -> presetId，null=清空）。
 *  死亡重生/重连时重新应用（对齐原版 OnPlayerSpawn → SpawnAttire：open.mp 重生会清挂件） */
const appliedPresetByPlayer = new Map<number, string | null>();
/** 实时编辑中的状态（open.mp 一次只编辑一个对象，per-player 串行） */
interface AttireEditState {
  presetId: string;
  itemId: string;
}
const playerEditing = new Map<number, AttireEditState>();
const vehicleEditing = new Map<number, AttireEditState>();

/**
 * 应用人物预设：按 preset_item 顺序 setAttachedObject（bone 附着）。
 * 先清空已有槽位，再逐件应用（上限 20 槽）。
 */
export async function applyPlayerPreset(player: Player, presetId: string | null): Promise<void> {
  // 清空已附着对象
  for (const obj of appliedPlayerObjs.get(player.id) ?? []) {
    if (obj.isValid()) obj.destroy();
  }
  appliedPlayerObjs.delete(player.id);
  playerSlotMap.delete(player.id); // 槽位映射随应用重建
  // 清空原生 attached object 槽位
  for (let i = 0; i < MAX_PLAYER_ATTIRE; i++) {
    if (player.isAttachedObjectSlotUsed(i)) {
      player.removeAttachedObject(i);
    }
  }
  if (!presetId) return;
  // 人物装扮显示开关：关闭则不应用（菜单提示与实际行为一致）
  const setting = await getSetting(player);
  if (setting && !setting.showPlayerAttire) return;
  const preset = await prisma.playerPreset.findUnique({
    where: { id: presetId },
    include: { items: { include: { attire: true } } },
  });
  if (!preset) return;
  let slot = 0;
  const slotMap = new Map<number, string>();
  for (const item of preset.items) {
    if (slot >= MAX_PLAYER_ATTIRE) break;
    player.setAttachedObject(
      slot,
      item.attire.modelId,
      item.boneId as BoneIdsEnum,
      Number(item.x),
      Number(item.y),
      Number(item.z),
      Number(item.rX),
      Number(item.rY),
      Number(item.rZ),
      Number(item.sX),
      Number(item.sY),
      Number(item.sZ),
    );
    slotMap.set(slot, item.id); // 登记槽位 → presetItemId（实时编辑用）
    slot++;
  }
  playerSlotMap.set(player.id, slotMap);
  // 记录当前应用的预设（死亡重生/重连时重新应用）
  appliedPresetByPlayer.set(player.id, presetId);
}

/**
 * 重新应用玩家当前的人物预设（死亡重生/重连后挂件被 open.mp 清除）。
 * - 进程内有记录（本次会话应用过，如装扮菜单"应用此预设"）→ 恢复该预设
 * - 无记录（重连是全新连接/登录未设默认）→ 回数据库默认预设（无则清空）
 * 编辑模式由调用方（onSpawn）排除。
 */
export async function reapplyCurrentPlayerPreset(player: Player): Promise<void> {
  if (player.isNpc() || !player.isConnected()) return;
  if (!getAuthState(player.id)) return;
  let presetId = appliedPresetByPlayer.get(player.id);
  if (presetId === undefined) {
    const setting = await prisma.sysUserSetting.findUnique({
      where: { userId: getAuthState(player.id)!.userId },
    });
    presetId = setting?.defaultPlayerPresetId ?? null;
  }
  if (!player.isConnected()) return;
  await applyPlayerPreset(player, presetId);
}

/**
 * 应用车辆预设：modComponents → addComponent；挂件条目 → DynamicObject attachToVehicle。
 * 返回创建的挂件对象（用于清理）。
 */
export async function applyVehiclePreset(
  vehicle: Vehicle,
  presetId: string | null,
  playerId: number,
): Promise<DynamicObject[]> {
  // 清理旧挂件（仅车辆挂件，不动人物装扮）
  for (const obj of appliedVehicleObjs.get(playerId) ?? []) {
    if (obj.isValid()) obj.destroy();
  }
  appliedVehicleObjs.delete(playerId);
  vehicleObjMap.delete(playerId); // 挂件实体映射随应用重建
  if (!presetId) return [];
  // 爱车装扮显示开关：关闭时只应用颜色/改装件，不挂动态挂件（挂件才是"装扮"）
  const owner = Player.getInstance(playerId);
  const setting = owner ? await getSetting(owner) : null;
  const showAttire = setting?.showVehicleAttire ?? true;
  const preset = await prisma.vehiclePreset.findUnique({
    where: { id: presetId },
    include: { items: { include: { attire: true } } },
  });
  if (!preset) return [];
  // 颜色 / paintjob / 改装件
  vehicle.changeColors(Number(preset.color1), Number(preset.color2));
  if (preset.paintjob != null) vehicle.changePaintjob(Number(preset.paintjob));
  if (preset.modComponents) {
    for (const c of preset.modComponents.split(" ")) {
      const id = Number(c);
      if (Number.isInteger(id) && id > 0) vehicle.addComponent(id);
    }
  }
  if (!showAttire) return [];
  // 挂件（上限 15 槽）
  const objs: DynamicObject[] = [];
  const objMap = new Map<string, DynamicObject>(); // presetItemId -> 挂件实体（实时编辑用）
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
        vehicle,
        Number(item.x),
        Number(item.y),
        Number(item.z),
        Number(item.rX),
        Number(item.rY),
        Number(item.rZ),
      );
      objs.push(obj);
      objMap.set(item.id, obj);
    } catch (e) {
      logger.error(`[attire] 车辆挂件创建失败 ${item.attire.name}`, e);
    }
    slot++;
  }
  appliedVehicleObjs.set(playerId, objs);
  vehicleObjMap.set(playerId, objMap);
  return objs;
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
  playerEditing.delete(playerId);
  vehicleEditing.delete(playerId);
}

/**
 * 断线时清理"零条目空白预设"：
 * 玩家创建预设后在添加第一件装扮前断线，会残留空预设（无事务兜底）。
 * 仅删除没有任何条目的预设（非空预设保留）。
 */
export async function cleanupOrphanPresets(userId: string): Promise<void> {
  try {
    // 人物预设：无条目且无默认引用
    const playerPresets = await prisma.playerPreset.findMany({
      where: { userId, deletedAt: null, items: { none: {} } },
    });
    if (playerPresets.length > 0) {
      const defaultIds = (
        await prisma.sysUserSetting.findMany({
          where: { userId, defaultPlayerPresetId: { in: playerPresets.map((p) => p.id) } },
        })
      ).map((s) => s.defaultPlayerPresetId);
      const orphan = playerPresets.filter((p) => !defaultIds.includes(p.id));
      if (orphan.length > 0) {
        await prisma.playerPreset.deleteMany({ where: { id: { in: orphan.map((p) => p.id) } } });
      }
    }
    // 车辆预设：无条目
    const vehiclePresets = await prisma.vehiclePreset.findMany({
      where: { userId, deletedAt: null, items: { none: {} } },
    });
    if (vehiclePresets.length > 0) {
      const usedIds = (
        await prisma.userVehicle.findMany({
          where: { userId, defaultPresetId: { in: vehiclePresets.map((p) => p.id) } },
        })
      ).map((v) => v.defaultPresetId);
      const orphan = vehiclePresets.filter((p) => !usedIds.includes(p.id));
      if (orphan.length > 0) {
        await prisma.vehiclePreset.deleteMany({ where: { id: { in: orphan.map((p) => p.id) } } });
      }
    }
  } catch (e) {
    logger.error(`[attire] 清理空白预设失败 userId=${userId}`, e);
  }
}

/**
 * 装扮面板入口：
 * 1. 人物预设（按 skinId）
 * 2. 车辆预设（按 modelId）
 */
export async function openAttireMenu(player: Player, back?: MenuBack): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "装扮",
      info: "1. 人物装扮预设\n2. 车辆装扮预设",
      button1: "确定",
      button2: "关闭",
    }),
  );
  if (!res) return; // 断线
  if (res.response !== 1) return back?.(); // 取消 → 返回上一层
  if (res.listItem === 0) {
    await playerPresetMenu(player, () => openAttireMenu(player, back));
  } else if (res.listItem === 1) {
    await vehiclePresetMenu(player, () => openAttireMenu(player, back));
  }
}

/** 人物预设管理：选择皮肤 → 预设列表 */
async function playerPresetMenu(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  const currentSkin = setting?.skinId ?? 0;

  // 第一步：输入皮肤 ID（或使用当前皮肤）
  const skinRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "人物装扮预设",
      info: `输入皮肤模型ID（0-311，留空用当前皮肤 ${currentSkin}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!skinRes) return;
  if (skinRes.response !== 1) return back?.();
  const skinId = skinRes.inputText.trim() ? Number(skinRes.inputText.trim()) : currentSkin;
  if (!Number.isInteger(skinId) || skinId < 0 || skinId > 311) {
    player.sendClientMessage(COLOR_ERROR, "皮肤ID需为 0-311 的整数");
    return back?.();
  }
  await showPlayerPresetList(player, skinId, back);
}

/** 人物预设列表：创建/选择预设/重排入口（重排后直接刷新本列表） */
async function showPlayerPresetList(
  player: Player,
  skinId: number,
  back?: MenuBack,
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });

  const presets = await prisma.playerPreset.findMany({
    where: { userId: auth.userId, skinId, deletedAt: null },
    orderBy: { index: "asc" },
    include: { _count: { select: { items: true } } },
  });
  // 创建入口 + 每套预设（含上移/下移入口，对齐原版"序号可调"的面板习惯）
  const options = [`创建新预设（上限3套）`];
  for (const p of presets) {
    const mark = setting?.defaultPlayerPresetId === p.id ? "（默认）" : "";
    options.push(
      `预设${p.index + 1}${p.name ? `（${p.name}）` : ""} ${p._count.items}/${MAX_PLAYER_ATTIRE}件${mark}`,
    );
    options.push(`↕ 上移/下移「${p.name ? p.name : `预设${p.index + 1}`}」`);
  }
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `皮肤 ${skinId} 的预设`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r) return;
  if (r.response !== 1) return back?.();
  if (r.listItem === 0) {
    await createPlayerPreset(player, skinId, presets, back);
    return;
  }
  const preset = presets[(r.listItem - 1) >> 1];
  if (!preset) return back?.();
  if (r.listItem % 2 === 0) {
    // 偶数项 = 重排入口（1=预设0, 2=重排0, 3=预设1, 4=重排1 ...）
    await reorderPreset(player, skinId, presets, preset.id, back);
    return;
  }
  await playerPresetDetail(player, preset.id, skinId, back);
}

/** 预设重排：上移/下移（与相邻预设交换 index），完成后刷新当前皮肤列表 */
async function reorderPreset(
  player: Player,
  skinId: number,
  presets: { id: string; index: number }[],
  presetId: string,
  back?: MenuBack,
): Promise<void> {
  const idx = presets.findIndex((p) => p.id === presetId);
  if (idx < 0) return;
  const label = presets[idx].index + 1;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `预设${label} 排序`,
      info: `1. 上移（与预设${presets[idx - 1] ? presets[idx - 1].index + 1 : "—"}交换）\n2. 下移（与预设${presets[idx + 1] ? presets[idx + 1].index + 1 : "—"}交换）`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const target = res.listItem === 0 ? presets[idx - 1] : presets[idx + 1];
  if (!target) {
    player.sendClientMessage(
      COLOR_ERROR,
      res.listItem === 0 ? "已是第一个预设" : "已是最后一个预设",
    );
    return back?.();
  }
  await swapSortIndex(presets[idx], target, (id, index) =>
    prisma.playerPreset.update({ where: { id }, data: { index } }),
  );
  player.sendClientMessage(COLOR_SUCCESS, `预设${label} 已${res.listItem === 0 ? "上移" : "下移"}`);
  await showPlayerPresetList(player, skinId, back);
}

async function createPlayerPreset(
  player: Player,
  skinId: number,
  presets: { index: number }[],
  back?: MenuBack,
): Promise<void> {
  if (presets.length >= 3) {
    player.sendClientMessage(COLOR_ERROR, "每个皮肤最多 3 套预设");
    return back?.();
  }
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建人物预设",
      info: "输入预设名称（可空）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes || nameRes.response !== 1) return;
  const auth = getAuthState(player.id);
  try {
    const preset = await prisma.playerPreset.create({
      data: {
        userId: auth!.userId,
        skinId,
        index: nextSortIndex(presets),
        name: nameRes.inputText.trim() || null,
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `预设创建成功，正在编辑装扮`);
    await playerPresetDetail(player, preset.id, skinId);
  } catch (e) {
    logger.error(`[attire] 创建人物预设失败`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败");
  }
}

/** 预设详情：应用/添加装扮/编辑装扮/设为默认/删除 */
async function playerPresetDetail(
  player: Player,
  presetId: string,
  skinId: number,
  back?: MenuBack,
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  const items = await prisma.playerPresetItem.findMany({
    where: { presetId },
    include: { attire: true },
    orderBy: { attireId: "asc" },
  });
  // 每件装扮一项（点击进入该件的编辑操作：调整参数/更换骨骼/移除），
  // 不再直接暴露"移除"——编辑菜单里可移除，避免"只能删不能调"的尴尬
  const options = [
    "应用此预设到当前角色",
    "添加装扮",
    ...items.map((it, i) => `装扮 ${i + 1}: ${it.attire.name}`),
    ...(setting?.defaultPlayerPresetId === presetId ? [] : ["设为默认预设"]),
    "删除预设",
  ];
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `预设（${items.length}/${MAX_PLAYER_ATTIRE}件）`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r) return;
  if (r.response !== 1) return back?.();
  const idx = r.listItem;
  const toThis = () => playerPresetDetail(player, presetId, skinId, back);
  if (idx === 0) {
    await applyPlayerPreset(player, presetId);
    player.sendClientMessage(COLOR_SUCCESS, "已应用人物预设");
    await toThis();
  } else if (idx === 1) {
    await addPlayerPresetItem(player, presetId, skinId, toThis);
  } else if (idx >= 2 && idx < 2 + items.length) {
    await editPlayerPresetItem(player, items[idx - 2], presetId, skinId, toThis);
  } else if (idx === 2 + items.length && setting?.defaultPlayerPresetId !== presetId) {
    await prisma.sysUserSetting.update({
      where: { userId: auth.userId },
      data: { defaultPlayerPresetId: presetId },
    });
    invalidateSettingCache(auth.userId); // 直接写库后使设置缓存失效，防脏读
    player.sendClientMessage(COLOR_SUCCESS, "已设为默认人物预设");
    await toThis();
  } else if (idx === options.length - 1) {
    await confirmDeletePreset(player, presetId, skinId, "人物");
    await back?.();
  }
}

/** 单件装扮操作：实时编辑（拖拽）/ 调整参数 / 更换骨骼 / 移除 */
async function editPlayerPresetItem(
  player: Player,
  item: { id: string; attire: { name: string } },
  presetId: string,
  skinId: number,
  back?: MenuBack,
): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `装扮：${item.attire.name}`,
      info: "1. 实时编辑位置（拖拽）\n2. 调整位置/旋转/缩放\n3. 更换骨骼\n4. 移除该装扮",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await startEditPlayerAttire(player, item.id, presetId);
    return; // 编辑结束后不弹回菜单（拖拽是独立交互）
  } else if (res.listItem === 1) {
    await adjustPlayerPresetItem(player, item.id, item.attire.name, presetId, back);
  } else if (res.listItem === 2) {
    await changePlayerPresetBone(player, item.id, item.attire.name, presetId, skinId, back);
  } else if (res.listItem === 3) {
    await prisma.playerPresetItem.delete({ where: { id: item.id } });
    player.sendClientMessage(COLOR_SUCCESS, `已移除装扮 ${item.attire.name}`);
    // 重新应用（当前预设已应用时，移除后身上的挂件同步消失）
    await applyPlayerPreset(player, presetId);
    await playerPresetDetail(player, presetId, skinId, back);
  }
}

/** 开始实时编辑人物挂件：找到该件占用的槽位，进入原生 EditAttachedObject 拖拽编辑 */
async function startEditPlayerAttire(
  player: Player,
  itemId: string,
  presetId: string,
): Promise<void> {
  const slotMap = playerSlotMap.get(player.id);
  const slot = slotMap ? [...slotMap.entries()].find(([, id]) => id === itemId)?.[0] : undefined;
  if (slot == null) {
    player.sendClientMessage(
      COLOR_ERROR,
      "该装扮未穿戴在身上（先应用此预设），无法实时编辑",
    );
    return;
  }
  // 登记编辑态：onPlayerEditAttached 回调按 playerId 取到 presetId/itemId 落库
  playerEditing.set(player.id, { presetId, itemId });
  player.sendClientMessage(COLOR_WHITE, "[装扮] 拖拽调整位置，按保存键确认（Enter/点击保存）保存，Esc 取消");
  player.editAttachedObject(slot);
}

/** 调整单件装扮的位置/旋转/缩放（输入 9 个数，留空保持当前值），调整后自动应用 */
async function adjustPlayerPresetItem(
  player: Player,
  itemId: string,
  name: string,
  presetId: string,
  back?: MenuBack,
): Promise<void> {
  const item = await prisma.playerPresetItem.findUnique({ where: { id: itemId } });
  if (!item) return;
  const cur = [item.x, item.y, item.z, item.rX, item.rY, item.rZ, item.sX, item.sY, item.sZ]
    .map((v) => Number(v))
    .join(" ");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: `调整「${name}」`,
      info: `当前: ${cur}\n输入新的 偏移X Y Z 旋转X Y Z 缩放X Y Z（9个数，空格分隔）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const nums = res.inputText.trim()
    ? res.inputText.trim().split(/\s+/).map(Number)
    : [item.x, item.y, item.z, item.rX, item.rY, item.rZ, item.sX, item.sY, item.sZ].map(Number);
  if (nums.length !== 9 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 9 个数字（X Y Z 偏移 / 旋转 / 缩放），留空保持当前");
    return back?.();
  }
  await prisma.playerPresetItem.update({
    where: { id: itemId },
    data: {
      x: nums[0],
      y: nums[1],
      z: nums[2],
      rX: nums[3],
      rY: nums[4],
      rZ: nums[5],
      sX: nums[6],
      sY: nums[7],
      sZ: nums[8],
    },
  });
  player.sendClientMessage(COLOR_SUCCESS, `已调整装扮「${name}」的位置/旋转/缩放`);
  // 重新应用当前预设，让玩家身上的挂件立即更新
  await applyPlayerPreset(player, presetId);
  return back?.();
}

/** 更换单件装扮的骨骼（列表选择，标注当前） */
async function changePlayerPresetBone(
  player: Player,
  itemId: string,
  name: string,
  presetId: string,
  skinId: number,
  back?: MenuBack,
): Promise<void> {
  const item = await prisma.playerPresetItem.findUnique({ where: { id: itemId } });
  if (!item) return;
  const bones = [
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
  const boneRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `更换「${name}」骨骼`,
      info: bones.map((o) => `${o}${Number(o.split(" ")[0]) === item.boneId ? "（当前）" : ""}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!boneRes) return;
  if (boneRes.response !== 1) return back?.();
  const boneId = boneRes.listItem + 1;
  if (boneId === item.boneId) {
    player.sendClientMessage(COLOR_WHITE, "骨骼未变化");
    return back?.();
  }
  await prisma.playerPresetItem.update({ where: { id: itemId }, data: { boneId } });
  player.sendClientMessage(COLOR_SUCCESS, `「${name}」已挂到骨骼 ${bones[boneId - 1]}`);
  // 应用当前预设使玩家身上的挂件立即更新（重新 setAttachedObject）
  await applyPlayerPreset(player, presetId);
  return back?.();
}

/** 添加装扮到人物预设：选装扮 → 选骨骼 → 输入偏移 */
async function addPlayerPresetItem(
  player: Player,
  presetId: string,
  skinId: number,
  back?: MenuBack,
): Promise<void> {
  const count = await prisma.playerPresetItem.count({ where: { presetId } });
  if (count >= MAX_PLAYER_ATTIRE) {
    player.sendClientMessage(COLOR_ERROR, `人物预设最多 ${MAX_PLAYER_ATTIRE} 件装扮`);
    return back?.();
  }
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null, OR: [{ type: "PLAYER" }, { type: "COMMON" }] },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "系统装扮库为空，请联系管理员添加");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "选择装扮",
    data: attires,
    format: (a) => `${a.name}（模型${a.modelId} 骨${a.boneId}）`,
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back?.();
  const attire = r.item;
  // 骨骼选择
  const boneOptions = [
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
  const boneRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "选择骨骼",
      info: boneOptions.map((o, i) => `${i + 1}. ${o}`).join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!boneRes) return;
  if (boneRes.response !== 1) return back?.();
  const boneId = boneRes.listItem + 1;
  // 偏移/旋转/缩放（沿用装扮目录默认值，可调整）
  const offsetRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "装配参数",
      info: `输入 偏移X Y Z 旋转X Y Z 缩放X Y Z（9个数，空格分隔，留空用默认 ${attire.x} ${attire.y} ${attire.z} ${attire.rX} ${attire.rY} ${attire.rZ} ${attire.sX} ${attire.sY} ${attire.sZ}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!offsetRes) return;
  if (offsetRes.response !== 1) return back?.();
  const nums = offsetRes.inputText.trim()
    ? offsetRes.inputText.trim().split(/\s+/).map(Number)
    : [
        Number(attire.x),
        Number(attire.y),
        Number(attire.z),
        Number(attire.rX),
        Number(attire.rY),
        Number(attire.rZ),
        Number(attire.sX),
        Number(attire.sY),
        Number(attire.sZ),
      ];
  if (nums.length !== 9 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 9 个数字（X Y Z 偏移 / 旋转 / 缩放）");
    return back?.();
  }
  try {
    await prisma.playerPresetItem.create({
      data: {
        presetId,
        attireId: attire.id,
        boneId,
        x: nums[0],
        y: nums[1],
        z: nums[2],
        rX: nums[3],
        rY: nums[4],
        rZ: nums[5],
        sX: nums[6],
        sY: nums[7],
        sZ: nums[8],
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `已添加装扮 ${attire.name}`);
    await playerPresetDetail(player, presetId, skinId, back);
  } catch (e) {
    logger.error(`[attire] 添加人物装扮失败`, e);
    player.sendClientMessage(COLOR_ERROR, "添加失败（可能已存在该装扮）");
    return back?.();
  }
}

/** 车辆预设管理：输入模型 → 预设列表 */
async function vehiclePresetMenu(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const veh = player.getVehicle();
  const currentModel = veh ? veh.getModel() : 411;
  const modelRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "车辆装扮预设",
      info: `输入车辆模型ID（400-611，留空用当前车辆 ${currentModel}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!modelRes) return;
  if (modelRes.response !== 1) return back?.();
  const modelId = modelRes.inputText.trim() ? Number(modelRes.inputText.trim()) : currentModel;
  if (!Number.isInteger(modelId) || modelId < 400 || modelId > 611) {
    player.sendClientMessage(COLOR_ERROR, "车辆模型ID需为 400-611");
    return back?.();
  }
  await showVehiclePresetList(player, modelId);
}

/** 车辆预设列表：创建/选择预设/重排入口（重排后直接刷新本列表） */
async function showVehiclePresetList(
  player: Player,
  modelId: number,
  back?: MenuBack,
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const presets = await prisma.vehiclePreset.findMany({
    where: { userId: auth.userId, modelId, deletedAt: null },
    orderBy: { index: "asc" },
    include: { _count: { select: { items: true } } },
  });
  const options = [`创建新预设（上限3套）`];
  for (const p of presets) {
    options.push(
      `预设${p.index + 1}${p.name ? `（${p.name}）` : ""} ${p._count.items}/${MAX_VEHICLE_ATTIRE}槽`,
    );
    options.push(`↕ 上移/下移「${p.name ? p.name : `预设${p.index + 1}`}」`);
  }
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `模型 ${modelId} 的预设`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r) return;
  if (r.response !== 1) return back?.();
  if (r.listItem === 0) {
    await createVehiclePreset(player, modelId, presets, back);
    return;
  }
  const preset = presets[(r.listItem - 1) >> 1];
  if (!preset) return back?.();
  if (r.listItem % 2 === 0) {
    // 偶数项 = 重排入口
    await reorderVehiclePreset(player, modelId, presets, preset.id, back);
    return;
  }
  await vehiclePresetDetail(player, preset.id, modelId, back);
}

/** 车辆预设重排：上移/下移（与相邻预设交换 index），完成后刷新当前模型列表 */
async function reorderVehiclePreset(
  player: Player,
  modelId: number,
  presets: { id: string; index: number }[],
  presetId: string,
  back?: MenuBack,
): Promise<void> {
  const idx = presets.findIndex((p) => p.id === presetId);
  if (idx < 0) return;
  const label = presets[idx].index + 1;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `预设${label} 排序`,
      info: `1. 上移（与预设${presets[idx - 1] ? presets[idx - 1].index + 1 : "—"}交换）\n2. 下移（与预设${presets[idx + 1] ? presets[idx + 1].index + 1 : "—"}交换）`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const target = res.listItem === 0 ? presets[idx - 1] : presets[idx + 1];
  if (!target) {
    player.sendClientMessage(
      COLOR_ERROR,
      res.listItem === 0 ? "已是第一个预设" : "已是最后一个预设",
    );
    return back?.();
  }
  await swapSortIndex(presets[idx], target, (id, index) =>
    prisma.vehiclePreset.update({ where: { id }, data: { index } }),
  );
  player.sendClientMessage(COLOR_SUCCESS, `预设${label} 已${res.listItem === 0 ? "上移" : "下移"}`);
  await showVehiclePresetList(player, modelId, back);
}

async function createVehiclePreset(
  player: Player,
  modelId: number,
  presets: { index: number }[],
  back?: MenuBack,
): Promise<void> {
  if (presets.length >= 3) {
    player.sendClientMessage(COLOR_ERROR, "每个车辆模型最多 3 套预设");
    return back?.();
  }
  const nameRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "创建车辆预设",
      info: "输入预设名称（可空）：",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!nameRes) return;
  if (nameRes.response !== 1) return back?.();
  const auth = getAuthState(player.id);
  try {
    const preset = await prisma.vehiclePreset.create({
      data: {
        userId: auth!.userId,
        modelId,
        index: nextSortIndex(presets),
        name: nameRes.inputText.trim() || null,
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `车辆预设创建成功`);
    await vehiclePresetDetail(player, preset.id, modelId, back);
  } catch (e) {
    logger.error(`[attire] 创建车辆预设失败`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败");
    return back?.();
  }
}

/** 车辆预设详情：应用/添加挂件/编辑挂件/删除 */
async function vehiclePresetDetail(
  player: Player,
  presetId: string,
  modelId: number,
  back?: MenuBack,
): Promise<void> {
  const items = await prisma.vehiclePresetItem.findMany({
    where: { presetId },
    include: { attire: true },
    orderBy: { slotId: "asc" },
  });
  // 每件挂件一项（点击进入该件操作：调整参数/移除），与人物装扮一致
  const options = [
    "应用此预设到当前车辆",
    "添加挂件",
    ...items.map((it, i) => `挂件 ${i + 1}: ${it.attire.name}`),
    "删除预设",
  ];
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `车辆预设（${items.length}/${MAX_VEHICLE_ATTIRE}槽）`,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!r) return;
  if (r.response !== 1) return back?.();
  const idx = r.listItem;
  const veh = player.getVehicle();
  const toThis = () => vehiclePresetDetail(player, presetId, modelId, back);
  if (idx === 0) {
    if (!veh) {
      player.sendClientMessage(COLOR_ERROR, "你不在车内，无法应用预设");
      return back?.();
    }
    await applyVehiclePreset(veh, presetId, player.id);
    player.sendClientMessage(COLOR_SUCCESS, "已应用车辆预设");
    return toThis();
  } else if (idx === 1) {
    await addVehiclePresetItem(player, presetId, modelId, toThis);
  } else if (idx >= 2 && idx < 2 + items.length) {
    await editVehiclePresetItem(player, items[idx - 2], presetId, modelId, toThis);
  } else if (idx === options.length - 1) {
    await confirmDeletePreset(player, presetId, modelId, "车辆");
    await back?.();
  }
}

/** 单件挂件操作：实时编辑（拖拽）/ 调整参数 / 移除 */
async function editVehiclePresetItem(
  player: Player,
  item: { id: string; attire: { name: string } },
  presetId: string,
  modelId: number,
  back?: MenuBack,
): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `挂件：${item.attire.name}`,
      info: "1. 实时编辑位置（拖拽）\n2. 调整位置/旋转\n3. 移除该挂件",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await startEditVehicleAttire(player, item.id, presetId);
    return; // 编辑结束后不弹回菜单
  } else if (res.listItem === 1) {
    await adjustVehiclePresetItem(player, item.id, item.attire.name, presetId, back);
  } else if (res.listItem === 2) {
    await prisma.vehiclePresetItem.delete({ where: { id: item.id } });
    player.sendClientMessage(COLOR_SUCCESS, `已移除挂件 ${item.attire.name}`);
    // 当前车辆重新应用，挂件即时消失
    const veh = player.getVehicle();
    if (veh) await applyVehiclePreset(veh, presetId, player.id);
    await vehiclePresetDetail(player, presetId, modelId, back);
  }
}

/** 开始实时编辑车辆挂件：对该挂件的 DynamicObject 进入 obj 拖拽编辑 */
async function startEditVehicleAttire(
  player: Player,
  itemId: string,
  presetId: string,
): Promise<void> {
  const objMap = vehicleObjMap.get(player.id);
  const obj = objMap?.get(itemId);
  if (!obj || !obj.isValid()) {
    player.sendClientMessage(
      COLOR_ERROR,
      "该挂件未挂载（先应用此预设或坐进车内），无法实时编辑",
    );
    return;
  }
  vehicleEditing.set(player.id, { presetId, itemId });
  player.sendClientMessage(COLOR_WHITE, "[装扮] 拖拽调整挂件位置，保存确认 / Esc 取消");
  obj.edit(player);
}

/** 调整单件车辆挂件的位置/旋转（输入 6 个数，留空保持当前值），调整后自动应用 */
async function adjustVehiclePresetItem(
  player: Player,
  itemId: string,
  name: string,
  presetId: string,
  back?: MenuBack,
): Promise<void> {
  const item = await prisma.vehiclePresetItem.findUnique({ where: { id: itemId } });
  if (!item) return;
  const cur = [item.x, item.y, item.z, item.rX, item.rY, item.rZ]
    .map((v) => Number(v))
    .join(" ");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: `调整「${name}」`,
      info: `当前: ${cur}\n输入新的 偏移X Y Z 旋转X Y Z（6个数，空格分隔）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  const nums = res.inputText.trim()
    ? res.inputText.trim().split(/\s+/).map(Number)
    : [item.x, item.y, item.z, item.rX, item.rY, item.rZ].map(Number);
  if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 6 个数字（偏移X Y Z / 旋转X Y Z），留空保持当前");
    return back?.();
  }
  await prisma.vehiclePresetItem.update({
    where: { id: itemId },
    data: { x: nums[0], y: nums[1], z: nums[2], rX: nums[3], rY: nums[4], rZ: nums[5] },
  });
  player.sendClientMessage(COLOR_SUCCESS, `已调整挂件「${name}」的位置/旋转`);
  // 当前车辆重新应用，挂件即时更新
  const veh = player.getVehicle();
  if (veh) await applyVehiclePreset(veh, presetId, player.id);
  return back?.();
}

/** 添加挂件到车辆预设 */
async function addVehiclePresetItem(
  player: Player,
  presetId: string,
  modelId: number,
  back?: MenuBack,
): Promise<void> {
  const count = await prisma.vehiclePresetItem.count({ where: { presetId } });
  if (count >= MAX_VEHICLE_ATTIRE) {
    player.sendClientMessage(COLOR_ERROR, `车辆预设最多 ${MAX_VEHICLE_ATTIRE} 个挂件`);
    return back?.();
  }
  const attires = await prisma.attire.findMany({
    where: { deletedAt: null, OR: [{ type: "VEHICLE" }, { type: "COMMON" }] },
    orderBy: { name: "asc" },
  });
  if (attires.length === 0) {
    player.sendClientMessage(COLOR_WHITE, "车辆装扮库为空，请联系管理员添加");
    return back?.();
  }
  const r = await showPagedDialog(player, {
    caption: "选择挂件",
    data: attires,
    format: (a) => `${a.name}（模型${a.modelId}）`,
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back?.();
  const attire = r.item;
  // 挂载偏移（沿用默认）
  const offsetRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.INPUT,
      caption: "挂载参数",
      info: `输入 偏移X Y Z 旋转X Y Z（6个数，空格分隔，留空用默认 ${attire.x} ${attire.y} ${attire.z} ${attire.rX} ${attire.rY} ${attire.rZ}）：`,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!offsetRes) return;
  if (offsetRes.response !== 1) return back?.();
  const nums = offsetRes.inputText.trim()
    ? offsetRes.inputText.trim().split(/\s+/).map(Number)
    : [
        Number(attire.x),
        Number(attire.y),
        Number(attire.z),
        Number(attire.rX),
        Number(attire.rY),
        Number(attire.rZ),
      ];
  if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) {
    player.sendClientMessage(COLOR_ERROR, "需要 6 个数字（偏移X Y Z / 旋转X Y Z）");
    return back?.();
  }
  try {
    await prisma.vehiclePresetItem.create({
      data: {
        presetId,
        attireId: attire.id,
        slotId: count,
        x: nums[0],
        y: nums[1],
        z: nums[2],
        rX: nums[3],
        rY: nums[4],
        rZ: nums[5],
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `已添加挂件 ${attire.name}`);
    await vehiclePresetDetail(player, presetId, modelId, back);
  } catch (e) {
    logger.error(`[attire] 添加车辆挂件失败`, e);
    player.sendClientMessage(COLOR_ERROR, "添加失败（可能槽位冲突）");
    return back?.();
  }
}

/** 删除预设（二次验证） */
async function confirmDeletePreset(
  player: Player,
  presetId: string,
  modelRef: number,
  kind: "人物" | "车辆",
): Promise<void> {
  const r = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: "删除预设",
      info: `确定删除该${kind}预设吗？\n预设内的全部装扮将一并删除，不可恢复！`,
      button1: "确认删除",
      button2: "取消",
    }),
  );
  if (!r || r.response !== 1) return;
  try {
    // 事务：删除预设条目 + 预设本体 + 同皮肤/模型后续预设 index 前移（防空洞），中途失败整体回滚
    await prisma.$transaction(async (tx) => {
      if (kind === "人物") {
        const deleted = await tx.playerPreset.findUnique({ where: { id: presetId } });
        await tx.playerPresetItem.deleteMany({ where: { presetId } });
        await tx.playerPreset.delete({ where: { id: presetId } });
        if (deleted) {
          const rest = await tx.playerPreset.findMany({
            where: { userId: deleted.userId, skinId: deleted.skinId, deletedAt: null },
            orderBy: { index: "asc" },
            select: { id: true, index: true },
          });
          await compactSortIndex(rest, deleted.index, (id, index) =>
            tx.playerPreset.update({ where: { id }, data: { index } }),
          );
        }
      } else {
        const deleted = await tx.vehiclePreset.findUnique({ where: { id: presetId } });
        await tx.vehiclePresetItem.deleteMany({ where: { presetId } });
        await tx.vehiclePreset.delete({ where: { id: presetId } });
        if (deleted) {
          const rest = await tx.vehiclePreset.findMany({
            where: { userId: deleted.userId, modelId: deleted.modelId, deletedAt: null },
            orderBy: { index: "asc" },
            select: { id: true, index: true },
          });
          await compactSortIndex(rest, deleted.index, (id, index) =>
            tx.vehiclePreset.update({ where: { id }, data: { index } }),
          );
        }
      }
    });
    player.sendClientMessage(COLOR_SUCCESS, `${kind}预设已删除`);
  } catch (e) {
    logger.error(`[attire] 删除预设失败`, e);
    player.sendClientMessage(COLOR_ERROR, "删除失败");
  }
}

/**
 * 实时编辑回调解救（防编辑态残留）：
 * 编辑期间玩家死亡/离开/车辆被销毁等导致回调不来 → 编辑态残留，
 * 下次菜单点"实时编辑"会沿用旧状态。死亡/重生时兜底清一次。
 */
export function cleanupAttireEditing(playerId: number): void {
  playerEditing.delete(playerId);
  vehicleEditing.delete(playerId);
}

/**
 * 初始化装扮实时编辑器（对齐原版 Attire_EditAttachedObject / 物件编辑）：
 * - 人物挂件：EditAttachedObject 拖拽编辑，OnPlayerEditAttachedObject 回调保存
 *   （response=1 保存新参数并落库；response=0 取消，保持原参数）
 * - 车辆挂件：DynamicObject.edit 拖拽编辑，OnPlayerEdit 回调保存（仅全局对象）
 * 保存后重新应用预设（updateAttachedObject / 重新 attach）并提示。
 */
export function initAttireEditor(): void {
  // 人物挂件编辑回调
  ObjectMpEvent.onPlayerEditAttached(
    ({ player, response, fOffsetX, fOffsetY, fOffsetZ, fRotX, fRotY, fRotZ, fScaleX, fScaleY, fScaleZ, next }) => {
      const st = playerEditing.get(player.id);
      if (!st) return next();
      // 拖拽期间会持续发 UPDATE 预览（不断改位置）；只有保存(FINAL)/取消(CANCEL)
      // 才结束编辑并清状态，否则下一次 UPDATE 就丢了 st，保存/取消失效
      if (response === EditResponseTypesEnum.CANCEL) {
        playerEditing.delete(player.id);
        // 取消：重新应用当前预设，恢复原位
        void applyPlayerPreset(player, st.presetId);
        player.sendClientMessage(COLOR_WHITE, "[装扮] 已取消编辑，恢复原位置");
        return next();
      }
      if (response === EditResponseTypesEnum.FINAL) {
        playerEditing.delete(player.id);
      }
      // 保存（FINAL）或预览（UPDATE）：落库最新参数（预览时玩家持续拖拽看效果）
      void (async () => {
        try {
          await prisma.playerPresetItem.update({
            where: { id: st.itemId },
            data: {
              x: fOffsetX,
              y: fOffsetY,
              z: fOffsetZ,
              rX: fRotX,
              rY: fRotY,
              rZ: fRotZ,
              sX: fScaleX,
              sY: fScaleY,
              sZ: fScaleZ,
            },
          });
          if (response === EditResponseTypesEnum.FINAL) {
            player.sendClientMessage(COLOR_SUCCESS, "[装扮] 已保存编辑");
          }
        } catch (e) {
          logger.error(`[attire] 保存挂件编辑失败 ${player.getName().name}`, e);
          player.sendClientMessage(COLOR_ERROR, "[装扮] 保存失败");
        }
      })();
      return next();
    },
  );

  // 车辆挂件编辑回调（onPlayerEdit 只报全局对象编辑：obj.edit 的响应）
  ObjectMpEvent.onPlayerEdit(
    ({ player, isGlobal, isPlayerObject, objectMp, response, fX, fY, fZ, fRotX, fRotY, fRotZ, next }) => {
      const st = vehicleEditing.get(player.id);
      // 仅处理全局对象（车辆挂件是 DynamicObject），且编辑对象确实是我们登记的那个
      if (!st || !isGlobal || isPlayerObject) return next();
      const objMap = vehicleObjMap.get(player.id);
      const obj = objMap?.get(st.itemId);
      if (!obj || objectMp?.id !== obj.id) return next();
      if (response === EditResponseTypesEnum.CANCEL) {
        vehicleEditing.delete(player.id);
        player.sendClientMessage(COLOR_WHITE, "[装扮] 已取消编辑");
        return next();
      }
      void (async () => {
        try {
          await prisma.vehiclePresetItem.update({
            where: { id: st.itemId },
            data: { x: fX, y: fY, z: fZ, rX: fRotX, rY: fRotY, rZ: fRotZ },
          });
          if (response === EditResponseTypesEnum.FINAL) {
            vehicleEditing.delete(player.id);
            player.sendClientMessage(COLOR_SUCCESS, "[装扮] 已保存编辑");
          }
        } catch (e) {
          logger.error(`[attire] 保存车辆挂件编辑失败 ${player.getName().name}`, e);
          player.sendClientMessage(COLOR_ERROR, "[装扮] 保存失败");
        }
      })();
      return next();
    },
  );

  // 断线清理编辑态
  PlayerEvent.onDisconnect(({ player, next }) => {
    playerEditing.delete(player.id);
    vehicleEditing.delete(player.id);
    return next();
  });
}
