import { Dialog, DialogStylesEnum, DynamicObject, KeysEnum, Player, Vehicle } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle, addVehicleComponentIfPossible } from "@/vehicles";
import { getSetting } from "@/personalize/settings";
import { setIntervalSafe } from "@/core/timers";
import { swapSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";
import type { MenuBack } from "@/core/panel";
import {
  MAX_VEHICLE_ATTIRE,
  appliedVehicleObjs,
  vehicleObjMap,
  vehicleEditing,
  vehEditTimers,
  updateStreamerForPlayer,
  stopVehEditPoll,
} from "./state";
import { confirmDeletePreset } from "./player";
import type { VehEditState } from "./types";

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

/** 车辆装扮预设直达入口（/aczb /cars buyobj /infobj 命令引导用）：
 * 装扮由模型+预设驱动，挂件（警灯/尾翼等同源）在车辆装扮预设里自由添加，无需购买 */
export async function openVehiclePresetMenu(player: Player, back?: MenuBack): Promise<void> {
  await vehiclePresetMenu(player, back);
}

/** 车辆预设管理：输入模型 → 预设列表 */
export async function vehiclePresetMenu(player: Player, back?: MenuBack): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  // 默认模型取"自己的爱车"（playerVehs）而非 player.getVehicle（坐的当前车）：
  // 刷了 /c 562 但没坐进车里时 getVehicle() 为 undefined 会误回退 411——
  // 玩家以为默认应是刚刷的 562。爱车才代表"我的车"
  const owned = getOwnedVehicle(player.id);
  const currentModel = owned && owned.isValid() ? owned.getModel() : 411;
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
    // 同时设为该车型的默认预设：应用 = 采用该方案，重刷车（/c 车型）自动带上。
    // 否则 defaultPresetId 只被改装店/换色路径（ensureDefaultPresetTx）设置——
    // 只在装扮菜单应用过的车型（如 562）刷车时装扮丢失，而 411 有默认就正常
    const auth = getAuthState(player.id);
    if (auth) {
      await prisma.userVehicle.updateMany({
        where: { userId: auth.userId, modelId },
        data: { defaultPresetId: presetId },
      });
    }
    player.sendClientMessage(COLOR_SUCCESS, "已应用车辆预设（重刷车自动带上）");
    return toThis();
  } else if (idx === 1) {
    await addVehiclePresetItem(player, presetId, modelId, toThis);
  } else if (idx >= 2 && idx < 2 + items.length) {
    await editVehiclePresetItem(player, items[idx - 2], presetId, modelId, toThis);
  } else if (idx === options.length - 1) {
    await confirmDeletePreset(player, presetId, "车辆");
    // 删除的是当前正应用在该车型爱车上的预设 → 立即清理挂件（否则 DB 删了但
    // 挂件残留到下次重应用/断线）
    const owned = getOwnedVehicle(player.id);
    if (owned && owned.isValid() && owned.getModel() === modelId) {
      await applyVehiclePreset(owned, null, player.id);
    }
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

const VEH_EDIT_POLL_MS = 100;

/** 微调轴名（对齐原版 CDIALOG_CarZB 列表；索引+1 = axis） */
const VEHC_EDIT_AXES = ["左右", "前后", "上下", "前翻", "侧翻", "旋转"];

/** 结束车辆挂件编辑会话（保存/删除/取消/断线）：停轮询 + 清状态；reapply 时按当前
 *  DB 值重建挂件（保存=新偏移生效，取消/删除=还原原状） */
function endVehicleAttireEdit(player: Player, reapply: boolean): void {
  const st = vehicleEditing.get(player.id);
  stopVehEditPoll(player.id);
  vehicleEditing.delete(player.id);
  // 操作框还开着（世界变化/进比赛退出等路径）：显式关掉客户端对话框——
  // 只清服务器会话的话，SA 对话框不随世界切换自动关闭，会残留在新世界成为
  // 无响应死框（直到玩家手动应答），进比赛画面被遮挡
  if (st?.dialogOpen) {
    try {
      Dialog.close(player);
    } catch {
      /* 已失效 */
    }
  }
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

/** 旋转轴（前翻/侧翻/旋转）的步长倍率：旋转以度计，0.1 度/步（位置步长）肉眼
 *  无感（按住 1 秒才 1 度）——放大到 5 度/步，与位置 0.1 单位的可见性匹配 */
const ROT_STEP_MULT = 50;

/** 对当前微调轴 ±step（dir=-1/1，对齐原版小键盘 4/6） */
function nudgeVehicleAttire(playerId: number, st: VehEditState, dir: -1 | 1): void {
  const objMap = vehicleObjMap.get(playerId);
  const old = objMap?.get(st.itemId);
  if (!objMap || !old || !old.isValid()) return;
  const model = old.getModel();
  const d = st.step * dir;
  const dRot = st.step * ROT_STEP_MULT * dir;
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
      st.work.rX += dRot;
      break;
    case 5:
      st.work.rY += dRot;
      break;
    case 6:
      st.work.rZ += dRot;
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
      caption: `挂件编辑（方向键←/→ 微调 · ↓ 重开本框）`,
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
    const stepText =
      res.listItem < 3 ? `每次 ±${st.step} 单位` : `每次 ±${st.step * ROT_STEP_MULT} 度`;
    player.sendClientMessage(
      COLOR_WHITE,
      `[装扮] 当前微调：${VEHC_EDIT_AXES[res.listItem]}（方向键 ←/→ 按住连续，${stepText}）`,
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
        info: `当前位置步长 ${st.step}（每次微调：位置 ±${st.step} 单位 / 旋转 ±${st.step * ROT_STEP_MULT} 度）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (r && r.response === 1) {
      // 严格数字格式 + 合理上限：parseFloat 会放行 "0.1abc"→0.1、无上限输入
      // 100000 会把挂件甩出地图（位置 1e5 单位）且保存落库
      const s = r.inputText.trim();
      const v = /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
      if (Number.isFinite(v) && v >= 0.01 && v <= 10) {
        st.step = v;
        player.sendClientMessage(COLOR_WHITE, `[装扮] 微调步长已设为 ${v}`);
      } else {
        player.sendClientMessage(COLOR_ERROR, "[装扮] 步长需为 0.01-10 之间的数字");
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
  try {
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
  } catch (e) {
    // 保存失败（条目可能被并发删除/DB 抖动）：不还原也不退出——提示后留在编辑
    logger.error(`[attire] 保存车辆挂件编辑失败 ${player.getName().name}`, e);
    player.sendClientMessage(COLOR_ERROR, "[装扮] 保存失败，请重试");
    return;
  }
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
    worldId: player.getVirtualWorld(),
  });
  // 轮询微调键：小键盘 4/6（keys 位集 ANALOG_*）与方向键 ←/→（leftRight 参数）
  // 是两套独立按键——SA 键位里方向键走 GetPlayerKeys 的 leftRight/updown 参数，
  // 小键盘数字键走 keys 位集。两套都要监听（无小键盘玩家用方向键）。
  // 重开操作框：小键盘 2（ANALOG_DOWN）或 方向键 ↓（updown 参数）
  const timer = setIntervalSafe(() => {
    const st2 = vehicleEditing.get(player.id);
    const p = Player.getInstance(player.id);
    if (!st2 || !p || !p.isConnected()) {
      stopVehEditPoll(player.id);
      return;
    }
    // 传送/换世界兜底：世界变化即退出编辑（还原 DB 原状）——防轮询/dialog
    // 在异世界残留（玩家传送/进战局后编辑上下文已失效）。进比赛由 joinRoom
    // 主动 cleanupAttireEditing（与本兜底互补，进比赛常先切世界两者都覆盖）
    if (p.getVirtualWorld() !== st2.worldId) {
      endVehicleAttireEdit(p, true);
      return;
    }
    const k = p.getKeys();
    const keys = k.keys & 0xffff;
    const lr = k.leftRight;
    const ud = k.upDown;
    if (!st2.dialogOpen) {
      const left = (keys & KeysEnum.ANALOG_LEFT) !== 0 || lr === KeysEnum.KEY_LEFT;
      const right = (keys & KeysEnum.ANALOG_RIGHT) !== 0 || lr === KeysEnum.KEY_RIGHT;
      if (left) nudgeVehicleAttire(player.id, st2, -1);
      else if (right) nudgeVehicleAttire(player.id, st2, 1);
    }
    // 重开操作框：小键盘 2 或 方向键 ↓（边沿触发）。
    // 必须 dialogOpen 守卫：对话框打开时 ↓ 是列表导航/取消键，此时重开会用新
    // 对话框替换 pending 的旧框（infernus show 先 close 旧框 → 旧框 promise
    // reject → 被 showDialog 当取消 → endVehicleAttireEdit 杀掉会话 + 还原未
    // 保存微调），新框又因会话已删而失效——"一按即坏"。想重开先关闭当前框
    const down = (keys & KeysEnum.ANALOG_DOWN) !== 0 || ud === KeysEnum.KEY_DOWN;
    if (down && !st2.prevKeys && !st2.dialogOpen) {
      void showVehicleEditDialog(p);
    }
    st2.prevKeys = down ? 1 : 0;
  }, VEH_EDIT_POLL_MS);
  vehEditTimers.set(player.id, timer);
  // 建议坐进车里操作：方向键在车外是移动键，会边走边调（对齐原版要求
  // IsPlayerInAnyVehicle 编辑）；车里方向键=转向，不冲突。不强制——站车外
  // 也能调，只是方向键会移动角色
  if (!player.isInAnyVehicle()) {
    player.sendClientMessage(
      COLOR_WHITE,
      "[装扮] 建议坐进车里编辑（车外方向键是移动），坐车后方向键=转向不冲突",
    );
  }
  player.sendClientMessage(
    COLOR_WHITE,
    "[装扮] 方向键 ←/→ 微调挂件位置（小键盘 4/6 同键位），方向键 ↓ 打开操作框",
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
