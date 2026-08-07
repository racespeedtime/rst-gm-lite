import { Player, PlayerStateEnum, VehicleEvent } from "@infernus/core";

/**
 * 漂移积分系统（纯展示，无实际效果）：
 * - 检测漂移（车身朝向 vs 运动方向的夹角差，对齐 drift-detection.inc），累计积分
 * - Forza 式连击倍率：累计漂移 2s 倍率 +1（×1..×8）；中断有 1.5s 宽限
 *   （DRIFT_BREAK_GRACE_MS，对齐参考实现的超时语义）——短暂失速/回正不打断连击
 * - 显示分数走"滚动逼近"动画（displayScore 每 tick 向实际 score 靠拢）
 * - 单次漂移积分有上限（SCORE_CAP）：加到上限停止累加
 * - 无漂移活动超过宽限（1.5s）→ 本次漂移结束：倍率归 1、积分归 0、整组隐藏
 *   （数字与倍率同步消失，下次漂移重新开始计算）
 * - 车身损伤状态变化（碰撞/爆胎/部件掉落）→ 打断：积分归 0 重来
 * - 无独立定时器：由 gui 100ms tick 调 tickDriftScore（onExit 由 clearAllTimers 兜底）
 * - per-player 状态 Map，断线经 cleanupDriftScore 清理
 */

/** 连击倍率：累计漂移时间每 2 秒 +1，封顶 ×8 */
const MULTIPLIER_MAX = 8;
const MULTIPLIER_STEP_MS = 2000;
/**
 * 漂移中断宽限：非漂移状态持续超过该时长才算打断连击（对齐 drift-detection.inc
 * 的 DRIFT_TIMEOUT_INTERVAL=1.5s 超时语义）——真实漂移中角度/速度会瞬时跌破
 * 阈值（甩尾抖动、短暂回正），无宽限则任何一帧中断都把倍率清零，永远卡 x1。
 * 宽限内恢复漂移：倍率与累计保留（只冻结新增累计），连击不断。
 */
const DRIFT_BREAK_GRACE_MS = 1500;
/** 漂移判定（对齐 drift-detection.inc 默认阈值）：
 * - 漂移角 = 车身朝向 vs 运动方向夹角差（度），∈ [12°, 80°]——过小不算（直行）、
 *   过大不算（失控打转）；用角度而非横向速度判定，低速甩尾也能识别（横向速度
 *   判定在低速甩尾时横向分量达不到阈值，会把漂移误判成"高速"）
 * - 车速 ≥ 45 km/h（MIN_DRIFT_SPEED） */
const DRIFT_ANGLE_MIN = 12;
const DRIFT_ANGLE_MAX = 80;
const DRIFT_SPEED_MIN = 45;
/** 单次漂移积分上限（加到上限停止累加，数字不再变大） */
const SCORE_CAP = 999999;

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

/** 不可漂移的车型（对齐参考 IsModelACar 排除表：摩托/船/飞机——漂移语义只对轿车成立） */
const NON_DRIFTABLE_MODELS = new Set<number>([
  // 摩托车
  448, 461, 462, 463, 468, 471, 481, 509, 510, 521, 522, 523, 581, 586,
  // 船
  430, 446, 452, 453, 454, 484, 493, 595,
  // 飞机
  417, 425, 447, 460, 469, 476, 487, 488, 497, 511, 512, 513, 519, 520, 548, 553, 563, 577, 592,
  593,
]);

/** 立即结束本次漂移（下车/不在车内/车型不可漂移）：不等宽限——参考实现
 *  OnPlayerStateChange 离开司机位立即 OnPlayerDriftEnd（下车是明确结束，不该
 *  享受 1.5s"短暂回正"宽限） */
function endDriftNow(st: DriftScoreState): void {
  st.status = "none";
  st.multiplier = 1;
  st.multiplierMs = 0;
  st.score = 0;
  st.displayScore = 0;
  st.lastActiveAt = 0;
  st.inactiveSince = 0;
}

/** 无漂移活动：宽限内不打断连击、不退出漂移显示态——对齐参考实现的超时语义
 * （drift-detection.inc 条件不满足累积 1.5s 才 OnPlayerDriftStop）：漂移中瞬时
 * 跌破阈值（弯心减速/甩尾抖动）是常态，若每帧都置 status=none，倍率徽章会
 * 一显示就隐藏、连击永远攒不起来。宽限到期 = 本次漂移结束：倍率归 1 + 积分
 * 同步归 0（数字与倍率一起消失，无"倍率先走、数字多留"的错位窗口——显示
 * 端两者同生共死）。
 * lastActiveAt 置 0 冻结累计——宽限内恢复漂移时首 tick elapsed=0，中断期不计入倍率。 */
