import { DynamicCheckpoint, DynamicMapIcon, GameMode, Player, TextLabel } from "@infernus/core";
import { prisma } from "@/prisma";
import { logger } from "@/logger";
import { getAuthState } from "@/auth/auth";
import { getSetting } from "@/personalize/settings";
import {
  setIntervalSafe,
  clearIntervalSafe,
  setTimeoutSafe,
  clearTimeoutSafe,
} from "@/core/timers";
import { isInRace } from "@/race/room";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { DEFAULT_CHARSET } from "@/utils/constants";
/** 世界环境持有的实体（onExit 时统一销毁） */
interface WorldEnv {
  icons: DynamicMapIcon[];
  labels: TextLabel[];
  checkpoints: DynamicCheckpoint[];
}

import { COLOR_LABEL, COLOR_RACE, COLOR_ORANGE } from "@/utils/colors";
/** 服务器全局天气（作为"世界"环境基准，供 syncWorldWeather 跟随） */
export const WORLD_WEATHER = 10;
/** 大世界时间同步间隔（秒）——现实时间映射，每 60 秒同步一次 */
export const WORLD_TIME_SYNC_MS = 60_000;
/** 天气轮换间隔（秒）——每 30 分钟 20% 概率随机换一次 */
export const WEATHER_ROTATE_MS = 30 * 60_000;
const WEATHER_ROTATE_CHANCE = 0.2;
/** 常用天气池（晴/多云/雨/雾等） */
const WEATHER_POOL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16];

/** 天气 ID → 中文名（变更提示用，对齐 open.mp weatherid 官方表 0-22；未列出的 ID 回退显示 ID） */
const WEATHER_NAMES: Record<number, string> = {
  0: "晴", // EXTRASUNNY_LA
  1: "晴", // SUNNY_LA
  2: "晴（薄雾）", // EXTRASUNNY_SMOG_LA
  3: "晴（薄雾）", // SUNNY_SMOG_LA
  4: "多云", // CLOUDY_LA
  5: "晴", // SUNNY_SF
  6: "晴", // EXTRASUNNY_SF
  7: "多云", // CLOUDY_SF
  8: "雨", // RAINY_SF
  9: "雾", // FOGGY_SF
  10: "晴", // SUNNY_VEGAS
  11: "晴（热浪）", // EXTRASUNNY_VEGAS
  12: "多云", // CLOUDY_VEGAS
  13: "晴", // EXTRASUNNY_COUNTRYSIDE
  14: "晴", // SUNNY_COUNTRYSIDE
  15: "多云", // CLOUDY_COUNTRYSIDE
  16: "雨", // RAINY_COUNTRYSIDE
  17: "晴", // EXTRASUNNY_DESERT
  18: "晴", // SUNNY_DESERT
  19: "沙尘暴", // SANDSTORM_DESERT
  20: "水下", // UNDERWATER
  21: "室内特殊", // EXTRACOLOURS_1
  22: "室内特殊", // EXTRACOLOURS_2
};

/**
 * 按现实时间分时段确定天气：
 * 白天(6-18)晴天、黄昏(18-20)橙色、夜晚(20-6)晴夜。
 */
function weatherByTime(hour: number): number {
  if (hour >= 6 && hour < 18) return 0; // 白天晴
  if (hour >= 18 && hour < 20) return 15; // 黄昏
  return 3; // 夜晚
}

/** 上次整点提醒的小时（防启动首轮误报；跨整点才提醒一次） */
let lastNotifiedHour = new Date().getHours();

