import {
  Dialog,
  DialogStylesEnum,
  GameText,
  Player,
  PlayerEvent,
  PlayerStateEnum,
  RaceCheckpoint,
  RaceCpEvent,
  VehicleEvent,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle, spawnVehicle, destroyPlayerVehicle } from "@/vehicles";
import {
  execCpScript,
  cleanupScriptVehicle,
  getSuperStartKmh,
  getFirstCpEnv,
  setVehicleSpeed,
  KMH_UNIT,
  type CpScriptContext,
} from "./scripts";
import { isEditing, exitEdit } from "./editor";
import { cleanupAttireEditing } from "@/attire";
import {
  applyRaceNoCollision,
  restorePersonalNoCollision,
  getDefaultRaceModel,
  getFirstCpStartAngle,
} from "./vehicle";
import { setIntervalSafe, setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";
import {
  raceRecordingStart,
  raceRecordingStop,
  stopReplayForPlayer,
  discardRaceReplay,
} from "@/replay";
import {
  noteCpProgress,
  noteRank,
  stopRecording,
  isRecording,
  getRecording,
  suspendRecording,
  dropRecording,
  markRaceFinished,
  saveRaceReplay,
  type RecordingSession,
} from "@/replay/recorder";
import {
  setObserveScopeProvider,
  startObservePlayer,
  stopObserve,
  isObserving,
  getObserverIdsOf,
  getObserveTarget,
  detachObserversOfPlayer,
} from "@/core/observe";
import { getWorldWeather, snapshotPersonalTime } from "@/core/worldenv";
import { getCachedSettingByUserId } from "@/personalize/settings";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { formatTime, formatRaceTimeCs } from "@/utils/format";
import { sysMsg } from "@/utils/msg";
import { playCountdown, cancelCountdownFx } from "@/interface/countdownFx";
import {
  showNextCheckpoint,
  syncCpToObservers,
  clearSpectatorCpForMember,
  clearRaceMapIcons,
  cleanupSpectatorCpForRoom,
  initCpArrowSync,
} from "./cpArrow";
import {
  createRaceTd,
  updateBestTd,
  setRaceTdText,
  rankSuffix,
  destroyRaceTds,
  syncRaceTds,
  formatLimitCountdown,
  TIME_COLOR_NORMAL,
} from "./raceTd";
import { respawnToLastCp, respawnPlayerToCp } from "./respawn";
import {
  cleanupExpiredReconnects,
  checkRoomState,
  restorePlayerAfterRace,
  restoreSpectatorAfterRace,
} from "./reconnect";
import {
  rooms,
  playerRaces,
  isInRace,
  isRacer,
  isSpectator,
  getRacePlayerState,
  getRaceRoom,
  getRacers,
  getSpectators,
  countRacers,
  broadcastToRoom,
  allocRaceWorld,
  freeRaceWorld,
} from "./state";
import { parseLevelData, tierForTime, formatLevelSummary, TIER_LABELS } from "./level";
import { loadRaceOnlyObjects, unloadRaceOnlyObjects } from "@/house";
import { showDialog } from "@/utils/dialog";
import type { PlayerRace, RaceRoom, RaceRole } from "./types";

/**
 * 比赛状态机（房间生命周期/进度推进/排名结算）——模块拆分后只承载状态**写**路径：
 * - 单例状态与只读 getter：./state.ts（含房间 Map / 世界 id / 广播）
 * - 类型定义：./types.ts
 * - 断线重连 / 房间销毁判定 / 世界恢复：./reconnect.ts（cleanupRacePlayer /
 *   tryReconnectRace / checkRoomState，本文件在成员离开/掉线路径调用）
 * - 重生/回退（死亡 / /kill / 面板回退）：./respawn.ts
 * - 比赛信息 TD（创建/刷新/销毁）：./raceTd.ts
 * - 观战者 CP 箭头同步：./cpArrow.ts
 * 对外保持原导入面（barrel 重新导出），外部模块无感知。
 */

/** 第一名完成后的结束宽限时长（毫秒） */
const END_GRACE_MS = 20_000;

/**
 * 比赛中允许的主命令白名单（对齐原版 GP:545-622）：
 * /r(race) 比赛管理 · /pm 私聊 · /kill 重生 · /tv(ob/spec) 观战 · /p(panel) 万能面板
 * 匹配的是主命令（strictMainCmd），如 "/r l" 的主命令是 "r"。
 * 其余命令一律拒绝。
 * p/panel 必须在白名单内：观战（spect）模式下客户端不发按键收不到 Y 键，
 * 只能靠 /p 开面板——比赛结束自动观战的玩家若不放行 /p 将彻底打不开面板。
 */
const RACE_SAFE_COMMANDS = new Set([
  "r",
  "race",
  "pm",
  "kill",
  "tv",
  "ob",
  "spec",
  "p",
  "panel",
  "f",
]);

export function isRaceCommandAllowed(command: string): boolean {
  return RACE_SAFE_COMMANDS.has(command);
}

let nextRoomId = 1;
/** 挂机检测参数（对齐原版 AFKTimes：静止累计超时移出比赛，防占坑不跑） */
const AFK_IDLE_MS = 45_000; // 静止累计超 45s 移出比赛
const AFK_WARN_MS = 30_000; // 静止累计超 30s 提示一次
/** 200ms 内位移 < 0.1（≈0.5m/s）判静止——比原版 0.001/s 宽松：防撞墙顶油门/
 *  被车流堵塞缓慢蠕动的活跃玩家被误判挂机（原版阈值过严曾被投诉误封） */
const AFK_MOVE_EPS = 0.1;
const AFK_TICK_MS = 200; // 与 tickRooms 周期一致（每 tick 固定累计）

/**
 * 随机抽一张启用赛道（有 CP 的）。无可用返回 null。
 * 用 count + skip 均匀随机（findFirst orderBy 稳定 + 随机偏移）。
 */
async function pickRandomRace(): Promise<{
  id: string;
  name: string;
  laps: number | null;
  isEnabled: boolean;
  deletedAt: Date | null;
  levelData: string | null;
  failedScoreFix: number;
  sysUser: { username: string } | null;
} | null> {
  const count = await prisma.race.count({
    where: { isEnabled: true, deletedAt: null, raceCps: { some: {} } },
  });
  if (count === 0) return null;
  const skip = Math.floor(Math.random() * count);
  const race = await prisma.race.findFirst({
    where: { isEnabled: true, deletedAt: null, raceCps: { some: {} } },
    skip,
    include: { sysUser: true },
  });
  return race;
}

/** 创建比赛房间并加入。raceId 为空 → 随机抽一张赛道（全部随机）。 */
export async function createRaceRoom(
  player: Player,
  raceId: string | null,
): Promise<RaceRoom | null> {
  if (isInRace(player.id)) {
    sysMsg(player, "race", "你已在比赛中", "error");
    return null;
  }
  // 编辑模式（/redit 赛道编辑器）中禁止进比赛：编辑器脚本车/CP 状态与比赛
  // 房间冲突，否则会卡在第一 CP 无法推进、编辑器车残留在世界
  if (isEditing(player.id)) {
    sysMsg(player, "race", "赛道编辑中不能创建比赛，先 /redit 退出编辑", "error");
    return null;
  }
  // 随机模式：抽到 <2 CP 的无效赛道最多重试 3 次（指定模式只查一次，失败即报错）
  const maxAttempts = raceId ? 1 : 3;
  let race: {
    id: string;
    name: string;
    laps: number | null;
    isEnabled: boolean;
    deletedAt: Date | null;
    levelData: string | null;
    failedScoreFix: number;
    sysUser: { username: string } | null;
  } | null = null;
  let cps: {
    index: number;
    id: string;
    x: unknown;
    y: unknown;
    z: unknown;
    angle: unknown;
    size: unknown;
    raceCpScripts: { script: string }[];
  }[] = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    race = raceId
      ? await prisma.race.findUnique({
          where: { id: raceId },
          include: { sysUser: true },
        })
      : await pickRandomRace();
    if (!race || !race.isEnabled || race.deletedAt) {
      if (raceId) {
        sysMsg(player, "race", "赛道不存在或未启用", "error");
        return null;
      }
      race = null;
      continue; // 随机没抽到 → 重试
    }
    cps = await prisma.raceCp.findMany({
      where: { raceId: race.id },
      orderBy: { index: "asc" },
      include: { raceCpScripts: { orderBy: { index: "asc" } } },
    });
    if (cps.length >= 2) break;
    race = null; // 无效赛道（<2 CP）
    if (raceId) {
      sysMsg(player, "race", "该赛道至少需要 2 个检查点", "error");
      return null;
    }
  }
  if (!race) {
    sysMsg(player, "race", "暂无可用赛道", "error");
    return null;
  }
  const room: RaceRoom = {
    id: nextRoomId++,
    raceId: race.id,
    raceName: race.name,
    authorName: race.sysUser?.username ?? "未知",
    laps: Math.max(1, race.laps ?? 1),
    worldId: allocRaceWorld(),
    ownerId: player.id,
    ownerUserId: getAuthState(player.id)?.userId ?? "",
    roleSwitches: new Set(),
    state: "WAITING",
    members: new Map(),
    cps: cps.map((c) => ({
      index: c.index,
      id: c.id,
      x: Number(c.x),
      y: Number(c.y),
      z: Number(c.z),
      angle: Number(c.angle),
      size: Number(c.size),
      scripts: c.raceCpScripts.map((s) => s.script),
    })),
    results: [],
    afk: new Map(),
    lastPositions: new Map(),
    raceTextTds: new Map(),
    tdTextCache: new Map(),
    bestTimes: new Map(),
    resultIndex: new Map(),
    createdAt: Date.now(),
    reconnectUntil: new Map(),
    reconnectSlots: new Map(),
    raceMembersLast: new Map(),
    // 房间统一时间天气：beginRace 时按房主设置填充
    roomTime: { hour: 12, minute: 0 },
    roomWeather: 0,
    // 挑战等级：默认未选（WAITING 阶段房主可选；选后存 challengeTierSeconds）
    challengeLevelData: race.levelData,
    challengeTierSeconds: 0,
    failedScoreFix: race.failedScoreFix ?? 0,
  };
  rooms.set(room.id, room);
  // 先加载赛道专属对象（raceOnly house），再让房主落位：保持"车落在对象平台上"
  // 的原有顺序。加载/房主入场期间用 -1 哨兵锁住入场（房主 join 内部绕过自己的
  // 哨兵），防止别人抢在房主前入房导致房主被 roleSwitches 拒绝。
  room.roleSwitches.add(-1);
  try {
    // 赛道专属对象（raceOnly house）：加载到本房间世界（玩该赛道才显示对象）
    await loadRaceOnlyObjects(room.raceId, room.worldId);
    if (rooms.get(room.id) !== room) return null;
    await joinRoom(player, room, { bypassRoleLock: true });
  } finally {
    room.roleSwitches.delete(-1);
  }
  if (!isInRace(player.id) || rooms.get(room.id) !== room) {
    checkRoomState(room);
    return null;
  }
  sysMsg(
    player,
    "race",
    `比赛房间已创建，赛道「${race.name}」（${room.laps} 圈），输入 /r j 参赛、/r ob 进观众席`,
    "success",
  );
  return room;
}

/**
 * 房主更换房间赛道（WAITING 阶段，开赛后锁定）。
 * raceId 为空 → 随机换一张（全部随机）。
 * 更新房间赛道数据 + 重定位所有成员（起点 + TD 刷新 + CP 箭头重建）。
 */
