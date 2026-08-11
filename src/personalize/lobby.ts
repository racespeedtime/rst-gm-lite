import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { getSetting, updateSetting } from "./settings";
import { spawnPlayer } from "@/core/spawn";
import { sessionManager } from "@/sessions/manager";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";

import { sysMsg } from "@/utils/msg";

/**
 * 玩家认证成功后的"大厅"（对话框序列）：
 * 合并为一个对话框选择 出生方式 × 进入世界方式（4 种组合），
 * 当前值标注（当前），确认后保存设置 → 进入对应战局 → 出生。
 * 合并后每次登录只点一次，避免"出生方式"→"进入世界方式"连续两个对话框。
 */
export async function runLobby(player: Player): Promise<void> {
  const setting = await getSetting(player);
  const currentSpawn = setting?.spawnMode === "LAST_POSITION" ? "LAST_POSITION" : "RANDOM";
  // "OWN" = 自身战局（enterWorldMode 列 VarChar(10)，"OWN_SESSION" 11 字符超长
  // 会触发 "value too long"——旧值用短枚举 "OWN" 对齐列宽）
  const currentEnter = setting?.enterWorldMode === "OWN" ? "OWN" : "PUBLIC";

  // 出生方式 × 进入世界方式 4 组合（一次选完，当前值标注）。
  // 带数据驱动（避免依赖固定排列的魔法索引，增删组合不易错）
  const combos: { spawn: "RANDOM" | "LAST_POSITION"; enter: "PUBLIC" | "OWN" }[] = [
    { spawn: "RANDOM", enter: "PUBLIC" },
    { spawn: "RANDOM", enter: "OWN" },
    { spawn: "LAST_POSITION", enter: "PUBLIC" },
    { spawn: "LAST_POSITION", enter: "OWN" },
  ];
  const options = combos.map((c) => {
    const isCurrent = c.spawn === currentSpawn && c.enter === currentEnter;
    return `${
      c.spawn === "RANDOM" ? "随机出生点" : "上次位置"
    } · ${c.enter === "PUBLIC" ? "公共大世界" : "自身战局"}${isCurrent ? "（当前）" : ""}`;
  });
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
    const chosen = combos[res.listItem];
    if (chosen) {
      spawnMode = chosen.spawn;
      enterMode = chosen.enter;
    }
  }
  // 写库（有变化才写；写库失败不致命：提示后按当前设置进入，避免把玩家踢出服务器）
  if (spawnMode !== currentSpawn || enterMode !== currentEnter) {
    try {
      await updateSetting(player, { spawnMode, enterWorldMode: enterMode });
    } catch (e) {
      logger.error(`[lobby] ${player.getName().name} 保存进入设置失败`, e);
      sysMsg(player, "settings", "进入设置保存失败，本次按当前设置进入", "error");
    }
  }

  // 进入对应战局（再次断线防护）
  if (!player.isConnected()) return;
  if (enterMode === "OWN") {
    // 已有自身战局则回到（createSession 内部处理防重复创建），没有则创建。
    // 战局创建失败（DB 故障/加入拦截）降级回公共大世界照常出生——与上面
    // "保存失败不致命"同口径：登录流程不应因战局问题把玩家踢出服务器
    try {
      const pw = setting?.sessionPassword ?? null;
      await sessionManager.createSession(player, `${player.getName().name} 的战局`, pw);
    } catch (e) {
      logger.error(`[lobby] ${player.getName().name} 创建战局失败，回公共大世界`, e);
      await sessionManager.joinPublicWorld(player);
    }
  } else {
    await sessionManager.joinPublicWorld(player);
  }

  // 出生（再次断线防护）
  if (!player.isConnected()) return;
  await spawnPlayer(player);
}
