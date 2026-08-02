/**
 * 流程互斥锁：玩家进入某个对话框/交互流程（认证、面板等）时锁定，
 * 防止其他入口（如万能面板快捷键）打断当前流程。
 */
const lockedPlayers = new Set<number>();

/** 锁定玩家（进入需要互斥的流程时调用） */
export function lockPlayer(playerId: number): void {
  lockedPlayers.add(playerId);
}

/** 解锁玩家（流程结束/中断/断开时调用） */
export function unlockPlayer(playerId: number): void {
  lockedPlayers.delete(playerId);
}

/** 判断玩家是否处于某个流程中 */
export function isPlayerLocked(playerId: number): boolean {
  return lockedPlayers.has(playerId);
}