export async function changeRoomTrack(player: Player, raceId?: string): Promise<boolean> {
  const pr = getRacePlayerState(player.id);
  const room = pr ? getRaceRoom(pr.roomId) : undefined;
  if (!room) {
    sysMsg(player, "race", "你不在比赛房间中", "error");
    return false;
  }
  if (room.ownerId !== player.id) {
    sysMsg(player, "race", "只有房主能更换赛道", "error");
    return false;
  }
  if (room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始，不能更换赛道", "warn");
    return false;
  }
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候再换赛道", "warn");
    return false;
  }
  // 换赛道全程（含 DB/对象加载 await）锁身份与开赛：期间 startRace/切身份/入场
  // 全部拒绝，避免"新 CP 已替换、人还没重定位"的半成品状态
  room.roleSwitches.add(player.id);
  try {
    const race = raceId
      ? await prisma.race.findUnique({ where: { id: raceId }, include: { sysUser: true } })
      : await pickRandomRace();
    if (!race || !race.isEnabled || race.deletedAt) {
      sysMsg(player, "race", "赛道不存在或未启用", "error");
      return false;
    }
    // await 期间房间可能已被 /r s 开赛（倒计时/开跑）→ 二次校验，防在 COUNTDOWN/
    // RACING 中静默替换赛道（换赛道对话框期间房主可同时 /r s）
    if (room.state !== "WAITING" || rooms.get(room.id) !== room) {
      sysMsg(player, "race", "比赛已开始，不能更换赛道", "warn");
      return false;
    }
    const cps = await prisma.raceCp.findMany({
      where: { raceId: race.id },
      orderBy: { index: "asc" },
      include: { raceCpScripts: { orderBy: { index: "asc" } } },
    });
    if (cps.length < 2) {
      sysMsg(player, "race", "该赛道至少需要 2 个检查点", "error");
      return false;
    }
    // 更新房间赛道数据（开赛前的等待阶段，成员进度均为 0）
    room.raceId = race.id;
    room.raceName = race.name;
    room.authorName = race.sysUser?.username ?? "未知";
    room.laps = Math.max(1, race.laps ?? 1);
    room.cps = cps.map((c) => ({
      index: c.index,
      id: c.id,
      x: Number(c.x),
      y: Number(c.y),
      z: Number(c.z),
      angle: Number(c.angle),
      size: Number(c.size),
      scripts: c.raceCpScripts.map((s) => s.script),
    }));
    room.bestTimes.clear(); // 新赛道 BEST 缓存失效（重查）
    room.afk.clear(); // 新赛道：清挂机记录
    room.lastPositions.clear(); // 掉线快照缓存随新赛道失效
    // 换赛道：挑战等级/失败扣分随旧赛道失效（新赛道需重新选择）
    room.challengeLevelData = race.levelData;
    room.challengeTierSeconds = 0;
    room.failedScoreFix = race.failedScoreFix ?? 0;
    // 换赛道：卸载旧赛道专属对象（按本房间世界）+ 加载新赛道对象（世界不变）
    unloadRaceOnlyObjects(room.worldId);
    await loadRaceOnlyObjects(race.id, room.worldId);
    // await 加载期间房间可能已被销毁（全员离开 → checkRoomState 回收世界 id）：
    // 此时对象已由 load 续体自查销毁，续体不得再操作已销毁的 room
    if (rooms.get(room.id) !== room || room.state !== "WAITING") return false;
    // 重置 WAITING 超时基准（对齐 restartRace）：换赛道后若房间已临近 10 分钟
    // 等待上限，不清 createdAt 会被 tickRooms 立即解散
    room.createdAt = Date.now();
    // 重定位参赛者：进度重置 + 起点 + TD 刷新 + CP 箭头重建；观众席不重定位
    for (const m of room.members.values()) {
      if (rooms.get(room.id) !== room) return false;
      const mp = playerRaces.get(m.id);
      if (!mp || mp.role !== "racer") continue;
      // 换赛道要 putPlayerIn 重定位：观战中的参赛者先退出观战，否则入座失败、
      // 开赛时人车分离（观众席保持观战，镜头跟着被观战的参赛者）
      if (isObserving(m.id)) stopObserve(m);
      mp.cpIndex = -1;
      mp.lap = 0;
      mp.startTime = 0;
      mp.finished = false;
      mp.cpSnapshots = []; // 换赛道：清空旧赛道的回退快照（防按旧赛道车型/time/weather 回撤）
      await positionPlayerAtStart(m, room);
    }
    // 观众席兜底：换赛道后若不再观战（目标失效等），自动看一个参赛者
    for (const s of getSpectators(room)) {
      if (!s.isConnected() || isObserving(s.id)) continue;
      autoObserveRacer(s, room);
    }
    if (rooms.get(room.id) !== room) return false;
    broadcastToRoom(room, `房主将赛道更换为「${race.name}」，参赛者已移至起点（观众席保留）`);
    return true;
  } finally {
    room.roleSwitches.delete(player.id);
  }
}

/**
 * 房主重开当前赛道比赛（同一赛道重置回 WAITING）：
 * 中断进行中的比赛（清倒计时/结束定时器 + 排名/进度数据），所有成员回起点 +
 * 进度清零（含退出观战），房主再 /r s 或面板「开始比赛」重新开局。
 * 适用：单人房间跑一半想重来 / 倒计时中反悔 / 成员乱跑想重置。
 * 注：比赛结束（FINISHED）时房间已销毁（endRoom），重开需重新创建房间。
 */
export async function restartRace(player: Player): Promise<void> {
  const pr = getRacePlayerState(player.id);
  const room = pr ? getRaceRoom(pr.roomId) : undefined;
  if (!room) {
    sysMsg(player, "race", "你不在比赛房间中", "error");
    return;
  }
  if (room.ownerId !== player.id) {
    sysMsg(player, "race", "只有房主能重开比赛", "error");
    return;
  }
  if (room.state === "FINISHED") {
    sysMsg(player, "race", "比赛已结束（房间已解散），请重新创建比赛", "error");
    return;
  }
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候再重开", "warn");
    return;
  }
  // 重开涉及全房参赛者异步重定位：期间禁止切身份/开赛（复用 roleSwitches 门闩）
  room.roleSwitches.add(player.id);
  try {
    // 中断进行中的比赛（倒计时动画/结束宽限定时器清理）。endTimer 必须置回
    // undefined：重开是同一 room 对象，否则新一场第一名冲线时 `!room.endTimer`
    // 门控（finishPlayer）永远 false → 宽限永不挂载、房间卡 RACING
    for (const m of room.members.values()) cancelCountdownFx(m.id);
    if (room.endTimer) {
      clearTimeoutSafe(room.endTimer);
      room.endTimer = undefined;
    }
    const wasRunning = room.state === "RACING" || room.state === "COUNTDOWN";
    room.state = "WAITING";
    // 本场是否已有完成者：有人冲线（results 非空）→ 未完成成员的录像应按"有人
    // 完成保留未完成段"落盘保留，不能 discard（与 checkRoomState 的 someoneFinished
    // 分支一致）；无人完成才作废（重开是新一场，旧段无成绩价值）
    const someoneFinished = room.results.length > 0;
    // 重置 WAITING 超时基准：createdAt 是建房时刻，重开不清会被 tickRooms 的
    // "等待超时 10 分钟解散"立即命中（建房到重开累计超过 10 分钟的长赛道常见）
    room.createdAt = Date.now();
    // 清空排名/CP 进度数据（重开后从零开始）
    room.results = [];
    room.resultIndex.clear();
    // 清空掉线重连窗口：重开是新一场比赛，旧赛的窗口/进度快照不能带进新赛
    //（否则窗口玩家重连会用旧赛进度恢复——CP/排名/计时全错）
    room.reconnectUntil.clear();
    room.reconnectSlots.clear();
    room.afk.clear(); // 重开是新比赛：清挂机记录
    room.lastPositions.clear(); // 掉线快照缓存随新比赛失效
    // 清掉重连窗口后可能一个在线参赛者都不剩（只剩观众）——不能留下全观众
    // 房间：直接解散并遣返观众（owner 是观众也走这里）
    if (countRacers(room) === 0) {
      broadcastToRoom(room, "没有参赛者，比赛房间已解散");
      checkRoomState(room);
      return;
    }
    // 参赛者重置：退出观战（防 putPlayerIn 无效）+ 进度清零 + 回起点 + TD/CP 重建；
    // 观众席保持观战（镜头跟着被观战的参赛者），重开后角色锁解除（WAITING）
    for (const m of room.members.values()) {
      if (rooms.get(room.id) !== room) return;
      const mp = playerRaces.get(m.id);
      if (!mp || mp.role !== "racer") continue;
      if (isObserving(m.id)) stopObserve(m);
      mp.cpIndex = -1;
      mp.lap = 0;
      mp.startTime = 0;
      mp.finished = false;
      mp.cpSnapshots = []; // 重开比赛：清空上一场的回退快照（防按旧场车型/time/weather 回撤）
      await positionPlayerAtStart(m, room);
    }
    // 观众席兜底：目标失效/未在观战时自动看一个参赛者
    for (const s of getSpectators(room)) {
      if (!s.isConnected() || isObserving(s.id)) continue;
      autoObserveRacer(s, room);
    }
    if (rooms.get(room.id) !== room) return;
    if (someoneFinished) {
      // 本场已有人完成：整场合并落盘（多轨道一个文件）保留，下一场重新开录。
      // mergeRoomReplays 会收集在线成员 + 挂起掉线成员的会话（含下方未处理的
      // 挂起 pid），成功后清会话；失败则保留由新一场的 raceRecordingStart 兜底
      void mergeRoomReplays(room, []);
    } else {
      // 无人完成：作废本段（discard 原子落盘即删文件不建 DB 记录），下一场
      // 开赛（beginRace）重新开始录制，两场成绩互不混入。观众席没有录制。
      for (const m of getRacers(room)) {
        void stopRecording(m.id, { quiet: true, discard: true });
      }
    }
    // 挂起中的掉线会话（掉线未重连）跨场处理：无人完成则丢弃（静止段无续录意义）；
    // 已有人完成则**不在此处理**（mergeRoomReplays 已收集合并，此处跳过防重复落盘）。
    // 归属校验：断线玩家 playerId 可能被复用开了别的房间录制，不能误停/误丢
    for (const pid of room.raceMembersLast.keys()) {
      if (!playerRaces.has(pid) && isRecording(pid)) {
        const rec = getRecording(pid);
        if (!rec || !rec.raceRoomId || rec.raceRoomId === room.id) {
          if (!someoneFinished) {
            dropRecording(pid);
          }
        }
      }
    }
    // 本场无人完成：已落盘的未完成段（掉线已落盘/上一轮重开落盘的旧段）同样作废
    //——重开是新一场，旧段无成绩价值，不能随下一场有人完成而永久保留。只处理
    // 内存中已无会话的 pid（挂起会话上面已 drop；在房成员的段落盘时 discard 原子
    // 删除无 DB 行，这里按 userId 快照作废命中不了），discardRaceReplay 按
    // userId+raceId+raceRoomId+rank=null 精确匹配旧段，不伤新一场的录制
    if (!someoneFinished) {
      for (const pid of room.raceMembersLast.keys()) {
        if (!isRecording(pid)) {
          discardRaceReplay(pid, room.raceId, room.raceMembersLast.get(pid), room.id);
        }
      }
    }
    if (wasRunning) {
      broadcastToRoom(
        room,
        `房主重开了比赛（赛道不变「${room.raceName}」），参赛者已回到起点（观众席保留）`,
      );
    } else {
      sysMsg(player, "race", `已重置比赛（赛道 ${room.raceName}），参赛者已回到起点`, "info");
    }
    sysMsg(player, "race", "输入 /r s 或面板「开始比赛」重新开局", "info");
  } finally {
    room.roleSwitches.delete(player.id);
  }
}

/** 找一个等待中的房间（roomUi 命令层 /r j 加入用；无则 undefined） */
export function findWaitingRoom(): RaceRoom | undefined {
  for (const room of rooms.values()) {
    if (room.state === "WAITING") return room;
  }
  return undefined;
}

