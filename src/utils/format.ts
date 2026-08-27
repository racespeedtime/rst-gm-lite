/** 毫秒 → mm:ss.SSS（比赛用时/记录展示） */
export function formatTime(ms: number): string {
  // 负毫秒兜底（计时器漂移等）→ 按 0 显示，防 "0-1:..." 怪串
  const safe = Math.max(0, ms);
  const m = Math.floor(safe / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const mm = safe % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}

/** 毫秒 → mm:ss:cc（厘秒，比赛 HUD TIME/BEST 用；room 与回放观战 TD 共用一份，
 *  收敛自 race/room.formatRaceTime 与 replay/playback.fmtRaceTime 的逐字节副本） */
export function formatRaceTimeCs(ms: number): string {
  const safe = Math.max(0, ms);
  const m = Math.floor(safe / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  const cs = Math.floor((safe % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(cs).padStart(2, "0")}`;
}

/** 时长格式化（<1h → mm:ss；≥1h → h:mm:ss，回放/成就/赛道管理列表共用；
 *  原各列表页内联实现收敛至此） */
export function formatDuration(ms: number): string {
  // 负值兜底（对齐 formatTime 的 Math.max(0, ...)）：计时器漂移等防御
  const s = Math.floor(Math.max(0, ms) / 1000);
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 短日期（MM-DD HH:MM，列表多列展示；固定格式，避免 toLocaleString 输出依赖
 *  ICU/locale——zh-CN 不补零时 "2026/8/4 15:20:30" 用 slice(5,16) 会切出半个秒数） */
export function formatShortDate(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 完整日期（YYYY-MM-DD HH:MM，排行榜等需要具体年月日的场景；固定格式同 formatShortDate） */
export function formatFullDate(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 完整日期含秒（YYYY-MM-DD HH:MM:SS，回放列表等需要精确到秒的创建时间） */
export function formatFullDateTime(d: Date): string {
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