function handleIdleDrift(st: DriftScoreState, now: number): void {
  if (st.inactiveSince === 0) st.inactiveSince = now;
  st.lastActiveAt = 0;
  if (now - st.inactiveSince >= DRIFT_BREAK_GRACE_MS) {
    st.status = "none";
    st.multiplier = 1;
    st.multiplierMs = 0;
    st.score = 0;
    st.displayScore = 0;
    st.inactiveSince = 0;
  }
}

/**
 * 每 tick 推进玩家漂移积分（gui 100ms tick 调用）：
 * - 读车辆速度（getVelocity 世界轴 ×180 = km/h）与车头方向（getMatrix.at* 单位向量）
 * - 漂移角 = 车身朝向角（atan2(atY,atX)）与运动方向角（atan2(vy,vx)）的夹角差；
 *   漂移 = 速度 ≥ 45 且 漂移角 ∈ [12°, 80°]；否则无活动（1.5s 宽限内不打断连击，
 *   宽限到期倍率归 1、积分归 0——数字与倍率同步消失）
 * - 漂移：按强度累加 score（×multiplier），封顶 SCORE_CAP；累计 2s 倍率 +1（封顶 ×8）
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
  // 不在车内 / 非司机 / 车型不可漂移（摩托/船/飞机）→ 立即结束漂移：
  // 下车是明确结束（参考 OnPlayerStateChange），不该享受 1.5s"短暂回正"宽限
  if (
    !veh ||
    !veh.isValid() ||
    player.getState() !== PlayerStateEnum.DRIVER ||
    NON_DRIFTABLE_MODELS.has(veh.getModel())
  ) {
    endDriftNow(st);
    st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
    if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
    return;
  }
  const vel = veh.getVelocity();
  const mat = veh.getMatrix();
  if (!vel.ret || !mat.ret) {
    // 读取失败（罕见）：按无活动处理——推进计时 + 归 0 收敛，
    // 否则连续失败时超时归零永不触发、displayScore 不收敛
    handleIdleDrift(st, now);
    st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
    if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
    return;
  }
  const vx = vel.x * 180;
  const vy = vel.y * 180;
  const vz = vel.z * 180;
  const speed = Math.hypot(vx, vy, vz);
  // 车身朝向角 vs 运动方向角（GTA 世界 xy 平面绝对角），夹角差即漂移角
  const heading = (Math.atan2(mat.atY, mat.atX) * 180) / Math.PI;
  const moveDir = (Math.atan2(vy, vx) * 180) / Math.PI;
  const driftAngle = Math.abs(normAngle180(heading - moveDir));

  if (speed >= DRIFT_SPEED_MIN && driftAngle >= DRIFT_ANGLE_MIN && driftAngle <= DRIFT_ANGLE_MAX) {
    st.inactiveSince = 0; // 恢复/持续漂移：清中断计时（宽限内恢复则连击保留）
    // 倍率累计 = 本次漂移 tick 间隔（lastActiveAt 在中断期被冻结为 0，宽限恢复
    // 首 tick elapsed=0——中断期不混入；连续漂移每 tick ≈100ms，2s 即 +1 级）
    const elapsed = st.lastActiveAt > 0 ? now - st.lastActiveAt : 0;
    st.multiplierMs += elapsed;
    if (st.multiplierMs >= MULTIPLIER_STEP_MS) {
      st.multiplierMs %= MULTIPLIER_STEP_MS;
      if (st.multiplier < MULTIPLIER_MAX) st.multiplier++;
    }
    st.status = "drift";
    st.lastActiveAt = now;
    // 强度积分：速度 × 漂移角占比 × 倍率；封顶 SCORE_CAP（加到上限停止累加）
    if (st.score < SCORE_CAP) {
      const gain = Math.round(speed * (driftAngle / 100) * st.multiplier);
      st.score = Math.min(SCORE_CAP, st.score + gain);
    }
  } else {
    handleIdleDrift(st, now);
  }

  // 显示分数滚动逼近实际分（动画：步进差值 20%，接近直追）
  st.displayScore += Math.round((st.score - st.displayScore) * 0.2);
  if (Math.abs(st.score - st.displayScore) < 10) st.displayScore = st.score;
}

/**
 * 初始化漂移系统（callbacks init 序列调用）：车身损伤状态变化（碰撞/爆胎/部件
 * 掉落）→ 打断当前漂移积分归 0 重来。正常漂移磨胎不改变 damageStatus，不会误触发。
 * 归属用 getLastDriver（事件 player 参数是"同步该次损伤变更的玩家"——乘客下车/
 * 无人车同步时不是司机，且 NPC/无人车时可能为 INVALID_PLAYER_ID，会经
 * getDriftScore 建孤儿状态）。
 */
export function initDriftScore(): void {
  VehicleEvent.onDamageStatusUpdate(({ vehicle, next }) => {
    const driver = vehicle.getLastDriver();
    if (driver && !driver.isNpc()) {
      breakDriftScore(driver.id);
    }
    return next();
  });
}
