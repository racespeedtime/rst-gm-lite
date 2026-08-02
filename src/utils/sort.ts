/**
 * 有序列表（带 index 排序字段的表）通用操作。
 *
 * 背景：HouseModel/RaceGroup/RaceGroupRace/RaceCp/RaceCpScript/Teleport/
 *       PlayerPreset/VehiclePreset/SpawnPoint 等表都有 index 排序字段，
 *       面板操作除 CRUD 外还需支持"新建取下一个序号/上移下移/删除后重排"。
 * 所有写库通过调用方传入的 update 回调（各表的 prisma delegate），保持类型安全。
 */

export interface SortRow {
  id: string;
  index: number;
}

/**
 * 新建条目的下一个 index：取当前列表 max+1。
 * （不用 count：删除留空洞后 count 可能与现有 index 冲突，max+1 永远安全）
 */
export function nextSortIndex(rows: readonly { index: number }[]): number {
  return rows.reduce((max, r) => Math.max(max, r.index), -1) + 1;
}

/**
 * 交换两行的排序位置（上移/下移 = 与相邻行交换）。
 * 三步写入：先用临时 -1 给 a 腾位（-1 与所有非负业务 index 不冲突），
 * 规避带 unique([scope, index]) 约束的表（预设/分组/CP 等）在交换时的冲突。
 */
export async function swapSortIndex(
  a: SortRow,
  b: SortRow,
  update: (id: string, index: number) => Promise<unknown>,
): Promise<void> {
  const TEMP = -1;
  await update(a.id, TEMP);
  await update(b.id, a.index);
  await update(a.id, b.index);
}

/**
 * 删除一行后把其后的行 index 前移（保持连续，防空洞）。
 * 从 deletedIndex+1 起逐个减：每个目标位都已被前一行腾出，无 unique 冲突。
 */
export async function compactSortIndex(
  rows: readonly SortRow[],
  deletedIndex: number,
  update: (id: string, index: number) => Promise<unknown>,
): Promise<void> {
  for (const r of rows) {
    if (r.index > deletedIndex) {
      await update(r.id, r.index - 1);
    }
  }
}
