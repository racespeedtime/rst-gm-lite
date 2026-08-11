import { DynamicCheckpoint, DynamicMapIcon, Player, TextLabel } from "@infernus/core";
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
import { isInChallenge } from "@/replay/challenge";
import { getReplaySession } from "@/replay/playback";
import { PUBLIC_WORLD_ID } from "@/sessions/session";
import { DEFAULT_CHARSET } from "@/utils/constants";
/** 世界环境持有的实体（onExit 时统一销毁） */
interface WorldEnv {
  icons: DynamicMapIcon[];
  labels: TextLabel[];
  checkpoints: DynamicCheckpoint[];
}

import { sysMsg } from "@/utils/msg";
import { COLOR_LABEL, COLOR_RACE } from "@/utils/colors";
/** 服务器全局天气（作为"世界"环境基准，供 syncWorldWeather 跟随） */
export const WORLD_WEATHER = 10;
/** 大世界时间同步间隔（毫秒）——现实时间映射，每 60 秒同步一次 */
export const WORLD_TIME_SYNC_MS = 60_000;
/** 天气轮换间隔（毫秒）——每 30 分钟 20% 概率随机换一次 */
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
 * 按现实时间分时段确定基准天气：
 * 白天(6-18)晴、黄昏(18-20)多云(15)、夜晚(20-6)晴薄雾(3)。
 * 数值对齐原版分时段取值（ID 语义见 WEATHER_NAMES 表）。
 */
function weatherByTime(hour: number): number {
  if (hour >= 6 && hour < 18) return 0; // 白天晴
  if (hour >= 18 && hour < 20) return 15; // 黄昏（多云）
  return 3; // 夜晚（晴·薄雾）
}

/** 上次整点提醒的小时（防启动首轮误报；跨整点才提醒一次） */
let lastNotifiedHour = new Date().getHours();

/** 同步大世界时间（现实时间）与天气，并同步给跟随的玩家 */
export async function syncWorldClock(): Promise<void> {
  const now = new Date();
  // 注意：不能调 GameMode.setWorldTime（服务器全局时间）——open.mp 的 SetWorldTime
  // 会强制**所有**玩家的时间变成现实小时，包括个人时间玩家（syncGameTime=false）：
  // 其 1s 流逝定时器从 12:00 正常推进，每 60s 被这里拉回现实小时（如 22:00）再从
  // 那里继续 +1 → "个人时间过一段时间突然变晚上"。跟随世界时间的玩家由下方
  // per-player setTime 设置，无需全局时间。
  // 整点提醒（跨整点触发，仅跟随服务器时间的玩家——自定义时间玩家不被提醒错乱）：
  // 与同步循环同一次遍历，先收集再广播
  const hourChanged = now.getHours() !== lastNotifiedHour;
  if (hourChanged) {
    lastNotifiedHour = now.getHours();
  }
  const hourMsg = `现在 ${String(now.getHours()).padStart(2, "0")}:00`;
  // 同步 syncGameTime=true 的在线玩家（现实 1 分钟 = 游戏 1 分钟）
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    // 比赛中/回放观看/影子挑战中跳过：比赛房间统一时间由 beginRace 定（CP 脚本
    // 也会改）、回放每帧 setTime 录制赛道时间——同步会把房间/回放画面时钟拉回
    // 服务器时间（最长 1 分钟错位，回放帧时间变化才重设）。对齐 timeFlow 冻结
    // 定时器与 getDisplayTime 的三态跳过口径
    if (isInRace(player.id) || isInChallenge(player.id) || !!getReplaySession(player.id)) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncGameTime) continue;
    // 同步是最终落点：取消可能进行中的过渡动画，防动画中间值反向覆盖刚同步的时间
    cancelTimeTransition(player.id);
    player.setTime(now.getHours(), now.getMinutes());
    if (hourChanged) {
      sysMsg(player, "weather", hourMsg, "info");
    }
  }
}