/** 同步大世界时间（现实时间）与天气，并同步给跟随的玩家 */
export async function syncWorldClock(): Promise<void> {
  const now = new Date();
  GameMode.setWorldTime(now.getHours());
  // 整点提醒（跨整点触发，仅跟随服务器时间的玩家——自定义时间玩家不被提醒错乱）：
  // 与同步循环同一次遍历，先收集再广播
  const hourChanged = now.getHours() !== lastNotifiedHour;
  if (hourChanged) {
    lastNotifiedHour = now.getHours();
  }
  const hourMsg = `[天气] 现在 ${String(now.getHours()).padStart(2, "0")}:00`;
  // 同步 syncGameTime=true 的在线玩家（现实 1 分钟 = 游戏 1 分钟）
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    // 比赛中跳过：比赛房间由 beginRace 按房主设置统一时间天气（CP 脚本也会改），
    // 轮换会把房间统一时间拉回服务器时间（重连恢复/快照回退也受影响）
    if (isInRace(player.id)) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncGameTime) continue;
    // 同步是最终落点：取消可能进行中的过渡动画，防动画中间值反向覆盖刚同步的时间
    cancelTimeTransition(player.id);
    player.setTime(now.getHours(), now.getMinutes());
    if (hourChanged) {
      player.sendClientMessage(COLOR_ORANGE, hourMsg);
    }
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
  const oldWeather = currentWeather;
  if (Math.random() < WEATHER_ROTATE_CHANCE) {
    currentWeather = WEATHER_POOL[Math.floor(Math.random() * WEATHER_POOL.length)];
  } else {
    currentWeather = weatherByTime(new Date().getHours());
  }
  // 只在天气实际变化时提示（分时段基准可能连续相同，避免刷提示）
  const changed = currentWeather !== oldWeather;
  GameMode.setWeather(currentWeather);
  const msg = `[天气] 大世界天气已变化：${WEATHER_NAMES[currentWeather] ?? `ID ${currentWeather}`}`;
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    // 比赛中跳过：房间统一天气由 beginRace 定（见 syncWorldClock 注释）
    if (isInRace(player.id)) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncWorldWeather) continue;
    player.setWeather(currentWeather);
    // 只提示跟随大世界天气的玩家（不跟随的玩家有自己的个人天气，不打扰）
    if (changed) {
      player.sendClientMessage(COLOR_ORANGE, msg);
    }
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

let worldEnv: WorldEnv = { icons: [], labels: [], checkpoints: [] };

/** 清理世界环境实体（GameMode.onExit 调用） */
export function clearWorldEnvironment(): void {
  for (const icon of worldEnv.icons) {
    if (icon.isValid()) icon.destroy();
  }
  for (const label of worldEnv.labels) {
    if (label.isValid()) label.destroy();
  }
  for (const cp of worldEnv.checkpoints) {
    if (cp.isValid()) cp.destroy();
  }
  worldEnv = { icons: [], labels: [], checkpoints: [] };
}

/** 大世界 map_icon 流式显示距离：覆盖一个城市范围（SA 城市半径约 2000-3000 单位），
 *  玩家所在城市内的图标显示、走远消失（按城市就近显示）。 */
const MAP_ICON_STREAM_DISTANCE = 2500;

/**
 * 初始化世界环境（GameMode.onInit 调用）：
 * 1. 服务器全局时间/天气（世界环境基准）
 * 2. map_icon 表 → DynamicMapIcon 流式图标（streamDistance=城市范围：玩家所在
 *    城市内的图标显示、走远消失——按城市就近显示，不再全图常驻铺满小地图）
 * 3. 系统传送点 → 3D 标签（"/名称 + 描述"）
 * 4. 启用赛道起点 → 3D 标签（"输入 /r s 赛道名 开始比赛"）+ 地图图标（类型 53）
 *
 * attempt（内部重试计数）：onInit 时机 DB 连接池可能尚未就绪，任一段查询失败会让
 * 该段实体缺失且永不补建（地图图标/传送点/赛道起点消失）。任一段失败 → 整体延迟
 * 重试补加载（上限 WORLD_ENV_RETRY 次），重试前先清掉已建的部分实体防重复创建。
 */
const WORLD_ENV_RETRY = 5;
const WORLD_ENV_RETRY_MS = 30_000;

