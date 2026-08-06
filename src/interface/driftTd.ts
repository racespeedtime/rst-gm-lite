import { Player, TextDraw } from "@infernus/core";
import { getDriftScore, type DriftStatus } from "@/core/driftScore";

/**
 * 漂移积分 TextDraw（屏幕中上，纯展示）：
 * - 大数字：当前显示分数（滚动动画值，千分位）
 * - 小字徽章：状态（漂移/高速）+ 连击倍率 ×N
 * - 无活动（none 且分数 0）时隐藏；刷新走文本 diff（100ms tick 零变化零 native）
 */

export interface DriftTdState {
  scoreTd: TextDraw;
  badgeTd: TextDraw;
  lastText: string;
  lastBadge: string;
  lastVisible: boolean;
}

/** 屏幕中上（小地图下方），大数字 + 徽章上下排列 */
export function createDriftTd(player: Player): DriftTdState {
  const scoreTd = new TextDraw({ player, x: 320, y: 296, text: "0" })
    .create()
    .setAlignment(2) // CENTER
    .setFont(2)
    .setLetterSize(0.45, 2.0)
    .setColor(0xffffffff)
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false);
  const badgeTd = new TextDraw({ player, x: 320, y: 330, text: "" })
    .create()
    .setAlignment(2)
    .setFont(1)
    .setLetterSize(0.2, 1.0)
    .setColor(0xffffffff)
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false);
  scoreTd.show(player);
  badgeTd.show(player);
  return { scoreTd, badgeTd, lastText: "", lastBadge: "", lastVisible: false };
}

/** 状态 → 徽章文案与颜色（漂移亮色/高速蓝/无活动灰色） */
function statusBadge(status: DriftStatus, multiplier: number): { text: string; color: number } {
  if (status === "drift") {
    return { text: `漂移 ×${multiplier}`, color: 0xffaa00ff };
  }
  if (status === "speed") {
    return { text: `高速 ×${multiplier}`, color: 0x00aaffff };
  }
  return { text: "", color: 0xffffffff };
}

/** 千分位（12345 → 12,345） */
function fmtScore(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/** 刷新漂移积分 TD（按玩家当前状态/分数；无活动且分数 0 隐藏，文本 diff 去重） */
export function updateDriftTd(state: DriftTdState, player: Player): void {
  const st = getDriftScore(player.id);
  const visible = st.status !== "none" || st.score > 0;
  const scoreText = fmtScore(st.displayScore);
  const badge = statusBadge(st.status, st.multiplier);
  // 文本变化才 setString（100ms tick 大多不变）
  if (visible) {
    if (scoreText !== state.lastText) {
      state.lastText = scoreText;
      state.scoreTd.setString(scoreText);
    }
    if (badge.text !== state.lastBadge) {
      state.lastBadge = badge.text;
      state.badgeTd.setColor(badge.color);
      state.badgeTd.setString(badge.text);
    }
  }
  // 显隐切换才 show/hide（活动状态翻转时）
  if (visible !== state.lastVisible) {
    state.lastVisible = visible;
    if (visible) {
      state.scoreTd.show(player);
      state.badgeTd.show(player);
    } else {
      state.scoreTd.hide(player);
      state.badgeTd.hide(player);
    }
  }
}

export function destroyDriftTd(state: DriftTdState | null): void {
  if (!state) return;
  if (state.scoreTd.isValid()) state.scoreTd.destroy();
  if (state.badgeTd.isValid()) state.badgeTd.destroy();
}
