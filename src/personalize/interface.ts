import { Player } from "@infernus/core";
import {
  getSetting,
  updateSetting,
  pickOption,
  notifySaved,
  toggleText,
  toggleSetting,
} from "./settings";
import type { MenuBack } from "@/core/panel";

/**
 * 界面个性化菜单
 * 1. 隐藏所有 GUI（textdraw 等，覆盖优先级 > 其他）
 * 2. 显示/隐藏网络信息 GUI
 * 3. 速度表显示（总开关）
 * 4. 速度表 2d 显示（开启 2d 时联动总开关）
 * 5. 速度表 3d 显示（与 2d 互斥）
 * 6. 特技显示
 */
export async function openInterfaceMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const options = [
    `隐藏所有GUI（覆盖优先）：${toggleText(setting.hideAllGui)}`,
    `网络信息GUI：${toggleText(setting.showNetstat)}`,
    `速度表显示：${toggleText(setting.showSpeed)}`,
    `速度表 2d：${toggleText(setting.showSpeed2d)}`,
    `速度表 3d：${toggleText(setting.showSpeed3d)}`,
    `特技显示：${toggleText(setting.showStunt)}`,
  ];
  const index = await pickOption(player, "界面个性化", options);
  if (index < 0) return back?.();

  if (index === 0) {
    const next = !setting.hideAllGui;
    await updateSetting(player, { hideAllGui: next });
    if (next) {
      player.sendClientMessage(
        "#ffaa00",
        "已开启隐藏所有GUI（覆盖优先），其他界面个性化开关暂时失效",
      );
    } else {
      notifySaved(player, "已关闭隐藏所有GUI");
    }
    return;
  }
  if (index === 1) {
    await toggleSetting(player, "showNetstat", "网络信息GUI");
    return;
  }
  if (index === 2) {
    await toggleSetting(player, "showSpeed", "速度表显示");
    return;
  }
  if (index === 3) {
    // 速度表 2d：开启时联动总开关，并关闭 3d
    const next = !setting.showSpeed2d;
    await updateSetting(player, {
      showSpeed2d: next,
      showSpeed3d: false,
      showSpeed: next ? true : setting.showSpeed,
    });
    notifySaved(player, `速度表 2d 已${next ? "开启" : "关闭"}`);
    return;
  }
  if (index === 4) {
    // 速度表 3d：开启时联动总开关，并关闭 2d
    const next = !setting.showSpeed3d;
    await updateSetting(player, {
      showSpeed3d: next,
      showSpeed2d: false,
      showSpeed: next ? true : setting.showSpeed,
    });
    notifySaved(player, `速度表 3d 已${next ? "开启" : "关闭"}`);
    return;
  }
  if (index === 5) {
    await toggleSetting(player, "showStunt", "特技显示");
  }
}