export async function joinRoom(
  player: Player,
  room: RaceRoom,
  opts?: { role?: RaceRole; bypassRoleLock?: boolean },
): Promise<void> {
  const role: RaceRole = opts?.role ?? "racer";
  // 已参与其他房间则先离开（防止 playerRaces 被覆盖、旧房间残留成员）
  if (isInRace(player.id)) {
    leaveRace(player);
  }
  // 赛道编辑中进比赛：编辑器脚本车/CP 状态与比赛冲突，且 onPlayerReachCp 对
  // isEditing 玩家跳过——不退出编辑会卡在第一 CP 无法推进。createRaceRoom 直接
  // 拦截，joinRoom（/r j）在这里主动退出编辑（对齐"进比赛清理活动状态"语义）
  if (isEditing(player.id)) {
    exitEdit(player.id);
  }
  // 进比赛：停止玩家正在播放的回放 + 影子挑战（比赛中 /rp 被白名单拦截无法
  // 主动停，挑战世界与比赛世界隔离——不清理会留下挂机 ghost）
  stopReplayForPlayer(player.id);
  // 装扮编辑中进比赛：退出编辑（挂件/微调轮询/dialog 全部清掉，对齐上述活动
  // 状态清理；不还原——进比赛本就要按比赛流程处理车辆）
  cleanupAttireEditing(player.id);
  // 观战中进比赛：退出观战（spectating 状态下 putPlayerIn/切世界均无效，
  // 否则整场比赛只能旁观无法开车，录制也采不到有效帧）
  if (isObserving(player.id)) {
    stopObserve(player);
  }
  // 进房前的世界/位置：观众退出时恢复；racer→观众时车停回这里
  const prevWorld = player.getVirtualWorld();
  const prevPos = player.getPos();
  const prevAngle = player.getFacingAngle().angle;
  // 进比赛：快照个人时间（个人时间流逝进度——比赛期间房间统一时间覆盖 + 1s
  // 定时器三态跳过不推进，出赛道按快照延续，否则跳回设定时刻重新流逝）。
  // 必须 await：玩家"进→立即退出"时，leaveRace 的恢复会抢在快照写入前执行，
  // 快照丢失则无法延续进度（恢复从当前时间续而非进赛道前的进度）
  await snapshotPersonalTime(player);
  // await 期间可能断线（snapshotPersonalTime 内部 await getSetting）——断线玩家的
  // cleanupRacePlayer 已跑（此时还没注册，无操作），若继续注册会成 zombie 成员
  //（tickRooms 每 200ms 对其 getPos、finish/endRoom 计为未完成者）
  if (!player.isConnected()) return;
  // await 期间房主可能已经开赛/房间被销毁：开赛后不允许再加入（观战身份也锁死）
  if (rooms.get(room.id) !== room || room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始或房间已解散，无法加入", "warn");
    return;
  }
  // 房间正在切身份/重开/换赛道重定位：先拒绝入场，避免并发 putPlayerIn/重复 TD。
  // 创建房间的房主入场用 bypassRoleLock：此时只有创建流程自己加的 -1 哨兵，
  // 不能把房主拦在门外。
  if (!opts?.bypassRoleLock && room.roleSwitches.size > 0) {
    sysMsg(player, "race", "房间正在调整身份/赛道，请稍后再加入", "warn");
    return;
  }
  // 观众不能加入一个没有参赛者的房间（否则房间只剩观众，无法开赛）
  if (role === "spectator" && countRacers(room) === 0) {
    sysMsg(player, "race", "房间没有参赛者，无法加入观众席", "warn");
    return;
  }
  room.members.set(player.id, player);
  playerRaces.set(player.id, {
    roomId: room.id,
    role,
    cpIndex: -1,
    lap: 0,
    startTime: 0,
    finished: false,
    prevWorld,
    prevPos,
    prevAngle,
    cpSnapshots: [],
  });
  if (role === "racer") {
    room.raceMembersLast.set(player.id, getAuthState(player.id)?.userId ?? ""); // 登记本场录制成员（房间销毁作废用，userId 供离线作废）
    // 入场定位是 async（刷车查库）：期间 startRace 必须等定位完成，否则倒计时
    // 开始后车还没摆好（复用 roleSwitches 作为"身份/入场变更中"门闩）
    room.roleSwitches.add(player.id);
    try {
      await positionPlayerAtStart(player, room);
    } finally {
      room.roleSwitches.delete(player.id);
    }
    // await 刷车期间玩家可能 /r l 离开或断线、房间可能被销毁——续体不能再把
    // 已离房玩家的世界拉回房间/发加入提示
    if (!player.isConnected() || !isInRace(player.id) || rooms.get(room.id) !== room) {
      return;
    }
    // 加入即切到房间世界（等待期/倒计时都在房间世界活动，发车不再临时切）。
    // beginRace 的 setVirtualWorld 幂等（已在房间世界则无操作）。
    player.setVirtualWorld(room.worldId);
    if (player.isInAnyVehicle()) {
      player.getVehicle()!.setVirtualWorld(room.worldId);
    }
    const owned = getOwnedVehicle(player.id);
    if (owned && owned.isValid() && owned !== player.getVehicle()) {
      owned.setVirtualWorld(room.worldId); // 爱车一并切（防留在原世界成幽灵车）
    }
  } else {
    // 观众席：不刷比赛车、不 putPlayerIn；人下车、车留在原世界（不干扰赛道），
    // 只把玩家切到房间世界并自动观战第一个参赛者
    if (player.isInAnyVehicle()) {
      try {
        player.removeFromVehicle();
      } catch {
        /* 已不在车里 */
      }
    }
    player.setVirtualWorld(room.worldId);
    autoObserveRacer(player, room);
  }
  // 提示：房主（创建者）不需要"等待房主开始"；无车兜底说明已刷默认比赛车
  const noCarHint =
    role === "racer" && !getOwnedVehicle(player.id)
      ? "（无车已自动刷默认比赛车，可用 /c 换爱车）"
      : "";
  if (role === "spectator") {
    sysMsg(
      player,
      "race",
      `你加入了比赛房间（赛道 ${room.raceName}）的观众席，等待房主开始（/r race 可回到比赛）`,
      "success",
    );
    return;
  }
  if (room.ownerId === player.id) {
    sysMsg(
      player,
      "race",
      `你加入了比赛房间（赛道 ${room.raceName}），输入 /r s 开始比赛${noCarHint}`,
      "success",
    );
  } else {
    sysMsg(
      player,
      "race",
      `你加入了比赛房间（赛道 ${room.raceName}），等待房主开始${noCarHint}`,
      "info",
    );
  }
}

/**
 * 定位玩家到赛道起点（第一 CP）+ 创建比赛信息 UI。
 * 目标车型 = 第一 CP 的 cveh 脚本车型（赛道标准车，如无则维持玩家当前爱车）：
 * 进赛道即以该车为标准——玩家有该模型爱车则直接开进来，没有则自动创建成爱车
 * （懒创建，对齐"没这个模型的爱车就为它创建一辆"）。第一 CP 触碰时不再临时换车。
 * joinRoom（加入）与 changeRoomTrack（换赛道）共用。
 */
async function positionPlayerAtStart(player: Player, room: RaceRoom): Promise<void> {
  // 防御：观众没有比赛车，任何路径都不应把观众放到起点（会导致幽灵车/干扰赛道）
  if (!isRacer(player.id)) return;
  const first = room.cps[0];
  if (!first) return;
  // 起点朝向校正：作者放置 CP1 时的 getFacingAngle 可能滞后/放歪，导致车头朝向
  // 与赛道走向不符——用 CP1→CP2 方向算理论朝向，偏差过大时覆盖并提示
  const startAngle = getFirstCpStartAngle(room.cps);
  if (startAngle.corrected) {
    sysMsg(
      player,
      "race",
      `起点朝向与赛道走向不符，已按走向校正车头（${first.angle.toFixed(0)}° → ${startAngle.angle.toFixed(0)}°）`,
      "warn",
    );
  }
  // 换赛道时该成员已有旧赛道 TD → 先销毁重建（joinRoom 无旧 TD，天然跳过）
  const oldTds = room.raceTextTds.get(player.id);
  if (oldTds) {
    for (const td of Object.values(oldTds)) {
      if (td.isValid()) td.destroy();
    }
    room.raceTextTds.delete(player.id);
    room.tdTextCache.delete(player.id);
  }
  const defaultModel = getDefaultRaceModel(room.cps);
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    // 有爱车：模型 = 赛道标准车型 → 直接用；模型不同 → 重刷成标准车型爱车
    // （销毁旧车 + 懒创建，玩家始终以标准车参赛）
    if (owned.getModel() !== defaultModel) {
      await spawnVehicle(player, defaultModel, true);
      sysMsg(player, "race", `本赛道标准车型为 ${defaultModel}，已切换为对应爱车`, "info");
    }
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(startAngle.angle);
      veh.putPlayerIn(player, 0);
      player.setFacingAngle(startAngle.angle); // putPlayerIn 后视角跟随车辆朝向的兜底
    }
  } else if (player.isInAnyVehicle()) {
    // 没爱车但人在某辆车里：若是标准车型 → 挪当前车；否则也以标准车型刷爱车
    const veh = player.getVehicle()!;
    if (veh.getModel() === defaultModel) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(startAngle.angle);
      player.setFacingAngle(startAngle.angle); // 车内旋转车辆后玩家朝向同步（防视角没跟上）
    } else {
      await spawnVehicle(player, defaultModel, true);
      sysMsg(player, "race", `本赛道标准车型为 ${defaultModel}，已刷为对应爱车`, "info");
      const v = getOwnedVehicle(player.id);
      if (v && v.isValid()) {
        v.setPos(first.x, first.y, first.z);
        v.setZAngle(startAngle.angle);
        player.setFacingAngle(startAngle.angle);
      }
    }
  } else {
    // 都没 → 用标准车型刷爱车（有该模型爱车则复用外观，没有则自动创建
    // 成爱车——玩家始终用自己的爱车比赛），原地放入
    await spawnVehicle(player, defaultModel, true);
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(startAngle.angle);
      player.setFacingAngle(startAngle.angle);
    }
  }
  // await spawnVehicle 期间玩家可能已离开（/r l）/断线、房间可能已被销毁
  //（checkRoomState）——续体不校验会创建孤儿 TD（set 进已销毁的 room、show 在
  // 已非成员的玩家屏幕，leaveRace 已跑过拿不到这个新 TD）
  if (!isInRace(player.id) || rooms.get(room.id) !== room) return;
  // 创建比赛信息 UI（加入房间即显示，对齐原版 Race_Game_Join → CreatePRaceTextDraw；
  // 倒计时/开赛不再重建；换赛道时需先销毁旧的再重建）
  const tds = createRaceTd(player, room);
  void updateBestTd(player, room, tds);
  // 显示第一个 CP（红色箭头指向第二个；open.mp 切换世界不改变坐标，
  // 开赛切到比赛世界后仍站在同一位置，beginRace 的 setPos 幂等保留）
  showNextCheckpoint(player, room.cps, -1);
  // 加入/换赛道时同步观战者的起点 CP 箭头（观察者跟着看到起点）
  syncCpToObservers(room, player, -1);
}

/** 房间销毁/选手离开时，把不在本房的外部观战者退出观战（恢复各自世界）：
 *  否则房间世界被回收/选手切回原世界后，外部观战者会卡在失效世界或继续盯着
 *  已换世界的目标。本房成员（racer/spectator）由各自角色恢复逻辑处理。 */
function detachExternalObservers(targetId: number): void {
  detachObserversOfPlayer(targetId, (oid) => playerRaces.has(oid));
}

/** 等待/倒计时阶段把参赛者放回起点并正常重生（面板/快捷操作/ /kill 共用）。
 *  直接 player.spawn() 会用主世界 spawnInfo 定位到错误坐标，必须先按起点摆车。 */
export async function respawnAtRoomStart(player: Player): Promise<void> {
  const pr = getRacePlayerState(player.id);
  const room = pr ? getRaceRoom(pr.roomId) : undefined;
  if (!pr || !room || pr.role !== "racer" || pr.finished) return;
  if (room.state !== "WAITING" && room.state !== "COUNTDOWN") return;
  if (room.roleSwitches.size > 0) return; // 房间正在切身份/重开/换图
  const first = room.cps[0];
  if (!first) return;
  room.roleSwitches.add(player.id); // 重定位期间禁止并发开赛
  try {
    if (isObserving(player.id)) stopObserve(player);
    // 先把 spawnInfo 指到起点再 spawn，否则 player.spawn() 会按主世界旧 spawnInfo
    // 出生（人车分离/被传去地图另一端）；之后 positionPlayerAtStart 负责摆车+TD/CP。
    const startAngle = getFirstCpStartAngle(room.cps).angle;
    player.setSpawnInfo(
      0,
      player.getSkin(),
      first.x,
      first.y,
      first.z,
      startAngle,
      0,
      0,
      0,
      0,
      0,
      0,
    );
    player.spawn();
    if (!player.isConnected() || !isInRace(player.id) || rooms.get(room.id) !== room) {
      return;
    }
    sysMsg(player, "race", "比赛尚未开始，已回到起点", "info");
    await positionPlayerAtStart(player, room);
  } finally {
    room.roleSwitches.delete(player.id);
  }
}

/** 销毁单个成员的比赛信息 TD（racer→观众时清屏；房间销毁走 destroyRaceTds） */
function destroyMemberRaceTd(room: RaceRoom, playerId: number): void {
  const tds = room.raceTextTds.get(playerId);
  if (tds) {
    for (const td of Object.values(tds)) {
      if (td.isValid()) td.destroy();
    }
    room.raceTextTds.delete(playerId);
  }
  room.tdTextCache.delete(playerId);
}

/** 让观察者自动观战一个可观的参赛者（未完赛优先；跳过正在观战/无效目标）。
 *  返回是否成功挂上镜头——观众席入席/目标失效重挂都走这里，避免第一个候选
 *  恰好也在观战（/tv 会拒绝）时观众停在"无镜头"状态。 */
function autoObserveRacer(observer: Player, room: RaceRoom, excludeId?: number): boolean {
  const racers = getRacers(room)
    .filter((m) => m.id !== observer.id && m.id !== excludeId && m.isConnected())
    .sort((a, b) => {
      const af = playerRaces.get(a.id)?.finished ? 1 : 0;
      const bf = playerRaces.get(b.id)?.finished ? 1 : 0;
      return af - bf;
    });
  for (const m of racers) {
    if (getObserveTarget(m.id)) continue; // 目标本身在观战（/tv 会拒绝）
    if (startObservePlayer(observer, m)) return true;
  }
  return false;
}

/**
 * 参赛者 → 观众席（仅 WAITING，且房间还有别的参赛者）。
 * 车不留在比赛世界：下车后把比赛车挪回进房前的世界/位置（remembered），
 * 清比赛 TD/CP/录制登记，自动观战一个参赛者。
 */
export function becomeSpectator(player: Player): boolean {
  const pr = getRacePlayerState(player.id);
  const room = pr ? getRaceRoom(pr.roomId) : undefined;
  if (!pr || !room) {
    sysMsg(player, "race", "你不在比赛房间中", "error");
    return false;
  }
  if (pr.role === "spectator") {
    sysMsg(player, "race", "你已经在观众席", "info");
    return false;
  }
  if (room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始，不能切换身份", "warn");
    return false;
  }
  if (countRacers(room) <= 1) {
    sysMsg(player, "race", "房间至少需要一名参赛者，不能切到观众席", "warn");
    return false;
  }
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候", "warn");
    return false;
  }
  // 参赛者可能正在观战其他参赛者：先退出观战（恢复房间世界/室内）
  if (isObserving(player.id)) stopObserve(player);
  // 下车后把比赛车挪出比赛世界（观众的车不允许留在赛道里）
  if (player.isInAnyVehicle()) {
    try {
      player.removeFromVehicle();
    } catch {
      /* 已不在车里 */
    }
  }
  const veh = getOwnedVehicle(player.id);
  let stowed = false;
  if (veh && veh.isValid()) {
    veh.setVirtualWorld(pr.prevWorld);
    veh.setPos(pr.prevPos.x, pr.prevPos.y, pr.prevPos.z);
    veh.setZAngle(pr.prevAngle);
    stowed = true;
  } else {
    // 实体已失效（等待期炸车等）：清引用，回比赛时按标准车重新刷
    destroyPlayerVehicle(player.id);
  }
  pr.role = "spectator";
  pr.spectatorCarStowed = stowed;
  pr.cpIndex = -1;
  pr.lap = 0;
  pr.startTime = 0;
  pr.finished = false;
  pr.timeUp = false;
  pr.rank = undefined;
  pr.cpSnapshots = [];
  room.raceMembersLast.delete(player.id);
  room.afk.delete(player.id);
  room.lastPositions.delete(player.id);
  destroyMemberRaceTd(room, player.id);
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player);
  // 原本在观战这个参赛者的人（观众/其他参赛者）：目标已变观众，自动切到
  // 下一个还在比赛的参赛者；没有则停止观战（避免继续看一个观众）
  for (const oid of getObserverIdsOf(player.id)) {
    if (oid === player.id) continue;
    const obs = Player.getInstance(oid);
    if (!obs || !obs.isConnected()) continue;
    if (!autoObserveRacer(obs, room, player.id)) stopObserve(obs);
  }
  // 人切回房间世界（车已挪走），自动看一个参赛者
  player.setVirtualWorld(room.worldId);
  autoObserveRacer(player, room, player.id);
  broadcastToRoom(room, `${player.getName().name} 加入了观众席`);
  sysMsg(player, "race", "已加入观众席，开赛前可用 /r race 回到比赛", "success");
  return true;
}