/**
 * 每 30 分钟轮换天气：20% 概率从天气池随机换一次，
 * 否则按分时段基准天气重算（可能连续相同）。
 * 同步给 syncWorldWeather 玩家。
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
  // 同 syncWorldClock：不能调 GameMode.setWeather（全局强制会劫持个人天气玩家
  // 的 setWeather）——跟随者由下方 per-player setWeather 设置，getWorldWeather()
  // 读内存 currentWeather 不依赖全局
  const msg = `大世界天气已变化：${WEATHER_NAMES[currentWeather] ?? `ID ${currentWeather}`}`;
  for (const player of Player.getInstances()) {
    if (player.isNpc() || !player.isConnected()) continue;
    // 比赛中/回放观看/影子挑战中跳过：房间统一天气由 beginRace 定、回放每帧
    // setWeather 录制赛道天气（对齐 syncWorldClock 的三态跳过口径）
    if (isInRace(player.id) || isInChallenge(player.id) || !!getReplaySession(player.id)) continue;
    const auth = getAuthState(player.id);
    if (!auth) continue;
    const setting = await getSetting(player);
    if (!setting || !setting.syncWorldWeather) continue;
    player.setWeather(currentWeather);
    // 只提示跟随大世界天气的玩家（不跟随的玩家有自己的个人天气，不打扰）
    if (changed) {
      sysMsg(player, "weather", msg, "info");
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
  // 1. 时间天气基准（现实时间同步 + 分时段天气）——仅初始化内存 currentWeather
  // 与跟随玩家的 per-player 时间天气（不做全局 setWorldTime/setWeather，理由见
  // syncWorldClock / rotateWeather 注释：全局强制会劫持个人时间/天气玩家）
  syncWorldClock();
  currentWeather = weatherByTime(new Date().getHours());
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
/** timeFlow=true 时每秒推进玩家个人时间 1 游戏分钟的定时器句柄（keyed by playerId）。
 *  open.mp 客户端时间**不会自动流逝**（服务器 setTime 后即冻结，与单机引擎不同），
 *  要模拟"现实 1 秒 = 游戏 1 分钟"的流动必须由服务器每秒 setTime 推进一次 */
const timeAdvanceTimers = new Map<number, NodeJS.Timeout>();

/**
 * 时间过渡动画的步进间隔（50ms 高频）：游戏内时间只有时:分，没有秒——过渡
 * 表现的是"分针/时针在快速转动"，帧率越高越平滑（50ms = 20fps，跨小时进位
 * 不再一格格跳）。总时长随跨度浮动，见 animateTimeTo 的步数策略。
 */
const TIME_TRANSITION_STEP_MS = 50;

/** 时间过渡动画定时器句柄（keyed by playerId）：个人时间设置快速变化到目标，模拟时间流逝感 */
const timeTransitionTimers = new Map<number, NodeJS.Timeout>();

/** 取消玩家进行中的时间过渡动画（重设/断线时调用；链式句柄由本表追踪） */
export function cancelTimeTransition(playerId: number): void {
  const t = timeTransitionTimers.get(playerId);
  if (t) clearTimeoutSafe(t);
  timeTransitionTimers.delete(playerId);
}

/** 玩家是否处于时间过渡动画中（GUI 时间显示据此回退实际 getTime——
 *  动画中间值与设置推算值/现实时间不一致，右上角时间 TD 与 debug 面板须跟随画面时钟） */
export function isTimeTransitioning(playerId: number): boolean {
  return timeTransitionTimers.has(playerId);
}

/**
 * 时间过渡动画：从当前时间快速变化到目标，模拟"时钟快转"而非瞬跳。
 * 步数按跨度自适应（游戏内时间只有时:分）：
 * - 跨度 ≤ 60 分钟 → 按 1 分钟/步（真正的分针转动，逐分钟平滑）
 * - 更大跨度 → 60 步均摊（时针转动，每步十几~几十分钟）
 * 50ms 一帧，总时长 = 步数 × 50ms（1 分钟跨度 ≈ 0.1s，12 小时跨度 ≈ 3s）。
 * 时间一维向前：只沿正向（分钟递增）推进，不逆时针回绕——即使目标在当前
 * 时刻"倒退侧"更近，也绕完整圈正向走（分针/时针永远向前转，符合"时间流逝"
 * 的直觉；原"较短回绕路径"会让时钟倒转，玩家看到分针逆走）。目标与当前
 * 相同直接设置（无动画）。断线自动停止（每步检查 isConnected）；重设前须先
 * cancelTimeTransition。
 */
