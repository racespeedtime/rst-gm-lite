import { Player } from "@infernus/core";
import { logger } from "@/logger";
import { getOwnedVehicle, spawnVehicle, destroyPlayerVehicle, addNitro } from "@/vehicles";
import { getSafeGroundZ } from "@/core/colandreas";
import { execCpScript, type CpScriptContext } from "./scripts";
import { getDefaultRaceModel } from "./vehicle";
import { MIN_Z } from "@/utils/map";
import { sysMsg } from "@/utils/msg";
import type { PlayerRace, RaceRoom } from "./types";
import { playerRaces, rooms } from "./state";
import { showNextCheckpoint, syncCpToObservers } from "./cpArrow";
import { noteCpProgress } from "@/replay/recorder";
import { getObserverIdsOf } from "@/core/observe";

/**
 * 重生/回退系统：死亡重生、/kill 重置回上一 CP、面板「回退到更早检查点」。
 * 对齐原版 ReSpawnRaceVehicle 语义：spawnpos 优先 → CP 坐标 + colandreas 抬升；
 * 重生重执行该 CP 脚本（弹射/换车等必需效果恢复）；回退时恢复目标 CP 触达后的
 * 状态（车模型 / time / weather，回放式状态回撤）。
 */

/**
 * 计算重生坐标 Z：以 CP 原始高度为基准（对齐原版重生 SetPlayerPos 用 CP 坐标——
 * CP 是赛道编辑时贴地放置的，原始 z 即正确地面高度）。
 * colandreas 仅当 CP 原始 z 异常偏低（数据异常/水下）时抬升到实际地面，
 * 避免把坡顶/桥上/平台上的 CP 压到下方地面（原实现无条件取地面导致重生偏低）。
 */
function getSafeRespawnZ(cp: { x: number; y: number; z: number }): number {
  const ground = getSafeGroundZ(cp.x, cp.y, cp.z);
  // ground 合理时取 CP 原始 z 与地面的较高者；colandreas 不可用/超范围时
  // ground 回退为 cp.z（等于 CP 原始高度），自然取 cp.z
  return ground > MIN_Z ? Math.max(cp.z, ground) : cp.z;
}

/**
 * 从 CP 脚本数组解析 spawnpos 重生点（原版 ReSpawnRaceVehicle 重生优先用 spawnpos）。
 * spawnpos x y z a —— 过 CP 时它只终止脚本链（防瞬移，见 execCpScript），
 * 重生时才单独解析坐标：原版在 ReSpawnRaceVehicle 里扫描脚本数组、有 spawnpos 即
 * 调用（RaceCpScript_func_spawnpos：人车一起挪到指定坐标 + 朝向），没有才用 CP 坐标。
 */
function parseSpawnPos(
  scripts: string[],
): { x: number; y: number; z: number; angle: number } | null {
  for (const script of scripts) {
    const [fn, sx, sy, sz, sa] = script.trim().split(/\s+/);
    if (fn === "spawnpos") {
      const x = Number(sx);
      const y = Number(sy);
      const z = Number(sz);
      const angle = Number(sa);
      if ([x, y, z, angle].every(Number.isFinite)) {
        return { x, y, z, angle };
      }
      return null; // 坐标残缺：作废该 spawnpos，回退 CP 坐标
    }
  }
  return null;
}

/** 重生点计算：优先该 CP 的 spawnpos 坐标（原版语义），否则 CP 原始坐标 + colandreas 抬升。
 * spawnpos 是作者精确放置的重生点，直接信其坐标；z 异常（数据错误/水下）时用
 * colandreas 抬升到实际地面（与 getSafeRespawnZ 同口径）。 */
function getRespawnPoint(cp: RaceRoom["cps"][number]): {
  x: number;
  y: number;
  z: number;
  angle: number;
} {
  const sp = parseSpawnPos(cp.scripts);
  if (sp) {
    const ground = getSafeGroundZ(sp.x, sp.y, sp.z);
    const z = ground > MIN_Z ? Math.max(sp.z, ground) : sp.z;
    return { x: sp.x, y: sp.y, z, angle: sp.angle };
  }
  return { x: cp.x, y: cp.y, z: getSafeRespawnZ(cp), angle: cp.angle };
}

