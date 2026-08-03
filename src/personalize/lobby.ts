import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { getSetting, updateSetting } from "./settings";
import { spawnPlayer } from "@/core/spawn";
import { sessionManager } from "@/sessions/manager";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";
import { COLOR_ERROR } from "@/utils/colors";

/**
 * 玩家认证成功后的"大厅"（对话框序列）：
 * 合并为一个对话框选择 出生方式 × 进入世界方式（4 种组合），
 * 当前值标注（当前），确认后保存设置 → 进入对应战局 → 出生。
 * 合并后每次登录只点一次，避免"出生方式"→"进入世界方式"连续两个对话框。
 */
export async function runLobby(player: Player): Promise<void> {
  const setting = await getSetting(player);
  const currentSpawn = setting?.spawnMode === "LAST_POSITION" ? "LAST_POSITION" : "RANDOM";
  const currentEnter = setting?.enterWorldMode === "OWN_SESSION" ? "OWN_SESSION" : "PUBLIC";

  // 出生方式 × 进入世界方式 4 组合（一次选完，当前值标注）
  const options = [
    `随机出生点 · 公共大世界${currentSpawn === "RANDOM" && currentEnter === "PUBLIC" ? "（当前）" : ""}`,
    `随机出生点 · 自身战局${currentSpawn === "RANDOM" && currentEnter === "OWN_SESSION" ? "（当前）" : ""}`,
    `上次位置 · 公共大世界${currentSpawn === "LAST_POSITION" && currentEnter === "PUBLIC" ? "（当前）" : ""}`,
    `上次位置 · 自身战局${currentSpawn === "LAST_POSITION" && currentEnter === "OWN_SESSION" ? "（当前）" : ""}`,
  ];
  const info = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "进入世界 · 出生方式",
      info,
      button1: "确定",
      button2: "跳过",
    }),
  );
  // 取消/关闭 → 使用当前设置进入（与旧行为一致）
  let spawnMode = currentSpawn;
  let enterMode = currentEnter;
  if (res && res.response === 1) {
    const idx = res.listItem;
    // 0 随机+公共 / 1 随机+自身 / 2 上次+公共 / 3 上次+自身
    spawnMode = idx >= 2 ? "LAST_POSITION" : "RANDOM";
    enterMode = idx % 2 === 1 ? "OWN_SESSION" : "PUBLIC";
  }
  // 写库（有变化才写；写库失败不致命：提示后按当前设置进入，避免把玩家踢出服务器）
  if (spawnMode !== currentSpawn || enterMode !== currentEnter) {
    try {
      await updateSetting(player, { spawnMode, enterWorldMode: enterMode });
    } catch (e) {
      logger.error(`[lobby] ${player.getName().name} 保存进入设置失败`, e);
      player.sendClientMessage(COLOR_ERROR, "进入设置保存失败，本次按当前设置进入");
    }
  }

  // 进入对应战局（再次断线防护）
  if (!player.isConnected()) return;
  if (enterMode === "OWN_SESSION") {
    // 已有自身战局则回到（createSession 内部处理防重复创建），没有则创建
    const pw = setting?.sessionPassword ?? null;
    await sessionManager.createSession(player, `${player.getName().name} 的战局`, pw);
  } else {
    await sessionManager.joinPublicWorld(player);
  }

  // 出生（再次断线防护）
  if (!player.isConnected()) return;
  await spawnPlayer(player);
}
