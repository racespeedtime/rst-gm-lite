import { COLOR_RACE } from "@/utils/colors";
import { PREFIX } from "@/utils/msg";
import type { PlayerRace, RaceRoom } from "./types";

/**
 * 比赛系统单例状态（跨模块共享，独立成模块避免 room ↔ editor / room ↔ reconnect
 * 循环依赖）。类型定义见 ./types.ts（RaceRoom / PlayerRace / …）。
 * 承载：房间/玩家状态 Map、世界 id 分配器、公共常量、只读 getter、房间广播。
 * 所有状态**写**操作仍在 room.ts（状态机）内进行；本模块只提供读/工具接口。
 */

/** 比赛房间 */
export const rooms = new Map<number, RaceRoom>();
/** 玩家比赛状态（playerId -> 状态） */
export const playerRaces = new Map<number, PlayerRace>();

/** 比赛房间独立世界起始 id（战局上限 1000，比赛从 1001 起；回放/挑战世界从
 *  REPLAY_WORLD_BASE=2001 起，两区间各 1000 个互不叠加） */
export const RACE_WORLD_BASE = 1001;
let nextRaceWorldId = RACE_WORLD_BASE;
/**
 * 已销毁房间释放的比赛世界 id（复用防无界增长）：
 * 房间创建/销毁非常频繁（每人一房、结束即销毁），若只递增不复用，长期运行
 * 约 1000 个房间后 worldId 会追上回放世界基准 2001（REPLAY_WORLD_BASE），
 * 造成比赛与回放/挑战世界互相可见（跨世界实体穿模）。销毁时回收、创建时先取。
 */
const freedRaceWorlds: number[] = [];

export function allocRaceWorld(): number {
  return freedRaceWorlds.pop() ?? nextRaceWorldId++;
}

export function freeRaceWorld(worldId: number): void {
  // 只回收本模块分配的 id（防误收外部世界；RACE_WORLD_BASE 之上都属本模块）
  if (worldId >= RACE_WORLD_BASE) freedRaceWorlds.push(worldId);
}

/** 赛道名/ID 查重共用（roomUi 命令层也用：/r s /r info /r edit 按名或 id 查赛道） */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 玩家是否在比赛中 */
export function isInRace(playerId: number): boolean {
  return playerRaces.has(playerId);
}

/** 获取玩家比赛状态（供其他模块读取） */
export function getRacePlayerState(playerId: number): PlayerRace | undefined {
  return playerRaces.get(playerId);
}

/** 获取比赛房间（供其他模块读取） */
export function getRaceRoom(roomId: number): RaceRoom | undefined {
  return rooms.get(roomId);
}

/** 广播给房间内所有在线成员（roomUi 命令层加入提示也用）。
 *  前缀统一在此拼接（PREFIX.race）：调用点只传正文，防漏写/手写前缀 */
export function broadcastToRoom(room: RaceRoom, msg: string): void {
  for (const m of room.members.values()) {
    m.sendClientMessage(COLOR_RACE, `${PREFIX.race} ${msg}`);
  }
}
