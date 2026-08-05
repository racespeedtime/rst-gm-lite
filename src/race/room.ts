import {
  Dialog,
  DialogStylesEnum,
  GameText,
  Player,
  PlayerEvent,
  RaceCheckpoint,
  RaceCpEvent,
  TextDraw,
  VehicleEvent,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle, spawnVehicle, destroyPlayerVehicle } from "@/vehicles";
import { execCpScript, cleanupScriptVehicle, type CpScriptContext } from "./scripts";
import { isEditing, enterRaceEdit, canEditRace, addCp, showEditMenu, exitEdit } from "./editor";
import { applyRaceNoCollision, restorePersonalNoCollision, getDefaultRaceModel } from "./vehicle";
import { setIntervalSafe, setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";
import {
  raceRecordingStart,
  raceRecordingStop,
  stopReplayForPlayer,
  discardRaceReplay,
} from "@/replay";
import {
  noteCpProgress,
  stopRecording,
  isRecording,
  getRecording,
  suspendRecording,
  resumeRecording,
  dropRecording,
  rebindRecording,
} from "@/replay/recorder";
import {
  startObservePlayer,
  stopObserve,
  isObserving,
  cleanupObserve,
  getObserverIdsOf,
} from "@/core/observe";
import { getSafeGroundZ } from "@/core/colandreas";
import { applyWorldEnv, getWorldWeather } from "@/core/worldenv";
import { sessionManager } from "@/sessions/manager";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { formatTime } from "@/utils/format";
import { showPagedDialog } from "@/utils/pagedDialog";
import { pickOption } from "@/personalize/settings";
import { showDialog } from "@/utils/dialog";
import { MIN_Z } from "@/utils/map";
import { COLOR_RACE, COLOR_SUCCESS, COLOR_ERROR, COLOR_WHITE } from "@/utils/colors";

/** 第一名完成后的结束倒计时（秒） */
const END_GRACE_MS = 20_000;
/** UUID 格式（/r s 按 id 查询前校验，避免非法字符串触发 uuid 类型错误） */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 比赛小地图图标索引（对齐原版 RACE_MAP_ICON_INDEX=1，避开大世界 map_icon 的 0-69） */
const RACE_MAP_ICON_NEXT = 70;
/** 比赛小地图图标类型：56 = 赛车 CP 预览图标（原版 RACE_MAP_ICON_TYPE） */
const RACE_MAP_ICON_TYPE_NEXT = 56;
/** 比赛房间独立世界起始 id（战局上限 1000，比赛从 1001 起；回放/挑战世界从
 *   REPLAY_WORLD_BASE=2001 起，两区间各 1000 个互不叠加） */
export const RACE_WORLD_BASE = 1001;
let nextRaceWorldId = RACE_WORLD_BASE;
/**
 * 已销毁房间释放的比赛世界 id（复用防无界增长）：
 * 房间创建/销毁非常频繁（每人一房、结束即销毁），若只递增不复用，长期运行
 * 约 1000 个房间后 worldId 会追上回放世界基准 2001（REPLAY_WORLD_BASE），
 * 造成比赛与回放/挑战世界互相可见（跨世界实体穿模）。销毁时回收、创建时先取。
 */
const freedRaceWorlds: number[] = [];

function allocRaceWorld(): number {
  return freedRaceWorlds.pop() ?? nextRaceWorldId++;
}

function freeRaceWorld(worldId: number): void {
  // 只回收本模块分配的 id（防误收外部世界；RACE_WORLD_BASE 之上都属本模块）
  if (worldId >= RACE_WORLD_BASE) freedRaceWorlds.push(worldId);
}

/** 比赛房间状态 */
type RaceRoomState = "WAITING" | "COUNTDOWN" | "RACING" | "FINISHED";

/** 玩家比赛状态（含圈数进度） */
interface PlayerRace {
  roomId: number;
  cpIndex: number; // 当前已通过的最大 CP 下标（-1 = 未过任何 CP）
  lap: number; // 当前圈（0 = 第一圈，laps-1 = 最后一圈）
  startTime: number;
  finished: boolean;
  /** 加入比赛前的世界（开赛切独立世界，离开/结束时恢复） */
  prevWorld: number;
}

/** 比赛信息 UI（对齐原版 CreatePRaceTextDraw 的 4 行独立 TD） */
interface RoomRaceTds {
  cp: TextDraw; //   C  P / ~p~进度~w~/~y~总数
  time: TextDraw; // TIME / mm:ss.cc
  best: TextDraw; // BEST / mm:ss.cc（无记录 99:99:99）
  rank: TextDraw; // RANK / N st/nd/rd/th
}

/** 比赛房间 */
interface RaceRoom {
  id: number;
  raceId: string;
  raceName: string;
  authorName: string; // 赛道作者名（CP 脚本 #aname 变量，创建时预载避免逐脚本查库）
  laps: number; // 圈数（赛道配置）
  worldId: number; // 比赛独立世界（开赛时成员切换）
  ownerId: number;
  ownerUserId: string; // 房主 userId（重连恢复房主身份用）
  state: RaceRoomState;
  members: Map<number, Player>;
  cps: {
    index: number;
    id: string;
    x: number;
    y: number;
    z: number;
    angle: number;
    size: number;
    scripts: string[];
  }[];
  results: { playerId: number; time: number; name: string }[];
  /** CP 触发冷却：playerId -> 上次判定时间（防刷圈） */
  lastCpAt: Map<number, number>;
  countdownTimer?: NodeJS.Timeout;
  endTimer?: NodeJS.Timeout;
  /** 每个成员的比赛信息 TextDraw（playerId -> 4 行 TD，开赛时创建） */
  raceTextTds: Map<number, RoomRaceTds>;
  /** 赛道个人最佳缓存（userId -> 最佳毫秒，开赛时查一次；重连复用） */
  bestTimes: Map<string, number>;
  /** 完成结果索引（playerId -> time），避免每 tick 线性查找 */
  resultIndex: Map<number, number>;
  /** 创建时间（WAITING 超时回收） */
  createdAt: number;
  /** 掉线重连：userId -> 重连截止时间戳（窗口内不清理）。
   *  用 userId 而非 playerId 作 key：掉线期间 playerId 可能被新连接复用，
   *  新玩家若命中旧窗口会劫持旧玩家的进度/名次/房主。 */
  reconnectUntil: Map<string, number>;
  /** 掉线重连：userId -> 断线时进度快照（含距下一 CP 距离——掉线玩家按快照
   *  继续参与实时/最终排名，车停在原地被超越）。slot.playerId 为掉线时的
   *  playerId：重连成功且 id 变化时用它把挂起的录制会话迁移到新 playerId；
   *  超时落盘时也用它找挂起会话 */
  reconnectSlots: Map<
    string,
    {
      playerId: number;
      cpIndex: number;
      lap: number;
      startTime: number;
      prevWorld: number;
      dist: number;
      name: string;
    }
  >;
  /** 本场比赛参与过录制的成员（playerId → userId 快照：房间销毁且无人完成时
   *  据此作废其未完成录像。存 userId 而非在线查 auth——掉线/重连超时者 auth
   *  已清，离线作废依赖此快照） */
  raceMembersLast: Map<number, string>;
  /** 开赛时按房主设置定的房间统一时间天气（重连玩家是新连接，恢复用；
   *  CP 脚本改时间天气后由脚本路径直接 setTime/setWeather，不更新此缓存） */
  roomTime: { hour: number; minute: number };
  roomWeather: number;
}

const rooms = new Map<number, RaceRoom>();
const playerRaces = new Map<number, PlayerRace>();
let nextRoomId = 1;
/** 重连窗口参数：预计时长 × 20%，上限 5 分钟、下限 30 秒；<2.5 分钟不支持 */
const RECONNECT_RATIO = 0.2;
const RECONNECT_MAX_MS = 5 * 60_000;
const RECONNECT_MIN_MS = 30_000;
const RECONNECT_SUPPORT_MIN_MS = 2.5 * 60_000;

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

/**
 * 比赛中允许的主命令白名单（对齐原版 GP:545-622）：
 * /r(race) 比赛管理 · /pm 私聊 · /kill 重生 · /tv(ob/spec) 观战 · /p(panel) 万能面板
 * 匹配的是主命令（strictMainCmd），如 "/r l" 的主命令是 "r"。
 * 其余命令一律拒绝。
 * p/panel 必须在白名单内：观战（spect）模式下客户端不发按键收不到 Y 键，
 * 只能靠 /p 开面板——比赛结束自动观战的玩家若不放行 /p 将彻底打不开面板。
 */
const RACE_SAFE_COMMANDS = new Set(["r", "race", "pm", "kill", "tv", "ob", "spec", "p", "panel"]);

export function isRaceCommandAllowed(command: string): boolean {
  return RACE_SAFE_COMMANDS.has(command);
}

/** 房间方法：广播 */
function broadcastToRoom(room: RaceRoom, msg: string): void {
  for (const m of room.members.values()) {
    m.sendClientMessage(COLOR_RACE, msg);
  }
}

/**
 * 恢复玩家离开比赛后的环境：切回原世界 + 按个人设置恢复时间天气。
 * 车辆：玩家坐着的车切回；若玩家已下车，其爱车（playerVehs）也一并切回原世界
 * （防爱车遗留在比赛独立世界成为幽灵车，对齐原版 Race_Game_Quit 的车世界恢复）。
 */
function restorePlayerAfterRace(player: Player, prevWorld: number): void {
  if (!player.isConnected()) return;
  player.setVirtualWorld(prevWorld);
  if (player.isInAnyVehicle()) {
    player.getVehicle()!.setVirtualWorld(prevWorld);
  }
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid() && owned !== player.getVehicle()) {
    owned.setVirtualWorld(prevWorld);
  }
  // 按个人设置恢复时间天气（CP 脚本改过的 time/weather 在此重置）
  void applyWorldEnv(player);
}

