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
 *
 * 表格两列（功能 | 当前值），操作一项后自动刷新回本菜单（状态实时刷新），
 * 点"取消"才退出面板。
 */
export async function openInterfaceMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const rows = [
    { name: "隐藏所有GUI（覆盖优先）", value: toggleText(setting.hideAllGui) },
    { name: "网络信息GUI", value: toggleText(setting.showNetstat) },
    { name: "速度表显示", value: toggleText(setting.showSpeed) },
    { name: "速度表 2d", value: toggleText(setting.showSpeed2d) },
    { name: "速度表 3d", value: toggleText(setting.showSpeed3d) },
    { name: "特技显示", value: toggleText(setting.showStunt) },
  ];
  const index = await pickOption(player, "界面个性化", rows.map((r) => r.name), {
    headers: ["设置", "当前"],
    format: (_o, i) => [rows[i].name, rows[i].value],
  });
  if (index < 0) return back?.();

  const again = () => openInterfaceMenu(player, back);
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
    return again();
  }
  if (index === 1) {
    await toggleSetting(player, "showNetstat", "网络信息GUI");
    return again();
  }
  if (index === 2) {
    await toggleSetting(player, "showSpeed", "速度表显示");
    return again();
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
    return again();
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
    return again();
  }
  if (index === 5) {
    await toggleSetting(player, "showStunt", "特技显示");
    return again();
  }
}
