import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { showDialog } from "@/utils/dialog";
import type { MenuBack } from "@/core/panel";
import { playerPresetMenu } from "./player";
import { vehiclePresetMenu } from "./vehicle";

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

// —— 对外公开 API（模块拆分后统一从这里导入，内部实现按实体/状态分文件）——
export {
  MAX_PLAYER_ATTIRE,
  MAX_VEHICLE_ATTIRE,
  cleanupAttire,
  cleanupAttireEditing,
} from "./state";
export { applyPlayerPreset, reapplyCurrentPlayerPreset, cleanupOrphanPresets } from "./player";
export { applyVehiclePreset, openVehiclePresetMenu } from "./vehicle";
export { initAttireEditor } from "./edit";
export type { AttireEditState, VehEditState } from "./types";