/**
 * 估算比赛预计时长（毫秒）：总距离 / 平均速度（约 90 km/h = 25 m/s），再 ×圈数。
 * 用于重连窗口计算。
 */
function estimateRaceDurationMs(room: RaceRoom): number {
  // cps 是完整路线（每圈），总长 = 相邻 CP 距离和 × 圈数
  let total = 0;
  for (let i = 0; i < room.cps.length - 1; i++) {
    const dx = room.cps[i].x - room.cps[i + 1].x;
    const dy = room.cps[i].y - room.cps[i + 1].y;
    const dz = room.cps[i].z - room.cps[i + 1].z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const avgSpeed = 25; // m/s ≈ 90 km/h
  return (total / avgSpeed) * 1000 * room.laps;
}

/**
 * 玩家断线：进入重连窗口（不立即清成员/转移房主）。
 * - 短比赛（<2.5 分钟）不支持重连 → 走原断线逻辑
 * - 支持重连的比赛：记录进度快照 + 重连截止时间
 */
export function cleanupRacePlayer(playerId: number): void {
  const pr = playerRaces.get(playerId);
  if (pr) {
    const room = rooms.get(pr.roomId);
    if (room) {
      const tds = room.raceTextTds.get(playerId);
      if (tds) {
        for (const td of Object.values(tds)) {
          td.destroy();
        }
        room.raceTextTds.delete(playerId);
      }
      // 比赛中且比赛支持重连 → 进入重连窗口（已完成玩家不开窗口：成绩已纪录，防重连后重复完成）
      const estMs = estimateRaceDurationMs(room);
      if (room.state === "RACING" && !pr.finished && estMs >= RECONNECT_SUPPORT_MIN_MS) {
        // 窗口 key 用 userId（防 playerId 复用劫持）；auth 在断线时仍可用
        //（closePlayerSession 清 auth 在其后执行），取不到则回退 playerId 字符串
        const uid = getAuthState(playerId)?.userId ?? String(playerId);
        const window = Math.min(
          RECONNECT_MAX_MS,
          Math.max(RECONNECT_MIN_MS, estMs * RECONNECT_RATIO),
        );
        room.reconnectUntil.set(uid, Date.now() + window);
        // 快照含"距下一 CP 距离"：掉线玩家按掉线瞬间位置/CP 继续参与排名
        const nextCp = room.cps[pr.cpIndex + 1];
        let dist = 0;
        if (nextCp) {
          const pos = Player.getInstance(playerId)?.getPos();
          if (pos) dist = Math.hypot(pos.x - nextCp.x, pos.y - nextCp.y, pos.z - nextCp.z);
        }
        room.reconnectSlots.set(uid, {
          playerId,
          cpIndex: pr.cpIndex,
          lap: pr.lap,
          startTime: pr.startTime,
          prevWorld: pr.prevWorld,
          dist,
          name: Player.getInstance(playerId)?.getName().name ?? `玩家${playerId}`,
        });
        room.members.delete(playerId);
        playerRaces.delete(playerId);
        // 录制挂起：会话保持、掉线期间 fallbackSample 生成静止帧（车停在掉线
        // 位置、时间流逝），重连成功后 resume 续录——回放完整不中断，能看到
        // 掉线后车原地不动那段的帧。不落盘（forceStopRecording 会跳过挂起）。
        suspendRecording(playerId);
        // 断线期间脚本车辆销毁（重连后玩家自己重新刷车/用脚本）
        cleanupScriptVehicle(playerId);
        // 房主断线：窗口内不转移房主（重连恢复），但保留窗口
        broadcastToRoom(
          room,
          `[赛车] ${Player.getInstance(playerId)?.getName().name ?? "玩家"} 掉线，${Math.round(window / 1000)} 秒内可重连`,
        );
        cleanupObserve(playerId);
        return;
      }
      // 不支持重连或非比赛状态 → 原断线逻辑
      room.members.delete(playerId);
      // 房主掉线 → 转移房主
      if (room.ownerId === playerId) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `[赛车] 房主已掉线，${np?.getName().name ?? next} 成为新房主`);
        }
      }
      if (room.state === "WAITING") {
        broadcastToRoom(room, `[赛车] 一名玩家离开了比赛`);
      }
      checkRoomState(room);
    }
    playerRaces.delete(playerId);
  }
  // 脚本车辆（cveh）随玩家断线清理
  cleanupScriptVehicle(playerId);
  // 清理观战状态（被观战者/观战者掉线）
  cleanupObserve(playerId);
}

/** 清理过期的重连窗口（tickRooms 调用）：窗口到期的玩家彻底移出房间 */
function cleanupExpiredReconnects(room: RaceRoom): void {
  const now = Date.now();
  for (const [uid, until] of room.reconnectUntil) {
    if (now >= until) {
      const slot = room.reconnectSlots.get(uid);
      room.reconnectUntil.delete(uid);
      room.reconnectSlots.delete(uid);
      // 重连超时：挂起中的录制落盘保留（未完成段，含掉线静止帧——玩家没回来，
      // 录像停在原地；无人完成则由房间销毁路径作废）。用 slot.playerId（掉线时
      // 的 id）找挂起会话——挂起会话键控在 playerId 上
      if (slot && isRecording(slot.playerId)) {
        void stopRecording(slot.playerId, { quiet: true });
      }
      // 房主重连窗口过期 → 转移房主
      if (slot && room.ownerUserId === uid) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `[赛车] 房主重连超时，${np?.getName().name ?? next} 成为新房主`);
        }
      }
    }
  }
  checkRoomState(room);
}

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
    player.sendClientMessage(COLOR_ERROR, "你已在比赛中");
    return null;
  }
  // 编辑模式（/redit 赛道编辑器）中禁止进比赛：编辑器脚本车/CP 状态与比赛
  // 房间冲突，否则会卡在第一 CP 无法推进、编辑器车残留在世界
  if (isEditing(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "赛道编辑中不能创建比赛，先 /redit 退出编辑");
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
        player.sendClientMessage(COLOR_ERROR, "赛道不存在或未启用");
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
      player.sendClientMessage(COLOR_ERROR, "该赛道至少需要 2 个检查点");
      return null;
    }
  }
  if (!race) {
    player.sendClientMessage(COLOR_ERROR, "暂无可用赛道");
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
    lastCpAt: new Map(),
    raceTextTds: new Map(),
    bestTimes: new Map(),
    resultIndex: new Map(),
    createdAt: Date.now(),
    reconnectUntil: new Map(),
    reconnectSlots: new Map(),
    raceMembersLast: new Map(),
    // 房间统一时间天气：beginRace 时按房主设置填充
    roomTime: { hour: 12, minute: 0 },
    roomWeather: 0,
  };
  rooms.set(room.id, room);
  await joinRoom(player, room);
  player.sendClientMessage(
    COLOR_SUCCESS,
    `比赛房间已创建，赛道「${race.name}」（${room.laps} 圈），输入 /r j 可加入`,
  );
  return room;
}

/**
 * 房主更换房间赛道（WAITING 阶段，开赛后锁定）。
 * raceId 为空 → 随机换一张（全部随机）。
 * 更新房间赛道数据 + 重定位所有成员（起点 + TD 刷新 + CP 箭头重建）。
 */
export async function changeRoomTrack(player: Player, raceId?: string): Promise<boolean> {
  const pr = playerRaces.get(player.id);
  const room = pr ? rooms.get(pr.roomId) : undefined;
  if (!room) {
    player.sendClientMessage(COLOR_ERROR, "你不在比赛房间中");
    return false;
  }
  if (room.ownerId !== player.id) {
    player.sendClientMessage(COLOR_ERROR, "只有房主能更换赛道");
    return false;
  }
  if (room.state !== "WAITING") {
    player.sendClientMessage(COLOR_ERROR, "比赛已开始，不能更换赛道");
    return false;
  }
  const race = raceId
    ? await prisma.race.findUnique({ where: { id: raceId }, include: { sysUser: true } })
    : await pickRandomRace();
  if (!race || !race.isEnabled || race.deletedAt) {
    player.sendClientMessage(COLOR_ERROR, "赛道不存在或未启用");
    return false;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId: race.id },
    orderBy: { index: "asc" },
    include: { raceCpScripts: { orderBy: { index: "asc" } } },
  });
  if (cps.length < 2) {
    player.sendClientMessage(COLOR_ERROR, "该赛道至少需要 2 个检查点");
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
  // 重定位所有成员：进度重置 + 起点 + TD 刷新 + CP 箭头重建
  for (const m of room.members.values()) {
    const mp = playerRaces.get(m.id);
    if (!mp) continue;
    mp.cpIndex = -1;
    mp.lap = 0;
    mp.startTime = 0;
    await positionPlayerAtStart(m, room);
  }
  broadcastToRoom(room, `[赛车] 房主将赛道更换为「${race.name}」，成员已移至起点`);
  return true;
}