export async function initWorldEnvironment(attempt = 1): Promise<void> {
  // 1. 全局时间天气（现实时间同步 + 分时段天气）
  syncWorldClock();
  currentWeather = weatherByTime(new Date().getHours());
  GameMode.setWeather(currentWeather);
  logger.info(`[worldenv] 全局时间 ${new Date().getHours()}:00 天气 ${currentWeather}`);

  const icons: DynamicMapIcon[] = [];
  const labels: TextLabel[] = [];
  const checkpoints: DynamicCheckpoint[] = [];
  let failed = false;

  // 2. 地图图标（数据库 map_icon 表）
  // 用 DynamicMapIcon 流式图标：streamDistance 覆盖一个城市范围（SA 城市半径
  // 约 2000-3000 单位）——玩家在哪个城市附近就看到那个城市的图标（走进显示、
  // 走远消失，对齐"按用户所在城市来显示"），不再用 SetPlayerMapIcon 全图常驻。
  // 全局实体（worldId 公共大世界），onExit 统一销毁，无需 per-player 清理。
  try {
    const mapIcons = await prisma.mapIcon.findMany({
      where: { deletedAt: null },
      orderBy: { index: "asc" },
    });
    for (const mi of mapIcons) {
      try {
        const icon = new DynamicMapIcon({
          type: mi.iconId,
          x: Number(mi.x),
          y: Number(mi.y),
          z: Number(mi.z),
          color: 0xffffffaa,
          worldId: PUBLIC_WORLD_ID,
          streamDistance: MAP_ICON_STREAM_DISTANCE,
        });
        icon.create();
        icons.push(icon);
      } catch (e) {
        logger.warn(`[worldenv] 地图图标创建失败 icon=${mi.iconId}`, e);
      }
    }
    logger.info(
      `[worldenv] 已创建 ${icons.length} 个地图图标（流式，城市范围 ${MAP_ICON_STREAM_DISTANCE}）`,
    );
  } catch (e) {
    logger.error(`[worldenv] 加载地图图标失败（第 ${attempt} 次）`, e);
    failed = true;
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
          virtualWorld: PUBLIC_WORLD_ID,
          testLOS: false,
          charset: DEFAULT_CHARSET, // 3D 标签中文必须与玩家默认字符集一致否则乱码
        });
        label.create();
        labels.push(label);
      } catch (e) {
        logger.warn(`[worldenv] 传送点标签创建失败 /${tp.name}`, e);
      }
    }
    logger.info(`[worldenv] 已创建 ${tps.length} 个系统传送点标签`);
  } catch (e) {
    logger.error(`[worldenv] 加载传送点标签失败（第 ${attempt} 次）`, e);
    failed = true;
  }

  // 4. 赛道起点展示：对齐原版 RaceGetCpsQuery 三件套——
  //    DynamicCheckpoint 圆圈（size 4，大世界常驻地面检查点）+
  //    DynamicMapIcon 小地图图标（53）+
  //    3D 标签（"输入 /r s 赛道名 开始比赛"）。
  //    比赛中的 per-player HUD 追踪仍由 race/room 的 RaceCheckpoint.set 负责。
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
        // 圆圈：大世界常驻地面检查点（对齐原版 CreateDynamicCP size 4，公共大世界）
        const cp = new DynamicCheckpoint({
          x: Number(first.x),
          y: Number(first.y),
          z: Number(first.z),
          size: 4,
          worldId: PUBLIC_WORLD_ID,
        });
        cp.create();
        checkpoints.push(cp);
        const label = new TextLabel({
          text: `{98cdfe}[赛车] ${race.name}\n输入 /r s ${race.name} 开始比赛`,
          color: COLOR_RACE,
          x: Number(first.x),
          y: Number(first.y),
          z: Number(first.z) + 1,
          drawDistance: 20,
          virtualWorld: PUBLIC_WORLD_ID,
          testLOS: false,
          charset: DEFAULT_CHARSET, // 3D 标签中文必须与玩家默认字符集一致否则乱码
        });
        label.create();
        labels.push(label);
        const icon = new DynamicMapIcon({
          type: 53,
          x: Number(first.x),
          y: Number(first.y),
          z: Number(first.z),
          color: COLOR_RACE,
          worldId: PUBLIC_WORLD_ID,
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
    logger.error(`[worldenv] 加载赛道起点失败（第 ${attempt} 次）`, e);
    failed = true;
  }

  // 提交（覆盖旧引用；失败段为空数组，onExit 按当前 worldEnv 清理）
  worldEnv = { icons, labels, checkpoints };

  // 任一段失败（onInit 时机 DB 未就绪等一次性故障）：清掉已建的部分实体后
  // 延迟重试补加载（上限内），防地图图标/传送点/赛道起点缺失且无人发现。
  // 上限达后放弃——持续连不上说明 DB 真有问题，不再空转重试
  if (failed && attempt < WORLD_ENV_RETRY) {
    setTimeoutSafe(() => {
      clearWorldEnvironment();
      void initWorldEnvironment(attempt + 1);
    }, WORLD_ENV_RETRY_MS);
  }
}

/** 玩家当前应跟随的现实游戏时间 */
function realGameTime(): { hour: number; minute: number } {
  const now = new Date();
  return { hour: now.getHours(), minute: now.getMinutes() };
}

/** timeFlow=false 时每分钟重置玩家个人时间的定时器句柄（keyed by playerId） */
const timeFlowTimers = new Map<number, NodeJS.Timeout>();

/** 时间过渡动画的步进数与单步间隔（总时长 2 秒：200ms × 10 步） */
const TIME_TRANSITION_STEPS = 10;
const TIME_TRANSITION_STEP_MS = 200;

/** 时间过渡动画定时器句柄（keyed by playerId）：个人时间设置快速变化到目标，模拟时间流逝感 */
const timeTransitionTimers = new Map<number, NodeJS.Timeout>();

/** 取消玩家进行中的时间过渡动画（重设/断线时调用；链式句柄由本表追踪） */
export function cancelTimeTransition(playerId: number): void {
  const t = timeTransitionTimers.get(playerId);
  if (t) clearTimeoutSafe(t);
  timeTransitionTimers.delete(playerId);
}

