import { Player, PlayerStateEnum, VehicleEvent } from "@infernus/core";

/**
 * 漂移积分系统（纯展示，无实际效果）：
 * - 检测漂移（车身朝向 vs 运动方向的夹角差，对齐 drift-detection.inc），累计积分
 * - Forza 式连击倍率：连续漂移不中断 3s 倍率 +1（×1..×8），中断归 1
 * - 显示分数走"滚动逼近"动画（displayScore 每 tick 向实际 score 靠拢）
 * - 单次漂移积分有上限（SCORE_CAP）：加到上限停止累加
 * - 无漂移活动超时（DRIFT_RESET_MS）→ 积分归 0、倍率重置（TD 隐藏，下次重新开始计算）
 * - 车身损伤状态变化（碰撞/爆胎/部件掉落）→ 打断：积分归 0 重来
 * - 无独立定时器：由 gui 100ms tick 调 tickDriftScore（onExit 由 clearAllTimers 兜底）
 * - per-player 状态 Map，断线经 cleanupDriftScore 清理
 */

/** 连击倍率：每连续有效 MULTIPLIER_STEP_MS +1，封顶 ×8 */
const MULTIPLIER_MAX = 8;
const MULTIPLIER_STEP_MS = 3000;
/** 漂移判定（对齐 drift-detection.inc 默认阈值）：
 * - 漂移角 = 车身朝向 vs 运动方向夹角差（度），∈ [12°, 80°]——过小不算（直行）、
 *   过大不算（失控打转）；用角度而非横向速度判定，低速甩尾也能识别（横向速度
 *   判定在低速甩尾时横向分量达不到阈值，会把漂移误判成"高速"）
 * - 车速 ≥ 45 km/h（MIN_DRIFT_SPEED） */
const DRIFT_ANGLE_MIN = 12;
const DRIFT_ANGLE_MAX = 80;
const DRIFT_SPEED_MIN = 45;
/** 单次漂移积分上限（加到上限停止累加，数字不再变大） */
const SCORE_CAP = 99999;
/** 无漂移活动超过该时长 → 积分归 0（TD 隐藏，下次重新开始计算） */
const DRIFT_RESET_MS = 3000;

export type DriftStatus = "drift" | "none";

export interface DriftScoreState {
  /** 实际累计分（真值；本次漂移会话内只增不减，归零时清） */
  score: number;
  /** 显示分数（动画逼近 score 用） */
  displayScore: number;
  /** 当前连击倍率 ×N */
  multiplier: number;
  /** 倍率累计毫秒（连续有效时长） */
  multiplierMs: number;
  /** 当前状态（drift/none） */
  status: DriftStatus;
  /** 上次有效活动时间（倍率连续性用） */
  lastActiveAt: number;
  /** 进入无漂移状态的时刻（归零计时起点；0=漂移中/未计时） */
  inactiveSince: number;
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
      inactiveSince: 0,
    };
    driftScores.set(playerId, st);
  }
  return st;
}

/** 断线清理（callbacks onDisconnect 调用；TD 由 cleanupGui 管） */
export function cleanupDriftScore(playerId: number): void {
  driftScores.delete(playerId);
}

/** 打断（碰撞/损伤）：积分归 0、倍率重置——重来（对齐"碰撞即中断"语义） */
export function breakDriftScore(playerId: number): void {
  const st = driftScores.get(playerId);
  if (!st) return;
  st.score = 0;
  st.displayScore = 0;
  st.multiplier = 1;
  st.multiplierMs = 0;
  st.status = "none";
  st.lastActiveAt = 0;
  st.inactiveSince = 0;
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
  st.inactiveSince = 0;
}

/** 角度归一化到 [-180, 180)（夹角差计算用） */
function normAngle180(a: number): number {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** 无漂移活动：记超时起点；超时归 0（下次重新开始计算） */
function idleDrift(st: DriftScoreState, now: number): void {
  if (st.inactiveSince === 0) st.inactiveSince = now;
  st.multiplier = 1;
  st.multiplierMs = 0;
  st.status = "none";
  if (now - st.inactiveSince >= DRIFT_RESET_MS) {
    st.score = 0;
    st.displayScore = 0;
    st.inactiveSince = 0;
  }
}

/**
 * 每 tick 推进玩家漂移积分（gui 100ms tick 调用）：
 * - 读车辆速度（getVelocity 世界轴 ×180 = km/h）与车头方向（getMatrix.at* 单位向量）
 * - 漂移角 = 车身朝向角（atan2(atY,atX)）与运动方向角（atan2(vy,vx)）的夹角差；
 *   漂移 = 速度 ≥ 45 且 漂移角 ∈ [12°, 80°]；否则无活动（超时归 0）
 * - 漂移：按强度累加 score（×multiplier），封顶 SCORE_CAP；连续 3s 倍率 +1（封顶 ×8）
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
  // 不在车内 / 非司机：视为无活动（超时归 0）
  if (!veh || !veh.isValid() || player.getState() !== PlayerStateEnum.DRIVER) {
    idleDrift(st, now);
    st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
    if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
    return;
  }
  const vel = veh.getVelocity();
  const mat = veh.getMatrix();
  if (!vel.ret || !mat.ret) return; // 读取失败本次跳过
  const vx = vel.x * 180;
  const vy = vel.y * 180;
  const vz = vel.z * 180;
  const speed = Math.hypot(vx, vy, vz);
  // 车身朝向角 vs 运动方向角（GTA 世界 xy 平面绝对角），夹角差即漂移角
  const heading = (Math.atan2(mat.atY, mat.atX) * 180) / Math.PI;
  const moveDir = (Math.atan2(vy, vx) * 180) / Math.PI;
  const driftAngle = Math.abs(normAngle180(heading - moveDir));

  if (speed >= DRIFT_SPEED_MIN && driftAngle >= DRIFT_ANGLE_MIN && driftAngle <= DRIFT_ANGLE_MAX) {
    // 连续漂移：推进倍率累计（防首 tick 大跳：lastActiveAt 未设用 now）
    const elapsed = now - (st.lastActiveAt || now);
    st.multiplierMs += elapsed;
    if (st.multiplierMs >= MULTIPLIER_STEP_MS) {
      st.multiplierMs %= MULTIPLIER_STEP_MS;
      if (st.multiplier < MULTIPLIER_MAX) st.multiplier++;
    }
    st.status = "drift";
    st.lastActiveAt = now;
    st.inactiveSince = 0;
    // 强度积分：速度 × 漂移角占比 × 倍率；封顶 SCORE_CAP（加到上限停止累加）
    if (st.score < SCORE_CAP) {
      const gain = Math.round(speed * (driftAngle / 100) * st.multiplier);
      st.score = Math.min(SCORE_CAP, st.score + gain);
    }
  } else {
    idleDrift(st, now);
  }

  // 显示分数滚动逼近实际分（动画：步进差值 20%，接近直追）
  st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
  if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
}

/**
 * 初始化漂移系统（callbacks init 序列调用）：车身损伤状态变化（碰撞/爆胎/部件
 * 掉落）→ 打断当前漂移积分归 0 重来。正常漂移磨胎不改变 damageStatus，不会误触发。
 */
export function initDriftScore(): void {
  VehicleEvent.onDamageStatusUpdate(({ player, next }) => {
    if (player.isNpc()) return next();
    breakDriftScore(player.id);
    return next();
  });
}
