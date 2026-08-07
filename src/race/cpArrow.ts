import { RaceCheckpoint, Player } from "@infernus/core";
import { getObserverIdsOf, getObserveTarget, onObserveStart, onObserveStop } from "@/core/observe";
import type { RaceRoom } from "./types";
import { playerRaces, rooms } from "./state";

/**
 * 观战者 → 被观战比赛成员 的 CP 同步映射（观察者 playerId → 成员 playerId）。
 * 仅"观察者当前正在观战本房间成员"时维护；成员 CP 变化时经 syncCpToObservers
 * 更新观察者的箭头/图标，stopObserve/切换目标/断线/房间销毁时清除。观察者本身
 * 不是房间成员（/tv 外部玩家观战比赛）或完赛自动观战者（仍在 members）都可能。
 */
const spectatorCpMap = new Map<number, number>();

/** 比赛小地图图标索引（对齐原版 RACE_MAP_ICON_INDEX=1，避开大世界 map_icon 的 0-69） */
export const RACE_MAP_ICON_NEXT = 70;
/** 比赛小地图图标类型：56 = 赛车 CP 预览图标（原版 RACE_MAP_ICON_TYPE） */
const RACE_MAP_ICON_TYPE_NEXT = 56;

/**
 * 显示下一个检查点箭头（红色=指向下一个CP，黄色=终点CP）。
 * 对齐原版 Race_ShowCp：
 * - RaceCheckpoint 红圈在"当前要过的 CP"（nxt）、箭头指向下一个（nxt2）
 * - 小地图图标在"下一个 CP"（nrcp = nxt2），类型 56 + color 0 + style 1
 * - nxt 是最后一个 CP（无 nxt2）→ 终点黄圈；原版该分支不调 SetPlayerMapIcon，
 *   图标保留在上一个位置（标记终点），不主动清除
 */
export function showNextCheckpoint(player: Player, cps: RaceRoom["cps"], cpIndex: number): void {
  // 下一个 CP（nxt）与下下个 CP（nxt2，若有）：箭头从 nxt 指向 nxt2
  let nxt = cps[cpIndex + 1];
  let nxt2 = nxt ? cps[cpIndex + 2] : undefined;
  if (!nxt) {
    // 当前是最后一个 CP（还差圈）→ 回到第一个 CP（nxt2 = 第二个）
    nxt = cps[0];
    nxt2 = cps[1];
  }
  if (!nxt) return;
  if (nxt2) {
    RaceCheckpoint.set(player, 0, nxt.x, nxt.y, nxt.z, nxt2.x, nxt2.y, nxt2.z, nxt.size);
  } else {
    RaceCheckpoint.set(player, 1, nxt.x, nxt.y, nxt.z, nxt.x, nxt.y, nxt.z, nxt.size);
  }
  // 小地图图标：下一个 CP（nrcp=nxt2），类型 56 + color 0 + style 1（原版 RACE_MAP_ICON_TYPE）
  if (nxt2) {
    player.setMapIcon(RACE_MAP_ICON_NEXT, nxt2.x, nxt2.y, nxt2.z, RACE_MAP_ICON_TYPE_NEXT, 0, 1);
  }
}

/** 清除比赛小地图图标（离开/结束/完成时，对齐原版 Race_HideCp 的 RemovePlayerMapIcon） */
export function clearRaceMapIcons(player: Player): void {
  if (!player.isConnected()) return;
  player.removeMapIcon(RACE_MAP_ICON_NEXT);
}

/** 为观察者同步其当前观战成员的下一 CP 箭头/图标（成员 CP 变化各同步点调用）。
 *  仅当观察者确实在看该成员（originPlayerId 匹配，覆盖车内目标）且世界在房间
 *  世界时才更新——观察者切走/离开房间世界后不干扰。 */
export function syncCpToObservers(room: RaceRoom, member: Player, cpIndex: number): void {
  for (const oid of getObserverIdsOf(member.id)) {
    const ob = Player.getInstance(oid);
    if (!ob || !ob.isConnected()) continue;
    if (ob.getVirtualWorld() !== room.worldId) continue; // 未在比赛世界（换世界中）
    const st = getObserveTarget(oid);
    if (!st || st.originPlayerId !== member.id) continue; // 当前目标不是该成员
    spectatorCpMap.set(oid, member.id);
    showNextCheckpoint(ob, room.cps, cpIndex);
  }
}

/** 清除观察者的比赛 CP 箭头/图标（退出观战/切换目标/断线/房间销毁时），并删映射 */
export function clearSpectatorCp(observerId: number): void {
  if (!spectatorCpMap.delete(observerId)) return; // 未为任何成员同步过 → 无操作
  const ob = Player.getInstance(observerId);
  if (!ob || !ob.isConnected()) return;
  try {
    RaceCheckpoint.disable(ob);
  } catch {
    /* 已失效 */
  }
  ob.removeMapIcon(RACE_MAP_ICON_NEXT);
}

/** 房间销毁/成员离开时清理指向该房间成员的观察者 CP 同步 */
export function cleanupSpectatorCpForRoom(room: RaceRoom): void {
  for (const [oid, mid] of [...spectatorCpMap]) {
    const pr = playerRaces.get(mid);
    if (pr && pr.roomId === room.id) {
      clearSpectatorCp(oid);
    }
  }
}

/** 成员掉线/离开时清理指向该成员的观察者 CP 箭头（车停原地无人可跟） */
export function clearSpectatorCpForMember(memberId: number): void {
  for (const [oid, mid] of [...spectatorCpMap]) {
    if (mid === memberId) clearSpectatorCp(oid);
  }
}

/** 观察者开始观战时：若是房间成员 → 立即同步其当前 CP（含从看别人切到看该成员） */
function onSpectatorStart(observerId: number): void {
  clearSpectatorCp(observerId); // 先清旧（若之前在看另一房间成员）
  const st = getObserveTarget(observerId);
  if (!st || st.originPlayerId == null) return;
  const member = Player.getInstance(st.originPlayerId);
  if (!member || !member.isConnected()) return;
  const pr = playerRaces.get(member.id);
  if (!pr) return;
  const room = rooms.get(pr.roomId);
  if (room && room.state === "RACING") {
    syncCpToObservers(room, member, pr.cpIndex);
  }
}

/** 注册观战 CP 箭头同步钩子（initRaceSystem 调用） */
export function initCpArrowSync(): void {
  onObserveStart(onSpectatorStart);
  onObserveStop(clearSpectatorCp);
}
