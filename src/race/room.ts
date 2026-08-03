import {
  Dialog,
  DialogStylesEnum,
  GameText,
  Player,
  PlayerEvent,
  RaceCheckpoint,
  RaceCpEvent,
  TextDraw,
} from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getOwnedVehicle } from "@/vehicles";
import { execCpScript, cleanupScriptVehicle, type CpScriptContext } from "./scripts";
import { isEditing } from "./editor";
import {
  applyRaceNoCollision,
  restorePersonalNoCollision,
  getDefaultRaceModel,
  spawnRaceVehicleAt,
} from "./vehicle";
import { setIntervalSafe, setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";
import { startObservePlayer, stopObserve, isObserving, cleanupObserve } from "@/core/observe";
import { getSafeGroundZ } from "@/core/colandreas";
import { applyWorldEnv, getWorldWeather } from "@/core/worldenv";
import { sessionManager } from "@/sessions/manager";
import { formatTime } from "@/utils/format";
import { showPagedDialog } from "@/utils/pagedDialog";
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
/** 比赛房间独立世界起始 id（避开公共大世界 0 与战局 1..n） */
const RACE_WORLD_BASE = 5000;
let nextRaceWorldId = RACE_WORLD_BASE;

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
  results: { playerId: number; time: number }[];
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
  /** 掉线重连：playerId -> 重连截止时间戳（窗口内不清理） */
  reconnectUntil: Map<number, number>;
  /** 掉线重连：playerId -> 断线时进度快照 */
  reconnectSlots: Map<
    number,
    { cpIndex: number; lap: number; startTime: number; prevWorld: number }
  >;
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
 * /r(race) 比赛管理 · /pm 私聊 · /kill 重生 · /tv(ob/spec) 观战
 * 匹配的是主命令（strictMainCmd），如 "/r l" 的主命令是 "r"。
 * 其余命令一律拒绝。
 */
const RACE_SAFE_COMMANDS = new Set(["r", "race", "pm", "kill", "tv", "ob", "spec"]);

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
        const window = Math.min(
          RECONNECT_MAX_MS,
          Math.max(RECONNECT_MIN_MS, estMs * RECONNECT_RATIO),
        );
        room.reconnectUntil.set(playerId, Date.now() + window);
        room.reconnectSlots.set(playerId, {
          cpIndex: pr.cpIndex,
          lap: pr.lap,
          startTime: pr.startTime,
          prevWorld: pr.prevWorld,
        });
        room.members.delete(playerId);
        playerRaces.delete(playerId);
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
  for (const [pid, until] of room.reconnectUntil) {
    if (now >= until) {
      room.reconnectUntil.delete(pid);
      room.reconnectSlots.delete(pid);
      // 房主重连窗口过期 → 转移房主
      if (room.ownerId === pid) {
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

/** 创建比赛房间并加入 */
export async function createRaceRoom(player: Player, raceId: string): Promise<RaceRoom | null> {
  if (isInRace(player.id)) {
    player.sendClientMessage(COLOR_ERROR, "你已在比赛中");
    return null;
  }
  const race = await prisma.race.findUnique({
    where: { id: raceId },
    include: { sysUser: true },
  });
  if (!race || !race.isEnabled || race.deletedAt) {
    player.sendClientMessage(COLOR_ERROR, "赛道不存在或未启用");
    return null;
  }
  const cps = await prisma.raceCp.findMany({
    where: { raceId },
    orderBy: { index: "asc" },
    include: { raceCpScripts: { orderBy: { index: "asc" } } },
  });
  if (cps.length < 2) {
    player.sendClientMessage(COLOR_ERROR, "该赛道至少需要 2 个检查点");
    return null;
  }
  const room: RaceRoom = {
    id: nextRoomId++,
    raceId,
    raceName: race.name,
    authorName: race.sysUser?.username ?? "未知",
    laps: Math.max(1, race.laps ?? 1),
    worldId: nextRaceWorldId++,
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
  };
  rooms.set(room.id, room);
  joinRoom(player, room);
  player.sendClientMessage(
    COLOR_SUCCESS,
    `比赛房间已创建，赛道「${race.name}」（${room.laps} 圈），输入 /r j 可加入`,
  );
  return room;
}

function joinRoom(player: Player, room: RaceRoom): void {
  // 已参与其他房间则先离开（防止 playerRaces 被覆盖、旧房间残留成员）
  if (isInRace(player.id)) {
    leaveRace(player);
  }
  room.members.set(player.id, player);
  playerRaces.set(player.id, {
    roomId: room.id,
    cpIndex: -1,
    lap: 0,
    startTime: 0,
    finished: false,
    prevWorld: player.getVirtualWorld(),
  });
  // 加入即定位到第一个 CP 起点（对齐原版 Race_Game_Join：玩家有自己的车就用
  // 自己的车放起点）并显示第一个 CP 箭头（指向第二个），等待/热身阶段就站在
  // 起点看到目标。优先级：
  // 1. 有爱车（playerVehs 实体，本次会话刷过的车）→ 用爱车（即使人不在车里）
  // 2. 没爱车但人在某辆车里 → 挪当前车
  // 3. 都没 → 刷默认比赛车兜底（首个 CP 有 cveh 用其车型，否则 411）
  const first = room.cps[0];
  if (first) {
    const owned = getOwnedVehicle(player.id);
    if (owned && owned.isValid()) {
      owned.setPos(first.x, first.y, first.z);
      owned.setZAngle(first.angle);
      owned.putPlayerIn(player, 0);
    } else if (player.isInAnyVehicle()) {
      const veh = player.getVehicle()!;
      veh.setPos(first.x, first.y, first.z);
      veh.setZAngle(first.angle);
    } else {
      spawnRaceVehicleAt(player, getDefaultRaceModel(room.cps), first.x, first.y, first.z, first.angle);
    }
    // 显示第一个 CP（红色箭头指向第二个；open.mp 切换世界不改变坐标，
    // 开赛切到比赛世界后仍站在同一位置，beginRace 的 setPos 幂等保留）
    showNextCheckpoint(player, room.cps, -1);
  }
  // 提示：房主（创建者）不需要"等待房主开始"
  if (room.ownerId === player.id) {
    player.sendClientMessage(COLOR_RACE, `你加入了比赛房间（赛道 ${room.raceName}），输入 /r s 开始比赛`);
  } else {
    player.sendClientMessage(COLOR_RACE, `你加入了比赛房间（赛道 ${room.raceName}），等待房主开始`);
  }
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
      if (!m.isInAnyVehicle()) {
        // 无车兜底（等待期间车辆被销毁等极端情况）：优先用爱车，否则原地刷默认比赛车，
        // 不移动玩家
        const owned = getOwnedVehicle(m.id);
        if (owned && owned.isValid()) {
          const pos = m.getPos();
          owned.setPos(pos.x, pos.y, pos.z);
          owned.setZAngle(m.getFacingAngle().angle);
          owned.putPlayerIn(m, 0);
        } else {
          const pos = m.getPos();
          spawnRaceVehicleAt(
            m,
            getDefaultRaceModel(room.cps),
            pos.x,
            pos.y,
            pos.z,
            m.getFacingAngle().angle,
          );
        }
      }
      // 显示起点 CP 箭头（红圈在起点、箭头指向第一个 CP；小地图图标在下一个 CP，对齐原版）
      showNextCheckpoint(m, room.cps, -1);
      // 创建比赛信息 UI（4 行：CP/TIME/BEST/RANK）
      const tds = createRaceTd(m, room);
      // 异步查询个人最佳并更新 BEST TD（原版进比赛即显示）
      void updateBestTd(m, room, tds);
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
    cp: raceTdBase(player, 118, "C  P / ~p~0~w~/~y~0"),
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

  // 更新 CP 进度 TD（对齐原版过 CP 时 "C  P / ~p~进度~w~/~y~总数"；完成时同样先刷满）
  const raceTds = room.raceTextTds.get(player.id);
  if (raceTds) {
    const done = Math.min(pr.cpIndex + 1, room.cps.length);
    raceTds.cp.setString(`C  P / ~p~${done}~w~/~y~${room.cps.length}`);
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

  // 触发当前 CP 脚本（脚本已随房间载入内存，不再查库）
  const scriptCtx: CpScriptContext = {
    raceId: room.raceId,
    cpid: nextCp.index,
    raceName: room.raceName,
    authorName: room.authorName,
    cps: room.cps.map((c) => ({ index: c.index, x: c.x, y: c.y, z: c.z })),
  };
  for (const script of nextCp.scripts) {
    // spawnpos 返回 false → 终止整条脚本链（对齐原版 Race_Cp_Script_Start 的 return 1）
    if (!execCpScript(player, scriptCtx, script)) return;
    // 脚本执行（同步）期间玩家可能已离开/比赛结束 → 终止后续操作
    if (!playerRaces.has(player.id) || rooms.get(pr.roomId)?.state !== "RACING" || pr.finished) {
      return;
    }
  }

  // 显示下一个 CP
  showNextCheckpoint(player, room.cps, pr.cpIndex);
  player.playSound(1056);
}

/** 完成比赛 */
async function finishPlayer(player: Player, pr: PlayerRace): Promise<void> {
  const room = rooms.get(pr.roomId);
  if (!room) return;
  pr.finished = true;
  RaceCheckpoint.disable(player);
  clearRaceMapIcons(player); // 完成：清比赛小地图图标
  const time = Date.now() - pr.startTime;
  room.results.push({ playerId: player.id, time });
  room.resultIndex.set(player.id, time);
  const rank = room.results.length; // 完成顺序 = 名次（同一起点同时开始）
  broadcastToRoom(room, `[赛车] ${player.getName().name} 完成比赛！耗时 ${formatTime(time)}`);

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
  // 否则会先广播"20 秒后结束"再立刻结束，误导）
  if (room.results.length >= room.members.size) {
    endRoom(room);
    return;
  }
  // 第一名完成、还有成员在跑 → 20s 宽限等他们冲线
  if (rank === 1 && !room.endTimer) {
    broadcastToRoom(room, "[赛车] 第一名已完成，20 秒后比赛结束");
    room.endTimer = setTimeoutSafe(() => endRoom(room), END_GRACE_MS);
  }
  // 自动观战下一个未完成玩家（二次确认目标仍有效）
  const next = [...room.members.values()].find((m) => {
    const mp = playerRaces.get(m.id);
    return mp && !mp.finished && m.isConnected();
  });
  if (next) {
    player.sendClientMessage(COLOR_RACE, "[赛车] 你已完成比赛，自动观战其他玩家（/tv off 停止）");
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
    const prevWorld = mp?.prevWorld ?? 0;
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
  destroyRaceTds(room);
  room.members.clear();
  rooms.delete(room.id);
}

function checkRoomState(room: RaceRoom): void {
  if (room.members.size === 0) {
    if (room.countdownTimer) clearTimeoutSafe(room.countdownTimer);
    if (room.endTimer) clearTimeoutSafe(room.endTimer);
    destroyRaceTds(room);
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
        playerRaces.delete(m.id);
      }
      destroyRaceTds(room);
      room.members.clear();
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
    });
  }
}

/** 初始化比赛系统 */
export function initRaceSystem(): void {
  PlayerEvent.onCommandText(["r", "race"], ({ player, subcommand, next }) => {
    const cmd = subcommand[0];
    const query = subcommand.slice(1).join(" ");
    if (cmd === "s") {
      if (query) {
        void startRaceFlow(player, query);
      } else {
        // 无参数：房主在房间内则开始比赛，否则提示用法
        const pr = playerRaces.get(player.id);
        if (pr && rooms.get(pr.roomId)?.ownerId === player.id) {
          void startRace(player);
        } else {
          player.sendClientMessage(
            COLOR_RACE,
            "用法: /r s 赛道名称 创建比赛 · /r j 加入 · /r l 离开",
          );
        }
      }
    } else if (cmd === "j") {
      joinRoomFlow(player);
    } else if (cmd === "l" || cmd === "leave") {
      leaveRace(player);
    } else if (!cmd) {
      // /r 无参数 → 弹赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表，
      // 选中赛道直接创建比赛）
      void openRaceListDialog(player);
    } else {
      player.sendClientMessage(COLOR_RACE, "用法: /r s 赛道名称 创建比赛 · /r j 加入 · /r l 离开");
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
}

/**
 * 计算重生坐标：用 colandreas 找 CP 坐标的实际地面高度，
 * 防止玩家重生时卡进建筑物里。超出地图范围或 colandreas 不可用时回退 CP 原始高度。
 */
function getSafeRespawnZ(cp: { x: number; y: number; z: number }): number {
  const ground = getSafeGroundZ(cp.x, cp.y, cp.z);
  // 地面高度合理（不低于地图下限），取地面；否则用原高度
  return ground > MIN_Z ? ground : cp.z;
}

/** 重生回上一 CP（死亡场景：setSpawnInfo + spawn 复活） */
function respawnPlayerToCp(player: Player, pr: PlayerRace, room: RaceRoom): void {
  const prevIdx = Math.max(0, pr.cpIndex);
  const prev = room.cps[prevIdx];
  if (!prev) return;
  const z = getSafeRespawnZ(prev);
  player.setSpawnInfo(0, player.getSkin(), prev.x, prev.y, z, prev.angle, 0, 0, 0, 0, 0, 0);
  player.spawn();
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

/** 开始比赛流程：按赛道名/ID 创建房间 */
async function startRaceFlow(player: Player, query: string): Promise<void> {
  if (!query) {
    player.sendClientMessage(COLOR_RACE, "用法: /r s 赛道名称 或 /r s 赛道ID");
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
    player.sendClientMessage(COLOR_ERROR, "未找到该赛道");
    return;
  }
  const room = await createRaceRoom(player, race.id);
  if (room) {
    // 创建后等待加入：房主再次 /r s 开始
    player.sendClientMessage(COLOR_RACE, "再输入 /r s 开始比赛");
  }
}

/**
 * /r 无参数 → 赛道列表对话框（对齐原版 Race_ShowGameMainSel 分页列表）。
 * 分页多列展示启用赛道（# 名称 长度 圈数 作者），选择后直接创建比赛。
 */
async function openRaceListDialog(player: Player): Promise<void> {
  const races = await prisma.race.findMany({
    where: { isEnabled: true, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { sysUser: true },
  });
  if (races.length === 0) {
    player.sendClientMessage(COLOR_ERROR, "暂无可用赛道");
    return;
  }
  const r = await showPagedDialog(player, {
    caption: "选择赛道开始比赛",
    data: races,
    headers: ["#", "名称", "长度", "圈数", "作者"],
    format: (race, index) => [
      String(index + 1),
      race.name,
      `${Math.round(Number(race.totalLength))}m`,
      `${race.laps ?? 1}`,
      race.sysUser?.username ?? "?",
    ],
    button1: "开始",
    button2: "取消",
  });
  if (!r) return;
  const room = await createRaceRoom(player, r.item.id);
  if (room) {
    player.sendClientMessage(COLOR_RACE, "再输入 /r s 开始比赛");
  }
}

/** 加入房间流程 */
function joinRoomFlow(player: Player): void {
  const room = [...rooms.values()].find((r) => r.state === "WAITING");
  if (!room) {
    player.sendClientMessage(COLOR_ERROR, "当前没有等待中的比赛房间");
    return;
  }
  joinRoom(player, room);
  broadcastToRoom(room, `[赛车] ${player.getName().name} 加入了比赛`);
}

/**
 * 掉线重连：玩家重新进入游戏时，若其断线窗口未过期且房间仍存在，恢复比赛进度。
 * 返回 true 表示已恢复；false 表示无可重连房间。
 */
export async function tryReconnectRace(player: Player): Promise<boolean> {
  const auth = getAuthState(player.id);
  if (!auth) return false;
  // 遍历房间找该玩家的重连窗口
  for (const room of rooms.values()) {
    const until = room.reconnectUntil.get(player.id);
    if (until == null) continue;
    const slot = room.reconnectSlots.get(player.id);
    // 窗口过期或房间已结束/解散 → 清理窗口，无法重连
    if (Date.now() >= until || room.state === "FINISHED") {
      room.reconnectUntil.delete(player.id);
      room.reconnectSlots.delete(player.id);
      continue;
    }
    // 恢复：重新加入房间 + 恢复进度
    room.reconnectUntil.delete(player.id);
    room.reconnectSlots.delete(player.id);
    room.members.set(player.id, player);
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
      const tds = createRaceTd(player, room);
      // 恢复 BEST TD（房间缓存已有，无则查询）
      void updateBestTd(player, room, tds);
      // 恢复 CP 进度 TD（按断线时进度）
      const cpDone = Math.min((slot?.cpIndex ?? -1) + 1, room.cps.length);
      tds.cp.setString(`C  P / ~p~${cpDone}~w~/~y~${room.cps.length}`);
      showNextCheckpoint(player, room.cps, slot?.cpIndex ?? -1);
      // 重新强制无碰撞（重连是全新连接，碰撞状态已重置）
      applyRaceNoCollision(player, true);
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
