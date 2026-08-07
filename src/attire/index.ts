import {
  BoneIdsEnum,
  Dialog,
  DialogStylesEnum,
  DynamicObject,
  EditResponseTypesEnum,
  KeysEnum,
  ObjectMpEvent,
  Player,
  PlayerEvent,
  Streamer,
  Vehicle,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle, addVehicleComponentIfPossible } from "@/vehicles";
import { invalidateSettingCache, getSetting } from "@/personalize/settings";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";
import { swapSortIndex, compactSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import type { MenuBack } from "@/core/panel";

/** 装扮数量上限：人物 10 槽（平台 SetPlayerAttachedObject 上限 MAX_PLAYER_ATTACHED_OBJECTS=10）/ 车辆 15 槽 */
export const MAX_PLAYER_ATTIRE = 10;
export const MAX_VEHICLE_ATTIRE = 15;

/** 刷新类操作（Streamer_Update）infernus 提供了 Streamer.update，见 updateStreamerForPlayer */

/**
 * 请求 streamer 立即为玩家刷新（Streamer.update = Streamer_Update）。
 * streamer 默认只在玩家移动/物体进出时更新流式对象——给静止玩家身上/车上
 * 挂装扮（DynamicObject attach 到车 / attached object）后若不更新，新对象可能
 * 不显示或错位，直到玩家移动才触发。所有装扮应用路径（applyPlayerPreset /
 * applyVehiclePreset）末尾调用，保证挂件即刻可见。低频调用（刷车/应用预设/
 * 编辑保存），开销可忽略。
 */
function updateStreamerForPlayer(playerId: number): void {
  try {
    const p = Player.getInstance(playerId);
    if (p && p.isConnected()) Streamer.update(p);
  } catch {
    /* streamer 更新失败不影响挂件本身（玩家移动时会自然刷新） */
  }
}

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
/** 车辆挂件按键微调会话（对齐原版 CDIALOG_CarZB：选轴 → 小键盘 4/6 连续微调，
 *  numpad 2 重开操作框；全程 destroy+recreate+attachToVehicle，纯 API 无拖拽） */
interface VehEditState extends AttireEditState {
  /** 当前微调轴（1=X 左右 2=Y 前后 3=Z 上下 4=RX 前翻 5=RY 侧翻 6=RZ 旋转，对齐原版） */
  axis: number;
  /** 微调步长（默认 0.1，操作框可调速） */
  step: number;
  /** 操作框打开中（打开时轮询不响应微调键，防误触） */
  dialogOpen: boolean;
  /** 上次轮询的按键位（numpad 2 重开操作框的边沿检测） */
  prevKeys: number;
  /** 本次会话的偏移工作副本：微调改这里，保存时才写 DB（对齐原版：DB 仅在保存时落） */
  work: { x: number; y: number; z: number; rX: number; rY: number; rZ: number };
}
const playerEditing = new Map<number, AttireEditState>();
const vehicleEditing = new Map<number, VehEditState>();

/** 人物骨骼列表（对齐原版 bone 目录，两处使用共用一份） */
const PLAYER_BONES = [
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

/**
 * 应用人物预设：按 preset_item 顺序 setAttachedObject（bone 附着）。
 * 先清空已有槽位，再逐件应用（上限 MAX_PLAYER_ATTIRE=10 槽）。
 * 返回是否实际应用（false = 装扮显示关闭 / 预设不存在，调用方提示与实际一致）。
 */
export async function applyPlayerPreset(player: Player, presetId: string | null): Promise<boolean> {
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
  if (!presetId) {
    appliedPresetByPlayer.set(player.id, null);
    return true;
  }
  // 人物装扮显示开关：关闭则不应用（菜单提示与实际行为一致）
  const setting = await getSetting(player);
  if (setting && !setting.showPlayerAttire) return false;
  const preset = await prisma.playerPreset.findUnique({
    where: { id: presetId },
    include: { items: { include: { attire: true } } },
  });
  if (!preset) return false;
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
  // streamer 对静止玩家不更新流式对象：挂完立即请求刷新，保证挂件即刻可见
  //（否则新 attached object 可能直到玩家移动才显示）
  updateStreamerForPlayer(player.id);
  return true;
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
  // 颜色：预设存了颜色（>0）才覆盖——懒创建预设 color1/color2=0 表示未设，
  // 无条件 changeColors(0,0) 会把 /cc 换过的爱车色重置成黑；0 号色是黑色
  // 极少被选，>0 判定足够区分（刷车路径已用存储色作为初始色，两者一致）
  if (preset.color1 > 0 || preset.color2 > 0) {
    vehicle.changeColors(Number(preset.color1), Number(preset.color2));
  }
  if (preset.paintjob != null) vehicle.changePaintjob(Number(preset.paintjob));
  if (preset.modComponents) {
    for (const c of preset.modComponents.split(" ")) {
      const id = Number(c);
      if (Number.isInteger(id) && id > 0) addVehicleComponentIfPossible(vehicle, id);
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
  // streamer 对静止玩家不更新流式对象：挂件（DynamicObject attach 到车）挂完
  // 立即请求刷新，保证静止状态下的车挂件即刻可见（否则直到玩家移动才显示）
  updateStreamerForPlayer(playerId);
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
  cleanupAttireEditing(playerId); // 含销毁编辑中的独立对象（防断线泄漏）
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
          // 仅统计仍有效的车辆引用：已软删车辆（deletedAt != null）不再占用预设，
          // 若其引用被计入会把空预设误判为"被使用"而漏删（残留）
          where: {
            userId,
            deletedAt: null,
            defaultPresetId: { in: vehiclePresets.map((p) => p.id) },
          },
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
    options.push(`↑↓ 上移/下移「${p.name ? p.name : `预设${p.index + 1}`}」`);
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
    // B9：应用结果与实际一致（装扮显示关闭时提示"未展示"）
    const applied = await applyPlayerPreset(player, presetId);
    player.sendClientMessage(
      applied ? COLOR_SUCCESS : COLOR_ERROR,
      applied ? "已应用人物预设" : "装扮显示已关闭，未展示（可到「界面个性化」打开）",
    );
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

/** 仅当该预设正应用在玩家身上时才重应用（编辑/移除未上身的预设不强制替换当前装扮） */
async function reapplyIfActive(player: Player, presetId: string): Promise<void> {
  if (appliedPresetByPlayer.get(player.id) === presetId) {
    await applyPlayerPreset(player, presetId);
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
    // B1：实时编辑失败（未穿戴）→ 回单件菜单，不丢面板流程
    const ok = await startEditPlayerAttire(player, item.id, presetId);
    if (!ok) return back?.();
    return; // 编辑结束后不弹回菜单（拖拽是独立交互）
  } else if (res.listItem === 1) {
    await adjustPlayerPresetItem(player, item.id, item.attire.name, presetId, back);
  } else if (res.listItem === 2) {
    await changePlayerPresetBone(player, item.id, item.attire.name, presetId, skinId, back);
  } else if (res.listItem === 3) {
    await prisma.playerPresetItem.delete({ where: { id: item.id } });
    player.sendClientMessage(COLOR_SUCCESS, `已移除装扮 ${item.attire.name}`);
    // 仅当该预设正应用时重应用（未上身的预设不移除时强制替换当前装扮）
    await reapplyIfActive(player, presetId);
    await playerPresetDetail(player, presetId, skinId, back);
  }
}

/** 开始实时编辑人物挂件：找到该件占用的槽位，进入原生 EditAttachedObject 拖拽编辑。
 *  返回是否成功（未穿戴/失败 → false，调用方回菜单） */
async function startEditPlayerAttire(
  player: Player,
  itemId: string,
  presetId: string,
): Promise<boolean> {
  // 槽位映射（playerSlotMap）可能在进程内与穿戴状态脱节（如默认预设已穿上但
  // 映射被清理/应用路径未重建）——先直接查；找不到再重应用该预设重建映射再试，
  // 避免"明明穿着却提示未穿戴、非得手动点一次应用"的割裂体验
  const findSlot = (): number | undefined => {
    const slotMap = playerSlotMap.get(player.id);
    return slotMap ? [...slotMap.entries()].find(([, id]) => id === itemId)?.[0] : undefined;
  };
  let slot = findSlot();
  if (slot == null) {
    // 重应用该预设（幂等：重新 setAttachedObject + 重建槽位映射，视觉无变化）
    const applied = await applyPlayerPreset(player, presetId);
    if (!applied) {
      player.sendClientMessage(COLOR_ERROR, "该装扮未穿戴在身上（先应用此预设），无法实时编辑");
      return false;
    }
    slot = findSlot();
    if (slot == null) {
      player.sendClientMessage(COLOR_ERROR, "该装扮未穿戴在身上（先应用此预设），无法实时编辑");
      return false;
    }
  }
  // 登记编辑态：onPlayerEditAttached 回调按 playerId 取到 presetId/itemId 落库
  playerEditing.set(player.id, { presetId, itemId });
  player.sendClientMessage(
    COLOR_WHITE,
    "[装扮] 拖拽调整位置，按保存键确认（Enter/点击保存）保存，Esc 取消",
  );
  player.editAttachedObject(slot);
  return true;
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
    player.sendClientMessage(
      COLOR_ERROR,
      "需要 9 个数字（X Y Z 偏移 / 旋转 / 缩放），留空保持当前",
    );
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
  // 仅当该预设正应用时重应用（调整未上身的预设不强制替换当前装扮）
  await reapplyIfActive(player, presetId);
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
  const bones = PLAYER_BONES;
  const boneRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `更换「${name}」骨骼`,
      info: bones
        .map((o) => `${o}${Number(o.split(" ")[0]) === item.boneId ? "（当前）" : ""}`)
        .join("\n"),
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
  // 仅当该预设正应用时重应用（换骨未上身的预设不强制替换当前装扮）
  await reapplyIfActive(player, presetId);
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
    // 多列：名称 | 模型 | 默认骨骼 | 类型
    headers: ["名称", "模型", "默认骨骼", "类型"],
    format: (a) => [
      a.name,
      String(a.modelId),
      String(a.boneId),
      a.type === "COMMON" ? "通用" : "人物",
    ],
    button1: "确定",
    button2: "取消",
  });
  if (!r) return back?.();
  const attire = r.item;
  // 骨骼选择
  const boneOptions = PLAYER_BONES;
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
    // U1：该预设已应用时重应用（添加后身上的挂件即时出现，与移除路径一致）
    await reapplyIfActive(player, presetId);
    await playerPresetDetail(player, presetId, skinId, back);
  } catch (e) {
    logger.error(`[attire] 添加人物装扮失败`, e);
    player.sendClientMessage(COLOR_ERROR, "添加失败（可能已存在该装扮）");
    return back?.();
  }
}

/** 车辆装扮预设直达入口（/aczb /cars buyobj /infobj 命令引导用）：
 * 装扮由模型+预设驱动，挂件（警灯/尾翼等同源）在车辆装扮预设里自由添加，无需购买 */
export async function openVehiclePresetMenu(player: Player, back?: MenuBack): Promise<void> {
  await vehiclePresetMenu(player, back);
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
    options.push(`↑↓ 上移/下移「${p.name ? p.name : `预设${p.index + 1}`}」`);
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
    // B8：预设只能应用到"自己的爱车"（在别人的车/乘客座上应用会污染他人车辆 +
    // 挂件残留到他车上），且车型必须与预设匹配（选 411 的预设挂到 560 上会错位）
    const owned = getOwnedVehicle(player.id);
    if (!owned || !owned.isValid() || owned !== veh) {
      player.sendClientMessage(COLOR_ERROR, "请进入你的爱车后再应用车辆预设");
      return back?.();
    }
    if (owned.getModel() !== modelId) {
      player.sendClientMessage(
        COLOR_ERROR,
        `该预设属于模型 ${modelId}，请先刷对应模型的爱车（/c ${modelId}）`,
      );
      return back?.();
    }
    await applyVehiclePreset(owned, presetId, player.id);
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
      info: "1. 实时编辑位置（小键盘 4/6 微调）\n2. 调整位置/旋转\n3. 移除该挂件",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    // B1：实时编辑失败（未挂载）→ 回单件菜单，不丢面板流程
    const ok = await startEditVehicleAttire(player, item.id, presetId);
    if (!ok) return back?.();
    return; // 编辑结束后不弹回菜单
  } else if (res.listItem === 1) {
    await adjustVehiclePresetItem(player, item.id, item.attire.name, presetId, back);
  } else if (res.listItem === 2) {
    await prisma.vehiclePresetItem.delete({ where: { id: item.id } });
    player.sendClientMessage(COLOR_SUCCESS, `已移除挂件 ${item.attire.name}`);
    // 当前爱车重新应用，挂件即时消失（用爱车而非 player.getVehicle，防别人车/乘客座）
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) await applyVehiclePreset(veh, presetId, player.id);
    await vehiclePresetDetail(player, presetId, modelId, back);
  }
}

