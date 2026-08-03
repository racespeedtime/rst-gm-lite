import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
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
import { applyInvincibleState } from "@/core/invincible";
import { applyPlayerStyle } from "@/core/playerStyle";
import { applyPlayerPreset } from "@/attire";
import { showSkinPicker, applySkin } from "./skinPicker";
import { parseIntInRange } from "@/utils/parse";
import type { MenuBack } from "@/core/panel";
import { showDialog } from "@/utils/dialog";

/**
 * 人物个性化菜单
 * 1. 显示/隐藏人物装扮（关闭时提示）
 * 2. 显示/隐藏游戏内其他玩家 NameTag（非赛车模式）
 * 3. 切换皮肤模型（skinId 输入）
 * 4. 名字前缀
 * 5. 名字后缀
 * 6. 默认人物预设
 * 7. 无敌状态
 *
 * 表格两列（功能 | 当前值），操作一项后自动刷新回本菜单（状态实时刷新），
 * 点"取消"才退出面板——避免改一项就得重新按 Y 的来回折腾。
 */
export async function openCharacterMenu(player: Player, back?: MenuBack): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const rows = [
    { name: "人物装扮", value: toggleText(setting.showPlayerAttire) },
    { name: "显示NameTag", value: toggleText(setting.showName) },
    { name: "皮肤模型", value: String(setting.skinId) },
    { name: "名字前缀", value: setting.prefix || "无" },
    { name: "名字后缀", value: setting.suffix || "无" },
    { name: "默认人物预设", value: "" },
    { name: "无敌状态", value: toggleText(setting.invincible) },
  ];
  const index = await pickOption(player, "人物个性化", rows.map((r) => r.name), {
    headers: ["设置", "当前"],
    format: (_o, i) => [rows[i].name, rows[i].value],
  });
  if (index < 0) return back?.(); // 取消 → 退出面板

  const again = () => openCharacterMenu(player, back); // 操作完成后回到本菜单
  if (index === 0) {
    const next = !setting.showPlayerAttire;
    await updateSetting(player, { showPlayerAttire: next });
    if (!next) {
      player.sendClientMessage(COLOR_ERROR, "你已关闭人物装扮显示，装扮将不再展示");
    } else {
      notifySaved(player, "人物装扮已开启显示");
    }
    // 立即生效：关闭则清空当前挂载，开启则重新应用默认预设（applyPlayerPreset 内部先清空再按开关应用）
    await applyPlayerPreset(player, setting.defaultPlayerPresetId ?? null);
    return again();
  }
  if (index === 1) {
    // NameTag 显示：切换后立即对所有在线玩家生效
    const next = !setting.showName;
    await updateSetting(player, { showName: next });
    notifySaved(player, `其他玩家NameTag已${next ? "开启" : "隐藏"}`);
    await applyPlayerStyle(player);
    return again();
  }
  if (index === 2) {
    // 皮肤模型：3D 选肤（推荐）或手动输入 ID（74 假 CJ 禁用）
    const pick = await pickOption(player, "皮肤模型", [
      "3D 选肤（浏览模型）",
      "输入皮肤ID",
    ]);
    if (pick < 0) return again();
    if (pick === 0) {
      await showSkinPicker(player);
      return again();
    }
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "切换皮肤模型",
        info: `输入皮肤模型ID（0-311，74 禁用，当前：${setting.skinId}）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res || res.response !== 1) return again();
    const skin = parseIntInRange(res.inputText, 0, 311);
    if (skin == null) {
      player.sendClientMessage(COLOR_ERROR, "皮肤ID需为 0-311 的整数");
      return again();
    }
    await applySkin(player, skin); // 统一校验（74 禁用）
    return again();
  }
  if (index === 3) {
    // 名字前缀
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "名字前缀",
        info: `输入名字前缀（留空清除，≤255字符，当前：${setting.prefix ? setting.prefix : "无"}）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res || res.response !== 1) return again();
    const prefix = res.inputText.trim();
    if (prefix.length > 255) {
      player.sendClientMessage(COLOR_ERROR, "名字前缀最多 255 个字符");
      return again();
    }
    await updateSetting(player, { prefix: prefix || null });
    notifySaved(player, prefix ? `名字前缀已设为：${prefix}` : "名字前缀已清除");
    await applyPlayerStyle(player);
    return again();
  }
  if (index === 4) {
    // 名字后缀
    const res = await showDialog(
      player,
      new Dialog({
        style: DialogStylesEnum.INPUT,
        caption: "名字后缀",
        info: `输入名字后缀（留空清除，≤255字符，当前：${setting.suffix ? setting.suffix : "无"}）：`,
        button1: "确定",
        button2: "取消",
      }),
    );
    if (!res || res.response !== 1) return again();
    const suffix = res.inputText.trim();
    if (suffix.length > 255) {
      player.sendClientMessage(COLOR_ERROR, "名字后缀最多 255 个字符");
      return again();
    }
    await updateSetting(player, { suffix: suffix || null });
    notifySaved(player, suffix ? `名字后缀已设为：${suffix}` : "名字后缀已清除");
    await applyPlayerStyle(player);
    return again();
  }
  if (index === 5) {
    await pickDefaultPreset(player);
    return again();
  }
  if (index === 6) {
    // 无敌开关：切换后立即应用（开启回满血 + 更新进程内缓存，关闭则移除）
    const next = !setting.invincible;
    await updateSetting(player, { invincible: next });
    notifySaved(player, `无敌状态已${next ? "开启" : "关闭"}`);
    await applyInvincibleState(player);
    return again();
  }
}

/** 选择默认人物预设（从 player_preset 表读取该用户的预设） */
async function pickDefaultPreset(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await getSetting(player);
  if (!setting) return;

  const presets = await prisma.playerPreset.findMany({
    where: { userId: auth.userId, deletedAt: null },
    orderBy: [{ skinId: "asc" }, { index: "asc" }],
  });

  const options = ["不使用默认预设"];
  if (presets.length === 0) {
    options.push("（你还没有人物预设）");
  } else {
    for (const p of presets) {
      const mark = setting.defaultPlayerPresetId === p.id ? "（当前）" : "";
      options.push(`皮肤${p.skinId} · 预设${p.index + 1}${p.name ? `（${p.name}）` : ""}${mark}`);
    }
  }
  const idx = await pickOption(player, "默认人物预设", options);
  if (idx < 0) return;

  if (idx === 0) {
    await updateSetting(player, { defaultPlayerPresetId: null });
    notifySaved(player, "已清除默认人物预设");
    return;
  }
  const preset = presets[idx - 1];
  if (!preset) return;
  await updateSetting(player, { defaultPlayerPresetId: preset.id });
  notifySaved(player, `默认人物预设已设为：皮肤${preset.skinId} · 预设${preset.index + 1}`);
}