/**
 * 房主重开当前赛道比赛（同一赛道重置回 WAITING）：
 * 中断进行中的比赛（清倒计时/结束定时器 + 排名/进度数据），所有成员回起点 +
 * 进度清零（含退出观战），房主再 /r s 或面板「开始比赛」重新开局。
 * 适用：单人房间跑一半想重来 / 倒计时中反悔 / 成员乱跑想重置。
 * 注：比赛结束（FINISHED）时房间已销毁（endRoom），重开需重新创建房间。
 */
export async function restartRace(player: Player): Promise<void> {
  const pr = playerRaces.get(player.id);
  const room = pr ? rooms.get(pr.roomId) : undefined;
  if (!room) {
    player.sendClientMessage(COLOR_ERROR, "你不在比赛房间中");
    return;
  }
  if (room.ownerId !== player.id) {
    player.sendClientMessage(COLOR_ERROR, "只有房主能重开比赛");
    return;
  }
  if (room.state === "FINISHED") {
    player.sendClientMessage(COLOR_ERROR, "比赛已结束（房间已解散），请重新创建比赛");
    return;
  }
  // 中断进行中的比赛（倒计时/结束宽限定时器清理）
  if (room.countdownTimer) clearTimeoutSafe(room.countdownTimer);
  if (room.endTimer) clearTimeoutSafe(room.endTimer);
  const wasRunning = room.state === "RACING" || room.state === "COUNTDOWN";
  room.state = "WAITING";
  // 重置 WAITING 超时基准：createdAt 是建房时刻，重开不清会被 tickRooms 的
  // "等待超时 10 分钟解散"立即命中（建房到重开累计超过 10 分钟的长赛道常见）
  room.createdAt = Date.now();
  // 清空排名/CP 进度数据（重开后从零开始）
  room.results = [];
  room.lastCpAt.clear();
  room.resultIndex.clear();
  // 清空掉线重连窗口：重开是新一场比赛，旧赛的窗口/进度快照不能带进新赛
  //（否则窗口玩家重连会用旧赛进度恢复——CP/排名/计时全错）
  room.reconnectUntil.clear();
  room.reconnectSlots.clear();
  // 成员重置：退出观战（防 putPlayerIn 无效）+ 进度清零 + 回起点 + TD/CP 重建
  for (const m of room.members.values()) {
    const mp = playerRaces.get(m.id);
    if (!mp) continue;
    if (isObserving(m.id)) stopObserve(m);
    mp.cpIndex = -1;
    mp.lap = 0;
    mp.startTime = 0;
    mp.finished = false;
    // 比赛中止重开：停止上一段的比赛自动录制并作废（整场无人完成，无成绩
    // 保留价值；discard 原子落盘即删文件不建 DB 记录），下一场开赛（beginRace）
    // 重新开始录制，两场成绩互不混入
    void stopRecording(m.id, { quiet: true, discard: true });
    await positionPlayerAtStart(m, room);
  }
  // 挂起中的掉线会话（掉线未重连）跨场丢弃：上一场已中止，静止段无续录意义
  for (const pid of room.raceMembersLast.keys()) {
    if (!playerRaces.has(pid) && isRecording(pid)) {
      dropRecording(pid);
    }
  }
  if (wasRunning) {
    broadcastToRoom(room, `[赛车] 房主重开了比赛（赛道不变「${room.raceName}」），成员已回到起点`);
  } else {
    player.sendClientMessage(COLOR_RACE, `已重置比赛（赛道 ${room.raceName}），成员已回到起点`);
  }
  player.sendClientMessage(COLOR_RACE, "输入 /r s 或面板「开始比赛」重新开局");
}

async function joinRoom(player: Player, room: RaceRoom): Promise<void> {
  // 已参与其他房间则先离开（防止 playerRaces 被覆盖、旧房间残留成员）
  if (isInRace(player.id)) {
    leaveRace(player);
  }
  // 进比赛：停止玩家正在播放的回放 + 影子挑战（比赛中 /rp 被白名单拦截无法
  // 主动停，挑战世界与比赛世界隔离——不清理会留下挂机 ghost）
  stopReplayForPlayer(player.id);
  // 观战中进比赛：退出观战（spectating 状态下 putPlayerIn/切世界均无效，
  // 否则整场比赛只能旁观无法开车，录制也采不到有效帧）
  if (isObserving(player.id)) {
    stopObserve(player);
  }
  room.members.set(player.id, player);
  room.raceMembersLast.set(player.id, getAuthState(player.id)?.userId ?? ""); // 登记本场录制成员（房间销毁作废用，userId 供离线作废）
  playerRaces.set(player.id, {
    roomId: room.id,
    cpIndex: -1,
    lap: 0,
    startTime: 0,
    finished: false,
    prevWorld: player.getVirtualWorld(),
  });
  await positionPlayerAtStart(player, room);
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
  // 提示：房主（创建者）不需要"等待房主开始"；无车兜底说明已刷默认比赛车
  const noCarHint = !getOwnedVehicle(player.id) ? "（无车已自动刷默认比赛车，可用 /c 换爱车）" : "";
  if (room.ownerId === player.id) {
    player.sendClientMessage(
      COLOR_RACE,
      `你加入了比赛房间（赛道 ${room.raceName}），输入 /r s 开始比赛${noCarHint}`,
    );
  } else {
    player.sendClientMessage(
      COLOR_RACE,
      `你加入了比赛房间（赛道 ${room.raceName}），等待房主开始${noCarHint}`,
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
  const first = room.cps[0];
  if (!first) return;
  // 换赛道时该成员已有旧赛道 TD → 先销毁重建（joinRoom 无旧 TD，天然跳过）
  const oldTds = room.raceTextTds.get(player.id);
  if (oldTds) {
    for (const td of Object.values(oldTds)) {
      if (td.isValid()) td.destroy();
    }
    room.raceTextTds.delete(player.id);
  }
  const defaultModel = getDefaultRaceModel(room.cps);
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    // 有爱车：模型 = 赛道标准车型 → 直接用；模型不同 → 重刷成标准车型爱车
    // （销毁旧车 + 懒创建，玩家始终以标准车参赛）
    if (owned.getModel() !== defaultModel) {
      await spawnVehicle(player, defaultModel, true);
      player.sendClientMessage(
        COLOR_RACE,
        `[赛车] 本赛道标准车型为 ${defaultModel}，已切换为对应爱车`,
      );
    }
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(first.angle);
      veh.putPlayerIn(player, 0);
      player.setFacingAngle(first.angle); // putPlayerIn 后视角跟随车辆朝向的兜底
    }
  } else if (player.isInAnyVehicle()) {
    // 没爱车但人在某辆车里：若是标准车型 → 挪当前车；否则也以标准车型刷爱车
    const veh = player.getVehicle()!;
    if (veh.getModel() === defaultModel) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(first.angle);
      player.setFacingAngle(first.angle); // 车内旋转车辆后玩家朝向同步（防视角没跟上）
    } else {
      await spawnVehicle(player, defaultModel, true);
      player.sendClientMessage(
        COLOR_RACE,
        `[赛车] 本赛道标准车型为 ${defaultModel}，已刷为对应爱车`,
      );
      const v = getOwnedVehicle(player.id);
      if (v && v.isValid()) {
        v.setPos(first.x, first.y, first.z);
        v.setZAngle(first.angle);
        player.setFacingAngle(first.angle);
      }
    }
  } else {
    // 都没 → 用标准车型刷爱车（有该模型爱车则复用外观，没有则自动创建
    // 成爱车——玩家始终用自己的爱车比赛），原地放入
    await spawnVehicle(player, defaultModel, true);
    const veh = getOwnedVehicle(player.id);
    if (veh && veh.isValid()) {
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(first.angle);
      player.setFacingAngle(first.angle);
    }
  }
  // 创建比赛信息 UI（加入房间即显示，对齐原版 Race_Game_Join → CreatePRaceTextDraw；
  // 倒计时/开赛不再重建；换赛道时需先销毁旧的再重建）
  const tds = createRaceTd(player, room);
  void updateBestTd(player, room, tds);
  // 显示第一个 CP（红色箭头指向第二个；open.mp 切换世界不改变坐标，
  // 开赛切到比赛世界后仍站在同一位置，beginRace 的 setPos 幂等保留）
  showNextCheckpoint(player, room.cps, -1);
}

/** 房主开始比赛：倒计时 5s */
export async function startRace(player: Player): Promise<void> {
  const pr = playerRaces.get(player.id);
  if (!pr) return;
  const room = rooms.get(pr.roomId);
  if (!room) return;
  if (room.ownerId !== player.id) {
    player.sendClientMessage(COLOR_ERROR, "只有房主能开始比赛");
    return;
  }
  if (room.state !== "WAITING") {
    player.sendClientMessage(COLOR_ERROR, "比赛已开始");
    return;
  }
  room.state = "COUNTDOWN";
  broadcastToRoom(room, "[赛车] 比赛倒计时开始！");
  let count = 5;
  const countdown = () => {
    if (room.state !== "COUNTDOWN") return;
    if (count <= 0) {
      beginRace(room);
      return;
    }
    // 倒计时：黄色数字（对齐原版 ~y~N）+ 音效 1056
    const gt = new GameText(`~y~${count}`, 850, 3);
    for (const m of room.members.values()) {
      if (!m.isConnected()) continue;
      gt.forPlayer(m);
      m.playSound(1056);
    }
    count--;
    room.countdownTimer = setTimeoutSafe(countdown, 1000);
  };
  countdown();
}