/** 车辆挂件按键微调轮询定时器（keyed by playerId；登记制，onExit 统一清理） */
const vehEditTimers = new Map<number, NodeJS.Timeout>();
const VEH_EDIT_POLL_MS = 100;

/** 微调轴名（对齐原版 CDIALOG_CarZB 列表；索引+1 = axis） */
const VEHC_EDIT_AXES = ["左右", "前后", "上下", "前翻", "侧翻", "旋转"];

/** 停止按键微调轮询 */
function stopVehEditPoll(playerId: number): void {
  const t = vehEditTimers.get(playerId);
  if (t) clearIntervalSafe(t);
  vehEditTimers.delete(playerId);
}

/** 结束车辆挂件编辑会话（保存/删除/取消/断线）：停轮询 + 清状态；reapply 时按当前
 *  DB 值重建挂件（保存=新偏移生效，取消/删除=还原原状） */
function endVehicleAttireEdit(player: Player, reapply: boolean): void {
  const st = vehicleEditing.get(player.id);
  stopVehEditPoll(player.id);
  vehicleEditing.delete(player.id);
  if (reapply && st) {
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) void applyVehiclePreset(veh, st.presetId, player.id);
  }
}

/** 重建单个车辆挂件对象（纯 API：销毁 → 新建 → attachToVehicle 工作副本偏移）。
 *  按键微调不写 DB、不改预设——每步 destroy+recreate+attach 让偏移即时生效。 */
