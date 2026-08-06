import { Player, TextDraw } from "@infernus/core";
import { getObserveTarget } from "@/core/observe";
import { getReplayDebugState } from "@/replay/playback";
import { getCachedSetting } from "@/personalize/settings";
import { getWorldWeather, isTimeTransitioning } from "@/core/worldenv";
import { isInRace } from "@/race/room";
import { isInChallenge } from "@/replay/challenge";

/**
 * 调试信息 GUI：屏幕底部居中、尽可能小字号的诊断文本，短标签格式：
 * x/y/z 位置 · a 朝向角 · w 世界 · i 内景 · qw/qx/qy/qz 旋转四元数 ·
 * h 血量 · ar 护甲 · sk 皮肤 · v 车辆ID · sp 速度 · k 按键位集。
 * 车内取车辆姿态（完整三维），车外取玩家（yaw）；观战/回放叠加一行。
 */

export interface DebugInfoState {
  td: TextDraw;
  lastText: string;
}

/** 底部居中调试文本 y（640x480 名义坐标：440 离底 40px，轻微 margin） */
const DEBUG_Y = 440;

/** 创建调试信息 TextDraw（单 TD 多行，底部居中） */
export function createDebugInfo(player: Player): DebugInfoState {
  const td = new TextDraw({ player, x: 320, y: DEBUG_Y, text: " " })
    .create()
    .setAlignment(2) // CENTER：x=320 为水平中心（默认左对齐会从左往右铺，偏左）
    .setFont(1)
    .setLetterSize(0.13, 0.55) // 比速度表(0.2)更小，底部居中不挡视野
    .setColor(0xffffffff)
    .setOutline(1)
    .setProportional(true)
    .setShadow(1)
    .setSelectable(false);
  td.show(player);
  return { td, lastText: "" };
}

export function destroyDebugInfo(state: DebugInfoState | null): void {
  if (state && state.td.isValid()) state.td.destroy();
}

/**
 * 构建版本 TextDraw（右下角、单独 TD）：显示当前构建基于的时间点与 git 提交号，
 * 由 gui.ts 随 showDebugInfo 开关与 debug 联动创建/销毁（不参与文本刷新——静态）。
 * Y 与 debug 对齐（同一 DEBUG_Y，不单独设坐标）。颜色用 TextDraw 内置 ~ 色码
 * （~y~ 黄 / ~w~ 白）——{}16 进制嵌入是聊天/对话框语法，TextDraw 不支持会原样输出。
 */
export function createBuildVersionTd(player: Player): TextDraw {
  const text = `~y~build ~w~${fmtBuildTime(__BUILD_TIME__)} @${__BUILD_HASH__}`;
  const td = new TextDraw({ player, x: 638, y: DEBUG_Y, text })
    .create()
    .setAlignment(3) // RIGHT：x=638 为右缘（右下角，留 2px margin）
    .setFont(1)
    .setLetterSize(0.12, 0.5) // 比 debug(0.13) 更小，角落不抢视线
    .setColor(0xffffffff)
    .setOutline(1)
    .setProportional(true)
    .setShadow(1)
    .setSelectable(false);
  td.show(player);
  return td;
}

export function destroyBuildVersionTd(td: TextDraw | null): void {
  if (td && td.isValid()) td.destroy();
}

/** 构建时间 ISO → "YYYY-MM-DD HH:mm"（服务器本地时区） */
function fmtBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const r2 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

/** 刷新调试文本（内容无变化跳过，省 5Hz 无用 setString） */
export function updateDebugInfo(player: Player, state: DebugInfoState, kmh: number): void {
  const pos = player.getPos();
  const angle = player.getFacingAngle().angle;
  const veh = player.isInAnyVehicle() ? player.getVehicle() : null;
  const keys = player.getKeys();
  const health = player.getHealth();
  const armour = player.getArmour();
  // 旋转四元数：车内取车辆（完整三维姿态），车外取玩家（yaw 旋转）
  const q = veh ? veh.getRotationQuat() : player.getRotationQuat();
  // 车内：位置/朝向取车辆实体（车辆坐标即玩家位置，车朝向更精确）
  const displayPos = veh ? veh.getPos() : pos;
  const displayAngle = veh ? veh.getZAngle().angle : angle;
  const qText = q.ret
    ? `qw ${r2(q.w)}  qx ${r2(q.x)}  qy ${r2(q.y)}  qz ${r2(q.z)}`
    : "qw --  qx --  qy --  qz --";
  const lines: string[] = [
    `x ${r2(displayPos.x)} ${r2(displayPos.y)} ${r2(displayPos.z)}  a ${r2(displayAngle)}  w ${player.getVirtualWorld()}  i ${player.getInterior()}`,
    `${qText}  h ${Math.ceil(health.health)}  ar ${Math.ceil(armour.armour)}  sk ${player.getSkin()}`,
    `${displayTimeWeather(player)}  v ${veh ? veh.id : "-"}  sp ${Math.floor(kmh)}  k 0x${(keys.keys & 0xffff).toString(16)}`,
  ];
  // 观战中：显示被观战对象（p 玩家 / v 车辆）
  const st = getObserveTarget(player.id);
  if (st) {
    lines.push(`watch ${st.kind === "vehicle" ? "v" : "p"} #${st.targetId}`);
  }
  // 回放中：叠加当前播放时长/总时长、帧号；掉线静止段标记 offline（~r~ 为
  // TextDraw 内置红色码，{}16 进制嵌入不被 TextDraw 支持）
  const rep = getReplayDebugState(player.id);
  if (rep) {
    lines.push(
      `rep ${fmtMs(rep.playTimeMs)}/${fmtMs(rep.durationMs)}  f ${rep.frameIndex}/${rep.frameCount}${rep.online ? "" : "  ~r~offline"}`,
    );
  }
  const text = lines.join("\n");
  if (text !== state.lastText) {
    state.lastText = text;
    state.td.setString(text);
  }
}