/**
 * 观众席 → 参赛者（仅 WAITING）。先退出观战，再把（可能停在原世界的）车
 * 放回起点/刷标准车，补建比赛 TD/CP；异步刷车期间 startRace 会拒绝开赛
 *（room.roleSwitches 非空），避免倒计时与身份切换并发。
 */
export async function becomeRacer(player: Player): Promise<boolean> {
  const pr = getRacePlayerState(player.id);
  const room = pr ? getRaceRoom(pr.roomId) : undefined;
  if (!pr || !room) {
    sysMsg(player, "race", "你不在比赛房间中", "error");
    return false;
  }
  if (pr.role === "racer") {
    sysMsg(player, "race", "你已经在比赛中", "info");
    return false;
  }
  if (room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始，不能切换身份", "warn");
    return false;
  }
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候", "warn");
    return false;
  }
  room.roleSwitches.add(player.id);
  try {
    if (isObserving(player.id)) stopObserve(player);
    pr.role = "racer";
    pr.spectatorCarStowed = false;
    pr.cpIndex = -1;
    pr.lap = 0;
    pr.startTime = 0;
    pr.finished = false;
    pr.timeUp = false;
    pr.rank = undefined;
    pr.cpSnapshots = [];
    room.raceMembersLast.set(player.id, getAuthState(player.id)?.userId ?? "");
    await positionPlayerAtStart(player, room);
    // await 期间可能断线/离开/房间销毁/开赛——开赛被 roleSwitches 挡住，正常
    // 不会发生；仍做防御，避免在已非本房的玩家身上继续写世界/发消息
    if (!player.isConnected() || !isInRace(player.id) || rooms.get(room.id) !== room) {
      return false;
    }
    if (room.state !== "WAITING") {
      // 极端兜底：比赛已被别的路径开起，身份退回观众席，避免无车参赛
      pr.role = "spectator";
      pr.spectatorCarStowed = false;
      autoObserveRacer(player, room, player.id);
      sysMsg(player, "race", "比赛已开始，身份切换取消（已留在观众席）", "warn");
      return false;
    }
    player.setVirtualWorld(room.worldId);
    if (player.isInAnyVehicle()) {
      player.getVehicle()!.setVirtualWorld(room.worldId);
    }
    const owned = getOwnedVehicle(player.id);
    if (owned && owned.isValid() && owned !== player.getVehicle()) {
      owned.setVirtualWorld(room.worldId);
    }
    broadcastToRoom(room, `${player.getName().name} 回到了比赛`);
    sysMsg(player, "race", "已回到比赛，等待房主开始", "success");
    return true;
  } finally {
    room.roleSwitches.delete(player.id);
  }
}

/** 房主开始比赛：倒计时 5s */
export async function startRace(player: Player): Promise<void> {
  const pr = getRacePlayerState(player.id);
  if (!pr) return;
  const room = getRaceRoom(pr.roomId);
  if (!room) return;
  if (room.ownerId !== player.id) {
    sysMsg(player, "race", "只有房主能开始比赛", "error");
    return;
  }
  if (room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始", "warn");
    return;
  }
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候再开始", "warn");
    return;
  }
  if (countRacers(room) === 0) {
    sysMsg(player, "race", "房间没有参赛者，无法开始比赛", "warn");
    return;
  }
  // 挑战等级：赛道有 level_data 且房主本场还没选（challengeTierSeconds === 0）
  // → 弹选择（神/鬼/人/菜/渣/无挑战）。选完再进倒计时；重开比赛沿用已选等级。
  // 选了"无挑战"存 -1，之后不再弹（与"未选(0)"区分开）。
  const tiers = parseLevelData(room.challengeLevelData);
  if (tiers && room.challengeTierSeconds === 0) {
    const chosen = await pickChallengeLevel(player, room, tiers);
    if (!chosen) return; // 取消选择 = 不开赛
  }
  // await 弹窗期间：房间可能被销毁/重开、玩家可能切身份/离开——全部二次校验
  if (rooms.get(room.id) !== room || room.state !== "WAITING") return;
  if (room.roleSwitches.size > 0) {
    sysMsg(player, "race", "有玩家正在切换身份，请稍候再开始", "warn");
    return;
  }
  if (countRacers(room) === 0) {
    sysMsg(player, "race", "房间没有参赛者，无法开始比赛", "warn");
    return;
  }
  // 开赛前退出观战：只停参赛者（观众席必须继续看比赛）。等待期 racer 可能
  // /tv 了本房间参赛者（房间作用域允许），倒计时开始应回到自己的车。
  for (const m of getRacers(room)) {
    if (m.isConnected() && isObserving(m.id)) stopObserve(m);
  }
  room.state = "COUNTDOWN";
  broadcastToRoom(room, "比赛倒计时开始！");
  // 倒计时：TextDraw 动画（掉落弹跳 + 放大淡出），GO 显示瞬间开赛（对齐回放/挑战）。
  // onGo 回调检查 state：重开/结束置非 COUNTDOWN 后不再 beginRace（门控保留）。
  // 倒计时 GameText/音效发给全房（观众席也能看到开赛倒计时，不影响镜头）。
  playCountdown(
    [...room.members.values()].filter((m) => m.isConnected()),
    {
      numbers: [5, 4, 3, 2, 1],
      onGo: () => {
        if (room.state === "COUNTDOWN") beginRace(room);
      },
    },
  );
}

/**
 * 房主选择挑战等级（LIST：神/鬼/人/菜/渣 + 无挑战 + 取消）。
 * 取消（取消/关闭）→ 返回 false，不开赛。
 * 选等级 → 存该档秒数（>0），本场全员限时；选"无挑战"→ 存 -1，本场不限时且不再询问。
 */
async function pickChallengeLevel(
  player: Player,
  room: RaceRoom,
  tiers: { seconds: number; score: number }[],
): Promise<boolean> {
  const summary = formatLevelSummary(tiers) ?? "";
  const options: { label: string; seconds: number }[] = [];
  // 显示顺序：神→渣（tier 4→0）
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i];
    if (t.seconds > 0 && t.score > 0) {
      options.push({
        label: `${TIER_LABELS[i]}（${Math.round(t.seconds)}秒/${t.score}分）`,
        seconds: t.seconds,
      });
    }
  }
  options.push({ label: "无挑战（不限时）", seconds: -1 });
  // header 行（前 3 行）必须单行不 wrap：SA 客户端对超宽行折行会破坏
  // listItem - 3 的映射。summary 过长截断（等级摘要最坏 5 档全设）
  const summarySafe = summary.length > 24 ? `${summary.slice(0, 24)}…` : summary;
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "选择挑战等级",
      info: [
        `赛道等级: ${summarySafe}`,
        `失败扣分: ${room.failedScoreFix !== 0 ? `${room.failedScoreFix} 分` : "无"}`,
        "本场全员限时挑战（超时未完赛者完成时扣分展示）：",
        ...options.map((o, i) => `${i + 1}. ${o.label}`),
      ].join("\n"),
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return false;
  // info 前 3 行为 header（等级摘要/失败扣分/说明），listItem 是渲染行号需偏移
  const idx = res.listItem - 3;
  if (idx < 0 || idx >= options.length) return false;
  // await 弹窗期间房间可能已被销毁/房主掉线——写前校验房间仍存在
  if (rooms.get(room.id) !== room) return false;
  room.challengeTierSeconds = options[idx].seconds;
  if (room.challengeTierSeconds > 0) {
    broadcastToRoom(
      room,
      `本场挑战等级：${options[idx].label.split("（")[0]}，全员限时 ${room.challengeTierSeconds} 秒`,
    );
  } else {
    broadcastToRoom(room, "本场无挑战限时");
  }
  return true;
}