function rebuildVehicleAttireItem(playerId: number, st: VehEditState, modelId: number): void {
  const player = Player.getInstance(playerId);
  const veh = getOwnedVehicle(playerId);
  const objMap = vehicleObjMap.get(playerId);
  if (!player || !veh || !veh.isValid() || !objMap) return;
  const old = objMap.get(st.itemId);
  if (!old || !old.isValid()) return;
  try {
    old.destroy();
  } catch {
    /* 已失效 */
  }
  const obj = new DynamicObject({
    modelId,
    x: 0,
    y: 0,
    z: 0,
    rx: 0,
    ry: 0,
    rz: 0,
  }).create();
  obj.attachToVehicle(veh, st.work.x, st.work.y, st.work.z, st.work.rX, st.work.rY, st.work.rZ);
  objMap.set(st.itemId, obj);
  // 同步应用对象数组的引用（applyVehiclePreset 销毁时按数组清）
  const arr = appliedVehicleObjs.get(playerId);
  if (arr) {
    const i = arr.indexOf(old);
    if (i >= 0) arr[i] = obj;
  }
  updateStreamerForPlayer(playerId);
}

/** 对当前微调轴 ±step（dir=-1/1，对齐原版小键盘 4/6） */
function nudgeVehicleAttire(playerId: number, st: VehEditState, dir: -1 | 1): void {
  const objMap = vehicleObjMap.get(playerId);
  const old = objMap?.get(st.itemId);
  if (!objMap || !old || !old.isValid()) return;
  const model = old.getModel();
  const d = st.step * dir;
  switch (st.axis) {
    case 1:
      st.work.x += d;
      break;
    case 2:
      st.work.y += d;
      break;
    case 3:
      st.work.z += d;
      break;
    case 4:
      st.work.rX += d;
      break;
    case 5:
      st.work.rY += d;
      break;
    case 6:
      st.work.rZ += d;
      break;
  }
  rebuildVehicleAttireItem(playerId, st, model);
}

