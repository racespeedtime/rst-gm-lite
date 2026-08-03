import { DynamicMapIcon, GameMode, Player, TextLabel } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getSetting } from "@/personalize/settings";
import { setIntervalSafe, clearIntervalSafe } from "@/core/timers";

/** 世界环境持有的实体（onExit 时统一销毁） */
interface WorldEnv {
  icons: DynamicMapIcon[];
  labels: TextLabel[];
}

import { COLOR_LABEL, COLOR_RACE } from "@/utils/colors";
/** 服务器全局天气（作为"世界"环境基准，供 syncWorldWeather 跟随） */
export const WORLD_WEATHER = 10;
/** 大世界时间同步间隔（秒）——现实时间映射，每 60 秒同步一次 */
export const WORLD_TIME_SYNC_MS = 60_000;
/** 天气轮换间隔（秒）——每 30 分钟 20% 概率随机换一次 */
export const WEATHER_ROTATE_MS = 30 * 60_000;
const WEATHER_ROTATE_CHANCE = 0.2;
/** 常用天气池（晴/多云/雨/雾等） */
const WEATHER_POOL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16];

/**
 * 按现实时间分时段确定天气：
 * 白天(6-18)晴天、黄昏(18-20)橙色、夜晚(20-6)晴夜。
 */
function weatherByTime(hour: number): number {
  if (hour >= 6 && hour < 18) return 0; // 白天晴
  if (hour >= 18 && hour < 20) return 15; // 黄昏
  return 3; // 夜晚
}

/** 同步大世界时间（现实时间）与天气，并同步给跟随的玩家 */
export async function syncWorldClock(): Promise<void> {
  const now = new Date();
  GameMode.setWorldTime(now.getHours());
  // 同步 syncGameTime=true 的在线玩家（现实 1 分钟 = 游戏 1 分钟）
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncGameTime) continue;
    player.setTime(now.getHours(), now.getMinutes());
  }
}

/**
 * 每 30 分钟轮换天气：20% 概率从天气池随机换一次，
 * 否则保持当前（分时段基准天气）。同步给 syncWorldWeather 玩家。
 */
let currentWeather = WORLD_WEATHER;

/** 当前世界天气（跟随世界/房间统一设置时读取） */
export function getWorldWeather(): number {
  return currentWeather;
}

async function rotateWeather(): Promise<void> {
  if (Math.random() < WEATHER_ROTATE_CHANCE) {
    currentWeather = WEATHER_POOL[Math.floor(Math.random() * WEATHER_POOL.length)];
  } else {
    currentWeather = weatherByTime(new Date().getHours());
  }
  GameMode.setWeather(currentWeather);
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncWorldWeather) continue;
    player.setWeather(currentWeather);
  }
}

/** 启动大世界时间/天气定时器（GameMode.onInit 调用，timer 统一清理） */
export function startWorldClockTimers(): void {
  setIntervalSafe(() => {
    void syncWorldClock();
  }, WORLD_TIME_SYNC_MS);
  setIntervalSafe(() => {
    void rotateWeather();
  }, WEATHER_ROTATE_MS);
}

let worldEnv: WorldEnv = { icons: [], labels: [] };

/** 清理世界环境实体（GameMode.onExit 调用） */
export function clearWorldEnvironment(): void {
  for (const icon of worldEnv.icons) {
    if (icon.isValid()) icon.destroy();
  }
  for (const label of worldEnv.labels) {
    if (label.isValid()) label.destroy();
  }
  worldEnv = { icons: [], labels: [] };
}

/** 地图图标定义（map_icon 表 → per-player SetPlayerMapIcon，登录时设置） */
let mapIconDefs: { iconId: number; x: number; y: number; z: number }[] = [];

/**
 * 给玩家设置全部地图图标（per-player SetPlayerMapIcon，无流式距离，小地图常驻）。
 * 断线后图标随连接自动消失，无需清理；重新登录时再设置。
 * 对齐原版 Race_ShowCp 的 SetPlayerMapIcon 用法（style=1 仅小地图显示）。
 */
