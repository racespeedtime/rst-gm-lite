import { GameText, Player } from "@infernus/core";
import { setTimeoutSafe, clearTimeoutSafe } from "@/core/timers";

/**
 * GameText 倒计时（替代 TextDraw 动画版）：
 * - 数字 ~y~N 居中大号显示（850ms，style 3），每 1s 切换一个（留间隙）
 * - 数字播完显示 ~g~GO!（1200ms），GO 显示瞬间触发 onGo（开赛/回放放行/挑战进 RACING）
 * - 音效：数字 1056 / GO 1057（与 TextDraw 版对齐）
 * - per-player 定时器 setTimeoutSafe 自链（登记制，onExit 由 clearAllTimers 兜底）；
 *   取消走 cancelCountdownFx（断线/重开/会话结束）。GameText 到时自动消失，
 *   无需手动销毁
 */

/** 数字显示时长（对齐原版 GameText 倒计时 850ms） */
const NUM_MS = 850;
/** 数字切换间隔（含显示时长；对齐原版 1s 一个数字） */
const NUM_INTERVAL_MS = 1000;
/** GO 显示时长 */
const GO_MS = 1200;

/** 每个玩家当前倒计时链句柄（keyed by playerId：同玩家重入先断旧链） */
const countdownTimers = new Map<number, NodeJS.Timeout>();

/** 取消玩家倒计时（断线/重开/会话结束）：断链即可——GameText 到时自动消失 */
export function cancelCountdownFx(playerId: number): void {
  const t = countdownTimers.get(playerId);
  if (t) clearTimeoutSafe(t);
  countdownTimers.delete(playerId);
}

/** onExit：清空全部倒计时链 */
export function disposeCountdownFxAll(): void {
  for (const pid of [...countdownTimers.keys()]) cancelCountdownFx(pid);
}

/** 播放单个目标的 GameText 倒计时链（数字 → GO；完成调用 onDone） */
function playFxForTarget(
  target: Player,
  numbers: number[],
  opts: { onGo?: () => void; sounds: boolean },
): void {
  const pid = target.id;
  cancelCountdownFx(pid);
  const show = (text: string, ms: number): void => {
    new GameText(text, ms, 3).forPlayer(target);
  };
  let numIdx = 0;
  const tick = (): void => {
    // 帧守卫：断线即终止链
    if (!target.isConnected()) {
      countdownTimers.delete(pid);
      return;
    }
    if (numIdx < numbers.length) {
      const n = numbers[numIdx];
      show(`~y~${n}`, NUM_MS);
      if (opts.sounds) target.playSound(1056);
      numIdx++;
      countdownTimers.set(pid, setTimeoutSafe(tick, NUM_INTERVAL_MS));
      return;
    }
    // GO：显示瞬间回调 onGo（门控由调用方在回调里做）
    show("~g~GO!", GO_MS);
    if (opts.sounds) target.playSound(1057);
    opts.onGo?.();
    countdownTimers.delete(pid);
  };
  countdownTimers.set(pid, setTimeoutSafe(tick, NUM_INTERVAL_MS));
}

/**
 * 播放倒计时（所有目标并行，各自独立 GameText）：
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
  // onGo 只触发一次：任一目标完成 GO 即回调（比赛/挑战用；多个 target 时
  // 回调一次足够——各目标并行且时长一致）
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
