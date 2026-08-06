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
import {
  getOwnedVehicle,
  spawnVehicle,
  destroyPlayerVehicle,
  addVehicleComponentIfPossible,
} from "@/vehicles";
import {
  execCpScript,
  cleanupScriptVehicle,
  getSuperStartKmh,
  setVehicleSpeed,
  KMH_UNIT,
  type CpScriptContext,
} from "./scripts";
import { isEditing } from "./editor";
import { reapplyCurrentPlayerPreset } from "@/attire";
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
  noteRank,
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
  getObserveTarget,
  onObserveStart,
  onObserveStop,
} from "@/core/observe";
import { getSafeGroundZ } from "@/core/colandreas";
import { applyWorldEnv, getWorldWeather } from "@/core/worldenv";
import { sessionManager } from "@/sessions/manager";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { formatTime } from "@/utils/format";
import { PREFIX, sysMsg } from "@/utils/msg";
import { MIN_Z } from "@/utils/map";
import { COLOR_RACE } from "@/utils/colors";
import { playCountdown, cancelCountdownFx } from "@/interface/countdownFx";

/** 第一名完成后的结束宽限时长（毫秒） */
const END_GRACE_MS = 20_000;
/** 赛道名/ID 查重共用（roomUi 命令层也用：/r s /r info /r edit 按名或 id 查赛道） */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
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
  /** 当前名次（0-based，tickRooms 排名计算写入）。60fps TD 刷新（syncRaceTds）
   * 只读该缓存——排名计算要做距离采样+排序，200ms 足够，高频刷新不重算 */
  rank?: number;
  /** 加入比赛前的世界（开赛切独立世界，离开/结束时恢复） */
  prevWorld: number;
  /** 过 CP 后（脚本执行完）的状态快照，按"比赛累计 CP 序号"索引：
   *  k = lap × 一圈CP数 + cpIndex（跨圈瞬间 cpIndex=-1、lap++，公式仍指向该 CP）。
   *  记录 cveh 换车后的车型 + time/weather 脚本结果——重生多回退一格时
   *  恢复目标 CP 触达后的状态（对齐"回放式状态回撤"，否则车模型/时间天气残留）。 */
  cpSnapshots: CpSnapshot[];
}

