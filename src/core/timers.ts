import { GameMode } from "@infernus/core";

/**
 * 统一 Timer 管理：
 * 本项目特殊性——open.mp 不会帮我们清理 Node 的 setInterval/setTimeout，
 * 所有 timer 必须登记，并在 GameMode.onExit 时统一清理。
 * 各模块应使用 setIntervalSafe / setTimeoutSafe 创建 timer，
 * 由 GameMode.onExit 统一调用 clearAllTimers 清理。
 *
 * 持久 tick（GUI 刷新、会话心跳、比赛刷新等）的注册生命周期：
 * - 模块顶层注册一次是"进程级"注册——samp-node 在 gmx 后不重新加载 bundle，
 *   但 gmx 的 onExit 会 clearAllTimers 清掉所有 timer，而 onInit 不重注册的话
 *   持久 tick 在 gmx 后永不复活（曾导致 GUI TextDraw 永久消失）。
 * - 因此持久 tick 必须显式放进 GameMode.onInit 注册（onExit 自动清理，onInit
 *   重新注册，生命周期与游戏模式一致），对齐 startWorldClockTimers 模式。
 *   不要依赖任何"自动重放"——一次性/玩家级 timer 不该在 gmx 后复活。
 */

const intervals = new Set<NodeJS.Timeout>();
const timeouts = new Set<NodeJS.Timeout>();
let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  GameMode.onExit(({ next }) => {
    clearAllTimers();
    return next();
  });
}

/** 登记式 setInterval（GameMode.onExit 自动清理） */
export function setIntervalSafe(fn: () => void, ms: number): NodeJS.Timeout {
  ensureInit();
  const t = setInterval(fn, ms);
  intervals.add(t);
  return t;
}

/** 登记式 setTimeout（GameMode.onExit 自动清理） */
export function setTimeoutSafe(fn: () => void, ms: number): NodeJS.Timeout {
  ensureInit();
  const t = setTimeout(() => {
    // 已触发的 timeout 从登记表移除，避免长期运行句柄累积
    timeouts.delete(t);
    fn();
  }, ms);
  timeouts.add(t);
  return t;
}

/** 清理并注销 interval */
export function clearIntervalSafe(t: NodeJS.Timeout | undefined): void {
  if (!t) return;
  intervals.delete(t);
  clearInterval(t);
}

/** 清理并注销 timeout */
export function clearTimeoutSafe(t: NodeJS.Timeout | undefined): void {
  if (!t) return;
  timeouts.delete(t);
  clearTimeout(t);
}

/** 清理全部 timer（GameMode.onExit 时调用） */
export function clearAllTimers(): void {
  for (const t of intervals) clearInterval(t);
  for (const t of timeouts) clearTimeout(t);
  intervals.clear();
  timeouts.clear();
}
