import { KeysEnum, Player, TextDraw } from "@infernus/core";
import { getObserveTarget } from "@/core/observe";
import { getReplayDebugState } from "@/replay/playback";

/**
 * 调试信息 GUI：屏幕底部居中、尽可能小字号的诊断文本（位置/朝向/世界/内景/
 * 车辆/按键/速度，观战中显示被观战对象，回放中叠加播放时长/帧率）。
 * 数据源全部实时读取，仅做文本拼接（速度 kmh 由 gui.ts 计算传入复用）。
 * 车内/车外区分：车内显示车辆位置+车朝向角+车速；车外显示玩家位置+朝向+步行速度。
 * 样式对齐"底部居中 + margin-bottom"，字体小于速度表（0.13 vs 0.2）。
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

const r2 = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

/** 已按下的按键名（位集解析；KeysEnum 数值键名） */
function pressedKeys(keys: number): string {
  const names: string[] = [];
  for (const k of Object.keys(KeysEnum)) {
    const v = KeysEnum[k as keyof typeof KeysEnum];
    if (typeof v === "number" && v > 0 && v < 0x10000 && (keys & v) === v) {
      names.push(k);
    }
  }
  return names.length > 0 ? names.join("|") : "-";
}

/** 刷新调试文本（内容无变化跳过，省 5Hz 无用 setString） */
export function updateDebugInfo(player: Player, state: DebugInfoState, kmh: number): void {
  const pos = player.getPos();
  const angle = player.getFacingAngle().angle;
  const veh = player.isInAnyVehicle() ? player.getVehicle() : null;
  const keys = player.getKeys();
  const health = player.getHealth();
  const armour = player.getArmour();
  // 车内：位置/朝向/速度取车辆实体（车辆坐标即玩家位置，车朝向更精确）
  const displayPos = veh ? veh.getPos() : pos;
  const displayAngle = veh ? veh.getZAngle().angle : angle;
  const lines: string[] = [
    `pos ${r2(displayPos.x)} ${r2(displayPos.y)} ${r2(displayPos.z)}  angle ${r2(displayAngle)}  world ${player.getVirtualWorld()}  int ${player.getInterior()}`,
    `hp ${Math.ceil(health.health)}  armor ${Math.ceil(armour.armour)}  skin ${player.getSkin()}`,
    `veh ${veh ? veh.id : "-"}  ${Math.floor(kmh)} km/h  keys 0x${(keys.keys & 0xffff).toString(16)} ${pressedKeys(keys.keys)}`,
  ];
  // 观战中：显示被观战对象（玩家/车辆）
  const st = getObserveTarget(player.id);
  if (st) {
    lines.push(`watch ${st.kind} #${st.targetId}`);
  }
  // 回放中：叠加当前播放时长/总时长、当前速度、帧号
  const rep = getReplayDebugState(player.id);
  if (rep) {
    lines.push(
      `replay ${fmtMs(rep.playTimeMs)}/${fmtMs(rep.durationMs)}  ${Math.floor(rep.currentKmh)} km/h  frame ${rep.frameIndex}/${rep.frameCount}`,
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
