/**
 * 赛道挑战等级（level_data / failed_score_fix）
 *
 * level_data 格式（对齐 5F [LevelInfo] Data）：`秒,分|秒,分|秒,分|秒,分|秒,分`
 *  - 固定 5 组，索引 0=渣（最宽松）、4=神（最严苛）
 *  - 每组的"秒"是时间上限（用时 ≤ 该秒数 → 命中该等级），"分"是对应分数
 *  - 时间越短等级越高：神(最快) > 鬼 > 人 > 菜 > 渣(最慢)
 *  - 组值为 0 表示该等级未设置（不参与判定）
 * failed_score_fix：挑战失败（超时）后完成比赛的扣分数，纯展示/计算用
 */

export const TIER_LABELS = ["渣", "菜", "人", "鬼", "神"] as const;
export type TierLabel = (typeof TIER_LABELS)[number];

export interface Tier {
  /** 时间上限（秒），0 = 未设置 */
  seconds: number;
  /** 该等级分数 */
  score: number;
}

/** 解析 level_data 字符串 → 5 个等级；null = 未设置/格式非法 */
export function parseLevelData(data: string | null | undefined): Tier[] | null {
  if (!data) return null;
  const parts = data.split("|");
  if (parts.length !== 5) return null;
  const tiers: Tier[] = [];
  for (const p of parts) {
    const [sec, score] = p.split(",");
    const s = Number(sec);
    const sc = Number(score);
    if (!Number.isFinite(s) || !Number.isFinite(sc)) return null;
    tiers.push({ seconds: s, score: sc });
  }
  return tiers;
}

/** 该等级组是否已设置（seconds > 0 且 score > 0 视为有效，0 值跳过） */
export function isTierSet(tier: Tier): boolean {
  return tier.seconds > 0 && tier.score > 0;
}

/**
 * 按完成时间（毫秒）判定命中的等级。
 * 语义：数据为时间上限——用时 ≤ 该组秒数 → 命中。取用时上限最紧（时间最短）
 * 且已设置的等级；都不满足（慢于最宽松档）→ null（未达任何等级）。
 * 例：350,10|300,20|240,40|195,75|170,125（索引0=渣350s → 索引4=神170s），
 * 用时 250s → 神170?否 鬼195?否 人240?否 菜300?是 → 菜（20分）。
 * 实现：索引从高（神）往低（渣）找第一个"用时 ≤ seconds"的已设置等级。
 */
export function tierForTime(
  timeMs: number,
  tiers: Tier[] | null,
): { label: TierLabel; score: number } | null {
  if (!tiers) return null;
  const sec = timeMs / 1000;
  for (let i = TIER_LABELS.length - 1; i >= 0; i--) {
    const t = tiers[i];
    if (isTierSet(t) && sec <= t.seconds) {
      return { label: TIER_LABELS[i], score: t.score };
    }
  }
  return null;
}

/** 生成 level_data 字符串（5 组固定，未设置组输出 0,0） */
export function formatLevelData(tiers: Tier[]): string {
  return tiers.map((t) => `${Math.round(t.seconds)},${Math.round(t.score)}`).join("|");
}

/**
 * 校验等级顺序：已设置的档位秒数必须严格递增（渣 < 菜 < 人 < 鬼 < 神），
 * 即时间越短等级越高。乱配（如神比渣还慢）会让 tierForTime 判定崩坏。
 * 返回 null = 合法；否则返回出错的中文描述（含冲突的两档）。
 */
export function validateTierOrder(tiers: Tier[] | null): string | null {
  if (!tiers) return null;
  let prev: number | null = null; // 上一个已设置档的秒数（从渣→神扫，秒数应递增）
  for (let i = 0; i < TIER_LABELS.length; i++) {
    const t = tiers[i];
    if (!isTierSet(t)) continue;
    if (prev != null && t.seconds <= prev) {
      return `${TIER_LABELS[i]}（${Math.round(t.seconds)}s）需快于 ${TIER_LABELS[i - 1]}（${Math.round(prev)}s）`;
    }
    prev = t.seconds;
  }
  return null;
}

/** 等级摘要（详情面板/提示用）：从神→渣列出已设置档，如 `神170s·鬼195s·人240s·菜300s·渣350s`，未设置档省略 */
export function formatLevelSummary(tiers: Tier[] | null): string | null {
  if (!tiers) return null;
  const parts: string[] = [];
  for (let i = TIER_LABELS.length - 1; i >= 0; i--) {
    const t = tiers[i];
    parts.push(isTierSet(t) ? `${TIER_LABELS[i]}${Math.round(t.seconds)}s` : "");
  }
  const s = parts.filter(Boolean).join("·");
  return s || null;
}
