/** 毫秒 → mm:ss.SSS（比赛用时/记录展示） */
export function formatTime(ms: number): string {
  // 负毫秒兜底（计时器漂移等）→ 按 0 显示，防 "0-1:..." 怪串
  const safe = Math.max(0, ms);
  const m = Math.floor(safe / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const mm = safe % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}
