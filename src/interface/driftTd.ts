import { Player, TextDraw } from "@infernus/core";
import { getDriftScore, type DriftStatus } from "@/core/driftScore";

/**
 * 漂移积分 TextDraw（屏幕上方居中、纯展示、不常驻）：
 * - 大数字：当前显示分数（滚动动画值，纯数字无千分位）
 * - 小字徽章：DRIFT xN（ASCII 全兼容——TextDraw 不支持中文）；颜色按倍率分级
 *   （×1 白 → ×2 黄 → ×3-4 橙 → ×5-6 红橙 → ×8 红），平滑渐变
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

/** 屏幕上方居中（网络信息 y0-3 下方一点），大数字 + 徽章上下排列。
 *  创建时不 show：等首次 updateDriftTd 判定 visible 后才显示——否则进游戏
 *  立即闪一个"0"（直到 100ms 后首 tick 隐藏），违背"第一次漂移才显示" */
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
  return {
    scoreTd,
    badgeTd,
    lastText: "",
    lastBadge: "",
    lastVisible: false,
    color: 0xffffffff,
  };
}

/** 倍率 → 徽章颜色（用户指定分级：×1 白 → ×2 黄 → ×3-4 橙 → ×5-6 红橙 → ×8 红；
 *  SA TextDraw 色值 0xRRGGBBAA，与 netstat/speedometer 同体系——这两个的绿/黄红
 *  在实机显示正常，是本项目验证过的字节序） */
function multiplierColor(multiplier: number): number {
  if (multiplier >= 8) return 0xff0000ff; // 红
  if (multiplier >= 5) return 0xff4500ff; // 红橙
  if (multiplier >= 3) return 0xff8800ff; // 橙
  if (multiplier >= 2) return 0xffff00ff; // 黄
  return 0xffffffff; // ×1 白
}

/** 状态 → 徽章文案与目标色（漂移中按倍率分级，无活动白；ASCII 兼容，TextDraw
 *  不支持中文）。无活动（status=none）仍返回 "xN" 而非空串：徽章与数字同生共死——
 *  只要整组可见（score>0 的收尾展示期），徽章就有文案，绝不单边隐藏造成"数字还在、
 *  倍率先没了"的不同步 */
function statusBadge(status: DriftStatus, multiplier: number): { text: string; color: number } {
  if (status === "drift") {
    return { text: `DRIFT x${multiplier}`, color: multiplierColor(multiplier) };
  }
  return { text: `x${multiplier}`, color: 0xffffffff };
}

/** 当前渲染色向目标色平滑过渡（每 tick 15% 步进，SA 色值 0xRRGGBBAA） */
function stepColor(from: number, target: number): number {
  const curR = (from >> 24) & 0xff;
  const curG = (from >> 16) & 0xff;
  const curB = (from >> 8) & 0xff;
  const curA = from & 0xff;

  const tarR = (target >> 24) & 0xff;
  const tarG = (target >> 16) & 0xff;
  const tarB = (target >> 8) & 0xff;
  const tarA = target & 0xff;

  const r = Math.round(curR + (tarR - curR) * 0.15);
  const g = Math.round(curG + (tarG - curG) * 0.15);
  const b = Math.round(curB + (tarB - curB) * 0.15);
  const a = Math.round(curA + (tarA - curA) * 0.15);

  return (r << 24) | (g << 16) | (b << 8) | a;
}

/** 分数纯数字（用户明确不要千分位逗号分隔） */
function fmtScore(n: number): string {
  return String(Math.max(0, Math.floor(n)));
}

/** 刷新漂移积分 TD（按玩家当前状态/分数；无活动且分数 0 隐藏，文本 diff 去重） */
export function updateDriftTd(state: DriftTdState, player: Player): void {
  const st = getDriftScore(player.id);
  const visible = st.status !== "none" || st.score > 0;
  const scoreText = fmtScore(st.displayScore);
  const badge = statusBadge(st.status, st.multiplier);
  // 文本变化才 setString（100ms tick 大多不变）。
  // 注意：infernus setString 对空字符串抛 "Invalid text length"——无文案（非漂移
  // 宽限期的徽章）不能 setString("")，改为隐藏徽章；转有文案时 setString + 显示
  if (visible) {
    if (scoreText !== state.lastText) {
      state.lastText = scoreText;
      state.scoreTd.setString(scoreText);
    }
    if (badge.text !== state.lastBadge) {
      state.lastBadge = badge.text;
      // 徽章始终有文案（statusBadge 无活动也返回 xN）——只 setString，显隐由
      // 下方 lastVisible 块与数字一起切（同步出现/消失）
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
      state.scoreTd.show(player);
      state.badgeTd.show(player);
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
