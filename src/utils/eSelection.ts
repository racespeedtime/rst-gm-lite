import { Player, PlayerEvent } from "@infernus/core";

/**
 * e-selection 3D 选择菜单封装：
 * - 统一每页网格数（6 列 × 3 行 = 18 铺满，e-selection 默认布局；原 14 是
 *   "第一行 6 + 第二行 8"的误记——那是 SA 原生 TABLIST 布局，e-selection 是
 *   纯 6 列网格，14 会让第三行空 4 格）
 * - 分页页码记忆（与 pagedDialog 的 pageMem 同模式：内存态不落库，断线重置）：
 *   打开时恢复上次页码，选中后按模型下标反推当前页保存（currentPage 是库内部
 *   Symbol 私有字段，无法直接读，但选中模型在传入列表中的下标 = 已知页码）
 */

/** 每页网格数：6 列 × 3 行（底部 banner 前坐标放得下，库默认值即 18） */
export const E_SELECTION_PAGE_SIZE = 18;

/** 页码记忆：playerId -> (menuKey -> page) */
const pageMem = new Map<number, Map<string, number>>();

PlayerEvent.onDisconnect(({ player, next }) => {
  pageMem.delete(player.id);
  return next();
});

export interface ESelectionItem {
  modelId: number;
  modelText?: string;
  vehColor?: [number, number];
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  zoom?: number;
}

export interface ModelSelectionOptions {
  models: ESelectionItem[];
  headerText?: string;
  bannerColor?: string;
  menuBgColor?: string;
  menuTextColor?: string;
  itemBgColor?: string;
  itemTextColor?: string;
  /** 每页网格数（默认 18 = 6 列 × 3 行；显式传 6 的倍数） */
  maxItemPerPage?: number;
}

/**
 * 打开 e-selection 选模型菜单（带页码记忆）。
 * 返回选中的模型；关闭/断线返回 null。
 * show() 同步创建 UI 并显示第 1 页，紧接翻到记忆页——同一 tick 内完成，无
 * "先闪第 1 页再跳记忆页"的视觉闪烁。记忆页超出总页数时 setPage 内部钳制。
 */
export async function showModelSelectionMenu(
  player: Player,
  key: string,
  opts: ModelSelectionOptions,
): Promise<ESelectionItem | null> {
  const { ModelSelectionMenu } = await import("@infernus/e-selection");
  const pageSize = opts.maxItemPerPage ?? E_SELECTION_PAGE_SIZE;
  const menu = new ModelSelectionMenu({
    player,
    models: opts.models,
    headerText: opts.headerText,
    maxItemPerPage: pageSize,
    bannerColor: opts.bannerColor,
    menuBgColor: opts.menuBgColor,
    menuTextColor: opts.menuTextColor,
    itemBgColor: opts.itemBgColor,
    itemTextColor: opts.itemTextColor,
  });
  const saved = pageMem.get(player.id)?.get(key) ?? 1;
  const p = menu.show();
  if (saved > 1) menu.setPage(saved);
  const model = await p;
  // 记忆当前页：选中模型下标 / 每页数 + 1（下标在传入列表内必然可算）。
  // 关闭（null）不更新，保留上次记忆页。
  if (model) {
    const idx = opts.models.findIndex((m) => m.modelId === model.modelId);
    if (idx >= 0) {
      let mem = pageMem.get(player.id);
      if (!mem) pageMem.set(player.id, (mem = new Map()));
      mem.set(key, Math.floor(idx / pageSize) + 1);
    }
  }
  return model;
}