function animateTimeTo(player: Player, targetHour: number, targetMinute: number): void {
  const cur = player.getTime();
  const start = (cur.ret ? cur.hour : 12) * 60 + (cur.ret ? cur.minute : 0);
  const target = (((targetHour % 24) + 24) % 24) * 60 + (((targetMinute % 60) + 60) % 60);
  if (start === target) {
    player.setTime(((targetHour % 24) + 24) % 24, ((targetMinute % 60) + 60) % 60);
    return;
  }
  // 正向分钟数（恒正）：目标在当前时刻"倒退侧"也不取负增量——时间一维向前，
  // 逆时针回绕会让分针倒转
  const fwd = (((target - start) % 1440) + 1440) % 1440;
  // 步数自适应：fwd ≤ 60 按 1 分钟一步（分针转动）；更大按 60 步均摊（时针转动）
  const steps = Math.min(60, Math.max(1, fwd));
  let i = 1;
  const tick = () => {
    if (!player.isConnected()) {
      timeTransitionTimers.delete(player.id);
      return;
    }
    const now = (((start + (fwd * i) / steps) % 1440) + 1440) % 1440;
    // 先对总分钟取整再拆小时/分钟：分钟满 60 直接进位到小时
    //（Math.round(now%60)%60 会让 12:59.5 显示成 12:00 回绕）
    const total = Math.floor(now);
    player.setTime(Math.floor(total / 60), total % 60);
    if (i >= steps) {
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
 * - syncGameTime=true → 跟随服务器时间（现实时间映射）；false → 从 timeHour:timeMinute 起
 * - 时间设置走过渡动画（快速变化到目标，模拟时间流逝，不瞬跳）
 * - syncWorldWeather=true → 跟随服务器天气；false → setWeather(weather)
 * - timeFlow=true（仅 syncGameTime=false 有效）→ 个人时间流逝：现实 1 秒 = 游戏 1 分钟，
 *   由服务器每秒 setTime 推进（open.mp 客户端时间不自动流）；false → 每分钟重置回设定
 *   时间（个人时间冻结）
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
  // 个人时间（syncGameTime=false）两种模式互斥，先清旧定时器再按模式挂载：
  // - timeFlow=true → 每秒推进 1 游戏分钟（现实 1 秒 = 游戏 1 分钟）
  // - timeFlow=false → 每分钟重置回设定时刻（时间冻结）
  const prevFreeze = timeFlowTimers.get(player.id);
  if (prevFreeze) clearIntervalSafe(prevFreeze);
  timeFlowTimers.delete(player.id);
  const prevAdvance = timeAdvanceTimers.get(player.id);
  if (prevAdvance) clearIntervalSafe(prevAdvance);
  timeAdvanceTimers.delete(player.id);
  if (!setting.syncGameTime) {
    if (setting.timeFlow) {
      // 从过渡动画终点（设定时刻）起算，每秒 +1 游戏分钟
      const timer = setIntervalSafe(() => {
        if (!player.isConnected()) {
          // 断线：自清 interval（对齐冻结定时器分支的自清行为——不依赖
          // clearWorldEnvForPlayer 兜底，防清理顺序变化时 1s 空转）
          const t = timeAdvanceTimers.get(player.id);
          if (t) clearIntervalSafe(t);
          timeAdvanceTimers.delete(player.id);
          return;
        }
        // 比赛中/回放观看/影子挑战中跳过：房间统一时间由 beginRace 定（CP 脚本
        // 也会改）、回放每帧 setTime 录制赛道时间——个人时间推进会把房间/回放
        // 画面时钟顶掉（回放画面时钟被硬切），对齐 syncWorldClock/rotateWeather
        // 与 getDisplayTime 的跳过口径
        if (isInRace(player.id) || isInChallenge(player.id) || !!getReplaySession(player.id))
          return;
        const tm = player.getTime();
        const hour = tm.ret ? tm.hour : setting.timeHour;
        const minute = tm.ret ? tm.minute : setting.timeMinute;
        // 分钟 59→0 进位到小时
        const nextMinute = (minute + 1) % 60;
        const nextHour = nextMinute === 0 ? (hour + 1) % 24 : hour;
        player.setTime(nextHour, nextMinute);
      }, 1000);
      timeAdvanceTimers.set(player.id, timer);
    } else {
      const timer = setIntervalSafe(() => {
        if (!player.isConnected()) {
          const t = timeFlowTimers.get(player.id);
          if (t) clearIntervalSafe(t);
          timeFlowTimers.delete(player.id);
          return;
        }
        // 比赛中/回放观看/影子挑战中跳过：房间统一时间由 beginRace 定（CP 脚本
        // 也会改）、回放每帧 setTime 录制赛道时间——冻结定时器把个人时间拉回
        // 会覆盖房间/回放时间轴（回放画面时钟被硬切），对齐 syncWorldClock/
        // rotateWeather 与 getDisplayTime 的跳过口径
        if (isInRace(player.id) || isInChallenge(player.id) || !!getReplaySession(player.id))
          return;
        player.setTime(setting.timeHour, setting.timeMinute);
      }, 60_000);
      timeFlowTimers.set(player.id, timer);
    }
  }
}

/** 清理玩家时间相关定时器（断线时调用）：冻结/流逝定时器 + 进行中的时间过渡动画 */
export function clearWorldEnvForPlayer(playerId: number): void {
  const freeze = timeFlowTimers.get(playerId);
  if (freeze) clearIntervalSafe(freeze);
  timeFlowTimers.delete(playerId);
  const advance = timeAdvanceTimers.get(playerId);
  if (advance) clearIntervalSafe(advance);
  timeAdvanceTimers.delete(playerId);
  cancelTimeTransition(playerId);
}