/** 重生目标 CP 计算：回退 rollback 格（0 = 回上一 CP = 当前进度；1 = 再往前一个 CP）。
 * 已触达 CP 的累计序号与快照写入（onPlayerReachCp）公式一致：lap × 一圈CP数 + cpIndex。
 * 跨圈瞬间 cpIndex=-1、lap++，该式仍指向刚触达的上一圈末 CP（如 2×len+(-1) = 上一圈第 len-1 个），
 * 而非"当前圈第一个 CP"——否则跨圈后重生会落在下一目标上、跳过上一圈末到本圈首的路段。
 * 回退 rollback 格 → 累计序号减 rollback（clamp 到 0 = 第一 CP）；位置/箭头用 cumIdx % len 取圈内下标。 */
function computeTargetCp(
  pr: PlayerRace,
  room: RaceRoom,
  rollback = 0,
): { prevIdx: number; cumIdx: number; prev: RaceRoom["cps"][number] | undefined } {
  const cumIdx = Math.max(0, pr.lap * room.cps.length + pr.cpIndex - rollback);
  const prevIdx = cumIdx % room.cps.length;
  return { prevIdx, cumIdx, prev: room.cps[prevIdx] };
}

/** 回撤/重生的目标 CP（computeTargetCp 的返回类型） */
export type RollbackTarget = ReturnType<typeof computeTargetCp>;

/** 回撤重生目标的状态（回放式状态回撤）：
 * - 车模型：目标快照的车型 ≠ 当前车型 → 回退到该车型（cveh 换车场景，否则车模型残留）。
 *   目标快照缺（比赛开始即回退/无记录）→ 模型不变（只能回退位置）；跳过"过点车"不可逆。
 * - time/weather：目标快照存在则恢复（time/weather 脚本可逆、覆盖当前即可）。
 * 快照有 vehModel=0（过点时步行）时保持当前车模型（不把车变没）。 */
function applyRollbackState(player: Player, pr: PlayerRace, target: RollbackTarget): void {
  const snap = pr.cpSnapshots[target.cumIdx];
  if (snap) {
    const model = player.isInAnyVehicle() ? player.getVehicle()!.getModel() : 0;
    if (snap.vehModel && model && model !== snap.vehModel) {
      void spawnVehicle(player, snap.vehModel, true); // 懒创建爱车，与 cveh 语义一致
    }
    player.setTime(snap.hour, snap.minute);
    player.setWeather(snap.weather);
  }
}

/** 重生时重执行该 CP 的脚本（对齐"触达即生效"语义——部分赛道靠 CP 弹射 speed /
 *  cveh 换车才能继续过后续路段，重生回该 CP 后检查点已消耗、红圈在下一个，玩家
 *  无法再次"触达"触发脚本 → 会被卡死或只能反复 /kill）：
 * - spawnpos：位置已由 getRespawnPoint 单独处理，且它会终止整条脚本链——跳过
 * - vgoto：会把刚放好的重生位置又传走——跳过
 * - damage：重生已挪车+修复，重执行会刚修好又爆胎——跳过
 * - 其余（speed/speedex/zspeed/angle/time/weather/cveh/fix/msg）照执行：弹射初速
 *   恢复（必需场景）、车型/时间天气恢复、提示重演
 * - 第一 CP 的 cveh 是赛道标准车（skipCveh，与过点语义一致） */
