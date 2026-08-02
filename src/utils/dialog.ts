import { Dialog, DialogException, Player } from "@infernus/core";

/**
 * 显示对话框并等待玩家响应。
 * 玩家断开/关闭时返回 null（DialogException），其余异常向上抛出。
 */
export async function showDialog(player: Player, dialog: Dialog) {
  try {
    return await dialog.show(player);
  } catch (e) {
    if (e instanceof DialogException) return null;
    throw e;
  }
}
