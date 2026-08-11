import { Player, PlayerEvent } from "@infernus/core";
import { getAuthState } from "@/auth/auth";
import { updateSetting, notifySaved } from "./settings";

import { isPlayerLocked, lockPlayer, unlockPlayer } from "@/core/interaction";
import { showModelSelectionMenu } from "@/utils/eSelection";
import { sysMsg } from "@/utils/msg";

/**
 * 皮肤选择工具：
 * - e-selection 3D 选皮肤（/skin 无参数、面板入口），逐页预览玩家模型
 * - 手动输入皮肤校验（/skin ID、面板输入），统一禁用 74（假 CJ）
 */

/**
 * 皮肤选择列表：0-299（SA-MP 有效玩家皮肤，对齐原版 scriptfiles/Vehicles/skins.txt）。
 * 排除 74（假 CJ，原版 /skin 校验 `skinid == 74` 明确禁止）。
 */
export const PICKABLE_SKINS: number[] = Array.from({ length: 300 }, (_, i) => i).filter(
  (id) => id !== 74,
);

/** 校验皮肤 ID 是否可穿戴：0-311 且非 74（假 CJ）。所有皮肤输入入口统一走这里 */
export function isValidSkin(skinId: number): boolean {
  return Number.isInteger(skinId) && skinId >= 0 && skinId <= 311 && skinId !== 74;
}

/** 应用皮肤并写库（统一入口：3D 选择与手动输入共用，含校验） */
export async function applySkin(player: Player, skinId: number): Promise<boolean> {
  if (!isValidSkin(skinId)) {
    sysMsg(player, "character", "该皮肤不可用（需 0-311，74 为禁用皮肤）", "error");
    return false;
  }
  const auth = getAuthState(player.id);
  if (!auth) return false;
  await updateSetting(player, { skinId });
  player.setSkin(skinId);
  notifySaved(player, `皮肤已切换为：${skinId}`);
  return true;
}

/** e-selection 3D 选皮肤：分页预览玩家模型（无背景/带旋转调节），选中应用并写库。
 *  每页 18 个（6 列 × 3 行铺满）+ 分页页码记忆（关掉再开回到上次页） */
export async function showSkinPicker(player: Player): Promise<void> {
  const model = await showModelSelectionMenu(player, "skin", {
    models: PICKABLE_SKINS.map((id) => ({ modelId: id, modelText: `Skin ${id}` })),
    headerText: "Select Skin",
    bannerColor: "#333",
    menuBgColor: "#222",
    menuTextColor: "#fff",
    itemBgColor: "#444",
    itemTextColor: "#0f0",
  });
  if (model) {
    await applySkin(player, model.modelId);
  }
}

/** 初始化皮肤命令：/skin 无参数打开 3D 选皮肤，/skin <ID> 直接切换 */
export function initSkinCommands(): void {
  PlayerEvent.onCommandText("skin", async ({ player, subcommand, next }) => {
    if (!getAuthState(player.id)) return next();
    const arg = subcommand[0];
    // 无参数 → 3D 选皮肤（对齐原版 /skin 无参数 ShowModelSelectionMenu）
    if (!arg) {
      if (isPlayerLocked(player.id)) {
        sysMsg(player, "character", "当前正在其他流程中，请稍后再试", "error");
        return next();
      }
      lockPlayer(player.id);
      try {
        await showSkinPicker(player);
      } finally {
        unlockPlayer(player.id);
      }
      return next();
    }
    const skinId = Number(arg);
    if (!Number.isInteger(skinId)) {
      sysMsg(player, "character", "用法: /skin（打开选肤菜单）或 /skin 皮肤ID（0-311）", "error");
      return next();
    }
    await applySkin(player, skinId);
    return next();
  });
}