export function applyMapIconsToPlayer(player: Player): void {
  for (let i = 0; i < mapIconDefs.length; i++) {
    const d = mapIconDefs[i];
    try {
      player.setMapIcon(i, d.x, d.y, d.z, d.iconId, 0xffffffaa, 1);
    } catch (e) {
      logger.warn(`[worldenv] 设置玩家地图图标失败 ${player.getName().name} icon=${d.iconId}`, e);
    }
  }
}

/**
 * 初始化世界环境（GameMode.onInit 调用）：
 * 1. 服务器全局时间/天气（世界环境基准）
 * 2. map_icon 表 → 缓存图标定义（per-player SetPlayerMapIcon 常驻小地图，
 *    不再用 DynamicMapIcon——streamer 默认 streamDistance=200 导致走远图标消失）
 * 3. 系统传送点 → 3D 标签（"/名称 + 描述"）
 * 4. 启用赛道起点 → 3D 标签（"输入 /r s 赛道名 开始比赛"）+ 地图图标（类型 53）
 */
export async function initWorldEnvironment(): Promise<void> {
  // 1. 全局时间天气（现实时间同步 + 分时段天气）
  syncWorldClock();
  currentWeather = weatherByTime(new Date().getHours());
  GameMode.setWeather(currentWeather);
  logger.info(`[worldenv] 全局时间 ${new Date().getHours()}:00 天气 ${currentWeather}`);

  const icons: DynamicMapIcon[] = [];
  const labels: TextLabel[] = [];

  // 2. 地图图标（数据库 map_icon 表）
  // 缓存定义即可（不创建实体）：登录时用 per-player SetPlayerMapIcon 设置，
  // 小地图常驻显示。不用 DynamicMapIcon——streamer 流式默认 streamDistance=200，
  // 玩家走远图标就消失（小地图也跟着没）。
  try {
    const mapIcons = await prisma.mapIcon.findMany({
      where: { deletedAt: null },
      orderBy: { index: "asc" },
    });
    mapIconDefs = mapIcons.map((mi) => ({
      iconId: mi.iconId,
      x: Number(mi.x),
      y: Number(mi.y),
      z: Number(mi.z),
    }));
    logger.info(`[worldenv] 已缓存 ${mapIconDefs.length} 个地图图标定义`);
  } catch (e) {
    logger.error("[worldenv] 加载地图图标失败", e);
  }

  // 3. 系统传送点 3D 标签
  try {
    const tps = await prisma.teleport.findMany({
      where: { isSystem: true, isEnabled: true, deletedAt: null },
    });
    for (const tp of tps) {
      try {
        const label = new TextLabel({
          text: `{2ba2d5}您现在位于 /${tp.name}\n${tp.description ?? ""}`,
          color: COLOR_LABEL,
          x: Number(tp.x),
          y: Number(tp.y),
          z: Number(tp.z) + 1,
          drawDistance: 30,
          virtualWorld: 0,
          testLOS: false,
          charset: "gbk", // 玩家默认 gbk 字符集，3D 标签中文必须同字符集否则乱码
        });
        label.create();
        labels.push(label);
      } catch (e) {
        logger.warn(`[worldenv] 传送点标签创建失败 /${tp.name}`, e);
      }
    }
    logger.info(`[worldenv] 已创建 ${tps.length} 个系统传送点标签`);
  } catch (e) {
    logger.error("[worldenv] 加载传送点标签失败", e);
  }

  // 4. 赛道起点展示（3D 标签 + 小地图图标 类型 53）
  // 对齐原版：大世界不常驻 RaceCheckpoint（那是 per-player 的比赛 HUD 追踪，
  // 只在进入比赛/测试时由 race/room 用 RaceCheckpoint.set 显示）。
  // 大世界起点只挂 3D 标签（"输入 /r s 赛道名 开始比赛"）+ 小地图检查点图标。
  try {
    const races = await prisma.race.findMany({
      where: { isEnabled: true, deletedAt: null },
      include: {
        raceCps: { orderBy: { index: "asc" }, take: 1 }, // 仅第一个 CP（起点）
      },
    });
    let raceLabels = 0;
    for (const race of races) {
      const first = race.raceCps[0];
      if (!first) continue;
      try {
        const label = new TextLabel({
          text: `{98cdfe}[赛车] ${race.name}\n输入 /r s ${race.name} 开始比赛`,
          color: COLOR_RACE,
          x: Number(first.x),
          y: Number(first.y),
          z: Number(first.z) + 1,
          drawDistance: 20,
          virtualWorld: 0,
          testLOS: false,
          charset: "gbk", // 玩家默认 gbk 字符集，3D 标签中文必须同字符集否则乱码
        });
        label.create();
        labels.push(label);
        const icon = new DynamicMapIcon({
          type: 53,
          x: Number(first.x),
          y: Number(first.y),
          z: Number(first.z),
          color: COLOR_RACE,
          worldId: 0,
          streamDistance: 10000, // 全图常驻（默认 200 会导致起点图标走近才显示）
        });
        icon.create();
        icons.push(icon);
        raceLabels++;
      } catch (e) {
        logger.warn(`[worldenv] 赛道起点展示失败 ${race.name}`, e);
      }
    }
    logger.info(`[worldenv] 已展示 ${raceLabels} 个赛道起点`);
  } catch (e) {
    logger.error("[worldenv] 加载赛道起点失败", e);
  }

  worldEnv = { icons, labels };
}