function replayCpScriptsOnRespawn(player: Player, room: RaceRoom, prevIdx: number): void {
  const cp = room.cps[prevIdx];
  if (!cp) return;
  const scripts = cp.scripts.filter((s) => {
    const fn = s.trim().split(/\s+/)[0];
    return fn !== "spawnpos" && fn !== "vgoto" && fn !== "damage";
  });
  if (scripts.length === 0) return;
  const pr = playerRaces.get(player.id);
  if (!pr) return;
  const isFirstCp = cp.index === room.cps[0].index;
  const scriptCtx: CpScriptContext = {
    raceId: room.raceId,
    cpid: cp.index,
    raceName: room.raceName,
    authorName: room.authorName,
    cps: room.cps.map((c) => ({ index: c.index, x: c.x, y: c.y, z: c.z })),
  };
  try {
    for (const script of scripts) {
      if (!execCpScript(player, scriptCtx, script, { skipCveh: isFirstCp })) break;
      // 脚本执行（同步）期间玩家可能已离开/比赛结束 → 终止后续脚本
      if (!playerRaces.has(player.id) || rooms.get(pr.roomId)?.state !== "RACING" || pr.finished) {
        break;
      }
    }
  } catch (e) {
    // 脚本执行异常（native 读取失败等）：不影响玩家状态（对齐过点脚本防御式执行）
    logger.error(`[race] 重生重执行脚本异常 race=${room.raceId} cp=${cp.index}`, e);
  }
}

/** 重生到指定 CP（位置 + 车就位 + 放回车里）：respawnPlayerToCp / respawnToLastCp 共用。
 * spawnpos 优先（对齐原版 ReSpawnRaceVehicle），否则 CP 坐标 + colandreas 抬升。
 * 车完好 → 挪到重生点 + 修复 + 加氮气 + 放回车里；车已毁（爆炸，getOwnedVehicle
 * 失效）→ 刷默认比赛车兜底（懒创建爱车）——玩家重生后始终有车（对齐原版
 * ReSpawnRaceVehicle / 本分支"玩家应始终在车上"的语义）。 */
function respawnToCpCore(player: Player, room: RaceRoom, target: RollbackTarget): void {
  const { prevIdx, prev } = target;
  if (!prev) return;
  const pt = getRespawnPoint(prev);
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(pt.x, pt.y, pt.z);
    owned.setZAngle(pt.angle);
    owned.setHealth(1000);
    owned.repair();
    addNitro(owned);
    owned.putPlayerIn(player, 0);
  } else {
    if (owned) destroyPlayerVehicle(player.id); // 清理爆炸后残留的失效实体引用
    void spawnVehicle(player, getDefaultRaceModel(room.cps), true);
  }
  // 重新显示当前 CP（红箭头指向下一个）
  showNextCheckpoint(player, room.cps, prevIdx);
  // 重生/回退同步观战者的 CP 箭头（观察者看到与成员一致的当前目标）
  syncCpToObservers(room, player, prevIdx);
  // 重生重执行该 CP 脚本（弹射/换车等必需效果恢复，跳过 spawnpos/vgoto/damage——
  // 见 replayCpScriptsOnRespawn 注释）。放在 applyRollbackState 之前：重执行 cveh
  // 已把车型换对，快照回撤的车型判断自然跳过（不重复刷车），time/weather 同值幂等。
  replayCpScriptsOnRespawn(player, room, prevIdx);
}

/** 重生回上一 CP（死亡场景：setSpawnInfo + spawn 复活）。导出供 initRaceSystem 的
 *  onDeath 死亡重生路径调用 */
export function respawnPlayerToCp(
  player: Player,
  pr: PlayerRace,
  room: RaceRoom,
  rollback?: number,
): void {
  const target = computeTargetCp(pr, room, rollback);
  const prev = target.prev;
  if (!prev) return;
  const pt = getRespawnPoint(prev);
  player.setSpawnInfo(0, player.getSkin(), pt.x, pt.y, pt.z, pt.angle, 0, 0, 0, 0, 0, 0);
  player.spawn();
  respawnToCpCore(player, room, target);
  applyRollbackState(player, pr, target);
  writeBackRollbackProgress(player, pr, room, target, rollback);
  sysMsg(player, "race", `已重生回${rollback ? `前 ${rollback + 1} 个` : "上一个"}检查点`, "info");
}

/** 回退（rollback>0）时把玩家进度回写到目标 CP：否则 onPlayerReachCp 仍按旧
 * cpIndex+1 取目标，红圈在回退目标、事件却期待更后面的 CP——脚本在错误位置触发
 * 且目标 CP 永远重跑不到（cveh 换车类赛道回退后车型/时间错乱）。
 * 普通重生（rollback=0）进度本就一致（playerRaces 与位置同步推进），不回写——
 * 跨圈瞬间 cpIndex=-1 时回写会错误地把 lap 打回上一圈。 */
