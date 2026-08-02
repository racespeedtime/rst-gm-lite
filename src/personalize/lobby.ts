import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { getSetting, updateSetting } from "./settings";
import { spawnPlayer } from "@/core/spawn";
import { sessionManager } from "@/sessions/manager";
import { logger } from "@/logger";
import { showDialog } from "@/utils/dialog";
import { COLOR_ERROR } from "@/utils/colors";

/**
 * 玩家认证成功后的"大厅"（对话框序列）：
 * 1. 选择出生方式（随机 / 上次位置，显示当前）
 * 2. 选择进入世界方式（公共大世界 / 自身战局，显示当前）
 * 确认后保存设置 → 进入对应战局 → 出生。
 * 玩家在此处即可调整出生设置，避免进入自由世界后反复掉线。
 */
export async function runLobby(player: Player): Promise<void> {
  const setting = await getSetting(player);
  const currentSpawn = setting?.spawnMode === "LAST_POSITION" ? "LAST_POSITION" : "RANDOM";
  const currentEnter = setting?.enterWorldMode === "OWN_SESSION" ? "OWN_SESSION" : "PUBLIC";

  // 1. 出生方式
  const spawnOptions = [
    `随机出生点${currentSpawn === "RANDOM" ? "（当前）" : ""}`,
    `上次位置出生${currentSpawn === "LAST_POSITION" ? "（当前）" : ""}`,
  ];
  const spawnInfo = spawnOptions.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const spawnRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "进入世界 · 出生方式",
      info: spawnInfo,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!spawnRes) return; // 关闭大厅 → 使用默认设置进入
  if (spawnRes.response === 1) {
    const mode = spawnRes.listItem === 1 ? "LAST_POSITION" : "RANDOM";
    if (mode !== currentSpawn) {
      // 写库失败不致命：提示后按当前设置进入，避免设置保存异常把玩家踢出服务器
      try {
        await updateSetting(player, { spawnMode: mode });
      } catch (e) {
        logger.error(`[lobby] ${player.getName().name} 保存出生方式失败`, e);
        player.sendClientMessage(COLOR_ERROR, "出生设置保存失败，本次按当前设置进入");
      }
    }
  }

  // 2. 进入世界方式
  const enterOptions = [
    `公共大世界${currentEnter === "PUBLIC" ? "（当前）" : ""}`,
    `自身战局${currentEnter === "OWN_SESSION" ? "（当前）" : ""}`,
  ];
  const enterInfo = enterOptions.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const enterRes = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "进入世界 · 战局选择",
      info: enterInfo,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!enterRes) return;
  // 大厅对话框期间玩家可能已断线 → 不再进入战局/出生
  if (!player.isConnected()) return;

  // 3. 按设置进入战局
  if (enterRes.response === 1 && enterRes.listItem === 1) {
    const mine = sessionManager.findOwnedSession(player);
    if (mine) {
      await sessionManager.joinSession(player, mine);
    } else {
      const pw = setting?.sessionPassword ?? null;
      await sessionManager.createSession(player, `${player.getName().name} 的战局`, pw);
    }
  } else {
    await sessionManager.joinPublicWorld(player);
  }

  // 4. 出生（再次断线防护）
  if (!player.isConnected()) return;
  await spawnPlayer(player);
}
