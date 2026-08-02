import { Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import {
  getSetting,
  updateSetting,
  pickOption,
  notifySaved,
  toggleText,
  COLOR_ERROR,
} from "./settings";
import { syncVehicleAutoState, syncNoCollisionState } from "@/core/vehicleAuto";
import { getOwnedVehicle } from "@/vehicles";
import { applyVehiclePreset } from "@/attire";
import type { MenuBack } from "@/core/panel";

/**
 * 车辆个性化菜单
 * 1. 显示/隐藏爱车装扮（关闭时提示）
 * 2. 定时器换颜色（开关）
 * 3. 自动修复（开关）
 * 4. 无碰撞模式（开关）
 * 5. 氮气方式（点按 / 定时器）
 * 6. 翻车自动翻正（开关）
 */
export async function openVehicleMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const options = [
    `爱车装扮：${toggleText(setting.showVehicleAttire)}`,
    `定时换颜色：${toggleText(setting.vehicleColorCycle)}`,
    `自动修复：${toggleText(setting.vehicleAutoFix)}`,
    `无碰撞模式：${toggleText(setting.vehicleNoCollision)}`,
    `氮气方式：${setting.nitroType === "timer" ? "定时器" : "点按"}`,
    `翻车自动翻正：${toggleText(setting.vehicleFlip)}`,
  ];
  const index = await pickOption(player, "车辆个性化", options);
  if (index < 0) return back?.();

  switch (index) {
    case 0: {
      const next = !setting.showVehicleAttire;
      await updateSetting(player, { showVehicleAttire: next });
      if (!next) {
        player.sendClientMessage(COLOR_ERROR, "你已关闭爱车装扮显示，装扮将不再展示");
      } else {
        notifySaved(player, "爱车装扮已开启显示");
      }
      // 立即生效：重新应用当前爱车（关闭则移除挂件，开启则恢复；
      // applyVehiclePreset 内部清理旧挂件后按开关决定是否挂）
      const veh = getOwnedVehicle(player.id);
      const auth = getAuthState(player.id);
      if (veh && auth) {
        const uv = await prisma.userVehicle.findUnique({
          where: { userId_modelId: { userId: auth.userId, modelId: veh.getModel() } },
        });
        await applyVehiclePreset(veh, uv?.defaultPresetId ?? null, player.id);
      }
      break;
    }
    case 1: {
      const next = !setting.vehicleColorCycle;
      await updateSetting(player, { vehicleColorCycle: next });
      notifySaved(player, `定时换颜色已${next ? "开启" : "关闭"}`);
      break;
    }
    case 2: {
      // 自动修复：切换后同步子弹拦截名单（onWeaponShot 同步热路径）
      const next = !setting.vehicleAutoFix;
      await updateSetting(player, { vehicleAutoFix: next });
      notifySaved(player, `自动修复已${next ? "开启" : "关闭"}`);
      syncVehicleAutoState(player, { vehicleAutoFix: next });
      break;
    }
    case 3: {
      const next = !setting.vehicleNoCollision;
      await updateSetting(player, { vehicleNoCollision: next });
      notifySaved(player, `无碰撞模式已${next ? "开启" : "关闭"}`);
      // 立即应用（非比赛状态；比赛中由比赛系统强制开启，恢复时按此设置）
      syncNoCollisionState(player, next);
      break;
    }
    case 4: {
      const current = setting.nitroType === "timer" ? "timer" : "hold";
      const nitroOptions = [
        `点按${current === "hold" ? "（当前）" : ""}`,
        `定时器${current === "timer" ? "（当前）" : ""}`,
      ];
      const nitroIndex = await pickOption(player, "氮气方式", nitroOptions);
      if (nitroIndex < 0) return;
      const next = nitroIndex === 1 ? "timer" : "hold";
      await updateSetting(player, { nitroType: next });
      notifySaved(player, `氮气方式已设为：${next === "timer" ? "定时器" : "点按"}`);
      break;
    }
    case 5: {
      const next = !setting.vehicleFlip;
      await updateSetting(player, { vehicleFlip: next });
      notifySaved(player, `翻车自动翻正已${next ? "开启" : "关闭"}`);
      break;
    }
  }
}