/**
 * 时间过渡动画：从当前时间经 2 秒快速变化到目标（每 200ms 一步、步进按剩余
 * 跨度均摊——大跨度快跳、小跨度缓跳，模拟"时间在快速流逝"而非瞬跳）。
 * 方向取较短回绕路径（≤12h，避免绕远一整圈）。目标与当前相同直接设置（无
 * 动画）。断线自动停止（每步检查 isConnected）；重设前须先 cancelTimeTransition。
 */
function animateTimeTo(player: Player, targetHour: number, targetMinute: number): void {
  const cur = player.getTime();
  const start = (cur.ret ? cur.hour : 12) * 60 + (cur.ret ? cur.minute : 0);
  const target = (((targetHour % 24) + 24) % 24) * 60 + (((targetMinute % 60) + 60) % 60);
  if (start === target) {
    player.setTime(((targetHour % 24) + 24) % 24, ((targetMinute % 60) + 60) % 60);
    return;
  }
  // 较短方向：正向 N 分钟 vs 回绕 24h-N 取小的；step 为有符号增量（负 = 回绕倒退）
  const fwd = (((target - start) % 1440) + 1440) % 1440;
  const step = fwd <= 720 ? fwd : fwd - 1440;
  let i = 1;
  const tick = () => {
    if (!player.isConnected()) {
      timeTransitionTimers.delete(player.id);
      return;
    }
    const now = (((start + (step * i) / TIME_TRANSITION_STEPS) % 1440) + 1440) % 1440;
    // 先对总分钟取整再拆小时/分钟：分钟满 60 直接进位到小时
    //（Math.round(now%60)%60 会让 12:59.5 显示成 12:00 回绕）
    const total = Math.floor(now);
    player.setTime(Math.floor(total / 60), total % 60);
    if (i >= TIME_TRANSITION_STEPS) {
      // 收尾：精确落到目标（浮点累计可能差 1 分钟）
      player.setTime(((targetHour % 24) + 24) % 24, ((targetMinute % 60) + 60) % 60);
      timeTransitionTimers.delete(player.id);
      return;
    }
    i++;
    timeTransitionTimers.set(player.id, setTimeoutSafe(tick, TIME_TRANSITION_STEP_MS));
  };
  timeTransitionTimers.set(player.id, setTimeoutSafe(tick, TIME_TRANSITION_STEP_MS));
}

/**
 * 按玩家设置应用世界环境（时间/天气）。
 * - syncGameTime=true → 跟随服务器时间；false → setTime(timeHour, timeMinute)
 * - 时间设置走过渡动画（快速变化到目标，模拟时间流逝，不瞬跳）
 * - syncWorldWeather=true → 跟随服务器天气；false → setWeather(weather)
 * - timeFlow=false → 每分钟重置回设定时间（个人时间冻结）
 */
export async function applyWorldEnv(player: Player): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  // 走设置缓存（登录时 getSetting 已预热；与各个性化菜单共用同一份数据，
  // 避免直查库读到旧值/多一次 DB 往返）
  const setting = await getSetting(player);
  if (!setting) return;

  // 取消进行中的时间过渡动画：重设时间先断旧链，防旧动画继续覆盖新设置
  cancelTimeTransition(player.id);

  if (setting.syncGameTime) {
    // 跟随大世界时间（现实时间映射）：过渡动画快速变化到当前现实时间
    const t = realGameTime();
    animateTimeTo(player, t.hour, t.minute);
  } else {
    // 个人时间：过渡动画快速变化到设定时间
    animateTimeTo(player, setting.timeHour, setting.timeMinute);
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
      if (!player.isConnected()) {
        const t = timeFlowTimers.get(player.id);
        if (t) clearIntervalSafe(t);
        timeFlowTimers.delete(player.id);
        return;
      }
      // 比赛中/回放挑战世界跳过：房间统一时间由 beginRace 定（CP 脚本也会改），
      // 冻结定时器把个人时间拉回会覆盖房间统一时间、与回退检查点的 time 回滚冲突
      //（对齐 syncWorldClock/rotateWeather 的比赛跳过口径）
      if (isInRace(player.id)) return;
      player.setTime(setting.timeHour, setting.timeMinute);
    }, 60_000);
    timeFlowTimers.set(player.id, timer);
  }
}

/** 清理玩家时间相关定时器（断线时调用）：冻结定时器 + 进行中的时间过渡动画 */
export function clearWorldEnvForPlayer(playerId: number): void {
  const timer = timeFlowTimers.get(playerId);
  if (timer) clearIntervalSafe(timer);
  timeFlowTimers.delete(playerId);
  cancelTimeTransition(playerId);
}
