import { Player, TextDraw } from "@infernus/core";
import { setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";

/**
 * TextDraw 倒计时动画组件（替代 GameText 静态数字）：
 * - 数字从上方掉落 + 弹跳入场 → 停留 → 渐变放大淡出消失
 * - 结束显示 GO（绿字，更大更久）
 * - per-player TextDraw，setTimeoutSafe 自链（有界动画自然终止）
 * - 清理：句柄 Map keyed by playerId，cancelCountdownFx 断链 + 销毁 TD；
 *   onExit 由 clearAllTimers 兜底 + disposeCountdownFxAll 全清
 */

/** 数字动画帧参数（每数字总时长 ≈1s：5 帧 × 200ms） */
const STEP_MS = 200;
const FALL_START_Y = 216; // 掉落起点（中心 240 - 24 上）
const REST_Y = 240; // 停留位置（屏幕中心）
/** 掉落弹跳 easing（帧 0-2）：0→1 带轻微过冲（弹跳感） */
const FALL_EASE = [0, 0.55, 0.94, 1, 1];
/** 放大淡出（帧 3-4）：letterSize 0.6→0.9、颜色 alpha 255→0 */
const SHRINK_EASE = [1, 0.72, 0.5];

interface FxTarget {
  player: Player;
  td: TextDraw;
  /** 当前显示文本（数字或 GO） */
  text: string;
  step: number;
  isGo: boolean;
}

/** 每个目标当前动画句柄（keyed by playerId：同玩家多会话共用，重入先断旧链） */
const countdownFxTimers = new Map<number, NodeJS.Timeout>();
/** 每目标当前 TextDraw（取消时销毁） */
const countdownFxTds = new Map<number, TextDraw>();

/** 文本 → 颜色（数字黄 / GO 绿） */
function colorFor(isGo: boolean, alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  return isGo ? (0x55ff55 & 0xffffff) | (a << 24) : (0xffffaa & 0xffffff) | (a << 24);
}

/** 推进一个目标的动画帧；返回是否继续（false = 该数字动画结束） */
function advanceFx(t: FxTarget): boolean {
  const { player, td } = t;
  // 帧守卫：掉线/已失效（infernus 掉线自动销毁 TD）→ 终止
  if (!player.isConnected() || !td.isValid()) return false;
  const step = t.step;
  const phase = step < 3 ? "fall" : step < 5 ? "shrink" : "done";
  if (phase === "fall") {
    const e = FALL_EASE[step] ?? 1;
    td.setPos(320, FALL_START_Y + (REST_Y - FALL_START_Y) * e);
    td.setColor(colorFor(t.isGo, 255));
    td.setLetterSize(0.6, 2.6);
    t.step++;
    return true;
  }
  if (phase === "shrink") {
    const e = SHRINK_EASE[step - 3] ?? 0.5;
    td.setLetterSize(0.6 + (0.9 - 0.6) * (1 - e), 2.6 + (3.4 - 2.6) * (1 - e));
    td.setColor(colorFor(t.isGo, 255 * e));
    t.step++;
    return true;
  }
  return false; // done
}

/** 播放单个目标的倒计时动画（数字 → GO）；完成调用 onDone（每目标都完成后由调用方统一触发） */
function playFxForTarget(
  target: Player,
  numbers: number[],
  opts: { onGo?: () => void; sounds: boolean },
): void {
  const pid = target.id;
  // 重入：先断旧链 + 销毁旧 TD
  cancelCountdownFx(pid);
  const td = new TextDraw({ player: target, x: 320, y: FALL_START_Y, text: "0" })
    .create()
    .setAlignment(2)
    .setFont(2)
    .setLetterSize(0.6, 2.6)
    .setColor(colorFor(false, 255))
    .setOutline(1)
    .setShadow(1)
    .setProportional(true)
    .setSelectable(false)
    .show(target);
  countdownFxTds.set(pid, td);
  const fx: FxTarget = { player: target, td, text: "", step: 0, isGo: false };
  let numIdx = 0;

  const tick = (): void => {
    if (!target.isConnected() || !td.isValid()) {
      // 掉线/TD 失效：销毁，终止链
      if (countdownFxTds.get(pid) === td) countdownFxTds.delete(pid);
      countdownFxTimers.delete(pid);
      return;
    }
    // 推进当前数字动画
    if (!advanceFx(fx)) {
      // 当前数字完成 → 下一个
      if (!fx.isGo) {
        // 销毁当前 TD（数字帧已结束），下一数字或 GO 重建
        try {
          if (td.isValid()) td.destroy();
        } catch {
          /* 已销毁 */
        }
        if (countdownFxTds.get(pid) === td) countdownFxTds.delete(pid);
        numIdx++;
        if (numIdx < numbers.length) {
          // 下一个数字
          const n = numbers[numIdx];
          const nd = new TextDraw({ player: target, x: 320, y: FALL_START_Y, text: String(n) })
            .create()
            .setAlignment(2)
            .setFont(2)
            .setLetterSize(0.6, 2.6)
            .setColor(colorFor(false, 255))
            .setOutline(1)
            .setShadow(1)
            .setProportional(true)
            .setSelectable(false)
            .show(target);
          countdownFxTds.set(pid, nd);
          fx.td = nd;
          fx.text = String(n);
          fx.isGo = false;
          fx.step = 0;
          if (opts.sounds) target.playSound(1056);
        } else {
          // GO
          const go = new TextDraw({ player: target, x: 320, y: FALL_START_Y, text: "GO!" })
            .create()
            .setAlignment(2)
            .setFont(2)
            .setLetterSize(0.9, 3.6)
            .setColor(colorFor(true, 255))
            .setOutline(1)
            .setShadow(1)
            .setProportional(true)
            .setSelectable(false)
            .show(target);
          countdownFxTds.set(pid, go);
          fx.td = go;
          fx.text = "GO!";
          fx.isGo = true;
          fx.step = 0;
          if (opts.sounds) target.playSound(1057);
          opts.onGo?.();
        }
      } else {
        // GO 动画结束：销毁 TD，终止链
        try {
          if (td.isValid()) td.destroy();
        } catch {
          /* 已销毁 */
        }
        if (countdownFxTds.get(pid) === td) countdownFxTds.delete(pid);
        countdownFxTimers.delete(pid);
        return;
      }
    }
    // 自链下一帧（每帧重存句柄，取消可断链）
    countdownFxTimers.set(pid, setTimeoutSafe(tick, STEP_MS));
  };
  // 首个数字音效 + 开始
  if (numbers.length > 0) {
    if (opts.sounds) target.playSound(1056);
    countdownFxTimers.set(pid, setTimeoutSafe(tick, STEP_MS));
  }
}

/**
 * 播放倒计时动画（所有目标并行，各自独立 TextDraw）：
 * - numbers：倒计时数字（如 [5,4,3,2,1] 或 [3,2,1]）；全部播完显示 GO
 * - onGo：GO 显示瞬间回调（比赛在此调 beginRace / 回放放行 / 挑战进 RACING）
 * - sounds：数字 1056 / GO 1057 音效（回放 watchers 场景可关，自行管理音效）
 */
export function playCountdown(
  targets: Player[],
  opts?: { numbers?: number[]; onGo?: () => void; sounds?: boolean },
): void {
  const numbers = opts?.numbers ?? [3, 2, 1];
  const sounds = opts?.sounds ?? true;
  // onGo 只触发一次：任一目标完成 GO 动画即回调（比赛/挑战用；多个 target 时
  // 回调一次足够——各目标动画并行且时长一致）
  let goFired = false;
  for (const target of targets) {
    if (!target || !target.isConnected()) continue;
    playFxForTarget(target, numbers, {
      sounds,
      onGo: () => {
        if (!goFired) {
          goFired = true;
          opts?.onGo?.();
        }
      },
    });
  }
}

/** 取消玩家倒计时动画（断线/重开/会话结束）：断链 + 销毁 TD + 删 Map */
export function cancelCountdownFx(playerId: number): void {
  const t = countdownFxTimers.get(playerId);
  if (t) clearTimeoutSafe(t);
  countdownFxTimers.delete(playerId);
  const td = countdownFxTds.get(playerId);
  if (td) {
    try {
      if (td.isValid()) td.destroy();
    } catch {
      /* 已销毁 */
    }
    countdownFxTds.delete(playerId);
  }
}

/** onExit：清空全部倒计时动画 */
export function disposeCountdownFxAll(): void {
  for (const pid of [...countdownFxTimers.keys()]) {
    cancelCountdownFx(pid);
  }
}
