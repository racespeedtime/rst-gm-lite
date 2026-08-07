import { BoneIdsEnum, Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getSetting, invalidateSettingCache } from "@/personalize/settings";
import { swapSortIndex, compactSortIndex, nextSortIndex } from "@/utils/sort";
import { showDialog } from "@/utils/dialog";
import { showPagedDialog } from "@/utils/pagedDialog";
import { COLOR_ERROR, COLOR_SUCCESS, COLOR_WHITE } from "@/utils/colors";
import type { MenuBack } from "@/core/panel";
import {
  MAX_PLAYER_ATTIRE,
  PLAYER_BONES,
  appliedPlayerObjs,
  playerSlotMap,
  appliedPresetByPlayer,
  updateStreamerForPlayer,
  playerEditing,
} from "./state";

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
 * 人物预设管理：选择皮肤 → 预设列表
 * （openAttireMenu 在本模块的 barrel（index.ts），组合人物 + 车辆子菜单）
 */
export async function playerPresetMenu(player: Player, back?: MenuBack): Promise<void> {
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
    await confirmDeletePreset(player, presetId, "人物");
    // 删除的是当前正应用/正穿着的预设 → 立即清理身上挂件（否则 DB 删了但挂件
    // 残留到下次重应用/断线）
    if (appliedPresetByPlayer.get(player.id) === presetId) {
      await applyPlayerPreset(player, null);
    }
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

/** 删除预设（二次验证）。删除后"当前正应用该预设"的挂件清理由调用方各自处理
 *  （人物在 player.ts / 车辆在 vehicle.ts）——本函数只做 DB 删除 + 序号前移 + 提示 */
export async function confirmDeletePreset(
  player: Player,
  presetId: string,
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