/** 毫秒 → m:ss 或 ss */
function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const p2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 玩家当前应显示的时间（按个性化设置推算实际值，与 applyWorldEnv 同口径）：
 * - syncGameTime=true → 服务器现实时间（new Date 时分）；false → 设置 timeHour:timeMinute
 * - 比赛中（房间统一时间由 beginRace 按房主设置 setTime）/ 回放观看（每帧 setTime
 *   录制赛道时间）/ 影子挑战中：画面时钟 ≠ 设置推算值——回退玩家实际 getTime
 *   （服务器已 setTime 后的结果），保证右上角时间与画面一致
 * - 时间过渡动画中：游戏时钟正从当前值快速转到目标，同样回退 getTime——右上角
 *   时间 TD 跟随分针/时针转动，直到过渡结束显示目标时间
 * - 设置缓存未命中（未登录/尚未缓存）→ 同样回退玩家实际 getTime
 * 5Hz 刷新读内存缓存不查库。右上角时间 TD 与 debugInfo 共用。
 */
export function getDisplayTime(player: Player): string {
  const setting = getCachedSetting(player);
  // 比赛中/回放观看/影子挑战/时间过渡中画面时钟被 setTime 覆盖，回退实际时间
  const overridden =
    isInRace(player.id) ||
    isInChallenge(player.id) ||
    isTimeTransitioning(player.id) ||
    !!getReplayDebugState(player.id);
  let hour: number;
  let minute: number;
  if (setting && !overridden) {
    hour = setting.syncGameTime ? new Date().getHours() : setting.timeHour;
    minute = setting.syncGameTime ? new Date().getMinutes() : setting.timeMinute;
  } else {
    const tm = player.getTime();
    hour = tm.ret ? tm.hour : 12;
    minute = tm.ret ? tm.minute : 0;
  }
  return `${p2(hour)}:${p2(minute)}`;
}

/**
 * 玩家当前应显示的时间/天气（按个性化设置推算实际值，与 applyWorldEnv 同口径）：
 * - syncGameTime=true → 服务器现实时间（new Date 时分）；false → 设置 timeHour:timeMinute
 * - syncWorldWeather=true → 服务器当前天气（getWorldWeather）；false → 设置 weather
 * 设置缓存未命中（未登录/尚未缓存）→ 回退玩家实际 getTime/getWeather（服务器
 * 按设置 setTime 后的结果）。5Hz 刷新读内存缓存不查库。
 */
function displayTimeWeather(player: Player): string {
  const setting = getCachedSetting(player);
  const tm = player.getTime();
  const actualHour = tm.ret ? tm.hour : 12;
  const actualMinute = tm.ret ? tm.minute : 0;
  let hour: number;
  let minute: number;
  let weather: number;
  // 比赛中（房间统一时间天气）/回放观看（每帧 setTime+setWeather）/时间过渡
  //（时钟快转中）→ 回退实际值，与 getDisplayTime 同口径（画面时钟 ≠ 设置推算值）；
  // 天气只被比赛/回放覆盖，时间过渡不动天气
  const overridden =
    isInRace(player.id) ||
    isInChallenge(player.id) ||
    isTimeTransitioning(player.id) ||
    !!getReplayDebugState(player.id);
  if (setting && !overridden) {
    hour = setting.syncGameTime ? new Date().getHours() : setting.timeHour;
    minute = setting.syncGameTime ? new Date().getMinutes() : setting.timeMinute;
    weather = setting.syncWorldWeather ? getWorldWeather() : setting.weather;
  } else {
    hour = actualHour;
    minute = actualMinute;
    weather = player.getWeather();
  }
  return `t ${p2(hour)}:${p2(minute)}  w ${weather}`;
}