/** 正式开赛：切独立世界 + 统一设置房间天气时间 */
function beginRace(room: RaceRoom): void {
  room.state = "RACING";
  // 倒计时期间参赛者可能全部离开/断线（观众还在）：没有参赛者就不开赛，直接解散
  if (countRacers(room) === 0) {
    checkRoomState(room);
    return;
  }
  const now = Date.now();
  // 超级起步速度：第一 CP 的 superstart 配置（无/非法 → 默认；写其他 CP 无效）。
  // 不写默认生效——所有比赛开局倒计时结束即有超级起步（GO 瞬间沿车头给初速）。
  const superStartKmh = getSuperStartKmh(room.cps);
  // 房间统一天气时间：按房主个人设置（syncGameTime 则跟随服务器真实时间，否则用
  // 房主 timeHour/timeMinute；天气同理取大世界当前或房主个人天气）。同步读设置
  // 缓存（房主必为房间在线成员，登录时已预热）——消除原异步查库的延迟：开赛瞬间
  // 即时生效，不再"开局后 1-2 秒才跳变"。缓存 miss（极端）退回服务器现实时间。
  const nowTime = new Date();
  let hour = nowTime.getHours();
  let minute = nowTime.getMinutes();
  let weather = getWorldWeather();
  const ownerAuth = getAuthState(room.ownerId);
  const ownerSetting = ownerAuth ? getCachedSettingByUserId(ownerAuth.userId) : undefined;
  if (ownerSetting) {
    if (!ownerSetting.syncGameTime) {
      // 房主个人时间：timeFlow=true 时大世界时间从设置值流逝（现实 1 秒 = 游戏
      // 1 分钟），设置值只是"起点"不是当前值——若用设置值，比赛时间会从起点
      // 重新开始，比房主赛前看到的时间倒退（如已流逝到 5:30 却重设 5:10）。
      // 读房主当前 getTime()（进入房间后 isInRace 冻结，即赛前看到的时刻）；
      // 取不到（极端）回退设置值。
      const owner = Player.getInstance(room.ownerId);
      const tm = owner?.getTime();
      if (tm?.ret) {
        hour = tm.hour;
        minute = tm.minute;
      } else {
        hour = ownerSetting.timeHour;
        minute = ownerSetting.timeMinute;
      }
    }
    if (!ownerSetting.syncWorldWeather) {
      weather = ownerSetting.weather;
    }
  }
  // 第一 CP 的 time/weather = 赛道固定环境：开赛即应用，覆盖房主设置——赛道
  // 作者在第一 CP 写 time/weather 即声明"本赛道环境"，无需等玩家触碰 CP1 才
  // 生效（触碰时 scripts.ts 仍会执行一次，值相同无影响）
  const cpEnv = getFirstCpEnv(room.cps);
  if (cpEnv.time) {
    hour = cpEnv.time.hour;
    minute = cpEnv.time.minute;
  }
  if (cpEnv.weather !== undefined) {
    weather = cpEnv.weather;
  }
  // 同步设置（beginRace 在 onGo 同步触发，room 必在 RACING，无需异步存活检查）
  for (const m of room.members.values()) {
    if (!m.isConnected()) continue;
    // 开赛瞬间兜底退出观战：只对参赛者（观众席保持观战，不能停）
    if (isRacer(m.id) && isObserving(m.id)) stopObserve(m);
    m.setTime(hour, minute);
    m.setWeather(weather);
  }
  // 观众席兜底：确保在房间世界且仍在观战本房间某个参赛者（目标可能赛前离开/
  // 完赛/变成观众）。镜头挂在房间外的人身上时也要重新挂回房内参赛者。
  for (const s of getSpectators(room)) {
    if (!s.isConnected()) continue;
    s.setVirtualWorld(room.worldId);
    const st = getObserveTarget(s.id);
    const targetId = st?.originPlayerId ?? (st?.kind === "player" ? st.targetId : undefined);
    const tpr = targetId != null ? playerRaces.get(targetId) : undefined;
    const watchingRoomRacer = !!tpr && tpr.role === "racer" && tpr.roomId === room.id;
    if (!watchingRoomRacer) autoObserveRacer(s, room);
  }
  // 缓存房间统一时间天气：重连玩家是新连接，按此恢复（与房间其他成员一致）
  room.roomTime = { hour, minute };
  room.roomWeather = weather;
  // 只有参赛者进入比赛状态（进度/车辆/录制/CP/TD/超级起步）；观众席不参与
  for (const m of getRacers(room)) {
    const mp = playerRaces.get(m.id);
    if (mp) {
      mp.cpIndex = -1;
      mp.lap = 0;
      mp.startTime = now;
      mp.finished = false;
      mp.timeUp = false; // 挑战限时标记重置
      mp.rank = undefined; // 新一场比赛：名次缓存重置（tickRooms 重新计算）
      mp.cpSnapshots = []; // 新一场比赛：清空上场的回退快照
      room.afk.delete(m.id);
      // 比赛中强制无碰撞（防他人车辆穿模阻挡），结束/离开时按个人设置恢复
      applyRaceNoCollision(m, true);
      // 切到比赛独立世界（车辆同步）
      m.setVirtualWorld(room.worldId);
      if (m.isInAnyVehicle()) {
        m.getVehicle()!.setVirtualWorld(room.worldId);
      }
      // 发车（对齐原版 Race_Game_Start_s）：不把玩家传送到第一个 CP——加入房间时
      // 已在起点定位（joinRoom），倒计时/等待期间可在起点自由活动，发车瞬间不应被拉回起点。
      // 无车兜底：有车玩家立即开录；无车玩家（等待期爆车等极端情况）不立即开录——
      // 避免 startRecording 失败弹"需要先刷车"红字，先异步刷默认比赛车（有该模型
      // 爱车则复用其外观，没有则自动创建成爱车），完成后补开录，保证开赛无车也有
      // 本场录像。录制起点晚几百 ms（刷车完成时刻），无车期间本来也无车辆帧可采。
      // 无车兜底判定要判 isValid：等待期爆车时 getOwnedVehicle 仍返回 Map 条目
      //（残骸实体），不判 isValid 会误走"有车"分支 → 开赛既无车也不录（startRecording
      // 的 veh.isValid() 失败弹"需要先刷车"）。爆车实体由 vehicles onDeath 清理（比赛外）
      // 或这里兜底（isValid 检查），统一口径。
      const ownedVeh = getOwnedVehicle(m.id);
      if (!m.isInAnyVehicle() && (!ownedVeh || !ownedVeh.isValid())) {
        void spawnVehicle(m, getDefaultRaceModel(room.cps), true).then((ok) => {
          if (
            ok &&
            m.isConnected() &&
            isInRace(m.id) &&
            room.state === "RACING" &&
            !isRecording(m.id)
          ) {
            raceRecordingStart(m.id, {
              raceId: room.raceId,
              raceName: room.raceName,
              raceRoomId: room.id,
            });
          }
        });
      } else {
        // 比赛自动录制：开赛即记录整个房间（回放/后续观战/影子挑战用）。
        // 必须在 setVirtualWorld 之后调用——startRecording 以调用时的世界为
        // startWorld，若在切世界前开录，开赛后会被"已离开录制世界"边界检查
        // 立即自动停止（首次 join 的玩家 startWorld 是原世界，上一场录制全丢，
        // 影子挑战也因此永远没有该赛道的比赛回放）。
        raceRecordingStart(m.id, {
          raceId: room.raceId,
          raceName: room.raceName,
          raceRoomId: room.id,
        });
      }
      // 超级起步：GO 瞬间把起步速度**补偿**到至少 superStartKmh（全局仅开局这一次）。
      // 本服允许偷跑——倒计时前玩家可移动/蓄力调整位置，因此：
      // - 当前车速 < 目标 → 补到目标。沿**当前速度方向**补偿（保留偷跑/蓄力已有
      //   的动量方向，不因车头朝向改向）；静止（车速≈0）→ 沿车头方向给初速。
      // - 当前车速 ≥ 目标 → 不动（不叠加、也不把快车拖慢回目标值）。
      // 无车（开局兜底刷车异步完成前）跳过——车就位后已不在起步加速时点。
      const ssVeh = m.getVehicle();
      if (superStartKmh > 0 && ssVeh) {
        const vv = ssVeh.getVelocity();
        const curSpeed = Math.hypot(vv.x, vv.y);
        const target = superStartKmh / KMH_UNIT;
        if (curSpeed < target) {
          if (curSpeed > 0.001) {
            const k = target / curSpeed;
            ssVeh.setVelocity(vv.x * k, vv.y * k, vv.z);
          } else {
            setVehicleSpeed(ssVeh, superStartKmh, ssVeh.getZAngle().angle + 90);
          }
        }
      }
      // 显示起点 CP 箭头（红圈在起点、箭头指向第一个 CP；小地图图标在下一个 CP，对齐原版）
      showNextCheckpoint(m, room.cps, -1);
      // 开赛同步观战者的起点 CP 箭头
      syncCpToObservers(room, m, -1);
      // 比赛信息 UI（C P/TIME/BEST/RANK）已在加入房间时创建（joinRoom），
      // 开赛重置 TIME 显示为 0（tickRooms 开始计时刷新）。TD 文本缓存一并清——
      // 60fps syncRaceTds 以缓存去重，不清会让开赛首帧拿到上一场的旧文本
      room.tdTextCache.delete(m.id);
      const tds = room.raceTextTds.get(m.id);
      if (tds && tds.time.isValid()) {
        tds.cp.setString(`C  P / ~p~1~w~/~y~${room.cps.length}`);
        // 挑战限时模式：TIME 初始显示完整限时（倒计时从限时开始，由 60fps
        // syncRaceTds 续刷）；非挑战模式从 00:00:00 开始正计时
        if (room.challengeTierSeconds > 0) {
          const { text } = formatLimitCountdown(room.challengeTierSeconds * 1000, 0);
          tds.time.setString(text);
        } else {
          tds.time.setString("TIME / 00:00:00");
        }
        tds.rank.setString("RANK / 1 st");
      }
    }
  }
  // 开始提示：对齐原版 ~y~Start! + 音效 1057 + 恢复第三人称视角（仅参赛者；
  // 观众席镜头是 spectate，setCameraBehind 会把观战镜头打回自己身上）
  const go = new GameText("~y~Start!", 850, 3);
  for (const m of getRacers(room)) {
    if (!m.isConnected()) continue;
    go.forPlayer(m);
    m.playSound(1057);
    m.setCameraBehind();
  }
  // 观众席也看到 GO 提示/听到发车音效，但不改镜头（setCameraBehind 会打断观战）
  for (const s of getSpectators(room)) {
    if (!s.isConnected()) continue;
    go.forPlayer(s);
    s.playSound(1057);
  }
  broadcastToRoom(room, "比赛开始！");
}

/** 特殊音效脚本函数（过此 CP 有显著动作）：cveh 换车 / speed* 变速 / angle 转向 /
 *  vgoto 传送 / fix 修复 / damage 破坏——播特殊音效 1133 提示"此 CP 有特殊效果"。
 *  time/weather/msg 属环境/文案类（无车辆动作），保持普通 CP 音效 1056。
 *  skipCveh 时忽略 cveh（第一 CP 的 cveh 是赛道标准车，进赛道已换好，不算显著动作）。 */
const SIGNIFICANT_SCRIPT_FNS = new Set([
  "cveh",
  "speed",
  "speedex",
  "zspeed",
  "angle",
  "vgoto",
  "fix",
  "damage",
]);

function hasSignificantScript(scripts: string[], skipCveh: boolean): boolean {
  for (const script of scripts) {
    const fn = script.trim().split(/\s+/)[0];
    // spawnpos 过 CP 时不执行且终止整条脚本链（execCpScript return false）——
    // 其后的脚本不会跑，不算显著（防 spawnpos 后的 speed 被误算而播 1133）
    if (fn === "spawnpos") return false;
    if (SIGNIFICANT_SCRIPT_FNS.has(fn) && !(skipCveh && fn === "cveh")) return true;
  }
  return false;
}

/** 玩家到达 CP（RaceCpEvent 触发） */
async function onPlayerReachCp(player: Player): Promise<void> {
  const pr = playerRaces.get(player.id);
  if (!pr || pr.role !== "racer") return;
  const room = rooms.get(pr.roomId);
  if (!room) return;
  if (room.state !== "RACING" || pr.finished) return;

  // 目标 CP = 当前进度 + 1
  const nextCp = room.cps[pr.cpIndex + 1];
  if (!nextCp) return;

  // 注意：这里不做任何时间冷却（对齐原版 OnPlayerEnterRaceCheckpoint 直接推进）。
  // open.mp 检查点是"进入即消耗"：触发后 showNextCheckpoint 立即把红圈挪到下一个
  // CP，同一 CP 想再次触发的前提（红圈留在原地）在推进成功的路径上不存在——
  // 冷却反而会制造它想防的滞留。更糟的是全局时间冷却会把"1 秒内连过的相邻近 CP"
  // 的第二次触达也吞掉（100km/h 下 ~30m 间距的 CP 间隔不足 1 秒），导致近 CP 被
  // 跳过、玩家直接错过（原版无此冷却，近 CP 从未错过）。

  pr.cpIndex++;

  // 回放录制：过 CP 时把进度写进录制会话（回放帧带 CP 进度，C P TD 与 seek 一致）
  noteCpProgress(player.id, Math.min(pr.cpIndex + 1, room.cps.length), room.cps.length);

  // 更新 CP 进度 TD（对齐原版过 CP 时 "C  P / ~p~进度~w~/~y~总数"；完成时同样先刷满）
  // 玩家自身 + 观战他的观察者（对齐原版 OnPlayerEnterRaceCheckpoint 对观战者的 CP TD 同步）
  const cpDone = Math.min(pr.cpIndex + 1, room.cps.length);
  const cpText = `C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`;
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

  // 最后一圈且到达最后一个 CP → 完成
  if (pr.lap === room.laps - 1 && pr.cpIndex >= room.cps.length - 1) {
    await finishPlayer(player, pr);
    return;
  }

  // 到达最后一个 CP 且还有圈 → 进入下一圈，回到第一个 CP
  if (pr.cpIndex >= room.cps.length - 1) {
    pr.cpIndex = -1;
    pr.lap++;
    sysMsg(player, "race", `第 ${pr.lap + 1} 圈（共 ${room.laps} 圈）`, "info");
  }

  // 触发当前 CP 脚本（脚本已随房间载入内存，不再查库）。
  // 第一 CP 的 cveh 是赛道标准车型（进赛道时已按它匹配/刷车），到达时跳过换车，
  // 其余 CP 的 cveh（如 Car 赛道 CP11 的 562 中途换车）照常执行。
  // 显示下一个 CP 与音效放在脚本循环之前——spawnpos 返回 false 会终止脚本链，
  // 若放在循环后，CP 箭头/红圈会残留错位一整段（cpIndex 已推进但视觉停在旧 CP）。
  const isFirstCp = nextCp.index === room.cps[0].index;
  showNextCheckpoint(player, room.cps, pr.cpIndex);
  // 同步观战者的 CP 箭头/图标（观察者看到被观战者下一步要过的 CP）
  syncCpToObservers(room, player, pr.cpIndex);
  // 有显著动作脚本的 CP（换车/变速/转向/传送/修车/破坏）播特殊音效 1133，提示
  // "这个 CP 有特殊效果"；普通 CP（含仅 time/weather/msg）用 1056。
  // 第一 CP 的 cveh 是赛道标准车（skipCveh 跳过、进赛道已换好）——不算显著动作。
  const cpSound = hasSignificantScript(nextCp.scripts, isFirstCp) ? 1133 : 1056;
  player.playSound(cpSound);
  // 过 CP 音效同步给观战者（与被观战者一致——观察者同样能听到"当前过了个特殊 CP"）
  for (const oid of getObserverIdsOf(player.id)) {
    const ob = Player.getInstance(oid);
    if (ob && ob.isConnected() && ob.getVirtualWorld() === room.worldId) {
      ob.playSound(cpSound);
    }
  }
  // 对齐原版 OnPlayerEnterRaceCheckpoint：只有司机（PLAYER_STATE_DRIVER）才执行 CP
  // 脚本；步行/副驾驶只推进检查点（racespeedtime.pwn:3332 的 state==2 门）。否则步行
  // 过带 speed 的 CP 会刷"需要车辆"错误，副驾驶也会触发 cveh/变速/时间天气。
  if (player.getState() === PlayerStateEnum.DRIVER) {
    const scriptCtx: CpScriptContext = {
      raceId: room.raceId,
      cpid: nextCp.index,
      raceName: room.raceName,
      authorName: room.authorName,
      cps: room.cps.map((c) => ({ index: c.index, x: c.x, y: c.y, z: c.z })),
    };
    try {
      for (const script of nextCp.scripts) {
        // spawnpos 返回 false → 终止整条脚本链（对齐原版 Race_Cp_Script_Start 的 return 1）
        if (!execCpScript(player, scriptCtx, script, { skipCveh: isFirstCp })) return;
        // 脚本执行（同步）期间玩家可能已离开/比赛结束 → 终止后续操作
        if (
          !playerRaces.has(player.id) ||
          rooms.get(pr.roomId)?.state !== "RACING" ||
          pr.finished
        ) {
          return;
        }
      }
    } catch (e) {
      // 脚本执行异常（native 读取失败等）：终止链但不影响玩家状态（对齐原版防御式执行）
      logger.error(`[race] CP 脚本执行异常 race=${room.raceId} cp=${nextCp.index}`, e);
      return;
    }
  }
  // 触达该 CP 并执行完脚本后的状态快照（回退重生恢复用）：cveh 换车后的车型
  // + time/weather 脚本结果。放在脚本链完整执行之后（execCpScript 里的 spawnpos
  // 提前 return 或脚本异常都不记账——脚本没跑完，状态未定型）。
  // 累计序号 = 当前圈 × 一圈CP数 + cpIndex：不跨圈时 cpIndex 即圈内下标（指向刚触达
  // 的 CP）；跨圈瞬间 cpIndex 已回 -1、lap++，`newLap×len + (-1)` 仍等于刚触达的
  // 上一圈末 CP 的累计序号。与重生回退的目标序号（computeTargetCp 同式）一致。
  const t = player.getTime();
  const cumIdx = pr.lap * room.cps.length + pr.cpIndex;
  pr.cpSnapshots[cumIdx] = {
    vehModel: player.isInAnyVehicle() ? player.getVehicle()!.getModel() : 0,
    hour: t.ret ? t.hour : 12,
    minute: t.ret ? t.minute : 0,
    weather: player.getWeather(),
  };
}

