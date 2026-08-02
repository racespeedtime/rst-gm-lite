import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { getSetting, updateSetting, pickOption, notifySaved, COLOR_ERROR } from "./settings";
import { showDialog } from "@/utils/dialog";

/**
 * 战局设置菜单
 * 1. 自身战局：公开/私有（切私有必须设置密码，空密码拒绝）
 * 2. 设置自身战局密码
 * 3. 启动时进入：公共大世界 / 自身战局
 */
export async function openSessionSettingsMenu(player: Player): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const menuOptions = [
    `自身战局类型：${setting.sessionType === "PUBLIC" ? "公开" : "私有"}${setting.sessionType === "PRIVATE" ? "（需要密码）" : ""}`,
    `设置战局密码：${setting.sessionPassword ? "已设置" : "未设置"}`,
    `启动进入：${setting.enterWorldMode === "OWN_SESSION" ? "自身战局" : "公共大世界"}`,
  ];
  const index = await pickOption(player, "战局设置", menuOptions);
  if (index < 0) return;

  if (index === 0) {
    // 自身战局类型（公开/私有）
    const isPublic = setting.sessionType !== "PRIVATE";
    const typeOptions = [
      `公开${isPublic ? "（当前）" : ""}`,
      `私有（需密码）${!isPublic ? "（当前）" : ""}`,
    ];
    const typeIndex = await pickOption(player, "自身战局类型", typeOptions);
    if (typeIndex < 0) return;
    if (typeIndex === 1) {
      // 私有战局必须设定密码
      const pwdRes = await showDialog(
        player,
        new Dialog({
          style: DialogStylesEnum.PASSWORD,
          caption: "私有战局",
          info: "私有战局必须设置一个密码：",
          button1: "确定",
          button2: "取消",
        }),
      );
      if (!pwdRes || pwdRes.response !== 1) return;
      if (!pwdRes.inputText.trim()) {
        player.sendClientMessage(COLOR_ERROR, "私有战局必须设置密码，未设置已取消");
        return;
      }
      await updateSetting(player, {
        sessionType: "PRIVATE",
        sessionPassword: pwdRes.inputText.trim(),
      });
      notifySaved(player, `自身战局已设为私有，密码：${pwdRes.inputText.trim()}`);
    } else {
      await updateSetting(player, { sessionType: "PUBLIC" });
      notifySaved(player, "自身战局已设为公开");
    }
    return;
  }

  if (index === 1) {
    // 设置战局密码
    const pwdRes = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.PASSWORD,
        caption: "设置战局密码",
        info: "输入自身战局密码（留空清除）：",
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!pwdRes || pwdRes.response !== 1) return;
    const pwd = pwdRes.inputText.trim();
    await updateSetting(player, { sessionPassword: pwd || null });
    notifySaved(player, pwd ? `战局密码已设为：${pwd}` : "战局密码已清除");
    return;
  }

  if (index === 2) {
    // 启动进入方式
    const enterOwn = setting.enterWorldMode === "OWN_SESSION";
    const enterOptions = [
      `公共大世界${!enterOwn ? "（当前）" : ""}`,
      `自身战局${enterOwn ? "（当前）" : ""}`,
    ];
    const modeIndex = await pickOption(player, "启动进入", enterOptions);
    if (modeIndex < 0) return;
    const next = modeIndex === 1 ? "OWN_SESSION" : "PUBLIC";
    await updateSetting(player, { enterWorldMode: next });
    notifySaved(player, `下次进入世界：${next === "OWN_SESSION" ? "自身战局" : "公共大世界"}`);
  }
}
