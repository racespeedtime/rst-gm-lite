import { Player, TextDraw } from "@infernus/core";
import { getDriftScore, type DriftStatus } from "@/core/driftScore";

/**
 * 漂移积分 TextDraw（屏幕上方居中、纯展示、不常驻）：
 * - 大数字：当前显示分数（滚动动画值，千分位）
 * - 小字徽章：DRIFT xN（ASCII 全兼容——TextDraw 不支持中文，曾写中文乱码）
 * - 不常驻：漂移中 / 分数 >0 时显示；无活动超时归 0 后自动隐藏（地平线式出现/消失）
 * - 刷新走文本 diff（100ms tick 零变化零 native）；状态切换颜色平滑渐变
 */

export interface DriftTdState {
  scoreTd: TextDraw;
  badgeTd: TextDraw;
  lastText: string;
  lastBadge: string;
  lastVisible: boolean;
  /** 徽章当前渲染色（状态切换时向目标色平滑过渡，非瞬跳） */
  color: number;
}

/** 屏幕上方居中（网络信息 y0-3 下方一点），大数字 + 徽章上下排列 */
export function createDriftTd(player: Player): DriftTdState {
  const scoreTd = new TextDraw({ player, x: 320, y: 8, text: "0" })
    .create()
    .setAlignment(2) // CENTER
    .setFont(2)
    .setLetterSize(0.3, 1.3)
    .setColor(0xffffffff)
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false);
  const badgeTd = new TextDraw({ player, x: 320, y: 18, text: "" })
    .create()
    .setAlignment(2)
    .setFont(1)
    .setLetterSize(0.18, 0.9)
    .setColor(0xffffffff)
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false);
  scoreTd.show(player);
  badgeTd.show(player);
  return {
    scoreTd,
    badgeTd,
    lastText: "",
    lastBadge: "",
    lastVisible: false,
    color: 0xffffffff,
  };
}

/** 状态 → 徽章文案与目标色（漂移亮橙/无活动白；ASCII 兼容，TextDraw 不支持中文） */
function statusBadge(status: DriftStatus, multiplier: number): { text: string; color: number } {
  if (status === "drift") {
    return { text: `DRIFT x${multiplier}`, color: 0xffaa00ff };
  }
  return { text: "", color: 0xffffffff };
}

/** 当前渲染色向目标色平滑过渡（每 tick 15% 步进，SA 色值 0xRRGGBBAA） */
function stepColor(from: number, target: number): number {
  const cur = from & 0xffffff;
  const dst = target & 0xffffff;
  const r = cur + Math.round(((dst & 0xff0000) - (cur & 0xff0000)) * 0.15);
  const g = cur + Math.round(((dst & 0xff00) - (cur & 0xff00)) * 0.15);
  const b = cur + Math.round(((dst & 0xff) - (cur & 0xff)) * 0.15);
  return (r & 0xff0000) | (g & 0xff00) | (b & 0xff) | 0xff;
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
      // 颜色不在此处设：由下方渐变步进统一管（避免文本一变化就瞬跳到目标色）
      state.badgeTd.setString(badge.text);
    }
  }
  // 显隐切换才 show/hide（活动状态翻转时）
  if (visible !== state.lastVisible) {
    state.lastVisible = visible;
    if (visible) {
      // 刚可见：颜色从当前平滑过渡，首帧可能仍呈旧色但无需瞬间跳变
      state.badgeTd.setColor(state.color);
      state.scoreTd.show(player);
      state.badgeTd.show(player);
    } else {
      state.scoreTd.hide(player);
      state.badgeTd.hide(player);
    }
  }
  // 可见状态：颜色持续向目标色过渡（状态切换不瞬跳），收敛到目标后零 native
  if (visible) {
    const stepped = stepColor(state.color, badge.color);
    if (stepped !== state.color) {
      state.color = stepped;
      state.badgeTd.setColor(stepped);
    }
  } else {
    state.color = badge.color; // 隐藏时收敛目标，避免下次显示从旧色漂移
  }
}

export function destroyDriftTd(state: DriftTdState | null): void {
  if (!state) return;
  if (state.scoreTd.isValid()) state.scoreTd.destroy();
  if (state.badgeTd.isValid()) state.badgeTd.destroy();
}