/** 正式开赛：切独立世界 + 统一设置房间天气时间 */
function beginRace(room: RaceRoom): void {
  room.state = "RACING";
  const now = Date.now();
  // 房间统一天气时间：按房主设置（syncGameTime 则跟随服务器真实时间，否则用房主 timeHour/timeMinute）
  void (async () => {
    const nowTime = new Date();
    let hour = nowTime.getHours();
    let minute = nowTime.getMinutes();
    let weather = getWorldWeather();
    const ownerAuth = getAuthState(room.ownerId);
    if (ownerAuth) {
      const setting = await prisma.sysUserSetting.findUnique({
        where: { userId: ownerAuth.userId },
      });
      if (setting) {
        if (!setting.syncGameTime) {
          hour = setting.timeHour;
          minute = setting.timeMinute;
        }
        if (!setting.syncWorldWeather) {
          weather = setting.weather;
        }
      }
    }
    for (const m of room.members.values()) {
      if (!m.isConnected()) continue;
      m.setTime(hour, minute);
      m.setWeather(weather);
    }
    // 缓存房间统一时间天气：重连玩家是新连接，按此恢复（与房间其他成员一致）
    room.roomTime = { hour, minute };
    room.roomWeather = weather;
  })();
  for (const m of room.members.values()) {
    const mp = playerRaces.get(m.id);
    if (mp) {
      mp.cpIndex = -1;
      mp.lap = 0;
      mp.startTime = now;
      mp.finished = false;
      // 比赛中强制无碰撞（防他人车辆穿模阻挡），结束/离开时按个人设置恢复
      applyRaceNoCollision(m, true);
      // 切到比赛独立世界（车辆同步）
      m.setVirtualWorld(room.worldId);
      if (m.isInAnyVehicle()) {
        m.getVehicle()!.setVirtualWorld(room.worldId);
      }
      // 发车（对齐原版 Race_Game_Start_s）：不把玩家传送到第一个 CP——加入房间时
      // 已在起点定位（joinRoom），倒计时/等待期间可在起点自由活动，发车瞬间不应被拉回起点。
      if (!m.isInAnyVehicle() && !getOwnedVehicle(m.id)) {
        // 无车兜底（等待期间车辆被销毁等极端情况）：用默认比赛车型刷爱车
        //（有该模型爱车则复用其外观，没有则自动创建成爱车——玩家始终用自己的
        // 爱车），在玩家当前位置创建并放入，不移动玩家。有爱车停在旁边时不动
        //（spawnVehicle 内部会 destroyPlayerVehicle 销毁旧车再重建，会把停在
        // 停车位/起飞点前的爱车无谓销毁）
        void spawnVehicle(m, getDefaultRaceModel(room.cps), true);
      }
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
      // 显示起点 CP 箭头（红圈在起点、箭头指向第一个 CP；小地图图标在下一个 CP，对齐原版）
      showNextCheckpoint(m, room.cps, -1);
      // 比赛信息 UI（C P/TIME/BEST/RANK）已在加入房间时创建（joinRoom），
      // 开赛重置 TIME 显示为 0（tickRooms 开始计时刷新）
      const tds = room.raceTextTds.get(m.id);
      if (tds) {
        tds.cp.setString(`C  P / ~p~1~w~/~y~${room.cps.length}`);
        tds.time.setString("TIME / 00:00:00");
        tds.rank.setString("RANK / 1 st");
      }
    }
  }
  // 开始提示：对齐原版 ~y~Start! + 音效 1057 + 恢复第三人称视角
  const go = new GameText("~y~Start!", 850, 3);
  for (const m of room.members.values()) {
    if (!m.isConnected()) continue;
    go.forPlayer(m);
    m.playSound(1057);
    m.setCameraBehind();
  }
  broadcastToRoom(room, "[赛车] 比赛开始！");
}

/** 比赛信息 UI 通用样式（对齐原版 CreatePRaceTextDraw）：
 * font 2 / letter 0.238 x 1.19 / 左对齐 / 白 / outline 0 / shadow 1 / 无底色。
 * TextDraw 必须先 create() 再设置属性（否则抛 "Cannot set font before create"）。 */
function raceTdBase(player: Player, y: number, text: string): TextDraw {
  return new TextDraw({ player, x: 500, y, text })
    .create()
    .setFont(2)
    .setLetterSize(0.238, 1.19)
    .setAlignment(1)
    .setColor(0xffffffff)
    .setOutline(0)
    .setShadow(1)
    .setProportional(true);
}

/** 创建比赛信息 UI（每人 4 行独立 TD，位置与原版一致：x 500 左缘，y 118/136/154/172） */
function createRaceTd(player: Player, room: RaceRoom): RoomRaceTds {
  const tds: RoomRaceTds = {
    cp: raceTdBase(player, 118, `C  P / ~p~1~w~/~y~${room.cps.length}`),
    time: raceTdBase(player, 136, "TIME / 00:00:00"),
    best: raceTdBase(player, 154, "BEST / 00:00:00"),
    rank: raceTdBase(player, 172, "RANK / 1 st"),
  };
  Object.values(tds).forEach((t) => t.show(player));
  room.raceTextTds.set(player.id, tds);
  return tds;
}