/** 完成比赛 */
async function finishPlayer(player: Player, pr: PlayerRace): Promise<void> {
  const room = rooms.get(pr.roomId);
  if (!room || pr.role !== "racer") return;
  pr.finished = true;
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 完成：清比赛小地图图标
  // 完成者不再跑：清理指向该成员的观察者 CP 箭头（观察者跟随完赛自动观战切走）
  clearSpectatorCpForMember(player.id);
  const time = Date.now() - pr.startTime;
  // 挑战评级：按完成时间判定称号（level_data 未设置/未达任何等级 → null）
  const tier = room.challengeLevelData
    ? tierForTime(time, parseLevelData(room.challengeLevelData))
    : null;
  const timeUp = !!pr.timeUp;
  // name 快照：完成后玩家可能掉线/离开，endRoom 补计排名时 getName 已取不到
  room.results.push({ playerId: player.id, time, name: player.getName().name });
  room.resultIndex.set(player.id, time);
  // 挑战限时模式：完成者 TIME 定格为最终用时（白色），不再显示倒计时/红色负数。
  // 非挑战模式 TIME 由 tickRooms 继续写最终时间（结果索引），无需特殊处理。
  if (room.challengeTierSeconds > 0) {
    const tds = room.raceTextTds.get(player.id);
    const cache = room.tdTextCache.get(player.id);
    if (tds && tds.time.isValid()) {
      const timeText = `TIME / ${formatRaceTimeCs(time)}`;
      tds.time.setString(timeText);
      tds.time.setColor(TIME_COLOR_NORMAL);
      if (cache) {
        cache.time = timeText;
        cache.timeColor = TIME_COLOR_NORMAL;
      }
    }
  }
  const rank = room.results.length; // 完成顺序 = 名次（同一起点同时开始）
  broadcastToRoom(
    room,
    `${player.getName().name} 完成比赛！用时 ${formatTime(time)}${tier ? ` 评级「${tier.label}」` : ""}${timeUp && room.failedScoreFix !== 0 ? `（超时扣 ${room.failedScoreFix} 分）` : ""}`,
  );
  // 完成反馈音效（对齐 countdownFx 的数字 1056 / GO 1057 音效族，冲线用 1058）
  player.playSound(1058);
  // 完成标记（多轨道合并落盘用）：只写会话标记不落盘——endRoom 统一把全房间
  // 会话合并成一个多轨道 .rec 文件。若这里提前落盘（旧逻辑），完成者会被单独
  // 写成一个单轨文件，整场回放就散成多个文件了。完成者掉线后标记仍保留在
  // 会话里，endRoom 合并时按标记写 rank/finished（不会丢名次）。
  markRaceFinished(player.id, rank);
  // 第一名完成：立即挂 20s 宽限定时器（同步段、在任何 await 之前）——若延后到
  // 结算对话框/DB 写纪录之后再挂，完成者掉线（cleanupRacePlayer 删 playerRaces，
  // 后续续体直接 return）或对话框一直挂着（await 永不 resolve）时 endTimer 永不
  // 挂载 → 房间永久卡 RACING、无人完赛则无任何路径触发 endRoom
  if (rank === 1 && !room.endTimer) {
    const unfinishedNow = getRacers(room).filter((m) => !playerRaces.get(m.id)?.finished).length;
    if (unfinishedNow > 0 || room.reconnectSlots.size > 0) {
      broadcastToRoom(room, "第一名已完成，20 秒后比赛结束");
      room.endTimer = setTimeoutSafe(() => endRoom(room), END_GRACE_MS);
    }
  }

  // 写纪录（record 为毫秒）
  let isPB = false;
  let prevRecord: number | null = null;
  let trackRank = 0;
  const auth = getAuthState(player.id);
  if (auth) {
    try {
      const prev = await prisma.raceRecord.findFirst({
        where: { raceId: room.raceId, userId: auth.userId, deletedAt: null },
        orderBy: { record: "asc" },
      });
      prevRecord = prev?.record ?? null;
      isPB = !prev || time < prev.record;
      // 事务内：写新纪录 + 删除该用户更差的旧纪录（防止表膨胀 + 排行榜被同一人刷屏）
      await prisma.$transaction([
        prisma.raceRecord.create({
          data: { raceId: room.raceId, userId: auth.userId, record: time },
        }),
        prisma.raceRecord.deleteMany({
          where: {
            raceId: room.raceId,
            userId: auth.userId,
            deletedAt: null,
            record: { gt: time },
          },
        }),
      ]);
      // 赛道排名：排除自己的历史纪录
      trackRank =
        (await prisma.raceRecord.count({
          where: {
            raceId: room.raceId,
            deletedAt: null,
            record: { lt: time },
            userId: { not: auth.userId },
          },
        })) + 1;
    } catch (e) {
      logger.error(`[race] 写纪录失败`, e);
    }
  }

  // 本次成绩优于旧纪录（或首次）→ 立即更新 BEST TD 与房间缓存（对齐原版刷新个人记录）
  if (isPB && auth) {
    const raceTds = room.raceTextTds.get(player.id);
    if (raceTds && raceTds.best.isValid()) {
      raceTds.best.setString(`BEST / ${formatRaceTimeCs(time)}`);
      room.bestTimes.set(auth.userId, time);
    }
  }

  // 比赛已结束（另一玩家完成/超时触发 endRoom）→ 不再弹个人结算，避免双结算
  if (room.state === "FINISHED") {
    return;
  }

  // 个人结算对话框（对齐原版结算风格）
  const rankLabel =
    rank === 1 ? "冠军" : rank === 2 ? "亚军" : rank === 3 ? "季军" : `第 ${rank} 名`;
  await new Dialog({
    style: DialogStylesEnum.MSGBOX,
    caption: "比赛完成",
    info: [
      `{98CDFE}赛道: {FFFFFF}${room.raceName}`,
      `{98CDFE}名次: {FFFFFF}${rankLabel}（No.${rank}）`,
      `{98CDFE}用时: {FFFFFF}${formatTime(time)}`,
      tier ? `{98CDFE}评级: {FFD700}「${tier.label}」{FFFFFF}+${tier.score} 分` : "",
      timeUp && room.failedScoreFix !== 0
        ? `{FF5555}挑战超时: 按失败处理，-${room.failedScoreFix} 分`
        : "",
      isPB
        ? `{00FF00}★ 新个人纪录！`
        : prevRecord != null
          ? `{FFFFFF}个人最佳: ${formatTime(prevRecord)}`
          : "",
      trackRank > 0 ? `{98CDFE}赛道排名: {FFFFFF}No.${trackRank}` : "",
    ].join("\n"),
    button1: "确定",
  })
    .show(player)
    .catch(() => {});

  // 个人结算框展示期间比赛可能已结束 → 重新校验房间状态与玩家归属
  const curRoom = rooms.get(pr.roomId);
  if (!curRoom || curRoom.state !== "RACING" || !playerRaces.has(player.id)) {
    return;
  }

  // 全部完成 → 立即结束（单人房间/全员冲线：没有人在跑，不需要 20s 宽限，
  // 否则会先广播"20 秒后结束"再立刻结束，误导）。
  // 判定"未完成的在线成员"而非 results.length：results 含已离开/掉线的完成者
  //（leaveRace/断线不移除条目），members.size 只算当前在线——若用
  // results.length >= members.size，A 完成离开后 B 再冲线会把还在跑的 C 提前
  // endRoom（"20 秒宽限"承诺作废）。重连窗口玩家（不在 members）仍在跑，也须算
  const unfinished = getRacers(room).filter((m) => !playerRaces.get(m.id)?.finished).length;
  if (unfinished === 0 && room.reconnectSlots.size === 0) {
    endRoom(room);
    return;
  }
  // 第一名完成、还有成员（含窗口玩家）在 → 20s 宽限等他们冲线
  if (rank === 1 && !room.endTimer) {
    broadcastToRoom(room, "第一名已完成，20 秒后比赛结束");
    room.endTimer = setTimeoutSafe(() => endRoom(room), END_GRACE_MS);
  }
  // 自动观战下一个未完成玩家（二次确认目标仍有效）。
  // 仅弹结算框的"关闭"提示，不额外发"自动观战"消息——玩家点击结算框时
  // 场景自然切换为观战（提示反而打断结算阅读），快捷操作面板可随时 /tv off
  const next = getRacers(room).find((m) => {
    const mp = playerRaces.get(m.id);
    return mp && !mp.finished && m.isConnected();
  });
  if (next) {
    // 观众席正在看完成者 → 自动切到下一个未完成参赛者（不弹“停止观战”）
    for (const oid of getObserverIdsOf(player.id)) {
      if (oid === player.id || !isSpectator(oid)) continue;
      const obs = Player.getInstance(oid);
      if (obs && obs.isConnected()) autoObserveRacer(obs, room, player.id);
    }
    startObservePlayer(player, next);
  }
}

/**
 * 房间合并落盘（endRoom/resetRoom 共用）：收集在线成员 + 挂起掉线成员的录制
 * 会话，合并编码成一个多轨道 .rec 文件（v9），DB 每玩家一行共享 fileName +
 * trackIndex。完成者已由 finishPlayer 打标记（markRaceFinished），rank/finished
 * 不丢；未完成者按排名快照补。saveRaceReplay 内部异步落盘，成功后清会话
 * （失败则保留——由断线/房间销毁兜底落单轨，避免"落盘失败但会话已删"丢录像）。
 */
function mergeRoomReplays(room: RaceRoom, ranked: { playerId: number; finished: boolean }[]): void {
  const recs: { pid: number; rec: RecordingSession | undefined }[] = [];
  // 按 pid 去重：在线成员在 room.members 里登记过，raceMembersLast 也含他们
  //（joinRoom 时 set）——避免同一会话被收集两次产生重复轨道。观众席不录制，
  // 只收集参赛者。
  const seen = new Set<number>();
  for (const m of getRacers(room)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    recs.push({ pid: m.id, rec: isRecording(m.id) ? getRecording(m.id) : undefined });
  }
  for (const pid of room.raceMembersLast.keys()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const rec = isRecording(pid) ? getRecording(pid) : undefined;
    // 归属校验：只处理属于本房间的录制会话
    if (rec && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
      // 未标记完成但排上名的挂起成员：补标记（掉线后拿到名次）
      if (rec.finishFlag !== true) {
        const r = ranked.find((x) => x.playerId === pid);
        if (r?.finished) {
          rec.finishRank = ranked.indexOf(r) + 1;
          rec.finishFlag = true;
        }
      }
      recs.push({ pid, rec });
    }
  }
  const validRecs = recs
    .filter((x) => x.rec)
    .map((x) => x.rec!)
    .filter((r) => r.frames.length >= 2);
  if (validRecs.length > 0) {
    // 先同步清 Map（saveRaceReplay 已持有会话对象引用，删 Map 不影响它读帧）：
    // 否则 resetRoom 重开下一场时 raceRecordingStart 的 forceStopRecording 会
    // 命中旧会话落单轨文件，破坏"一场一个文件"。saveRaceReplay 内部只读传入
    // 的 sessions 数组，不依赖 Map。
    for (const x of recs) {
      if (x.rec) dropRecording(x.pid);
    }
    void saveRaceReplay(room.raceId, room.raceName, room.id, validRecs);
  }
}