function writeBackRollbackProgress(
  player: Player,
  pr: PlayerRace,
  room: RaceRoom,
  target: RollbackTarget,
  rollback?: number,
): void {
  if (!rollback) return;
  const len = room.cps.length;
  // 目标累计序号对应某圈的**最后一个 CP**：onPlayerReachCp 里"触达末 CP"是函数体
  // 内瞬态（随后立即 cpIndex=-1、lap++ 翻圈），不能持久化为 (lap, len-1)——
  // 否则 nextCp = cps[len] = undefined 导致过点事件永久早退、进度软锁。写
  // post-wrap 状态（lap+1, cpIndex=-1），与正常翻圈后的进度一致；红圈已由
  // respawnToCpCore 的 showNextCheckpoint(prevIdx=len-1) 摆到本圈第一个 CP。
  if (target.cumIdx % len === len - 1) {
    pr.lap = Math.floor(target.cumIdx / len) + 1;
    pr.cpIndex = -1;
  } else {
    pr.lap = Math.floor(target.cumIdx / len);
    pr.cpIndex = target.cumIdx % len;
  }
  // 圈内进度 = 目标累计序号 % 一圈CP数 + 1（末 CP 情形 = len，与正常翻圈后的显示一致）
  // 玩家自身 + 观战他的观察者（对齐过 CP 时 onPlayerReachCp 的同步口径——否则
  // 观战者右上角停在回退前的高进度，直到下次过 CP 才被拉回）
  const cpDone = (target.cumIdx % len) + 1;
  const cpText = `C  P / ~p~${cpDone}~w~/~y~${len}`;
  const raceTds = room.raceTextTds.get(player.id);
  if (raceTds && raceTds.cp.isValid()) {
    raceTds.cp.setString(cpText);
  }
  for (const oid of getObserverIdsOf(player.id)) {
    const ot = room.raceTextTds.get(oid);
    if (ot && ot.cp.isValid()) {
      ot.cp.setString(cpText);
    }
  }
  // 录制会话的 cpProgress 同步回退：否则回放帧残留回退前的高进度，C P TD 与
  // seek 显示玩家实际未跑到的进度（对齐过 CP 时的 noteCpProgress 口径）
  noteCpProgress(player.id, Math.min(cpDone, len), len);
}

/** 比赛中重生回上一 CP（/kill 与快捷操作共用；车就位 + 放回车里） */
export function respawnToLastCp(
  player: Player,
  pr: PlayerRace,
  room: RaceRoom,
  rollback?: number,
): void {
  const target = computeTargetCp(pr, room, rollback);
  if (!target.prev) return;
  respawnToCpCore(player, room, target);
  applyRollbackState(player, pr, target);
  writeBackRollbackProgress(player, pr, room, target, rollback);
  sysMsg(player, "race", `已重生回${rollback ? `前 ${rollback + 1} 个` : "上一个"}检查点`, "info");
}

/** 多回退一格重生（面板「回退到更早检查点」）：上一 CP 可能是空中/无落点（无 spawnpos、
 * colandreas 抬不动），重生会落空/卡空——回退到更早一个 CP，并恢复该 CP 触达后的状态
 * （cveh 车型 / time / weather，回放式状态回撤）。 */
export function rollbackToPrevCp(player: Player, pr: PlayerRace, room: RaceRoom): void {
  // 已触达累计序号 < 1（起点 / 刚过第一个 CP / 第一圈未过任何 CP）→ 没有更早的
  // 不同 CP 可回退（回退会 clamp 到同一目标）。跨圈后 cpIndex=-1 但累计序号
  // lap×len-1 ≥ len-1，回退目标 = 上一圈末 CP 的前一个，有效。
  if (pr.lap * room.cps.length + pr.cpIndex < 1) {
    sysMsg(player, "race", "当前进度没有更早的检查点可回退", "error");
    return;
  }
  respawnToLastCp(player, pr, room, 1);
}
