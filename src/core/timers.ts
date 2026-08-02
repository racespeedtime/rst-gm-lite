import { GameMode } from "@infernus/core";

/**
 * 统一 Timer 管理：
 * 本项目特殊性——open.mp 不会帮我们清理 Node 的 setInterval/setTimeout，
 * 所有 timer 必须登记，并在 GameMode.onExit 时统一清理。
 * 各模块应使用 setIntervalSafe / setTimeoutSafe 创建 timer，
 * 由 GameMode.onExit 统一调用 clearAllTimers 清理。
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
  const t = setTimeout(fn, ms);
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