/** 比赛结束：最终排名结算 + 成员收尾 + 房间销毁（结束宽限到点/全员完成/重连窗口清空） */
function endRoom(room: RaceRoom): void {
  // FINISHED 幂等；WAITING 也要跳过——restartRace 已把 state 置回 WAITING（20s 宽限
  // 定时器恰在 restart 的 await 期间触发时，若不拦会销毁刚重开的房间）
  if (room.state === "FINISHED" || room.state === "WAITING") return;
  room.state = "FINISHED";
  for (const m of room.members.values()) cancelCountdownFx(m.id);
  if (room.endTimer) {
    clearTimeoutSafe(room.endTimer);
    room.endTimer = undefined;
  }
  // 最终排名结算：完成者按用时升序，未完成者按进度（CP 数）降序
  const ranked: {
    playerId: number;
    name: string;
    time: number;
    finished: boolean;
    cp: number;
    dist: number;
  }[] = [];
  for (const m of getRacers(room)) {
    const mp = playerRaces.get(m.id);
    if (!mp) continue;
    const time = room.resultIndex.get(m.id);
    const nextCp = room.cps[mp.cpIndex + 1];
    let dist = 0;
    if (nextCp && time == null) {
      const pos = m.getPos();
      dist = Math.hypot(pos.x - nextCp.x, pos.y - nextCp.y, pos.z - nextCp.z);
    }
    ranked.push({
      playerId: m.id,
      name: m.getName().name,
      time: time ?? 0,
      finished: time != null,
      cp: mp.lap * room.cps.length + mp.cpIndex + 1,
      dist,
    });
  }
  // 掉线重连窗口玩家：按掉线前快照计入最终排名（未完成，排在线完成者之后）
  for (const [, slot] of room.reconnectSlots) {
    ranked.push({
      playerId: slot.playerId,
      name: slot.name,
      time: 0,
      finished: false,
      cp: slot.lap * room.cps.length + slot.cpIndex + 1,
      dist: slot.dist,
    });
  }
  // 完成后掉线/离开的玩家：不在 members 也不在 reconnectSlots（完成者不开
  // 重连窗口），从 results 快照补计——否则冠军掉线后最终结算榜缺失他，且
  // 其录像在兜底落盘时 rank 取不到被判"未完成"
  for (const res of room.results) {
    if (ranked.some((x) => x.playerId === res.playerId)) continue;
    ranked.push({
      playerId: res.playerId,
      name: res.name,
      time: res.time,
      finished: true,
      cp: 0,
      dist: 0,
    });
  }
  ranked.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return a.time - b.time;
    if (a.cp !== b.cp) return b.cp - a.cp;
    return a.dist - b.dist || a.playerId - b.playerId; // 同进度稳定排序
  });
  // 挑战等级：结算列表称号判定用（无等级 → 不加称号）
  const tiers = room.challengeLevelData ? parseLevelData(room.challengeLevelData) : null;
  const resultLines = ranked.map((r, i) => {
    const medal = i === 0 ? "{FFD700}" : i === 1 ? "{C0C0C0}" : i === 2 ? "{CD7F32}" : "";
    const nameColor = r.finished ? "{FFFFFF}" : "{808080}";
    const tier = r.finished && tiers ? tierForTime(r.time, tiers) : null;
    return `${medal}No.${i + 1} ${nameColor}${r.name}  ${r.finished ? formatTime(r.time) : "未完成"}${tier ? ` ［${tier.label}］` : ""}`;
  });

  for (const m of room.members.values()) {
    RaceCheckpoint.disable(m);
    clearRaceMapIcons(m); // 比赛结束：清每个成员的小地图图标
    const mp = playerRaces.get(m.id);
    // 观众席不参与结算/排名：退出观战、恢复进房前的位置/车，单独提示
    if (mp?.role === "spectator") {
      playerRaces.delete(m.id);
      restoreSpectatorAfterRace(m, mp);
      sysMsg(m, "race", "比赛结束，已退出观众席", "info");
      continue;
    }
    // 脚本车辆（cveh）在比赛结束时统一清理，防残留比赛世界成为幽灵车
    cleanupScriptVehicle(m.id);
    if (mp && !mp.finished) {
      sysMsg(m, "race", "比赛已结束，你未完成比赛", "plain");
    }
    // 先退出观战（否则 stopObserve 会把世界覆盖回比赛世界），再恢复原世界
    if (isObserving(m.id)) {
      stopObserve(m);
    }
    // 恢复原世界 + 个人时间天气（在 playerRaces.delete 前取 prevWorld）
    const prevWorld = mp?.prevWorld ?? PUBLIC_WORLD_ID;
    playerRaces.delete(m.id);
    restorePlayerAfterRace(m, prevWorld);
    // 无碰撞恢复为个人设置（比赛中强制开启）
    void restorePersonalNoCollision(m);
    void new Dialog({
      style: DialogStylesEnum.MSGBOX,
      caption: `结算 · ${room.raceName}`,
      info: resultLines.join("\n") || "（无排名信息）",
      button1: "确定",
    })
      .show(m)
      .catch(() => {});
  }
  // 外部观战者：房间世界即将回收，退出观战回各自世界（本房成员已在上面恢复）
  for (const m of room.members.values()) detachExternalObservers(m.id);

  // 回放：整场合并落盘（v9 多轨道——一场一个 .rec 文件，内含所有参赛玩家轨道）。
  // 有完成者才落盘（整场有意义）；无人完成走 checkRoomState 的 discard 路径。
  if (room.results.length > 0) {
    mergeRoomReplays(room, ranked);
  }

  destroyRaceTds(room);
  cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
  room.members.clear();
  // 房间销毁：卸载该赛道的专属对象（世界 id 即将回收复用，对象必须销毁）
  unloadRaceOnlyObjects(room.worldId);
  freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id（供后续房间复用）
  rooms.delete(room.id);
}

/** 离开比赛（参赛者/观众席都走这里） */
export function leaveRace(player: Player): void {
  const pr = playerRaces.get(player.id);
  if (!pr) {
    // 不在比赛中：明确提示，避免 /r l 零反馈
    sysMsg(player, "race", "你不在比赛中", "info");
    return;
  }
  const role = pr.role;
  const room = rooms.get(pr.roomId);
  if (room) {
    room.members.delete(player.id);
    room.lastPositions.delete(player.id); // 掉线快照缓存随成员离开清理
    room.afk.delete(player.id); // 挂机累计随离开清理（防 Map 残留）
    cancelCountdownFx(player.id); // 倒计时中离开：停掉自己的倒计时动画（视觉/音效残留）
    // 离开者不再被观战：清理指向该成员的观察者 CP 箭头（观察者切走/继续看别人）
    clearSpectatorCpForMember(player.id);
    broadcastToRoom(
      room,
      `${player.getName().name} ${role === "spectator" ? "离开了观众席" : "离开了比赛"}`,
    );
    destroyMemberRaceTd(room, player.id);
    // 房主离开 → 转移房主（优先参赛者，观众没有开赛/换图职责）
    if (room.ownerId === player.id) {
      const next = getRacers(room)[0];
      if (next) {
        room.ownerId = next.id;
        // 同步 ownerUserId（对齐 reconnect.ts 断线转移）：新房主断线重连是全新
        // playerId，tryReconnectRace 靠 ownerUserId 匹配恢复房主——不同步则
        // 新房主重连后无法开始/重开/换赛道，房间卡死到超时解散
        room.ownerUserId = getAuthState(next.id)?.userId ?? "";
        broadcastToRoom(room, `房主已离开，${next.getName().name} 成为新房主`);
      }
    }
    // 参赛者离开：正在看他比赛的观众自动切到下一个参赛者（没有则等房间遣返）
    if (role === "racer") {
      for (const oid of getObserverIdsOf(player.id)) {
        if (oid === player.id || !isSpectator(oid)) continue;
        const obs = Player.getInstance(oid);
        if (obs && obs.isConnected()) autoObserveRacer(obs, room, player.id);
      }
    }
    // 外部（非本房）观战者：目标已离开房间，退出观战回各自世界
    detachExternalObservers(player.id);
    checkRoomState(room);
  }
  // 离开者自己的反馈
  sysMsg(
    player,
    "race",
    role === "spectator" ? "你已离开比赛房间（观众席）" : "你已离开比赛房间",
    "info",
  );
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 离开：清比赛小地图图标
  playerRaces.delete(player.id);
  // 回放：只有参赛者有录制。中途退出挂起会话（车停在原地、录像静止帧录到比赛
  // 结束落盘）——与掉线重连一致，整场回放完整（能看到退出者停在哪）。房间销毁
  //（无人完成）或 endRoom（有人完成）时统一落盘处理；若房间仍有人继续跑，静止
  // 帧持续录。offline=false：退赛挂起，玩家仍在线，静止帧不标"掉线"。
  if (role === "racer") {
    if (room && room.state === "RACING") {
      suspendRecording(player.id, false);
    } else {
      // 非比赛状态（等待/倒计时中离开）：没有在跑，直接落盘（未完成，无名次）
      raceRecordingStop(player.id);
    }
    // 脚本车辆（cveh）在离开比赛时销毁，防残留
    cleanupScriptVehicle(player.id);
  }
  // 恢复：观众席回进房前的位置/车；参赛者回原世界（车随人/世界同步）
  if (role === "spectator") {
    restoreSpectatorAfterRace(player, pr);
  } else {
    if (isObserving(player.id)) {
      stopObserve(player);
    }
    restorePlayerAfterRace(player, pr.prevWorld);
    // 无碰撞恢复为个人设置（比赛中强制开启）
    void restorePersonalNoCollision(player);
  }
}

/**
 * 房间实时排名：
 * 排名依据 = (完成的CP总数) 降序，相同则比"距下一个CP的距离"升序。
 * 完成者按用时升序排最前。
 * 每 200ms 计算并更新到每位成员的 TextDraw。
 */
