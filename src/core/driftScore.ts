import { Player, PlayerStateEnum } from "@infernus/core";

/**
 * 漂移积分系统（纯展示，无实际效果）：
 * - 检测漂移（车头方向 vs 速度方向的横向滑移）与高速行驶，累计积分
 * - Forza 式连击倍率：连续漂移/高速不中断 3s 倍率 +1（×1..×8），中断归 1
 * - 显示分数走"滚动逼近"动画（displayScore 每 tick 向实际 score 靠拢）
 * - 无独立定时器：由 gui 100ms tick 调 tickDriftScore（onExit 由 clearAllTimers 兜底）
 * - per-player 状态 Map，断线经 cleanupDriftScore 清理
 */

/** 连击倍率：每连续有效 MULTIPLIER_STEP_MS 秒 +1，封顶 ×8 */
const MULTIPLIER_MAX = 8;
const MULTIPLIER_STEP_MS = 3000;
/** 漂移判定：车速（km/h，getVelocity×180）下限 + 横向滑移（km/h）下限 */
const DRIFT_SPEED_MIN = 40;
const DRIFT_LATERAL_MIN = 12;
/** 高速判定：车速下限（非漂移时） */
const SPEED_KMH_MIN = 140;

export type DriftStatus = "drift" | "speed" | "none";

export interface DriftScoreState {
  /** 实际累计分（真值，只增不减） */
  score: number;
  /** 显示分数（动画逼近 score 用） */
  displayScore: number;
  /** 当前连击倍率 ×N */
  multiplier: number;
  /** 倍率累计毫秒（连续有效时长） */
  multiplierMs: number;
  /** 当前状态（drift/speed/none） */
  status: DriftStatus;
  /** 上次有效活动时间（断开连续） */
  lastActiveAt: number;
}

const driftScores = new Map<number, DriftScoreState>();

/** 取玩家漂移积分状态（无则创建） */
export function getDriftScore(playerId: number): DriftScoreState {
  let st = driftScores.get(playerId);
  if (!st) {
    st = {
      score: 0,
      displayScore: 0,
      multiplier: 1,
      multiplierMs: 0,
      status: "none",
      lastActiveAt: 0,
    };
    driftScores.set(playerId, st);
  }
  return st;
}

/** 断线清理（callbacks onDisconnect 调用；TD 由 cleanupGui 管） */
export function cleanupDriftScore(playerId: number): void {
  driftScores.delete(playerId);
}

/**
 * 显示开关关闭后再开启：保留已累计的战果（纯展示，关了不清分），只重置连击——
 * 倍率/累计/状态归零。连击是"进行时"，关了再开等于重新起连击；且不清 lastActiveAt
 * 的话，重开首 tick 会把整个关闭期算进 multiplierMs（elapsed 陈旧）白送一次倍率。
 */
export function resetDriftCombo(playerId: number): void {
  const st = driftScores.get(playerId);
  if (!st) return;
  st.multiplier = 1;
  st.multiplierMs = 0;
  st.status = "none";
  st.lastActiveAt = 0;
}

/**
 * 每 tick 推进玩家漂移积分（gui 100ms tick 调用）：
 * - 读车辆速度（getVelocity 世界轴 ×180 = km/h）与车头方向（getMatrix.at* 单位向量）
 * - 横向滑移 = 速度向量与车头方向的叉积分量（车头沿 at，速度相对车头的垂直分量）
 * - 漂移 = 速度≥40 且横向≥12；高速 = 非漂移且速度≥140；否则 none
 * - 漂移/高速：按强度累加 score（×multiplier）；连续 3s 倍率 +1（封顶 ×8）；中断归 1
 * - displayScore 每 tick 向 score 逼近（滚动动画：差值的 20% 步进，差 <10 直追）
 */
export function tickDriftScore(player: Player): void {
  if (!player.isConnected()) {
    cleanupDriftScore(player.id);
    return;
  }
  const st = getDriftScore(player.id);
  const veh = player.isInAnyVehicle() ? player.getVehicle() : null;
  const now = Date.now();
  // 不在车内 / 非司机：视为中断（清倍率，不累分）
  if (!veh || !veh.isValid() || player.getState() !== PlayerStateEnum.DRIVER) {
    st.multiplier = 1;
    st.multiplierMs = 0;
    st.status = "none";
    // 动画仍向 score 收敛（分数显示保持），保持显示
    st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
    if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
    return;
  }
  const vel = veh.getVelocity();
  const mat = veh.getMatrix();
  if (!vel.ret || !mat.ret) return; // 读取失败本次跳过
  // 世界轴速度分量（×180 转 km/h）
  const vx = vel.x * 180;
  const vy = vel.y * 180;
  const vz = vel.z * 180;
  const speed = Math.hypot(vx, vy, vz);
  // 车头方向单位向量（at = 前向，getMatrix 已归一化）
  const ax = mat.atX;
  const ay = mat.atY;
  // 横向滑移 = |v × at|（z 分量 = vy*ax − vx*ay，GTA 世界 xy 平面），转 km/h
  const lateral = Math.abs(vy * ax - vx * ay);

  // 状态判定
  let status: DriftStatus = "none";
  let gain = 0;
  if (speed >= DRIFT_SPEED_MIN && lateral >= DRIFT_LATERAL_MIN) {
    status = "drift";
    // 漂移强度 = 车速 × 横向占比（横向占比越高分越高）
    gain = speed * (lateral / 100) * 2;
  } else if (speed >= SPEED_KMH_MIN) {
    status = "speed";
    // 高速 = 超速段比例 × 系数（140 起算，越高速越多）
    gain = (speed - SPEED_KMH_MIN) * 0.5;
  }

  if (status !== "none") {
    // 连续有效：推进倍率累计
    const elapsed = now - (st.lastActiveAt || now);
    // 倍率累计只在有效状态累加（中断重置在下方）
    st.multiplierMs += elapsed;
    if (st.multiplierMs >= MULTIPLIER_STEP_MS) {
      st.multiplierMs %= MULTIPLIER_STEP_MS;
      if (st.multiplier < MULTIPLIER_MAX) st.multiplier++;
    }
    st.status = status;
    st.lastActiveAt = now;
    st.score += Math.round(gain * st.multiplier);
  } else {
    // 中断：倍率归 1、状态 none
    st.multiplier = 1;
    st.multiplierMs = 0;
    st.status = "none";
    st.lastActiveAt = 0;
  }

  // 显示分数滚动逼近实际分（动画：步进差值 20%，接近直追）
  st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
  if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
}