/** 毫秒 → mm:ss.cc（两位百分秒，对齐原版 ms2time 后 msg[2]/10） */
function formatRaceTime(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(cs).padStart(2, "0")}`;
}

/** 排名后缀（对齐原版 RANK / %i st/nd/rd/th） */
function rankSuffix(rank: number): string {
  const n = rank + 1;
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

/** 查询赛道个人最佳并更新 BEST TD（对齐原版进比赛时 Race_GetPlayerRecord：
 * 无记录显示 BEST / 99:99:99，有记录显示 BEST / mm:ss.cc）。房间级缓存，只查一次。 */
async function updateBestTd(player: Player, room: RaceRoom, tds: RoomRaceTds): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  try {
    let best = room.bestTimes.get(auth.userId);
    if (best === undefined) {
      const rec = await prisma.raceRecord.findFirst({
        where: { userId: auth.userId, raceId: room.raceId, deletedAt: null },
        orderBy: { record: "asc" },
      });
      best = rec ? rec.record : -1;
      room.bestTimes.set(auth.userId, best);
    }
    tds.best.setString(best === -1 ? "BEST / 99:99:99" : `BEST / ${formatRaceTime(best)}`);
  } catch (e) {
    logger.error(`[race] 查询个人最佳失败 ${player.getName().name}`, e);
  }
}

/**
 * 显示下一个检查点箭头（红色=指向下一个CP，黄色=终点CP）。
 * 对齐原版 Race_ShowCp：
 * - RaceCheckpoint 红圈在"当前要过的 CP"（nxt）、箭头指向下一个（nxt2）
 * - 小地图图标在"下一个 CP"（nrcp = nxt2），类型 56 + color 0 + style 1
 * - nxt 是最后一个 CP（无 nxt2）→ 终点黄圈；原版该分支不调 SetPlayerMapIcon，
 *   图标保留在上一个位置（标记终点），不主动清除
 */
function showNextCheckpoint(player: Player, cps: RaceRoom["cps"], cpIndex: number): void {
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
function clearRaceMapIcons(player: Player): void {
  if (!player.isConnected()) return;
  player.removeMapIcon(RACE_MAP_ICON_NEXT);
}

/** 销毁房间所有比赛信息 TD（防未创建/已失效的 TD destroy 抛异常） */
function destroyRaceTds(room: RaceRoom): void {
  for (const tds of room.raceTextTds.values()) {
    for (const td of Object.values(tds)) {
      if (td.isValid()) {
        td.destroy();
      }
    }
  }
  room.raceTextTds.clear();
}

/** 玩家到达 CP（RaceCpEvent 触发） */
async function onPlayerReachCp(player: Player): Promise<void> {
  const pr = playerRaces.get(player.id);
  if (!pr) return;
  const room = rooms.get(pr.roomId);
  if (!room) return;
  if (room.state !== "RACING" || pr.finished) return;

  // 目标 CP = 当前进度 + 1
  const nextCp = room.cps[pr.cpIndex + 1];
  if (!nextCp) return;

  // 防刷圈：同一点 1 秒内重复触发忽略
  const now = Date.now();
  const last = room.lastCpAt.get(player.id) ?? 0;
  if (now - last < 1000) return;
  room.lastCpAt.set(player.id, now);

  pr.cpIndex++;

  // 回放录制：过 CP 时把进度写进录制会话（回放帧带 CP 进度，C P TD 与 seek 一致）
  noteCpProgress(player.id, Math.min(pr.cpIndex + 1, room.cps.length), room.cps.length);

  // 更新 CP 进度 TD（对齐原版过 CP 时 "C  P / ~p~进度~w~/~y~总数"；完成时同样先刷满）
  // 玩家自身 + 观战他的观察者（对齐原版 OnPlayerEnterRaceCheckpoint 对观战者的 CP TD 同步）
  const cpDone = Math.min(pr.cpIndex + 1, room.cps.length);
  const cpText = `C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`;
  const raceTds = room.raceTextTds.get(player.id);
  if (raceTds) {
    raceTds.cp.setString(cpText);
  }
  for (const oid of getObserverIdsOf(player.id)) {
    const ot = room.raceTextTds.get(oid);
    if (ot) {
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
    player.sendClientMessage(COLOR_RACE, `[赛车] 第 ${pr.lap + 1} 圈（共 ${room.laps} 圈）`);
  }

  // 触发当前 CP 脚本（脚本已随房间载入内存，不再查库）。
  // 第一 CP 的 cveh 是赛道标准车型（进赛道时已按它匹配/刷车），到达时跳过换车，
  // 其余 CP 的 cveh（如 Car 赛道 CP11 的 562 中途换车）照常执行。
  // 显示下一个 CP 与音效放在脚本循环之前——spawnpos 返回 false 会终止脚本链，
  // 若放在循环后，CP 箭头/红圈会残留错位一整段（cpIndex 已推进但视觉停在旧 CP）。
  showNextCheckpoint(player, room.cps, pr.cpIndex);
  player.playSound(1056);
  const isFirstCp = nextCp.index === room.cps[0].index;
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
      if (!playerRaces.has(player.id) || rooms.get(pr.roomId)?.state !== "RACING" || pr.finished) {
        return;
      }
    }
  } catch (e) {
    // 脚本执行异常（native 读取失败等）：终止链但不影响玩家状态（对齐原版防御式执行）
    logger.error(`[race] CP 脚本执行异常 race=${room.raceId} cp=${nextCp.index}`, e);
    return;
  }
}

/** 完成比赛 */
async function finishPlayer(player: Player, pr: PlayerRace): Promise<void> {
  const room = rooms.get(pr.roomId);
  if (!room) return;
  pr.finished = true;
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 完成：清比赛小地图图标
  const time = Date.now() - pr.startTime;
  // name 快照：完成后玩家可能掉线/离开，endRoom 补计排名时 getName 已取不到
  room.results.push({ playerId: player.id, time, name: player.getName().name });
  room.resultIndex.set(player.id, time);
  const rank = room.results.length; // 完成顺序 = 名次（同一起点同时开始）
  broadcastToRoom(room, `[赛车] ${player.getName().name} 完成比赛！用时 ${formatTime(time)}`);
  // 完成瞬间即落盘本段录像（带名次）：完成者掉线不进重连窗口，若等 endRoom
  // 才落盘，宽限期内掉线会经 forceStopRecording 以无 rank 落盘 → 录像永远
  // 误标"未完成"。提前落盘后 endRoom 的 raceRecordingStop 对已移除会话是 no-op。
  raceRecordingStop(player.id, { rank, finished: true });

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
    if (raceTds) {
      raceTds.best.setString(`BEST / ${formatRaceTime(time)}`);
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
  // 否则会先广播"20 秒后结束"再立刻结束，误导）。判定须含掉线重连窗口玩家
  //（members 不含窗口玩家，漏算会提前 endRoom，把"C 秒内可重连"的承诺作废）
  if (room.results.length >= room.members.size + room.reconnectSlots.size) {
    endRoom(room);
    return;
  }
  // 第一名完成、还有成员（含窗口玩家）在 → 20s 宽限等他们冲线
  if (rank === 1 && !room.endTimer) {
    broadcastToRoom(room, "[赛车] 第一名已完成，20 秒后比赛结束");
    room.endTimer = setTimeoutSafe(() => endRoom(room), END_GRACE_MS);
  }
  // 自动观战下一个未完成玩家（二次确认目标仍有效）。
  // 仅弹结算框的"关闭"提示，不额外发"自动观战"消息——玩家点击结算框时
  // 场景自然切换为观战（提示反而打断结算阅读），快捷操作面板可随时 /tv off
  const next = [...room.members.values()].find((m) => {
    const mp = playerRaces.get(m.id);
    return mp && !mp.finished && m.isConnected();
  });
  if (next) {
    startObservePlayer(player, next);
  }
}

function endRoom(room: RaceRoom): void {
  if (room.state === "FINISHED") return;
  room.state = "FINISHED";
  if (room.countdownTimer) clearTimeoutSafe(room.countdownTimer);
  if (room.endTimer) clearTimeoutSafe(room.endTimer);
  // 最终排名结算：完成者按用时升序，未完成者按进度（CP 数）降序
  const ranked: {
    playerId: number;
    name: string;
    time: number;
    finished: boolean;
    cp: number;
    dist: number;
  }[] = [];
  for (const m of room.members.values()) {
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
  const resultLines = ranked.map((r, i) => {
    const medal = i === 0 ? "{FFD700}" : i === 1 ? "{C0C0C0}" : i === 2 ? "{CD7F32}" : "";
    const nameColor = r.finished ? "{FFFFFF}" : "{808080}";
    return `${medal}No.${i + 1} ${nameColor}${r.name}  ${r.finished ? formatTime(r.time) : "未完成"}`;
  });

  for (const m of room.members.values()) {
    RaceCheckpoint.disable(m);
    clearRaceMapIcons(m); // 比赛结束：清每个成员的小地图图标
    // 回放：比赛结束停止录制并落盘（名次/完成态快照）
    const r = ranked.find((x) => x.playerId === m.id);
    raceRecordingStop(m.id, {
      rank: r ? ranked.indexOf(r) + 1 : null,
      finished: r?.finished ?? false,
    });
    // 脚本车辆（cveh）在比赛结束时统一清理，防残留比赛世界成为幽灵车
    cleanupScriptVehicle(m.id);
    const mp = playerRaces.get(m.id);
    if (mp && !mp.finished) {
      m.sendClientMessage(COLOR_WHITE, "[赛车] 比赛已结束，你未完成比赛");
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
  // 落盘挂起中的掉线会话（掉线未重连、录像含静止段）：比赛结束（有人完成）
  // 统一保留，并按排名补 rank/finished（在线成员已在上面的 raceRecordingStop
  // 带 rank 落盘；挂起成员不在 members 循环里，这里补上——完成后掉线者也能
  // 在录像里拿到名次，不再误标"未完成"。stopRecording 对已落盘的会话无副作用）
  for (const pid of room.raceMembersLast.keys()) {
    // 归属校验：只处理属于本房间的录制会话（玩家退赛后又加入别的房间时，
    // 其新会话 raceRoomId 是别的房间——防误停/误丢另一房间的活跃录制）
    const rec = isRecording(pid) ? getRecording(pid) : undefined;
    if (rec && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
      const r = ranked.find((x) => x.playerId === pid);
      void stopRecording(pid, {
        quiet: true,
        rank: r ? ranked.indexOf(r) + 1 : null,
        finished: r?.finished ?? false,
      });
    }
  }
  destroyRaceTds(room);
  room.members.clear();
  freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id（供后续房间复用）
  rooms.delete(room.id);
}

function checkRoomState(room: RaceRoom): void {
  if (room.members.size === 0) {
    if (room.countdownTimer) clearTimeoutSafe(room.countdownTimer);
    if (room.endTimer) clearTimeoutSafe(room.endTimer);
    destroyRaceTds(room);
    // 有人完成（room.results 非空）→ 比赛有成绩，录像保留：挂起会话落盘、
    // 已落盘段不作废。仅"无人完成"才作废删除（挂起丢弃 + 已落盘段删除）。
    const someoneFinished = room.results.length > 0;
    for (const pid of room.raceMembersLast.keys()) {
      // 归属校验：只处理属于本房间的录制会话（玩家退赛后又加入别的房间时，
      // 其新会话 raceRoomId 是别的房间——防误停/误丢另一房间的活跃录制）
      const rec = getRecording(pid);
      const mine = !rec || !rec.raceRoomId || rec.raceRoomId === room.id;
      if (!mine) continue;
      if (isRecording(pid)) {
        if (someoneFinished) {
          void stopRecording(pid, { quiet: true }); // 挂起会话落盘保留（含静止段）
        } else {
          dropRecording(pid); // 挂起会话：丢弃（静止段无成绩价值）
        }
      } else if (!someoneFinished) {
        // 已落盘未完成段：作废（限定本场比赛；用 userId 快照——掉线/重连超时
        // 者 auth 已清，传参兜底离线作废）
        discardRaceReplay(pid, room.raceId, room.raceMembersLast.get(pid));
      }
    }
    room.raceMembersLast.clear();
    freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id
    rooms.delete(room.id);
  }
}

/** 离开比赛 */
export function leaveRace(player: Player): void {
  const pr = playerRaces.get(player.id);
  if (!pr) {
    // 不在比赛中：明确提示，避免 /r l 零反馈
    player.sendClientMessage(COLOR_RACE, "[赛车] 你不在比赛中");
    return;
  }
  const room = rooms.get(pr.roomId);
  if (room) {
    room.members.delete(player.id);
    broadcastToRoom(room, `[赛车] ${player.getName().name} 离开了比赛`);
    const tds = room.raceTextTds.get(player.id);
    if (tds) {
      for (const td of Object.values(tds)) {
        td.destroy();
      }
      room.raceTextTds.delete(player.id);
    }
    // 房主离开 → 转移房主（否则其余成员永远无法开始比赛）
    if (room.ownerId === player.id) {
      const next = [...room.members.keys()][0];
      if (next != null) {
        room.ownerId = next;
        const np = Player.getInstance(next);
        broadcastToRoom(room, `[赛车] 房主已离开，${np?.getName().name ?? next} 成为新房主`);
      }
    }
    checkRoomState(room);
  }
  // 离开者自己的反馈
  player.sendClientMessage(COLOR_RACE, "[赛车] 你已离开比赛房间");
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 离开：清比赛小地图图标
  playerRaces.delete(player.id);
  // 回放：中途退出也挂起会话（车停在原地、录像静止帧录到比赛结束落盘）——
  // 与掉线重连一致，整场回放完整（能看到退出者停在哪）。房间销毁（无人完成）
  // 或 endRoom（有人完成）时统一落盘处理；若房间仍有人继续跑，静止帧持续录。
  // offline=false：退赛挂起，玩家仍在线，静止帧不标"掉线"（掉线挂起才标）。
  if (room && room.state === "RACING") {
    suspendRecording(player.id, false);
  } else {
    // 非比赛状态（等待/倒计时中离开）：没有在跑，直接落盘（未完成，无名次）
    raceRecordingStop(player.id);
  }
  // 脚本车辆（cveh）在离开比赛时销毁，防残留
  cleanupScriptVehicle(player.id);
  // 先退出观战（避免 stopObserve 覆盖世界回比赛世界），再恢复原世界
  if (isObserving(player.id)) {
    stopObserve(player);
  }
  // 恢复原世界 + 个人时间天气
  restorePlayerAfterRace(player, pr.prevWorld);
  // 无碰撞恢复为个人设置（比赛中强制开启）
  void restorePersonalNoCollision(player);
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
      broadcastToRoom(room, "[赛车] 比赛房间因长时间未开始已解散");
      for (const m of room.members.values()) {
        const mp = playerRaces.get(m.id);
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
        // 清掉起点 CP 箭头与小地图图标，防留在公共/战局世界里永久残留
        RaceCheckpoint.disable(m);
        clearRaceMapIcons(m);
        cleanupScriptVehicle(m.id); // 等待期玩家可能在起点的比赛车上，解散一并清
      }
      destroyRaceTds(room);
      room.members.clear();
      freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id
      rooms.delete(room.id);
      continue;
    }
    // 重连窗口过期清理（房主窗口过期转移）
    if (room.reconnectUntil.size > 0) {
      cleanupExpiredReconnects(room);
    }
    if (room.state !== "RACING") continue;
    // 收集成员快照与进度
    const rows: {
      playerId: number;
      totalCp: number; // 完成 CP 总数（圈数 x CP数 + 当前圈内 CP）
      dist: number; // 距下一个 CP 距离
      finished: boolean;
      time: number;
    }[] = [];
    for (const m of room.members.values()) {
      const mp = playerRaces.get(m.id);
      if (!mp) continue;
      const totalCp = mp.lap * room.cps.length + (mp.cpIndex + 1);
      let dist = 0;
      const nextCp = room.cps[mp.cpIndex + 1];
      if (nextCp && !mp.finished) {
        const pos = m.getPos();
        dist = Math.hypot(pos.x - nextCp.x, pos.y - nextCp.y, pos.z - nextCp.z);
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
    rows.forEach((r, rank) => {
      const tds = room.raceTextTds.get(r.playerId);
      const mp = playerRaces.get(r.playerId);
      if (!tds || !mp) return;
      const time = mp.finished ? r.time : now - mp.startTime;
      tds.time.setString(`TIME / ${formatRaceTime(time)}`);
      tds.rank.setString(`RANK / ${rank + 1} ${rankSuffix(rank)}`);
      // 观战者同步：观察该玩家的玩家显示同样的 TIME/RANK（对齐原版 RaceRunTime/
      // RaceRunRank 里对观战者的 TD 同步——观战者看到被观战者的比赛信息）
      for (const oid of getObserverIdsOf(r.playerId)) {
        const ot = room.raceTextTds.get(oid);
        if (!ot) continue;
        ot.time.setString(`TIME / ${formatRaceTime(time)}`);
        ot.rank.setString(`RANK / ${rank + 1} ${rankSuffix(rank)}`);
      }
    });
  }
}

/** 初始化比赛系统 */
export function initRaceSystem(): void {
  PlayerEvent.onCommandText(["r", "race"], ({ player, subcommand, next }) => {
    const cmd = subcommand[0];
    const rest = subcommand.slice(1);
    const query = rest.join(" ");
    if (cmd === "s") {
      if (query) {
        void startRaceFlow(player, query);
      } else {
        // 无参数三分支（对齐原版）：
        // - 房间内房主 → 开始比赛
        // - 房间内非房主 → 等房主开始（不随机建房）
        // - 不在房间 → 弹赛道列表选赛道建房（建房入口，列表首行有「全部随机」）
        const pr = playerRaces.get(player.id);
        if (pr) {
          if (rooms.get(pr.roomId)?.ownerId === player.id) {
            void startRace(player);
          } else {
            player.sendClientMessage(COLOR_RACE, "[赛车] 等待房主开始比赛");
          }
        } else {
          void openRaceListDialog(player);
        }
      }
    } else if (cmd === "j") {
      joinRoomFlow(player);
    } else if (cmd === "l" || cmd === "leave") {
      leaveRace(player);
    } else if (cmd === "info") {
      // /r info 赛道名 → 赛道详情（对齐原版）
      if (!query) {
        player.sendClientMessage(COLOR_RACE, "用法: /r info 赛道名称");
      } else {
        void showRaceInfo(player, query);
      }
    } else if (cmd === "page") {
      // /r page [N] → 原版翻页入口，gm-lite 无页码概念 → 打开赛道选择列表
      void openRaceListDialog(player);
    } else if (cmd === "create") {
      // /r create 赛道名 → 创建赛道并进入编辑（对齐原版；无密码机制）
      if (!query) {
        player.sendClientMessage(COLOR_RACE, "用法: /r create 赛道名称");
      } else {
        void createRaceByCommand(player, query);
      }
    } else if (cmd === "edit") {
      void handleRaceEditCommand(player, rest);
    } else if (!cmd) {
      // /r 无参数 → 弹赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表，
      // 选中赛道直接创建比赛）
      void openRaceListDialog(player);
    } else {
      player.sendClientMessage(
        COLOR_RACE,
        "用法: /r s 赛道名称 创建比赛 · /r j 加入 · /r l 离开 · /r info 名称 · /r create 名称 · /r edit 名称|cp|q|d",
      );
    }
    return next();
  });

  // 到达检查点事件
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    if (isInRace(player.id) && !isEditing(player.id)) {
      void onPlayerReachCp(player);
    }
    return next();
  });

  // 实时排名定时器（GameMode.onExit 统一清理）
  setIntervalSafe(() => tickRooms(), 200);

  // 比赛中的命令隔离：非白名单命令一律拒绝
  // 注意：onCommandReceived 的 command 是完整命令串（如 "r l"），strictMainCmd
  // 是主命令（"r"），但运行时可能为 undefined——必须回退到 command 的第一个
  // token 取主命令，否则 /r l /r j /r s 全被当成未授权命令拦截
  PlayerEvent.onCommandReceived(({ player, command, strictMainCmd, next }) => {
    if (!isInRace(player.id)) return next();
    const main = (strictMainCmd || command.split(/\s+/)[0] || "").toLowerCase();
    if (isRaceCommandAllowed(main)) return next();
    player.sendClientMessage(
      COLOR_ERROR,
      "[比赛] 比赛中只能使用 /r l 离开、/pm 私聊、/tv 观战或 /kill 重生",
    );
    return false;
  }, true); // unshift 优先执行（在限频之前，避免双提示）

  // /kill 重生（原版比赛中允许）
  PlayerEvent.onCommandText("kill", ({ player, next }) => {
    if (player.isWasted()) {
      player.sendClientMessage(COLOR_WHITE, "[系统] 生命值为空，请等待重生");
      return next();
    }
    if (!isInRace(player.id)) {
      // 非比赛：自杀（对齐原版 /kill）
      player.setHealth(0);
      return next();
    }
    const pr = playerRaces.get(player.id);
    const room = pr ? rooms.get(pr.roomId) : undefined;
    if (room && room.state === "RACING") {
      // 比赛中：直接回到上一 CP（/kill 在比赛中 = 重置回上一个检查点）
      respawnToLastCp(player, pr!, room);
      return next();
    }
    // 在比赛房间但未开跑（WAITING/COUNTDOWN）：没有比赛进度，正常重生而非自杀
    player.sendClientMessage(COLOR_RACE, "[赛车] 比赛尚未开始，已正常重生");
    player.spawn();
    return next();
  });

  // 比赛中死亡：重生回上一 CP（原版 updateSpeedometer 防卡住检测驱动）
  PlayerEvent.onDeath(({ player, next }) => {
    if (isInRace(player.id)) {
      const pr = playerRaces.get(player.id);
      const room = pr ? rooms.get(pr.roomId) : undefined;
      if (room && room.state === "RACING") {
        // 死亡后需要重新出生
        respawnPlayerToCp(player, pr!, room);
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
      const pr = playerRaces.get(driver.id);
      const room = pr ? rooms.get(pr.roomId) : undefined;
      if (room && room.state === "RACING" && getOwnedVehicle(driver.id) === vehicle) {
        destroyPlayerVehicle(driver.id); // 清理爆炸后残留的失效实体引用
        void spawnVehicle(driver, getDefaultRaceModel(room.cps), true);
        driver.sendClientMessage(COLOR_RACE, "[赛车] 车辆已损毁，自动刷出比赛用车");
      }
    }
    return next();
  });
}

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

/** 重生回上一 CP（死亡场景：setSpawnInfo + spawn 复活） */
function respawnPlayerToCp(player: Player, pr: PlayerRace, room: RaceRoom): void {
  const prevIdx = Math.max(0, pr.cpIndex);
  const prev = room.cps[prevIdx];
  if (!prev) return;
  const z = getSafeRespawnZ(prev);
  player.setSpawnInfo(0, player.getSkin(), prev.x, prev.y, z, prev.angle, 0, 0, 0, 0, 0, 0);
  player.spawn();
  // 对齐原版 ReSpawnRaceVehicle（死亡重生 → 把车挪到 CP + 修复 + 加氮气 + 放回车里）：
  // 车完好 → 挪到 CP 并放回；车已毁（爆炸，getOwnedVehicle 失效）→ 刷默认比赛车兜底
  //（懒创建爱车，与 beginRace/reconnect 的无车兜底一致）。否则玩家死亡重生后只能
  // 步行跑完（原版重生的核心就是"人车一起回 CP"）。
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(prev.x, prev.y, z);
    owned.setZAngle(prev.angle);
    owned.setHealth(1000);
    owned.repair();
    owned.addComponent(1010);
    owned.putPlayerIn(player, 0);
  } else {
    if (owned) destroyPlayerVehicle(player.id); // 清理爆炸后残留的失效实体引用
    void spawnVehicle(player, getDefaultRaceModel(room.cps), true);
  }
  // 重新显示当前 CP
  showNextCheckpoint(player, room.cps, pr.cpIndex);
  player.sendClientMessage(COLOR_RACE, "[赛车] 已重生回上一个检查点");
}

/** 比赛中重生回上一 CP（/kill 与快捷操作共用） */
export function respawnToLastCp(player: Player, pr: PlayerRace, room: RaceRoom): void {
  const prevIdx = Math.max(0, pr.cpIndex);
  const prev = room.cps[prevIdx];
  if (!prev) return;
  const z = getSafeRespawnZ(prev);
  if (player.isInAnyVehicle()) {
    const veh = player.getVehicle()!;
    veh.setPos(prev.x, prev.y, z);
    veh.setHealth(1000);
    veh.repair();
  } else {
    player.setPos(prev.x, prev.y, z);
    player.setHealth(100);
  }
  // 重新显示当前 CP（红箭头指向下一个）
  showNextCheckpoint(player, room.cps, pr.cpIndex);
  player.sendClientMessage(COLOR_RACE, "[赛车] 已重生回上一个检查点");
}

/** 开始比赛流程：按赛道名/ID 创建房间；无赛道名或不存在 → 打开赛道列表（含排序） */
async function startRaceFlow(player: Player, query: string): Promise<void> {
  if (!query) {
    // 无赛道名 → 打开赛道列表（对齐面板「赛道列表」，含排序与「全部随机」首行）
    void openRaceListDialog(player);
    return;
  }
  // 先按名字查（同名字符串，参数安全）；查不到且 query 形如 uuid 才按 id 查——
  // 不能直接用 OR: [{name},{id}]：id 是 uuid 列，非 uuid 字符串会让 PostgreSQL
  // 参数类型检查直接报错（invalid input syntax for type uuid），即使用户输入的是赛道名
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name: query },
    })) ??
    (UUID_RE.test(query)
      ? await prisma.race.findFirst({
          where: { isEnabled: true, deletedAt: null, id: query },
        })
      : null);
  if (!race) {
    // 指定赛道不存在 → 打开赛道列表让玩家选（原版是弹列表；随机建房是
    // gm-lite 旧行为，与面板/命令对齐后改为列表——列表首行即有「全部随机」）
    player.sendClientMessage(COLOR_RACE, `未找到赛道「${query}」，请从列表选择`);
    void openRaceListDialog(player);
    return;
  }
  const room = await createRaceRoom(player, race.id);
  if (room) {
    // 创建后等待加入：房主再次 /r s 开始
    player.sendClientMessage(COLOR_RACE, "再输入 /r s 开始比赛");
  }
}

/** 全部随机的占位赛道 id（列表首行：随机抽一张创建） */
const RANDOM_RACE_ID = "__RANDOM__";

/** 查询启用赛道（分页选择共用：列表创建 + 换赛道 + 命令列表排序）。
 * orderBy 支持创建时间/名称/总长度 × 升降序（对齐面板「赛道列表」的排序） */
async function fetchEnabledRaces(
  orderBy:
    | { createdAt: "asc" | "desc" }
    | { name: "asc" | "desc" }
    | { totalLength: "asc" | "desc" } = {
    createdAt: "desc",
  },
): Promise<
  {
    id: string;
    name: string;
    totalLength: unknown;
    laps: number | null;
    sysUser: { username: string } | null;
  }[]
> {
  return prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy,
    include: { sysUser: true },
  });
}

/**
 * /r 无参数 → 赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表）。
 * 排序与面板「赛道列表」对齐：先选排序字段（创建时间/名称/总长度）→ 方向。
 * 首行「全部随机」→ 随机抽一张赛道创建房间；其余选中直接创建。
 */
async function openRaceListDialog(player: Player): Promise<void> {
  // 排序选择（对齐面板 raceListFlow：字段 + 方向，取消则返回不弹列表）
  const fieldIndex = await pickOption(player, "赛道列表 · 排序", [
    "按创建时间",
    "按名称",
    "按总长度",
  ]);
  if (fieldIndex < 0) return;
  const dirIndex = await pickOption(player, "排序方向", ["升序", "降序"]);
  if (dirIndex < 0) return;
  const dir = dirIndex === 0 ? ("asc" as const) : ("desc" as const);
  const orderBy =
    fieldIndex === 0
      ? ({ createdAt: dir } as const)
      : fieldIndex === 1
        ? ({ name: dir } as const)
        : ({ totalLength: dir } as const);
  const races = await fetchEnabledRaces(orderBy);
  if (races.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无可用赛道");
    return;
  }
  // 首行「全部随机」：id 用占位符，其余字段留空（format 按 id 分支）
  const data: (typeof races)[number][] = [
    { id: RANDOM_RACE_ID, name: "", totalLength: null, laps: null, sysUser: null },
    ...races,
  ];
  const r = await showPagedDialog(player, {
    caption: "选择赛道开始比赛",
    data,
    headers: ["#", "名称", "长度", "圈数", "作者"],
    format: (race, index) =>
      race.id === RANDOM_RACE_ID
        ? ["🎲", "全部随机（随机一张赛道）", "", "", ""]
        : [
            String(index),
            race.name,
            `${Math.round(Number(race.totalLength))}m`,
            `${race.laps ?? 1}`,
            race.sysUser?.username ?? "?",
          ],
    button1: "开始",
    button2: "取消",
  });
  if (!r) return;
  const room =
    r.item.id === RANDOM_RACE_ID
      ? await createRaceRoom(player, null)
      : await createRaceRoom(player, r.item.id);
  if (room) {
    player.sendClientMessage(COLOR_RACE, "再输入 /r s 开始比赛");
  }
}

/** 赛道选择器（换赛道/创建共用）：分页选择返回选中赛道，取消返回 null */
async function showTrackPicker(
  player: Player,
  title: string,
  button: string,
): Promise<{ id: string } | null> {
  const races = await fetchEnabledRaces();
  if (races.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无可用赛道");
    return null;
  }
  const r = await showPagedDialog(player, {
    caption: title,
    data: races,
    headers: ["#", "名称", "长度", "圈数", "作者"],
    format: (race, index) => [
      String(index + 1),
      race.name,
      `${Math.round(Number(race.totalLength))}m`,
      `${race.laps ?? 1}`,
      race.sysUser?.username ?? "?",
    ],
    button1: button,
    button2: "取消",
  });
  if (!r) return null;
  return r.item;
}

/** 面板「更换赛道」：随机换一张 / 从列表选择（房主 + WAITING） */
export async function openChangeTrackMenu(
  player: Player,
  back?: () => void | Promise<void>,
): Promise<void> {
  const res = await showDialog(
    player,
    new Dialog({
      style: DialogStylesEnum.LIST,
      caption: "更换赛道",
      info: "1. 随机换一张\n2. 从列表选择",
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res) return;
  if (res.response !== 1) return back?.();
  if (res.listItem === 0) {
    await changeRoomTrack(player);
  } else if (res.listItem === 1) {
    const race = await showTrackPicker(player, "选择新赛道", "更换");
    if (race) {
      await changeRoomTrack(player, race.id);
    }
  }
  return back?.();
}

/** 加入房间流程 */
function joinRoomFlow(player: Player): void {
  // 已在比赛中：直接提示而非静默踢出——joinRoom 会对已参赛玩家 leaveRace，
  // 正在跑的比赛进度/录像/排名会被无声放弃
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "[赛车] 你已在比赛中，先 /r l 离开后再加入其他房间");
    return;
  }
  const room = [...rooms.values()].find((r) => r.state === "WAITING");
  if (!room) {
    player.sendClientMessage(COLOR_ERROR, "当前没有等待中的比赛房间");
    return;
  }
  void joinRoom(player, room).then(() => {
    broadcastToRoom(room, `[赛车] ${player.getName().name} 加入了比赛`);
  });
}

/** 赛道信息查询（/r info）：按名字或 id 查赛道，展示名称/长度/圈数/作者/纪录数 */
async function showRaceInfo(player: Player, query: string): Promise<void> {
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name: query },
    })) ??
    (UUID_RE.test(query)
      ? await prisma.race.findFirst({
          where: { isEnabled: true, deletedAt: null, id: query },
        })
      : null);
  if (!race) {
    player.sendClientMessage(COLOR_ERROR, `未找到赛道「${query}」`);
    return;
  }
  const [recs, author] = await Promise.all([
    prisma.raceRecord.count({ where: { raceId: race.id, deletedAt: null } }),
    race.userId
      ? prisma.sysUser.findUnique({ where: { id: race.userId }, select: { username: true } })
      : null,
  ]);
  player.sendClientMessage(
    COLOR_RACE,
    `[赛道] ${race.name} | 长度 ${Math.round(Number(race.totalLength))}m | ` +
      `${race.laps ?? 1} 圈 | 作者 ${author?.username ?? "?"} | ${recs} 条纪录`,
  );
}

/** 创建赛道（/r create）：名字查重后创建 + 进入编辑（对齐原版 /r create 流程，无密码机制） */
async function createRaceByCommand(player: Player, name: string): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const dup = await prisma.race.findFirst({ where: { name } });
  if (dup) {
    player.sendClientMessage(COLOR_ERROR, `赛道「${name}」已存在`);
    return;
  }
  try {
    const race = await prisma.race.create({
      data: { name, isEnabled: true, userId: auth.userId },
    });
    if (isInRace(player.id)) {
      // 比赛中不能进编辑（对齐原版 /r edit 门禁）：赛道已建但只提示，不刷编辑车
      player.sendClientMessage(COLOR_RACE, `赛道「${name}」创建成功（比赛中，请离开比赛后编辑）`);
      return;
    }
    player.sendClientMessage(COLOR_SUCCESS, `赛道「${name}」创建成功，进入编辑模式放置检查点`);
    await enterRaceEdit(player, race.id);
  } catch (e) {
    logger.error(`[race] /r create 创建赛道失败 ${name}`, e);
    player.sendClientMessage(COLOR_ERROR, "创建失败（名称可能已存在）");
  }
}

/** /r edit 子命令：无参数 → 编辑帮助；名称 → 进编辑；cp/q/d → 编辑态操作（对齐原版） */
async function handleRaceEditCommand(player: Player, rest: string[]): Promise<void> {
  const sub = rest[0];
  if (!sub) {
    player.sendClientMessage(
      COLOR_RACE,
      "用法: /r edit 赛道名 进入编辑 · /r edit cp 放置CP · /r edit q 退出 · /r edit d 打开编辑菜单",
    );
    return;
  }
  if (sub === "cp") {
    if (!isEditing(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "你不在赛道编辑中，先 /r edit 赛道名 进入编辑");
      return;
    }
    await addCp(player);
    return;
  }
  if (sub === "q") {
    exitEdit(player.id);
    player.sendClientMessage(COLOR_RACE, "已退出编辑模式");
    return;
  }
  if (sub === "d") {
    if (!isEditing(player.id)) {
      player.sendClientMessage(COLOR_ERROR, "你不在赛道编辑中，先 /r edit 赛道名 进入编辑");
      return;
    }
    await showEditMenu(player);
    return;
  }
  // /r edit 赛道名 → 进入编辑（对齐原版，无密码机制；按名字查）
  const name = rest.join(" ");
  const race =
    (await prisma.race.findFirst({
      where: { isEnabled: true, deletedAt: null, name },
    })) ??
    (UUID_RE.test(name)
      ? await prisma.race.findFirst({ where: { isEnabled: true, deletedAt: null, id: name } })
      : null);
  if (!race) {
    player.sendClientMessage(COLOR_ERROR, `未找到赛道「${name}」`);
    return;
  }
  if (!(await canEditRace(player, race.id))) {
    player.sendClientMessage(COLOR_ERROR, "你无权编辑该赛道（仅作者或管理员）");
    return;
  }
  if (isInRace(player.id)) {
    // 比赛中禁止进编辑（对齐原版 /r edit 门禁：编辑会刷测试车/切走玩家，干扰比赛）
    player.sendClientMessage(COLOR_ERROR, "比赛中不能进入赛道编辑，先 /r l 离开比赛");
    return;
  }
  await enterRaceEdit(player, race.id);
}

/**
 * 掉线重连：玩家重新进入游戏时，若其断线窗口未过期且房间仍存在，恢复比赛进度。
 * 返回 true 表示已恢复；false 表示无可重连房间。
 */
export async function tryReconnectRace(player: Player): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  // 遍历房间找该玩家的重连窗口（key 是 userId：防 playerId 复用劫持旧窗口）
  for (const room of rooms.values()) {
    const until = room.reconnectUntil.get(auth.userId);
    if (until == null) continue;
    const slot = room.reconnectSlots.get(auth.userId);
    // 窗口过期或房间已结束/解散 → 清理窗口，无法重连；对齐 cleanupExpiredReconnects
    // 把挂起的录制落盘（不落盘则会话永久悬挂、静止帧无限累积内存）
    if (Date.now() >= until || room.state === "FINISHED") {
      room.reconnectUntil.delete(auth.userId);
      room.reconnectSlots.delete(auth.userId);
      if (slot && isRecording(slot.playerId)) {
        void stopRecording(slot.playerId, { quiet: true });
      }
      continue;
    }
    // 恢复：重新加入房间 + 恢复进度
    room.reconnectUntil.delete(auth.userId);
    room.reconnectSlots.delete(auth.userId);
    // playerId 可能已被复用（新连接 id 与掉线时不同）：把挂起的录制会话从
    // 旧 id 迁移到新 id，否则 resumeRecording(player.id) 找不到会话（掉线静帧
    // 断在旧 id 上、回放缺段），且旧 id 残留挂起会话占内存
    if (slot && slot.playerId !== player.id) {
      rebindRecording(slot.playerId, player.id);
    }
    room.members.set(player.id, player);
    room.raceMembersLast.set(player.id, auth.userId); // 重新登记本场录制成员（userId 快照供离线作废）
    // 恢复战局归属：prevWorld 对应战局若仍存在则加回，否则回公共大世界并修正
    // prevWorld=0（避免比赛结束恢复到已解散战局的幽灵世界，与战局登记不一致）
    const prevWorld = slot?.prevWorld ?? player.getVirtualWorld();
    const joinedSession = sessionManager.rejoinPlayerSessionByWorld(player, prevWorld);
    playerRaces.set(player.id, {
      roomId: room.id,
      cpIndex: slot?.cpIndex ?? -1,
      lap: slot?.lap ?? 0,
      startTime: slot?.startTime ?? Date.now(),
      finished: false,
      // 恢复断线前所在世界（重连时玩家必然在世界 0，不能用作 prevWorld）
      prevWorld: joinedSession ? prevWorld : 0,
    });
    // 切回比赛世界 + 恢复 CP 显示
    player.setVirtualWorld(room.worldId);
    if (room.state === "RACING") {
      // 回放：恢复挂起的录制（同一会话续录，掉线静止帧衔接无缝；若挂起会话
      // 已被其他路径处理——超时落盘/房间销毁/重开丢弃——resume 无会话可恢复，
      // 则新开一段录制兜底）
      resumeRecording(player.id);
      if (!isRecording(player.id)) {
        raceRecordingStart(player.id, {
          raceId: room.raceId,
          raceName: room.raceName,
          raceRoomId: room.id,
        });
      }
      const tds = createRaceTd(player, room);
      // 恢复 BEST TD（房间缓存已有，无则查询）
      void updateBestTd(player, room, tds);
      // 恢复 CP 进度 TD（按断线时进度）
      const cpDone = Math.min((slot?.cpIndex ?? -1) + 1, room.cps.length);
      tds.cp.setString(`C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`);
      showNextCheckpoint(player, room.cps, slot?.cpIndex ?? -1);
      // 重新强制无碰撞（重连是全新连接，碰撞状态已重置）
      applyRaceNoCollision(player, true);
      // 恢复房间统一时间天气（重连是新连接，默认回服务器时间天气——不恢复会
      // 与同房其他成员不一致，直到碰到带 time/weather 脚本的 CP）
      player.setTime(room.roomTime.hour, room.roomTime.minute);
      player.setWeather(room.roomWeather);
      // 无车兜底（断线前坐默认比赛车，重连时已被清理）：用默认比赛车型刷爱车
      // （有该模型爱车则复用外观，没有则自动创建成爱车——与 joinRoom/beginRace 一致）
      if (!player.isInAnyVehicle() && !getOwnedVehicle(player.id)) {
        void spawnVehicle(player, getDefaultRaceModel(room.cps), true);
      }
    }
    broadcastToRoom(room, `[赛车] ${player.getName().name} 已重连比赛！`);
    player.sendClientMessage(
      COLOR_SUCCESS,
      `已重连比赛「${room.raceName}」，继续第 ${(slot?.lap ?? 0) + 1} 圈`,
    );
    // 房主重连 → 恢复房主身份
    if (room.ownerId === player.id || room.ownerUserId === auth.userId) {
      room.ownerId = player.id;
      room.ownerUserId = auth.userId;
      broadcastToRoom(room, `[赛车] ${player.getName().name} 恢复了房主身份`);
    }
    return true;
  }
  return false;
}
