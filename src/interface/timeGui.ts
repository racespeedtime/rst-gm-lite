import { Player, TextDraw } from "@infernus/core";
import { getDisplayTime } from "./debugInfo";

/**
 * 右上角时间 TextDraw（设置 showTimeGui 控制）：
 * - 显示玩家当前时间（按设置 syncGameTime 跟随服务器 / 自定义 timeHour:timeMinute，
 *   与 debugInfo 的 displayTimeWeather 同口径，经 getDisplayTime 共用）
 * - 位置右上角空白区（x~500+ / y~5-8）：netstat 占 x228-430/y0-3，错开不重叠
 * - 刷新走文本 diff（每 100ms tick 时间不变时零 native）
 */

export interface TimeGuiState {
  td: TextDraw;
  lastText: string;
}

/** 右上角时间 TD 样式：小字右对齐，与速度表同风格 */
export function createTimeTd(player: Player): TimeGuiState {
  const td = new TextDraw({ player, x: 635, y: 5.2, text: "00:00" })
    .create()
    .setAlignment(3) // RIGHT：x=635 为右缘（右上角，留 margin 给网速/边框）
    .setFont(2)
    .setLetterSize(0.2, 1.0)
    .setColor(0xffffffff)
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false);
  td.show(player);
  return { td, lastText: "" };
}

/** 刷新时间文本（按玩家设置推算，无变化跳过） */
export function updateTimeTd(state: TimeGuiState, player: Player): void {
  const text = getDisplayTime(player);
  if (text !== state.lastText) {
    state.lastText = text;
    state.td.setString(text);
  }
}

export function destroyTimeTd(state: TimeGuiState | null): void {
  if (state && state.td.isValid()) state.td.destroy();
}
