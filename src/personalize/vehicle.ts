import { Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { getSetting, updateSetting, pickOption, notifySaved, toggleText } from "./settings";
import { COLOR_ERROR } from "@/utils/colors";
import { syncVehicleAutoState, syncNoCollisionState, resetNitroCount } from "@/core/vehicleAuto";
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
 *
 * 表格两列（功能 | 当前值），操作一项后自动刷新回本菜单（状态实时刷新），
 * 点"取消"才退出面板。
 */
export async function openVehicleMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const rows = [
    { name: "爱车装扮", value: toggleText(setting.showVehicleAttire) },
    { name: "定时换颜色", value: toggleText(setting.vehicleColorCycle) },
    { name: "自动修复", value: toggleText(setting.vehicleAutoFix) },
    { name: "无碰撞模式", value: toggleText(setting.vehicleNoCollision) },
    { name: "氮气方式", value: setting.nitroType === "timer" ? "定时器" : "点按" },
    { name: "翻车自动翻正", value: toggleText(setting.vehicleFlip) },
  ];
  const index = await pickOption(
    player,
    "车辆个性化",
    rows.map((r) => r.name),
    {
      headers: ["设置", "当前"],
      format: (_o, i) => [rows[i].name, rows[i].value],
    },
  );
  if (index < 0) return back?.();

  const again = () => openVehicleMenu(player, back);
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
      return again();
    }
    case 1: {
      const next = !setting.vehicleColorCycle;
      await updateSetting(player, { vehicleColorCycle: next });
      if (!next) {
        // 关闭定时换颜色：恢复爱车默认颜色——变色龙每秒随机换色，关掉后车色
        // 会停在最后一次随机色。默认色 = 爱车默认预设存的颜色（未存则 [-1,-1]
        // 游戏默认色，与 getOrCreateUserVehicle/applyVehiclePreset 同口径）
        const veh = getOwnedVehicle(player.id);
        if (veh && veh.isValid()) {
          const auth = getAuthState(player.id);
          if (auth) {
            const uv = await prisma.userVehicle.findUnique({
              where: { userId_modelId: { userId: auth.userId, modelId: veh.getModel() } },
            });
            let color1 = -1;
            let color2 = -1;
            if (uv?.defaultPresetId) {
              const preset = await prisma.vehiclePreset.findUnique({
                where: { id: uv.defaultPresetId },
                select: { color1: true, color2: true },
              });
              if (preset) {
                // 懒创建预设 0 = 未设色，>0 才是用户选色（与 getOrCreateUserVehicle/
                // applyVehiclePreset 同口径，防 0 号色黑车覆盖）
                color1 = preset.color1 > 0 ? preset.color1 : -1;
                color2 = preset.color2 > 0 ? preset.color2 : -1;
              }
            }
            veh.changeColors(color1, color2);
          }
        }
      }
      notifySaved(player, `定时换颜色已${next ? "开启" : "关闭"}`);
      return again();
    }
    case 2: {
      // 自动修复：切换后同步子弹拦截名单（onWeaponShot 同步热路径）
      const next = !setting.vehicleAutoFix;
      await updateSetting(player, { vehicleAutoFix: next });
      notifySaved(player, `自动修复已${next ? "开启" : "关闭"}`);
      syncVehicleAutoState(player, { vehicleAutoFix: next });
      return again();
    }
    case 3: {
      const next = !setting.vehicleNoCollision;
      await updateSetting(player, { vehicleNoCollision: next });
      notifySaved(player, `无碰撞模式已${next ? "开启" : "关闭"}`);
      // 立即应用（非比赛状态；比赛中由比赛系统强制开启，恢复时按此设置）
      syncNoCollisionState(player, next);
      return again();
    }
    case 4: {
      const current = setting.nitroType === "timer" ? "timer" : "hold";
      const nitroOptions = [
        `点按${current === "hold" ? "（当前）" : ""}`,
        `定时器${current === "timer" ? "（当前）" : ""}`,
      ];
      const nitroIndex = await pickOption(player, "氮气方式", nitroOptions);
      if (nitroIndex < 0) return again();
      const next = nitroIndex === 1 ? "timer" : "hold";
      await updateSetting(player, { nitroType: next });
      // 重置氮气计数：nitroCount 只服务 timer 模式（hold 走 KEY_FIRE 无冷却不碰它），
      // 从 hold 切回 timer 不清零会继承旧累计、立即触发一次补充——切换后从零开始
      resetNitroCount(player.id);
      notifySaved(player, `氮气方式已设为：${next === "timer" ? "定时器" : "点按"}`);
      return again();
    }
    case 5: {
      const next = !setting.vehicleFlip;
      await updateSetting(player, { vehicleFlip: next });
      notifySaved(player, `翻车自动翻正已${next ? "开启" : "关闭"}`);
      return again();
    }
  }
}