/** 车辆挂件操作框（对齐原版 CDIALOG_CarZB）：选轴 / 调速 / 删除 / 保存退出。
 *  取消 → 还原退出；断线由 showDialog 转 null 走同一分支 */
async function showVehicleEditDialog(player: Player): Promise<void> {
  const st = vehicleEditing.get(player.id);
  if (!st) return;
  st.dialogOpen = true;
  const info = [...VEHC_EDIT_AXES, "调速", "{FF0000}删除", "{00FF00}保存并退出"].join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: `挂件编辑（小键盘 4/6 微调 · 2 重开本框）`,
      info,
      button1: "选择",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) {
    // 取消 / 断线：还原退出（DB 未动，applyVehiclePreset 恢复原状）
    endVehicleAttireEdit(player, true);
    return;
  }
  if (res.listItem < 6) {
    st.axis = res.listItem + 1;
    player.sendClientMessage(
      COLOR_WHITE,
      `[装扮] 当前微调：${VEHC_EDIT_AXES[res.listItem]}（小键盘 4/6，按住连续）`,
    );
    st.dialogOpen = false;
    return;
  }
  if (res.listItem === 6) {
    // 调速
    const r = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "调速",
        info: `当前步长 ${st.step}（每次微调 ±该值）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (r && r.response === 1) {
      const v = parseFloat(r.inputText.trim());
      if (Number.isFinite(v) && v > 0) {
        st.step = v;
        player.sendClientMessage(COLOR_WHITE, `[装扮] 微调步长已设为 ${v}`);
      }
    }
    st.dialogOpen = false;
    return showVehicleEditDialog(player);
  }
  if (res.listItem === 7) {
    // 删除：删 DB 行 → 重建预设（该挂件消失）
    await prisma.vehiclePresetItem.delete({ where: { id: st.itemId } });
    player.sendClientMessage(COLOR_SUCCESS, "[装扮] 已删除该挂件");
    endVehicleAttireEdit(player, true);
    return;
  }
  // 保存并退出：工作副本写 DB → 重建生效
  await prisma.vehiclePresetItem.update({
    where: { id: st.itemId },
    data: {
      x: st.work.x,
      y: st.work.y,
      z: st.work.z,
      rX: st.work.rX,
      rY: st.work.rY,
      rZ: st.work.rZ,
    },
  });
  player.sendClientMessage(COLOR_SUCCESS, "[装扮] 已保存编辑");
  endVehicleAttireEdit(player, true);
}

/** 开始实时编辑车辆挂件（对齐原版：选轴 + 小键盘 4/6 微调，无拖拽）。
 *  返回是否成功（未挂载 → false，调用方回菜单）
 *  原理：attach 对象无法直接拖拽（attach 关系覆盖编辑写入），原版用"按键微调
 *  偏移 + destroy/recreate/attachToVehicle"实现——纯 API，无 EditDynamicObject、
 *  无直接 native。微调只改会话工作副本，保存时才写 DB。 */
async function startEditVehicleAttire(
  player: Player,
  itemId: string,
  presetId: string,
): Promise<boolean> {
  const objMap = vehicleObjMap.get(player.id);
  const obj = objMap?.get(itemId);
  if (!objMap || !obj || !obj.isValid()) {
    player.sendClientMessage(COLOR_ERROR, "该挂件未挂载（先应用此预设或坐进车内），无法实时编辑");
    return false;
  }
  const item = await prisma.vehiclePresetItem.findUnique({ where: { id: itemId } });
  if (!item) {
    player.sendClientMessage(COLOR_ERROR, "挂件数据不存在");
    return false;
  }
  vehicleEditing.set(player.id, {
    presetId,
    itemId,
    axis: 1,
    step: 0.1,
    dialogOpen: false,
    prevKeys: 0,
    work: {
      x: Number(item.x),
      y: Number(item.y),
      z: Number(item.z),
      rX: Number(item.rX),
      rY: Number(item.rY),
      rZ: Number(item.rZ),
    },
  });
  // 轮询：小键盘 4/6 连续微调（按住每 tick 一次）；numpad 2（ANALOG_DOWN）边沿重开操作框
  const timer = setIntervalSafe(() => {
    const st2 = vehicleEditing.get(player.id);
    const p = Player.getInstance(player.id);
    if (!st2 || !p || !p.isConnected()) {
      stopVehEditPoll(player.id);
      return;
    }
    const keys = p.getKeys().keys & 0xffff;
    if (!st2.dialogOpen) {
      if (keys & KeysEnum.ANALOG_LEFT) nudgeVehicleAttire(player.id, st2, -1);
      else if (keys & KeysEnum.ANALOG_RIGHT) nudgeVehicleAttire(player.id, st2, 1);
    }
    if (keys & KeysEnum.ANALOG_DOWN && !(st2.prevKeys & KeysEnum.ANALOG_DOWN)) {
      void showVehicleEditDialog(p); // 重开操作框（调速/删除/保存）
    }
    st2.prevKeys = keys;
  }, VEH_EDIT_POLL_MS);
  vehEditTimers.set(player.id, timer);
  player.sendClientMessage(
    COLOR_WHITE,
    "[装扮] 小键盘 4/6 微调挂件位置，2 打开操作框（调速/删除/保存）",
  );
  void showVehicleEditDialog(player);
  return true;
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
  const cur = [item.x, item.y, item.z, item.rX, item.rY, item.rZ].map((v) => Number(v)).join(" ");
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
  // B4：用爱车实体重应用（玩家在车内时 player.getVehicle 可能不是爱车/为空，
  // 调整后已刷出的爱车挂件必须刷新）
  const veh = getOwnedVehicle(player.id);
  if (veh && veh.isValid()) await applyVehiclePreset(veh, presetId, player.id);
  return back?.();
}

/** 添加挂件到车辆预设 */
async function addVehiclePresetItem(
  player: Player,
  presetId: string,
  modelId: number,
  back?: MenuBack,
): Promise<void> {
  // 新 slotId = 当前最大槽位 + 1：不能按 count 取——删除中间槽后（如删掉 slot 0）
  // count < max+1，新建会与现存项撞 @@unique([presetId, slotId]) 唯一键
  const maxSlot = await prisma.vehiclePresetItem.findFirst({
    where: { presetId },
    orderBy: { slotId: "desc" },
    select: { slotId: true },
  });
  const nextSlot = (maxSlot?.slotId ?? -1) + 1;
  if (nextSlot >= MAX_VEHICLE_ATTIRE) {
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
    headers: ["名称", "模型", "类型"],
    format: (a) => [a.name, String(a.modelId), a.type === "COMMON" ? "通用" : "车辆"],
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
        slotId: nextSlot,
        x: nums[0],
        y: nums[1],
        z: nums[2],
        rX: nums[3],
        rY: nums[4],
        rZ: nums[5],
      },
    });
    player.sendClientMessage(COLOR_SUCCESS, `已添加挂件 ${attire.name}`);
    // U1：该预设正应用在当前爱车时重应用（添加后挂件即时出现）
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) await applyVehiclePreset(veh, presetId, player.id);
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
    // B10：删除的是当前正应用/正穿着的预设 → 立即清理身上/爱车上的挂件
    // （否则 DB 删了但挂件残留到下次重应用/断线）
    if (kind === "人物") {
      if (appliedPresetByPlayer.get(player.id) === presetId) {
        await applyPlayerPreset(player, null);
      }
    } else {
      const veh = getOwnedVehicle(player.id);
      if (veh && veh.isValid() && veh.getModel() === modelRef) {
        await applyVehiclePreset(veh, null, player.id);
      }
    }
  } catch (e) {
    logger.error(`[attire] 删除预设失败`, e);
    player.sendClientMessage(COLOR_ERROR, "删除失败");
  }
}

/**
 * 编辑态兜底清理（死亡/重生时调用）：编辑期间玩家死亡/离开/车辆被销毁等
 * 导致回调不来 → 编辑态残留，下次菜单点"实时编辑"会沿用旧状态。onSpawn
 * 时清一次（死亡重生挂件由 spawn 流程重应用）。
 */
function cleanupAttireEditing(playerId: number): void {
  playerEditing.delete(playerId);
  stopVehEditPoll(playerId); // 停按键微调轮询（编辑态随断线/重生清除）
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
    ({
      player,
      response,
      fOffsetX,
      fOffsetY,
      fOffsetZ,
      fRotX,
      fRotY,
      fRotZ,
      fScaleX,
      fScaleY,
      fScaleZ,
      next,
    }) => {
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
      } else {
        // UPDATE 预览帧：客户端本地编辑态已实时显示效果，不落库（防拖拽
        // 每帧写 DB 造成几十上百次写）；仅 FINAL 保存时写一次
        return next();
      }
      // 保存（FINAL）：落库最终参数
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
          player.sendClientMessage(COLOR_SUCCESS, "[装扮] 已保存编辑");
        } catch (e) {
          logger.error(`[attire] 保存挂件编辑失败 ${player.getName().name}`, e);
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
  // 死亡/重生兜底清编辑态（编辑中死亡回调不来 → 防编辑态残留）
  PlayerEvent.onSpawn(({ player, next }) => {
    if (playerEditing.has(player.id) || vehicleEditing.has(player.id)) {
      cleanupAttireEditing(player.id);
    }
    return next();
  });
}