function tickRooms(): void {
  const now = Date.now();
  for (const room of rooms.values()) {
    // WAITING 房间超时回收（10 分钟无人开始 → 解散，防僵尸房间累积）
    if (room.state === "WAITING" && now - room.createdAt > 10 * 60 * 1000) {
      broadcastToRoom(room, "比赛房间因长时间未开始已解散");
      for (const m of room.members.values()) {
        // 清掉起点 CP 箭头与小地图图标，防留在公共/战局世界里永久残留
        RaceCheckpoint.disable(m);
        clearRaceMapIcons(m);
        const mp = playerRaces.get(m.id);
        // 观众席：没有比赛车，直接回进房前位置/车（不参与比赛清理）
        if (mp?.role === "spectator") {
          playerRaces.delete(m.id);
          restoreSpectatorAfterRace(m, mp);
          continue;
        }
        // 解散先清成员观战态（endRoom/restartRace 同序）：成员可能在房间世界
        // /tv 观战他人，不 stopObserve 则其 observeStates 残留、prevWorld 快照
        // 指向即将回收的房间世界——世界 id 复用到新房后 /tv off 会把它塞进
        // 别人的新比赛世界
        if (isObserving(m.id)) stopObserve(m);
        // 加入即切到房间世界：解散时恢复成员原世界（防留在房间世界成幽灵）
        if (mp) {
          m.setVirtualWorld(mp.prevWorld);
          if (m.isInAnyVehicle()) m.getVehicle()!.setVirtualWorld(mp.prevWorld);
          const owned = getOwnedVehicle(m.id);
          if (owned && owned.isValid() && owned !== m.getVehicle()) {
            owned.setVirtualWorld(mp.prevWorld);
          }
        }
        playerRaces.delete(m.id);
        cleanupScriptVehicle(m.id); // 等待期玩家可能在起点的比赛车上，解散一并清
      }
      // 外部观战者：房间世界即将回收，退出观战回各自世界
      for (const m of room.members.values()) detachExternalObservers(m.id);
      destroyRaceTds(room);
      cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
      room.members.clear();
      unloadRaceOnlyObjects(room.worldId); // 解散：卸载该赛道专属对象
      freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id
      rooms.delete(room.id);
      continue;
    }
    // 防御：任何时刻房间都不允许只剩观众（0 在线参赛者且无参赛者重连窗口）。
    // 身份/入场/重定位锁定期间跳过（避免把正在建房/重开的房间误杀）。
    if (
      room.state !== "FINISHED" &&
      room.roleSwitches.size === 0 &&
      countRacers(room) === 0 &&
      room.reconnectSlots.size === 0 &&
      room.reconnectUntil.size === 0
    ) {
      checkRoomState(room);
      continue;
    }
    // 重连窗口过期清理（房主窗口过期转移）
    if (room.reconnectUntil.size > 0) {
      cleanupExpiredReconnects(room);
    }
    if (room.state !== "RACING") continue;
    // 挑战限时检测：本场选了挑战等级（challengeTierSeconds>0）时，未完成成员
    // 用时超过限时 → 标记 timeUp（不踢出、可继续跑完；完成时展示失败扣分）。
    // 用 mp.startTime + 限时 作 deadline：重连恢复 startTime，deadline 保持一致。
    if (room.challengeTierSeconds > 0) {
      const deadline = room.challengeTierSeconds * 1000;
      for (const m of getRacers(room)) {
        const mp = playerRaces.get(m.id);
        if (!mp || mp.finished || mp.timeUp) continue;
        if (now - mp.startTime > deadline) {
          mp.timeUp = true;
          sysMsg(
            m,
            "race",
            `挑战超时（限时 ${room.challengeTierSeconds} 秒），完成时按失败处理${room.failedScoreFix !== 0 ? `（扣 ${room.failedScoreFix} 分）` : ""}`,
            "warn",
          );
        }
      }
    }
    // 挂机检测（对齐原版 AFKTimes：静止累计超时移出比赛，防占坑不跑）。
    // 200ms tick 采样位置：位移 < 阈值判静止累计（每 tick 固定 +AFK_TICK_MS，与
    // tickRooms 周期一致），有位移清零；累计超 AFK_WARN_MS 提示一次、AFK_IDLE_MS
    // 移出（leaveRace 广播 + 清成员 + 录制落盘）。断线玩家已在重连窗口不在 members。
    // 只检测参赛者：观众席天然静止（镜头观战），不能被挂机逻辑移出。
    for (const m of getRacers(room)) {
      // 已完赛者跳过：停在终点等待结算/观战，位移恒 <0.1，不挂机检测
      //（多圈赛道早完赛者 idle 超 45s 会被误踢出房间、错过结算）
      if (playerRaces.get(m.id)?.finished) {
        room.afk.delete(m.id);
        continue;
      }
      const pos = m.getPos();
      // 缓存最近采样位置：掉线快照兜底（onDisconnect 取不到坐标时用——见 cleanupRacePlayer）
      room.lastPositions.set(m.id, { x: pos.x, y: pos.y, z: pos.z });
      const st = room.afk.get(m.id);
      if (!st) {
        room.afk.set(m.id, { x: pos.x, y: pos.y, z: pos.z, idleMs: 0 });
        continue;
      }
      const dx = pos.x - st.x;
      const dy = pos.y - st.y;
      const dz = pos.z - st.z;
      if (Math.hypot(dx, dy, dz) < AFK_MOVE_EPS) {
        const idleMs = st.idleMs + AFK_TICK_MS;
        if (idleMs >= AFK_IDLE_MS) {
          room.afk.delete(m.id);
          sysMsg(m, "race", "挂机时间过长，已移出比赛", "info");
          leaveRace(m);
          continue;
        }
        if (idleMs >= AFK_WARN_MS && st.idleMs < AFK_WARN_MS) {
          sysMsg(m, "race", "检测到长时间静止，即将移出比赛（挂机检测）", "warn");
        }
        room.afk.set(m.id, { x: pos.x, y: pos.y, z: pos.z, idleMs });
      } else {
        // 位移恢复：取消本次挂机累计。若之前已处于警告区（提示过"即将移出"），
        // 玩家动起来要明确告知"已取消"——否则刚收到警告又没了下文，困惑
        if (st.idleMs >= AFK_WARN_MS) {
          sysMsg(m, "race", "已检测到移动，取消挂机移出", "success");
        }
        room.afk.set(m.id, { x: pos.x, y: pos.y, z: pos.z, idleMs: 0 });
      }
    }
    // 采集成员快照与进度
    const rows: {
      playerId: number;
      totalCp: number; // 完成 CP 总数（圈数 x CP数 + 当前圈内 CP）
      dist: number; // 距下一个 CP 距离
      finished: boolean;
      time: number;
    }[] = [];
    for (const m of getRacers(room)) {
      const mp = playerRaces.get(m.id);
      if (!mp) continue;
      const totalCp = mp.lap * room.cps.length + (mp.cpIndex + 1);
      let dist = 0;
      const nextCp = room.cps[mp.cpIndex + 1];
      if (nextCp && !mp.finished) {
        // 复用 AFK 循环刚采样的位置（room.lastPositions，本 tick 已写入）——
        // 每成员每 200ms 省一次 native getPos
        const lp = room.lastPositions.get(m.id);
        if (lp) {
          dist = Math.hypot(lp.x - nextCp.x, lp.y - nextCp.y, lp.z - nextCp.z);
        }
      }
      rows.push({
        playerId: m.id,
        totalCp,
        dist,
        finished: mp.finished,
        time: mp.finished ? (room.resultIndex.get(m.id) ?? 0) : 0,
      });
    }
    // 掉线重连窗口玩家：按掉线前快照继续参与排名（车停在原地，被在线玩家超越，
    // 但名次仍占着——重连成功后恢复真实位置重新计算）
    for (const uid of room.reconnectUntil.keys()) {
      const slot = room.reconnectSlots.get(uid);
      if (!slot) continue;
      rows.push({
        playerId: slot.playerId,
        totalCp: slot.lap * room.cps.length + (slot.cpIndex + 1),
        dist: slot.dist,
        finished: false,
        time: 0,
      });
    }
    // 排序：完成者（按用时升序）> 未完成者（CP 多优先，同 CP 距离近优先）
    rows.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.time - b.time;
      if (a.totalCp !== b.totalCp) return b.totalCp - a.totalCp;
      return a.dist - b.dist;
    });
    // 更新每人比赛信息 TD：TIME（对齐原版 RaceRunTime 计时）+ RANK（对齐原版
    // RaceRunRank 排名）。CP/BEST 由事件驱动更新（过 CP / 进比赛 / 跑完 PB），不在此刷。
    // 挑战限时模式（challengeTierSeconds>0）：TIME 由 syncRaceTds 60fps 倒计时
    // 独占（本 200ms 只写 RANK，避免两定时器互相覆盖倒计时）；已完成者 TIME 定格
    // 由 finishPlayer 写最终用时，不在此覆盖。非挑战模式保持原逻辑（TIME+RANK 都写）。
    const limitMode = room.challengeTierSeconds > 0;
    rows.forEach((r, rank) => {
      const mp = playerRaces.get(r.playerId);
      if (!mp) return;
      // 名次写入缓存：60fps syncRaceTds 只读 mp.rank / tdTextCache 重放文本，
      // 不重算排名（距离采样 + 排序保持 200ms 粒度，高频刷新零重计算）
      mp.rank = rank;
      // 实时名次写入录制帧（回放 RANK TD 按播放进度实时显示；与 CP 进度同为
      // 事件驱动——无录制会话时零开销）
      noteRank(r.playerId, rank + 1);
      const rankText = `RANK / ${rank + 1} ${rankSuffix(rank)}`;
      if (limitMode) {
        setRaceTdText(room, r.playerId, null, rankText);
        for (const oid of getObserverIdsOf(r.playerId)) {
          setRaceTdText(room, oid, null, rankText);
        }
      } else {
        const time = mp.finished ? r.time : now - mp.startTime;
        const timeText = `TIME / ${formatRaceTimeCs(time)}`;
        setRaceTdText(room, r.playerId, timeText, rankText);
        // 观战者同步：观察该玩家的玩家显示同样的 TIME/RANK（对齐原版 RaceRunTime/
        // RaceRunRank 里对观战者的 TD 同步——观战者看到被观战者的比赛信息）
        for (const oid of getObserverIdsOf(r.playerId)) {
          setRaceTdText(room, oid, timeText, rankText);
        }
      }
    });
  }
}

/** 启动比赛持久 tick（实时排名 + 比赛 TD 刷新；onInit 注册、onExit 统一清理） */
export function startRaceTicks(): void {
  // 实时排名定时器
  setIntervalSafe(() => tickRooms(), 200);
  // 比赛信息 TD 高频刷新（60fps，对齐回放观战效果；只对变化内容调 native）
  setIntervalSafe(() => syncRaceTds(), 16);
}

/** 初始化比赛系统（事件注册，模块加载时注册一次） */
export function initRaceSystem(): void {
  // /r(race) 命令入口（/r s|j|l|info|create|edit|page + 赛道列表）已拆到 roomUi.ts 的
  // initRaceUi()，callbacks 里在 initRaceSystem() 后调用——本函数只管比赛核心事件。

  // 观战者 CP 箭头同步：观察者开始观战（/tv / 切换目标 / 完赛自动观战）时若目标是
  // 房间成员 → 立即摆上其当前 CP；停止观战/断线/切换时清除。清理集中在钩子 +
  // 房间销毁（cleanupSpectatorCpForRoom），无独立实体残留
  initCpArrowSync();

  // 观战作用域：比赛房间内只允许观战本房间成员（observe 侧的房间范围限制）。
  // observer 在房间中（WAITING/COUNTDOWN/RACING）→ 返回成员 id 列表；离开/房间
  // 销毁后 provider 返回 null，自动回到全局观战。provider 每次切换时现算，成员
  // 进出房间即时生效；observe 不 import race，依赖方向仍是 race → core。
  setObserveScopeProvider((observerId) => {
    const pr = playerRaces.get(observerId);
    if (!pr) return null;
    const room = rooms.get(pr.roomId);
    if (!room || room.state === "FINISHED") return null;
    // 只允许观战参赛者（观众不能看其他观众；racer 也只能看 racer）
    const racerIds = getRacers(room).map((m) => m.id);
    // 比赛中/倒计时中的未完成参赛者禁止观战（车停在赛道会干扰/AFK，OB 请赛前
    // 加入观众席）；已完赛者允许自动观战下一个选手
    const racerBlocked = pr.role === "racer" && room.state !== "WAITING" && !pr.finished;
    return {
      label: "比赛房间",
      memberIds: racerIds,
      // 观众席目标失效（完赛/离开/掉线）时自动切下一个参赛者，不弹“停止观战”
      autoRetarget: pr.role === "spectator",
      blockedReason: racerBlocked
        ? "比赛进行中，参赛者不能观战（开赛前可加入观众席，或 /r l 离开比赛）"
        : undefined,
    };
  });

  // 到达检查点事件
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    // 统一排除 NPC（对齐项目约定：所有事件回调排除 NPC）
    if (player.isNpc()) return next();
    if (isInRace(player.id) && !isEditing(player.id)) {
      void onPlayerReachCp(player);
    }
    return next();
  });

  // 比赛中的命令隔离：非白名单命令一律拒绝
  // 注意：onCommandReceived 的 command 是完整命令串（如 "r l"），strictMainCmd
  // 是主命令（"r"），但运行时可能为 undefined——必须回退到 command 的第一个
  // token 取主命令，否则 /r l /r j /r s 全被当成未授权命令拦截
  PlayerEvent.onCommandReceived(({ player, command, strictMainCmd, next }) => {
    if (!isInRace(player.id)) return next();
    const main = (strictMainCmd || command.split(/\s+/)[0] || "").toLowerCase();
    if (isRaceCommandAllowed(main)) return next();
    sysMsg(player, "match", "比赛中只能使用 /r l 离开、/pm 私聊、/tv 观战或 /kill 重生", "error");
    return false;
  }, true); // unshift 优先执行（在限频之前，避免双提示）

  // /kill 重生（原版比赛中允许）
  PlayerEvent.onCommandText("kill", async ({ player, next }) => {
    if (player.isWasted()) {
      sysMsg(player, "system", "生命值为空，请等待重生", "plain");
      return next();
    }
    if (!isInRace(player.id)) {
      // 非比赛：自杀（对齐原版 /kill）
      player.setHealth(0);
      return next();
    }
    const pr = getRacePlayerState(player.id);
    const room = pr ? getRaceRoom(pr.roomId) : undefined;
    if (pr && pr.role === "spectator") {
      sysMsg(player, "race", "观众席不能重生；开赛前想参赛请 /r race 回到比赛", "warn");
      return next();
    }
    if (pr?.finished) {
      sysMsg(player, "race", "你已完成比赛，请等待结算/观战", "info");
      return next();
    }
    if (room && room.state === "RACING") {
      // 比赛中：直接回到上一 CP（/kill 在比赛中 = 重置回上一个检查点）
      await respawnToLastCp(player, pr!, room);
      return next();
    }
    // 在比赛房间但未开跑（WAITING/COUNTDOWN）：没有比赛进度，正常重生。
    // 不能直接 player.spawn()——加入房间后 spawnInfo 仍是主世界的（旧位置/随机
    // 点），spawn 会重生到主世界坐标而虚拟世界还在房间世界（玩家被传去地图另一
    // 端）。定位回起点（第一 CP）再重生
    if (room) {
      await respawnAtRoomStart(player);
    } else {
      sysMsg(player, "race", "比赛尚未开始，已正常重生", "info");
      player.spawn();
    }
    return next();
  });

  // 比赛中死亡：重生回上一 CP（原版 updateSpeedometer 防卡住检测驱动）
  PlayerEvent.onDeath(({ player, next }) => {
    if (isInRace(player.id)) {
      const pr = getRacePlayerState(player.id);
      const room = pr ? getRaceRoom(pr.roomId) : undefined;
      if (room && room.state === "RACING" && pr?.role === "racer" && !pr.finished) {
        // 死亡后需要重新出生（补车要 await 查库，事件里不阻塞 next()）
        void respawnPlayerToCp(player, pr, room);
      }
    }
    return next();
  });

  // 比赛中座驾被毁（爆炸/损毁，respawnDelay=0 不会自动重生）：司机存活 → 当场刷
  // 默认比赛车继续；司机死亡 → 由上面的死亡重生路径兜底补车（respawnPlayerToCp 的
  // "车已毁则刷默认比赛车"），这里不重复刷。否则爆车后玩家只能步行跑完（原版
  // respawnDelay 车死后也是重建 + PutPlayerInVehicle 语义）。
  VehicleEvent.onDeath(({ vehicle, next }) => {
    const driver = vehicle.getLastDriver();
    if (
      driver &&
      driver.isConnected() &&
      !driver.isNpc() &&
      !driver.isWasted() &&
      isInRace(driver.id)
    ) {
      const pr = getRacePlayerState(driver.id);
      const room = pr ? getRaceRoom(pr.roomId) : undefined;
      if (
        room &&
        room.state === "RACING" &&
        pr?.role === "racer" &&
        !pr.finished &&
        getOwnedVehicle(driver.id) === vehicle
      ) {
        destroyPlayerVehicle(driver.id); // 清理爆炸后残留的失效实体引用
        void spawnVehicle(driver, getDefaultRaceModel(room.cps), true);
        sysMsg(driver, "race", "车辆已损毁，自动刷出比赛用车", "info");
      }
    }
    return next();
  });
}

// —— 对外公开 API（模块拆分后统一从这里导入；外部模块无感知，导入面保持不变）——
export {
  UUID_RE,
  RACE_WORLD_BASE,
  isInRace,
  getRacePlayerState,
  getRaceRoom,
  broadcastToRoom,
} from "./state";
export { cleanupRacePlayer, tryReconnectRace } from "./reconnect";
export { respawnToLastCp, rollbackToPrevCp } from "./respawn";
export type { PlayerRace, RaceRoom, CpSnapshot, RoomRaceTds, RaceRoomState } from "./types";