/** 玩家当前应跟随的现实游戏时间 */
function realGameTime(): { hour: number; minute: number } {
  const now = new Date();
  return { hour: now.getHours(), minute: now.getMinutes() };
}

/** timeFlow=false 时每分钟重置玩家个人时间的定时器句柄（keyed by playerId） */
const timeFlowTimers = new Map<number, NodeJS.Timeout>();

/**
 * 按玩家设置应用世界环境（时间/天气）。
 * - syncGameTime=true → 跟随服务器时间；false → setTime(timeHour, timeMinute)
 * - syncWorldWeather=true → 跟随服务器天气；false → setWeather(weather)
 * - timeFlow=false → 每分钟重置回设定时间（个人时间冻结）
 */
export async function applyWorldEnv(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.findUnique({
    where: { userId: auth.userId },
  });
  if (!setting) return;

  if (setting.syncGameTime) {
    // 跟随大世界时间（现实时间映射）
    const t = realGameTime();
    player.setTime(t.hour, t.minute);
  } else {
    player.setTime(setting.timeHour, setting.timeMinute);
  }
  if (setting.syncWorldWeather) {
    // 跟随服务器当前天气（currentWeather，会随分时段/轮换变化，而非固定常量）
    player.setWeather(getWorldWeather());
  } else {
    player.setWeather(setting.weather);
  }
  // timeFlow=false：冻结时间，每分钟重置回设定时刻
  const prev = timeFlowTimers.get(player.id);
  if (prev) clearIntervalSafe(prev);
  if (!setting.syncGameTime && !setting.timeFlow) {
    const timer = setIntervalSafe(() => {
      if (player.isConnected()) {
        player.setTime(setting.timeHour, setting.timeMinute);
      } else {
        const t = timeFlowTimers.get(player.id);
        if (t) clearIntervalSafe(t);
        timeFlowTimers.delete(player.id);
      }
    }, 60_000);
    timeFlowTimers.set(player.id, timer);
  }
}

/** 清理玩家 timeFlow 定时器（断线时调用） */
export function clearWorldEnvForPlayer(playerId: number): void {
  const timer = timeFlowTimers.get(playerId);
  if (timer) clearIntervalSafe(timer);
  timeFlowTimers.delete(playerId);
}
