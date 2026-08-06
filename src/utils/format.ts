/** 毫秒 → mm:ss.SSS（比赛用时/记录展示） */
export function formatTime(ms: number): string {
  // 负毫秒兜底（计时器漂移等）→ 按 0 显示，防 "0-1:..." 怪串
  const safe = Math.max(0, ms);
  const m = Math.floor(safe / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const mm = safe % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}

/** 时长格式化（mm:ss 或 ss，回放列表等短格式用；原各列表页内联实现收敛至此） */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 短日期（MM-DD HH:MM，列表多列展示；固定格式，避免 toLocaleString 输出依赖
 *  ICU/locale——zh-CN 不补零时 "2026/8/4 15:20:30" 用 slice(5,16) 会切出半个秒数） */
export function formatShortDate(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