/** 触达一个 CP 并执行完脚本后的状态快照（回退重生恢复用） */
interface CpSnapshot {
  vehModel: number; // 过该 CP 后玩家座驾车型（cveh 换车后的）
  hour: number;
  minute: number;
  weather: number;
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
  /** 挂机检测：playerId -> 上次采样位置 + 已静止累计毫秒（仅 RACING 检测；
   *  对齐原版 AFKTimes 每秒位移 <0.001 累计 45 秒移出赛道） */
  afk: Map<number, { x: number; y: number; z: number; idleMs: number }>;
  /** 最近一次 tickRooms 采样的成员位置（200ms 更新；掉线快照兜底——onDisconnect 时
   *  Player.getInstance 可能已失效取不到坐标，用最近采样位置恢复重连定位） */
  lastPositions: Map<number, { x: number; y: number; z: number }>;
  endTimer?: NodeJS.Timeout;
  /** 每个成员的比赛信息 TextDraw（playerId -> 4 行 TD，开赛时创建） */
  raceTextTds: Map<number, RoomRaceTds>;
  /** 比赛信息 TD 文本缓存（playerId -> 上次显示文本，成员与观战者各一条）。
   *  60fps 高频刷新只对变化的内容 setString——静态/稳定段零 native 调用。
   *  timeCs：上次显示的厘秒（秒表跳表去重，60fps 下大多数 tick 厘秒未变，
   *  提前比较跳过 formatRaceTime 的格式化开销） */
  tdTextCache: Map<number, { time: string; rank: string; timeCs: number }>;
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
      /** 掉线瞬间位置：重连是全新连接（跳过 spawnPlayer/出生定位），须恢复到此
       *  位置（配合 prevWorld 战局归属），否则玩家重连后出现在默认出生点 */
      x: number;
      y: number;
      z: number;
      /** 掉线瞬间原战局 id（callbacks 在 handlePlayerDisconnect 前快照）。sessionId
       *  自增不复用——重连时按它精确匹配原战局（worldId 会被解散战局回收复用，
       *  按 worldId 可能塞进无关新战局） */
      sessionId?: number;
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
/** 挂机检测参数（对齐原版 AFKTimes：静止累计超时移出比赛，防占坑不跑） */
const AFK_IDLE_MS = 45_000; // 静止累计超 45s 移出比赛
const AFK_WARN_MS = 30_000; // 静止累计超 30s 提示一次
/** 200ms 内位移 < 0.1（≈0.5m/s）判静止——比原版 0.001/s 宽松：防撞墙顶油门/
 *  被车流堵塞缓慢蠕动的活跃玩家被误判挂机（原版阈值过严曾被投诉误封） */
const AFK_MOVE_EPS = 0.1;
const AFK_TICK_MS = 200; // 与 tickRooms 周期一致（每 tick 固定累计）
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

/** 房间方法：广播 */
/** 广播给房间内所有在线成员（roomUi 命令层加入提示也用）。
 *  前缀统一在此拼接（PREFIX.race）：调用点只传正文，防漏写/手写前缀 */
export function broadcastToRoom(room: RaceRoom, msg: string): void {
  for (const m of room.members.values()) {
    m.sendClientMessage(COLOR_RACE, `${PREFIX.race} ${msg}`);
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
export function cleanupRacePlayer(playerId: number, opts?: { sessionId?: number }): void {
  const pr = playerRaces.get(playerId);
  if (pr) {
    const room = rooms.get(pr.roomId);
    if (room) {
      const tds = room.raceTextTds.get(playerId);
      if (tds) {
        // infernus 在玩家 onDisconnect 时已自动销毁其全部 PlayerTextDraw
        //（_id 回到 65535），此处必须 isValid 守卫——裸 destroy 会抛
        // TextDrawException 中断清理，TD 条目残留，tickRooms/syncRaceTds
        // 继续对已销毁 TD setString 无限刷屏
        for (const td of Object.values(tds)) {
          if (td.isValid()) td.destroy();
        }
        room.raceTextTds.delete(playerId);
      }
      room.tdTextCache.delete(playerId);
      // 掉线成员下线：清理指向该成员的观察者 CP 箭头（车停原地无人可跟）
      for (const [oid, mid] of [...spectatorCpMap]) {
        if (mid === playerId) clearSpectatorCp(oid);
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
        // 快照含"距下一 CP 距离"：掉线玩家按掉线瞬间位置/CP 继续参与排名。
        // onDisconnect 时 getPos 可能已失效（返回 undefined）→ 退化为 0,0,0，重连
        // 后玩家会出生在默认出生点、与"继续第 N 圈"脱节——用 tickRooms 最近一次
        // 采样位置兜底（200ms 内的最后已知位置，比 0,0,0 精确得多）
        const discPlayer = Player.getInstance(playerId);
        const dpos = discPlayer?.getPos() ?? room.lastPositions.get(playerId);
        const nextCp = room.cps[pr.cpIndex + 1];
        let dist = 0;
        if (nextCp && dpos) {
          dist = Math.hypot(dpos.x - nextCp.x, dpos.y - nextCp.y, dpos.z - nextCp.z);
        }
        room.reconnectSlots.set(uid, {
          playerId,
          cpIndex: pr.cpIndex,
          lap: pr.lap,
          startTime: pr.startTime,
          prevWorld: pr.prevWorld,
          dist,
          name: discPlayer?.getName().name ?? `玩家${playerId}`,
          // 掉线瞬间位置：重连是全新连接，恢复时 setPos 回此处（防出现在默认出生点）
          x: dpos?.x ?? 0,
          y: dpos?.y ?? 0,
          z: dpos?.z ?? 0,
          // 掉线瞬间原战局 id 快照（由 callbacks 在 handlePlayerDisconnect 删
          // playerSessions 之前传入——onDisconnect 阶段再取 getPlayerSession 只会
          // 命中公共大世界、恒为 0）
          sessionId: opts?.sessionId,
        });
        room.members.delete(playerId);
        room.lastPositions.delete(playerId); // 掉线快照缓存随成员移出清理
        room.afk.delete(playerId); // 挂机累计随断线清理（重连是新上下文，从零累计）
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
          `${Player.getInstance(playerId)?.getName().name ?? "玩家"} 掉线，${Math.round(window / 1000)} 秒内可重连`,
        );
        cleanupObserve(playerId);
        return;
      }
      // 不支持重连或非比赛状态 → 原断线逻辑
      room.members.delete(playerId);
      room.lastPositions.delete(playerId); // 掉线快照缓存随成员移出清理
      room.afk.delete(playerId); // 挂机累计随断线清理（防 Map 残留到房间销毁）
      // 房主掉线 → 转移房主
      if (room.ownerId === playerId) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `房主已掉线，${np?.getName().name ?? next} 成为新房主`);
        }
      }
      if (room.state === "WAITING") {
        broadcastToRoom(room, `一名玩家离开了比赛`);
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
      // 的 id）找挂起会话——挂起会话键控在 playerId 上。归属校验：断线期间该
      // playerId 可能被新连接复用开了录制（同一房间也可能被同房新成员复用——
      // raceRoomId 会相同），必须再比 userId 才能确认是掉线者自己的会话，防误停
      // 别人的活跃录制（与 endRoom/checkRoomState 的归属校验一致）
      if (slot && isRecording(slot.playerId)) {
        const rec = getRecording(slot.playerId);
        if (rec && rec.userId === uid && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
          void stopRecording(slot.playerId, { quiet: true });
        }
      }
      // 房主重连窗口过期 → 转移房主
      if (slot && room.ownerUserId === uid) {
        const next = [...room.members.keys()][0];
        if (next != null) {
          room.ownerId = next;
          room.ownerUserId = getAuthState(next)?.userId ?? "";
          const np = Player.getInstance(next);
          broadcastToRoom(room, `房主重连超时，${np?.getName().name ?? next} 成为新房主`);
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
  };
  rooms.set(room.id, room);
  await joinRoom(player, room);
  sysMsg(
    player,
    "race",
    `比赛房间已创建，赛道「${race.name}」（${room.laps} 圈），输入 /r j 可加入`,
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
  const pr = playerRaces.get(player.id);
  const room = pr ? rooms.get(pr.roomId) : undefined;
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
  // 重定位所有成员：进度重置 + 起点 + TD 刷新 + CP 箭头重建
  for (const m of room.members.values()) {
    const mp = playerRaces.get(m.id);
    if (!mp) continue;
    mp.cpIndex = -1;
    mp.lap = 0;
    mp.startTime = 0;
    mp.cpSnapshots = []; // 换赛道：清空旧赛道的回退快照（防按旧赛道车型/time/weather 回撤）
    await positionPlayerAtStart(m, room);
  }
  broadcastToRoom(room, `房主将赛道更换为「${race.name}」，成员已移至起点`);
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
  // 成员重置：退出观战（防 putPlayerIn 无效）+ 进度清零 + 回起点 + TD/CP 重建
  for (const m of room.members.values()) {
    const mp = playerRaces.get(m.id);
    if (!mp) continue;
    if (isObserving(m.id)) stopObserve(m);
    mp.cpIndex = -1;
    mp.lap = 0;
    mp.startTime = 0;
    mp.finished = false;
    mp.cpSnapshots = []; // 重开比赛：清空上一场的回退快照（防按旧场车型/time/weather 回撤）
    if (someoneFinished) {
      // 本场已有人完成：成员段落盘保留（含掉线静止段），下一场重新开录
      void stopRecording(m.id, { quiet: true });
    } else {
      // 无人完成：作废本段（discard 原子落盘即删文件不建 DB 记录），下一场
      // 开赛（beginRace）重新开始录制，两场成绩互不混入
      void stopRecording(m.id, { quiet: true, discard: true });
    }
    await positionPlayerAtStart(m, room);
  }
  // 挂起中的掉线会话（掉线未重连）跨场处理：无人完成则丢弃（静止段无续录意义）；
  // 已有人完成则落盘保留。归属校验：断线玩家 playerId 可能被复用开了别的房间
  // 录制，不能误停/误丢
  for (const pid of room.raceMembersLast.keys()) {
    if (!playerRaces.has(pid) && isRecording(pid)) {
      const rec = getRecording(pid);
      if (!rec || !rec.raceRoomId || rec.raceRoomId === room.id) {
        if (someoneFinished) {
          void stopRecording(pid, { quiet: true });
        } else {
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
    broadcastToRoom(room, `房主重开了比赛（赛道不变「${room.raceName}」），成员已回到起点`);
  } else {
    sysMsg(player, "race", `已重置比赛（赛道 ${room.raceName}），成员已回到起点`, "info");
  }
  sysMsg(player, "race", "输入 /r s 或面板「开始比赛」重新开局", "info");
}

/** 找一个等待中的房间（roomUi 命令层 /r j 加入用；无则 undefined） */
export function findWaitingRoom(): RaceRoom | undefined {
  for (const room of rooms.values()) {
    if (room.state === "WAITING") return room;
  }
  return undefined;
}

export async function joinRoom(player: Player, room: RaceRoom): Promise<void> {
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
    cpSnapshots: [],
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
  const first = room.cps[0];
  if (!first) return;
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
      sysMsg(player, "race", `本赛道标准车型为 ${defaultModel}，已刷为对应爱车`, "info");
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

/** 房主开始比赛：倒计时 5s */
export async function startRace(player: Player): Promise<void> {
  const pr = playerRaces.get(player.id);
  if (!pr) return;
  const room = rooms.get(pr.roomId);
  if (!room) return;
  if (room.ownerId !== player.id) {
    sysMsg(player, "race", "只有房主能开始比赛", "error");
    return;
  }
  if (room.state !== "WAITING") {
    sysMsg(player, "race", "比赛已开始", "warn");
    return;
  }
  room.state = "COUNTDOWN";
  broadcastToRoom(room, "比赛倒计时开始！");
  // 倒计时：TextDraw 动画（掉落弹跳 + 放大淡出），GO 显示瞬间开赛（对齐回放/挑战）。
  // onGo 回调检查 state：重开/结束置非 COUNTDOWN 后不再 beginRace（门控保留）
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

/** 正式开赛：切独立世界 + 统一设置房间天气时间 */
function beginRace(room: RaceRoom): void {
  room.state = "RACING";
  const now = Date.now();
  // 超级起步速度：第一 CP 的 superstart 配置（无/非法 → 默认；写其他 CP 无效）。
  // 不写默认生效——所有比赛开局倒计时结束即有超级起步（GO 瞬间沿车头给初速）。
  const superStartKmh = getSuperStartKmh(room.cps);
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
    // await 让出期间房间可能已销毁（/r l 全员离开→checkRoomState）/重开：
    // 此时再对成员 setTime/写缓存会把"已结束房间"的成员时间或已重开的房间
    // 统一时间改乱，直接放弃本次精修
    if (rooms.get(room.id) !== room || room.state !== "RACING") return;
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
  broadcastToRoom(room, "比赛开始！");
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
    // DB 查询为异步：查询期间玩家可能已掉线（TD 被 infernus 自动销毁）或
    // 已离开比赛——setString 前守卫 isValid，防 async 续体对失效 TD 抛错
    if (tds.best.isValid()) {
      tds.best.setString(best === -1 ? "BEST / 99:99:99" : `BEST / ${formatRaceTime(best)}`);
    }
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

/**
 * 观战者 → 被观战比赛成员 的 CP 同步映射（观察者 playerId → 成员 playerId）。
 * 仅"观察者当前正在观战本房间成员"时维护；成员 CP 变化时经 syncCpToObservers
 * 更新观察者的箭头/图标，stopObserve/切换目标/断线/房间销毁时清除。观察者本身
 * 不是房间成员（/tv 外部玩家观战比赛）或完赛自动观战者（仍在 members）都可能。
 */
const spectatorCpMap = new Map<number, number>();

/** 为观察者同步其当前观战成员的下一 CP 箭头/图标（成员 CP 变化各同步点调用）。
 *  仅当观察者确实在看该成员（originPlayerId 匹配，覆盖车内目标）且世界在房间
 *  世界时才更新——观察者切走/离开房间世界后不干扰。 */
function syncCpToObservers(room: RaceRoom, member: Player, cpIndex: number): void {
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
function clearSpectatorCp(observerId: number): void {
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
function cleanupSpectatorCpForRoom(room: RaceRoom): void {
  for (const [oid, mid] of [...spectatorCpMap]) {
    const pr = playerRaces.get(mid);
    if (pr && pr.roomId === room.id) {
      clearSpectatorCp(oid);
    }
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
  room.tdTextCache.clear();
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
  if (!pr) return;
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
  if (!room) return;
  pr.finished = true;
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 完成：清比赛小地图图标
  // 完成者不再跑：清理指向该成员的观察者 CP 箭头（观察者跟随完赛自动观战切走）
  for (const [oid, mid] of [...spectatorCpMap]) {
    if (mid === player.id) clearSpectatorCp(oid);
  }
  const time = Date.now() - pr.startTime;
  // name 快照：完成后玩家可能掉线/离开，endRoom 补计排名时 getName 已取不到
  room.results.push({ playerId: player.id, time, name: player.getName().name });
  room.resultIndex.set(player.id, time);
  const rank = room.results.length; // 完成顺序 = 名次（同一起点同时开始）
  broadcastToRoom(room, `${player.getName().name} 完成比赛！用时 ${formatTime(time)}`);
  // 完成瞬间即落盘本段录像（带名次）：完成者掉线不进重连窗口，若等 endRoom
  // 才落盘，宽限期内掉线会经 forceStopRecording 以无 rank 落盘 → 录像永远
  // 误标"未完成"。提前落盘后 endRoom 的 raceRecordingStop 对已移除会话是 no-op。
  raceRecordingStop(player.id, { rank, finished: true });
  // 第一名完成：立即挂 20s 宽限定时器（同步段、在任何 await 之前）——若延后到
  // 结算对话框/DB 写纪录之后再挂，完成者掉线（cleanupRacePlayer 删 playerRaces，
  // 后续续体直接 return）或对话框一直挂着（await 永不 resolve）时 endTimer 永不
  // 挂载 → 房间永久卡 RACING、无人完赛则无任何路径触发 endRoom
  if (rank === 1 && !room.endTimer) {
    const unfinishedNow = [...room.members.values()].filter(
      (m) => !playerRaces.get(m.id)?.finished,
    ).length;
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
  // 否则会先广播"20 秒后结束"再立刻结束，误导）。
  // 判定"未完成的在线成员"而非 results.length：results 含已离开/掉线的完成者
  //（leaveRace/断线不移除条目），members.size 只算当前在线——若用
  // results.length >= members.size，A 完成离开后 B 再冲线会把还在跑的 C 提前
  // endRoom（"20 秒宽限"承诺作废）。重连窗口玩家（不在 members）仍在跑，也须算
  const unfinished = [...room.members.values()].filter(
    (m) => !playerRaces.get(m.id)?.finished,
  ).length;
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
  cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
  room.members.clear();
  freeRaceWorld(room.worldId); // 房间销毁：回收独立世界 id（供后续房间复用）
  rooms.delete(room.id);
}

function checkRoomState(room: RaceRoom): void {
  // 全员离开但仍有重连窗口 → 不销毁：重连是"成员全掉线也靠窗口存活"的场景
  //（单人房掉线是重连功能最典型用法）。窗口全部到期后 cleanupExpiredReconnects
  // 会再调本函数，此时窗口空、members 仍空 → 正常销毁。
  if (room.members.size === 0 && room.reconnectSlots.size === 0 && room.reconnectUntil.size === 0) {
    // 置 FINISHED：COUNTDOWN 中全员离开时，倒计时链每步都查 state，置位后
    // beginRace 不再被调用（防闭包链空转几秒无效执行）
    room.state = "FINISHED";
    // 全员离开：各自的倒计时动画链随断线自停（组件帧守卫），成员残留 TD 一并清
    for (const m of room.members.values()) cancelCountdownFx(m.id);
    if (room.endTimer) {
      clearTimeoutSafe(room.endTimer);
      room.endTimer = undefined;
    }
    destroyRaceTds(room);
    cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
    // 有人完成（room.results 非空）→ 比赛有成绩，录像保留：挂起会话落盘、
    // 已落盘段不作废。仅"无人完成"才作废删除（挂起丢弃 + 已落盘段删除）。
    const someoneFinished = room.results.length > 0;
    for (const pid of room.raceMembersLast.keys()) {
      // 当前 pid 上的会话归属：只处理本房间的挂起/活跃会话（玩家退赛后又加入
      // 别的房间时，其新会话 raceRoomId 是别的房间——防误停/误丢另一房间的录制）
      const rec = getRecording(pid);
      const mine = !rec || !rec.raceRoomId || rec.raceRoomId === room.id;
      if (isRecording(pid) && mine) {
        if (someoneFinished) {
          void stopRecording(pid, { quiet: true }); // 挂起会话落盘保留（含静止段）
        } else {
          dropRecording(pid); // 挂起会话：丢弃（静止段无成绩价值）
        }
      }
      // 已落盘未完成段作废：不依赖 isRecording 状态——pid 可能已被新连接复用
      // 开了别的房间录制（isRecording=true 且归属不符），旧用户本场的落盘段
      // 仍须作废。discardRaceReplay 按 userId+raceId+raceRoomId 精确匹配本场
      //（rank=null），只会命中旧段，碰不到新用户（不同 userId）的活跃会话
      if (!someoneFinished) {
        discardRaceReplay(pid, room.raceId, room.raceMembersLast.get(pid), room.id);
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
    sysMsg(player, "race", "你不在比赛中", "info");
    return;
  }
  const room = rooms.get(pr.roomId);
  if (room) {
    room.members.delete(player.id);
    room.lastPositions.delete(player.id); // 掉线快照缓存随成员离开清理
    room.afk.delete(player.id); // 挂机累计随离开清理（防 Map 残留）
    cancelCountdownFx(player.id); // 倒计时中离开：停掉自己的倒计时动画（视觉/音效残留）
    // 离开者不再被观战：清理指向该成员的观察者 CP 箭头（观察者切走/继续看别人）
    for (const [oid, mid] of [...spectatorCpMap]) {
      if (mid === player.id) clearSpectatorCp(oid);
    }
    broadcastToRoom(room, `${player.getName().name} 离开了比赛`);
    const tds = room.raceTextTds.get(player.id);
    if (tds) {
      for (const td of Object.values(tds)) {
        if (td.isValid()) td.destroy();
      }
      room.raceTextTds.delete(player.id);
    }
    room.tdTextCache.delete(player.id);
    // 房主离开 → 转移房主（否则其余成员永远无法开始比赛）
    if (room.ownerId === player.id) {
      const next = [...room.members.keys()][0];
      if (next != null) {
        room.ownerId = next;
        const np = Player.getInstance(next);
        broadcastToRoom(room, `房主已离开，${np?.getName().name ?? next} 成为新房主`);
      }
    }
    checkRoomState(room);
  }
  // 离开者自己的反馈
  sysMsg(player, "race", "你已离开比赛房间", "info");
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
      broadcastToRoom(room, "比赛房间因长时间未开始已解散");
      for (const m of room.members.values()) {
        // 解散先清成员观战态（endRoom/restartRace 同序）：成员可能在房间世界
        // /tv 观战他人，不 stopObserve 则其 observeStates 残留、prevWorld 快照
        // 指向即将回收的房间世界——世界 id 复用到新房后 /tv off 会把它塞进
        // 别人的新比赛世界
        if (isObserving(m.id)) stopObserve(m);
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
      cleanupSpectatorCpForRoom(room); // 房间销毁：清理指向本房间成员的观察者 CP 箭头
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
    // 挂机检测（对齐原版 AFKTimes：静止累计超时移出比赛，防占坑不跑）。
    // 200ms tick 采样位置：位移 < 阈值判静止累计（每 tick 固定 +AFK_TICK_MS，与
    // tickRooms 周期一致），有位移清零；累计超 AFK_WARN_MS 提示一次、AFK_IDLE_MS
    // 移出（leaveRace 广播 + 清成员 + 录制落盘）。断线玩家已在重连窗口不在 members。
    for (const m of room.members.values()) {
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
    for (const m of room.members.values()) {
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
    rows.forEach((r, rank) => {
      const mp = playerRaces.get(r.playerId);
      if (!mp) return;
      // 名次写入缓存：60fps syncRaceTds 只读 mp.rank / tdTextCache 重放文本，
      // 不重算排名（距离采样 + 排序保持 200ms 粒度，高频刷新零重计算）
      mp.rank = rank;
      // 实时名次写入录制帧（回放 RANK TD 按播放进度实时显示；与 CP 进度同为
      // 事件驱动——无录制会话时零开销）
      noteRank(r.playerId, rank + 1);
      const time = mp.finished ? r.time : now - mp.startTime;
      const timeText = `TIME / ${formatRaceTime(time)}`;
      const rankText = `RANK / ${rank + 1} ${rankSuffix(rank)}`;
      setRaceTdText(room, r.playerId, timeText, rankText);
      // 观战者同步：观察该玩家的玩家显示同样的 TIME/RANK（对齐原版 RaceRunTime/
      // RaceRunRank 里对观战者的 TD 同步——观战者看到被观战者的比赛信息）
      for (const oid of getObserverIdsOf(r.playerId)) {
        setRaceTdText(room, oid, timeText, rankText);
      }
    });
  }
}

/** 写比赛信息 TD 文本 + 更新文本缓存（去重：相同文本不重复 setString）。
 * 成员与观战者共用：cache 按 playerId 记录上次显示的文本，60fps 高频刷新
 * 只对变化的内容调 native——静态/稳定段零开销 */
function setRaceTdText(room: RaceRoom, playerId: number, timeText: string, rankText: string): void {
  const tds = room.raceTextTds.get(playerId);
  if (!tds) return;
  // TD 可能已被销毁但 Map 条目残留（如掉线瞬间 infernus 自动销毁玩家 TD 后
  // 清理中断）——setString 前守卫 isValid，防止定时器对已销毁 TD 无限抛错
  if (!tds.time.isValid() || !tds.rank.isValid()) return;
  let cache = room.tdTextCache.get(playerId);
  if (!cache) {
    cache = { time: "", rank: "", timeCs: -1 };
    room.tdTextCache.set(playerId, cache);
  }
  if (timeText !== cache.time) {
    cache.time = timeText;
    tds.time.setString(timeText);
  }
  if (rankText !== cache.rank) {
    cache.rank = rankText;
    tds.rank.setString(rankText);
  }
}

/** 60fps 比赛信息 TD 高频刷新（对齐回放观战的平滑效果）：TIME 实时推进跳表。
 * 排名由 tickRooms（200ms）计算写入 mp.rank / tdTextCache，本函数只按缓存重放
 * 文本——不做距离采样/排序，内容未变零 native 调用（cache 去重），仅 RACING
 * 房间参与（WAITING/COUNTDOWN/FINISHED 直接跳过，空转开销忽略）。
 * 成员刷自己的计时；观战者刷被观战者的计时（其 TD 缓存由 tickRooms 写入，
 * 这里按被观战者 startTime 重算同值） */
function syncRaceTds(): void {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state !== "RACING") continue;
    // 成员本人：TIME 实时推进（finished 定格在 tickRooms 写入的完成时间）。
    // 观战中的成员跳过：其 TD 显示被观战者的信息（下面观战循环写），否则
    // 60fps 会用自己的时间覆盖掉 tickRooms 写入的被观战者时间——出现"自己的
    // 时间 + 别人的名次"错乱。
    for (const m of room.members.values()) {
      const mp = playerRaces.get(m.id);
      const tds = room.raceTextTds.get(m.id);
      const cache = room.tdTextCache.get(m.id);
      if (!mp || !tds || !cache || mp.finished || isObserving(m.id)) continue;
      // 60fps 热路径：TD 可能因掉线被 infernus 自动销毁（残留条目不命中上面
      // 的 !tds）——setString 前守卫 isValid，防对已销毁 TD 抛错刷屏
      if (!tds.time.isValid()) continue;
      // 秒表跳表：仅当显示值（厘秒）变化才格式化+setString——60fps 下大多数
      // tick 的厘秒没变，跳过能省下 formatRaceTime 的除法/padStart/模板串
      const cs = Math.floor((now - mp.startTime) / 10);
      if (cs !== cache.timeCs) {
        cache.timeCs = cs;
        const timeText = `TIME / ${formatRaceTime(now - mp.startTime)}`;
        cache.time = timeText;
        tds.time.setString(timeText);
      }
    }
    // 观战中的房内成员：同步被观战者（玩家）的 TIME（RANK 由 tickRooms 写入
    // 被观战者名次，两者一致）。只处理房内成员（tdTextCache 只为有房间 TD 的
    // 成员/观察者创建；房外观察者无本房 TD，本就没有 TD 可刷）。
    for (const pid of room.tdTextCache.keys()) {
      if (!isObserving(pid)) continue;
      const st = getObserveTarget(pid);
      if (!st || st.kind !== "player") continue;
      // 跨房间校验：房间 X 成员可能 /tv 观战别的房间的步行玩家，此时不能用
      // 目标房间 Y 的 startTime 写本房间 X 的 TD（"Y 的时间 + 自己的名次"错乱）
      const tmp = playerRaces.get(st.targetId);
      if (!tmp || tmp.roomId !== room.id) continue;
      const target = Player.getInstance(st.targetId);
      if (!target || !target.isConnected()) continue;
      const tds = room.raceTextTds.get(pid);
      const cache = room.tdTextCache.get(pid);
      if (!tds || !cache || tmp.finished) continue;
      if (!tds.time.isValid()) continue;
      const cs = Math.floor((now - tmp.startTime) / 10);
      if (cs !== cache.timeCs) {
        cache.timeCs = cs;
        const timeText = `TIME / ${formatRaceTime(now - tmp.startTime)}`;
        cache.time = timeText;
        tds.time.setString(timeText);
      }
    }
  }
}

/** 初始化比赛系统 */
export function initRaceSystem(): void {
  // /r(race) 命令入口（/r s|j|l|info|create|edit|page + 赛道列表）已拆到 roomUi.ts 的
  // initRaceUi()，callbacks 里在 initRaceSystem() 后调用——本函数只管比赛核心事件。

  // 观战者 CP 箭头同步：观察者开始观战（/tv / 切换目标 / 完赛自动观战）时若目标是
  // 房间成员 → 立即摆上其当前 CP；停止观战/断线/切换时清除。清理集中在钩子 +
  // 房间销毁（cleanupSpectatorCpForRoom），无独立实体残留
  onObserveStart(onSpectatorStart);
  onObserveStop(clearSpectatorCp);

  // 到达检查点事件
  RaceCpEvent.onPlayerEnter(({ player, next }) => {
    // 统一排除 NPC（对齐项目约定：所有事件回调排除 NPC）
    if (player.isNpc()) return next();
    if (isInRace(player.id) && !isEditing(player.id)) {
      void onPlayerReachCp(player);
    }
    return next();
  });

  // 实时排名定时器（GameMode.onExit 统一清理）
  setIntervalSafe(() => tickRooms(), 200);
  // 比赛信息 TD 高频刷新（60fps，对齐回放观战效果；只对变化内容调 native）
  setIntervalSafe(() => syncRaceTds(), 16);

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
  PlayerEvent.onCommandText("kill", ({ player, next }) => {
    if (player.isWasted()) {
      sysMsg(player, "system", "生命值为空，请等待重生", "plain");
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
    sysMsg(player, "race", "比赛尚未开始，已正常重生", "info");
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
        sysMsg(driver, "race", "车辆已损毁，自动刷出比赛用车", "info");
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

/** 回撤重生目标的状态（回放式状态回撤）：
 * - 车模型：目标快照的车型 ≠ 当前车型 → 回退到该车型（cveh 换车场景，否则车模型残留）。
 *   目标快照缺（比赛开始即回退/无记录）→ 模型不变（只能回退位置）；跳过"过点车"不可逆。
 * - time/weather：目标快照存在则恢复（time/weather 脚本可逆、覆盖当前即可）。
 * 快照有 vehModel=0（过点时步行）时保持当前车模型（不把车变没）。 */
function applyRollbackState(
  player: Player,
  pr: PlayerRace,
  target: ReturnType<typeof computeTargetCp>,
): void {
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
function respawnToCpCore(
  player: Player,
  room: RaceRoom,
  target: ReturnType<typeof computeTargetCp>,
): void {
  const { prevIdx, prev } = target;
  if (!prev) return;
  const pt = getRespawnPoint(prev);
  const owned = getOwnedVehicle(player.id);
  if (owned && owned.isValid()) {
    owned.setPos(pt.x, pt.y, pt.z);
    owned.setZAngle(pt.angle);
    owned.setHealth(1000);
    owned.repair();
    addVehicleComponentIfPossible(owned, 1010);
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

/** 重生回上一 CP（死亡场景：setSpawnInfo + spawn 复活） */
function respawnPlayerToCp(
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

/** 回退（rollback>0）时把玩家进度回写到目标 CP：否则 onPlayerReachCp 仍按旧
 * cpIndex+1 取目标，红圈在回退目标、事件却期待更后面的 CP——脚本在错误位置触发
 * 且目标 CP 永远重跑不到（cveh 换车类赛道回退后车型/时间错乱）。
 * 普通重生（rollback=0）进度本就一致（playerRaces 与位置同步推进），不回写——
 * 跨圈瞬间 cpIndex=-1 时回写会错误地把 lap 打回上一圈。 */
function writeBackRollbackProgress(
  player: Player,
  pr: PlayerRace,
  room: RaceRoom,
  target: ReturnType<typeof computeTargetCp>,
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
      // 归属校验（对齐 cleanupExpiredReconnects）：断线期间该 playerId 可能被新
      // 连接复用开了录制（含同一房间被同房新成员复用——raceRoomId 相同），须再
      // 比 userId 才是掉线者自己的挂起会话，防误停别人的活跃会话
      if (slot && isRecording(slot.playerId)) {
        const rec = getRecording(slot.playerId);
        if (rec && rec.userId === auth.userId && (!rec.raceRoomId || rec.raceRoomId === room.id)) {
          void stopRecording(slot.playerId, { quiet: true });
        }
      }
      // 玩家已在线（重连流程中）：明确提示窗口状态，避免"输入完密码直接走登录
      // 流程"的困惑（重连窗口只对进行中的比赛建立，短比赛/过期/房间结束都无
      // 法恢复，走正常登录是预期行为，但要说清楚）
      sysMsg(
        player,
        "race",
        room.state === "FINISHED"
          ? "原比赛房间已结束，无法重连（将正常登录）"
          : "重连窗口已过期，无法恢复比赛（将正常登录）",
        "warn",
      );
      continue;
    }
    // 恢复：重新加入房间 + 恢复进度
    room.reconnectUntil.delete(auth.userId);
    room.reconnectSlots.delete(auth.userId);
    // playerId 可能已被复用（新连接 id 与掉线时不同）：把挂起的录制会话从
    // 旧 id 迁移到新 id，否则 resumeRecording(player.id) 找不到会话（掉线静帧
    // 断在旧 id 上、回放缺段），且旧 id 残留挂起会话占内存。传 raceRoomId 归属
    // 校验：旧 id 可能已被新连接占用来开别的房间的挂起会话，不能劫持
    if (slot && slot.playerId !== player.id) {
      rebindRecording(slot.playerId, player.id, room.id, auth.userId);
    }
    room.members.set(player.id, player);
    room.raceMembersLast.set(player.id, auth.userId); // 重新登记本场录制成员（userId 快照供离线作废）
    // 恢复战局归属：按掉线时快照的原战局 id 精确匹配（sessionId 自增不复用，战局
    // 仍在则必然命中原战局——worldId 会被解散战局回收复用，按 worldId 可能塞进
    // 无关新战局）。战局已解散（查无此 id）→ 回公共大世界并修正 prevWorld=0
    //（避免比赛结束恢复到已解散战局的幽灵世界，与战局登记不一致）
    const prevWorld = slot?.prevWorld ?? player.getVirtualWorld();
    const joinedSession = sessionManager.rejoinPlayerSession(player, slot?.sessionId ?? 0);
    playerRaces.set(player.id, {
      roomId: room.id,
      cpIndex: slot?.cpIndex ?? -1,
      lap: slot?.lap ?? 0,
      startTime: slot?.startTime ?? Date.now(),
      finished: false,
      // 恢复断线前所在世界（重连时玩家必然在世界 0，不能用作 prevWorld）
      prevWorld: joinedSession ? prevWorld : 0,
      cpSnapshots: [], // 重连是新连接：回退重生快照从空重建（后续过 CP 重新记录）
    });
    // 切回比赛世界 + 恢复掉线瞬间位置（重连是全新连接，跳过出生定位，不恢复
    // 会出现在地图默认出生点，与"继续第 N 圈"提示严重不符）。
    // 只 setSpawnInfo 不设 pendingSpawnPos：比赛中 onSpawn 的 respawnBySetting 对
    // isInRace 玩家提前 return（不会随机定位），setSpawnInfo 即权威；而 pendingSpawnPos
    // 若残留会在**之后的死亡重生**被 onSpawn 误消费（把玩家 setPos 回掉线点并弹出车）。
    player.setVirtualWorld(room.worldId);
    if (slot && slot.x !== 0) {
      const angle = room.cps[Math.max(0, slot.cpIndex)]?.angle ?? 0;
      player.setSpawnInfo(0, player.getSkin(), slot.x, slot.y, slot.z, angle, 0, 0, 0, 0, 0, 0);
      player.setPos(slot.x, slot.y, slot.z);
    }
    // 清挂机采样：playerId 键可能继承掉线前的静止累计（重连后停在原地没立刻开
    // 车会误判"即将移出比赛"），且重连玩家是新上下文，从零开始累计
    room.afk.delete(player.id);
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
      // 立即写入 TIME/RANK（含初始化 tdTextCache）：否则下一个 tickRooms（≤200ms）
      // 前 syncRaceTds 无 cache 跳过、TD 停在创建时的 "00:00:00 / 1 st"，显示
      // 从 0 跳变到掉线前累计时间。TIME 用 startTime 起算（slot 恢复的掉线前计时）
      const rstart = playerRaces.get(player.id)?.startTime ?? Date.now();
      setRaceTdText(
        room,
        player.id,
        `TIME / ${formatRaceTime(Date.now() - rstart)}`,
        `RANK / 1 ${rankSuffix(0)}`,
      );
      // 恢复 BEST TD（房间缓存已有，无则查询）
      void updateBestTd(player, room, tds);
      // 恢复 CP 进度 TD（按断线时进度）
      const cpDone = Math.min((slot?.cpIndex ?? -1) + 1, room.cps.length);
      tds.cp.setString(`C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`);
      showNextCheckpoint(player, room.cps, slot?.cpIndex ?? -1);
      // 重连恢复同步观战者的 CP 箭头（观察者跟着看到重连后的当前目标）
      syncCpToObservers(room, player, slot?.cpIndex ?? -1);
      // 重新强制无碰撞（重连是全新连接，碰撞状态已重置）
      applyRaceNoCollision(player, true);
      // 恢复房间统一时间天气（重连是新连接，默认回服务器时间天气——不恢复会
      // 与同房其他成员不一致，直到碰到带 time/weather 脚本的 CP）
      player.setTime(room.roomTime.hour, room.roomTime.minute);
      player.setWeather(room.roomWeather);
      // 无车兜底（断线前坐默认比赛车，重连时已被清理）：用默认比赛车型刷爱车
      // （有该模型爱车则复用外观，没有则自动创建成爱车——与 joinRoom/beginRace 一致）。
      // 判 isValid：断线期间爱车可能被炸（实体失效但仍占 Map 条目）
      const ownedVeh = getOwnedVehicle(player.id);
      if (!player.isInAnyVehicle() && (!ownedVeh || !ownedVeh.isValid())) {
        void spawnVehicle(player, getDefaultRaceModel(room.cps), true);
      }
    }
    // 重连是全新连接：onDisconnect 已 cleanupAttire 清空挂件，且重连路径不触发
    // onSpawn（玩家被直接放回车里）——手动重挂默认人物装扮，否则整个重连比赛
    // 期间装扮缺失
    void reapplyCurrentPlayerPreset(player);
    broadcastToRoom(room, `${player.getName().name} 已重连比赛！`);
    sysMsg(
      player,
      "race",
      `已重连比赛「${room.raceName}」，继续第 ${(slot?.lap ?? 0) + 1} 圈`,
      "success",
    );
    // 房主重连 → 恢复房主身份
    if (room.ownerId === player.id || room.ownerUserId === auth.userId) {
      room.ownerId = player.id;
      room.ownerUserId = auth.userId;
      broadcastToRoom(room, `${player.getName().name} 恢复了房主身份`);
    }
    return true;
  }
  return false;
}
