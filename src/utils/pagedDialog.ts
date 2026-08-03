import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { showDialog } from "@/utils/dialog";

/** 分页导航哨兵：上一页 */
const NAV_PREV = -1;
/** 分页导航哨兵：下一页 */
const NAV_NEXT = -2;

export interface PagedDialogOptions<T> {
  /** 对话框标题 */
  caption: string;
  /** 全部条目（一次取回，分页在内存中完成） */
  data: T[];
  /**
   * 条目 → 显示文本（index 为全局索引，从 0 起）。
   * 返回 string = 单列；返回 string[] = 多列（配合 headers 用 TABLIST_HEADERS，
   * 列间用 \t 分隔，列数须与 headers 一致）。
   */
  format: (item: T, index: number) => string | string[];
  /** 表头列（提供时启用 TABLIST_HEADERS 多列对话框；行内 \t 分隔） */
  headers?: string[];
  /** 每页条数，默认 10 */
  pageSize?: number;
  /** 是否可选择条目（默认 true）。false = 纯浏览：点普通条目忽略，只响应上一页/下一页/取消 */
  selectable?: boolean;
  /** 确定按钮文字，默认 "确定" */
  button1?: string;
  /** 取消按钮文字，默认 "取消" */
  button2?: string;
}

export interface PagedDialogResult<T> {
  item: T;
  /** 全局索引（0 起） */
  index: number;
  /** 所在页（0 起） */
  page: number;
}

/**
 * 通用分页对话框。
 * 单列（无 headers）：LIST 样式，首尾自动追加"← 上一页 / 下一页 →"导航行。
 * 多列（传 headers）：TABLIST_HEADERS 样式，表头 + 每行多列（\t 分隔），
 * 导航行统一放数据行之后，表头不占可选行号（TABLIST 的 listItem 从首个数据行起算）。
 * 内部循环翻页，直到选中真实条目（selectable=true）返回结果，
 * 或用户取消/关闭/断线返回 null。
 */
export async function showPagedDialog<T>(
  player: Player,
  options: PagedDialogOptions<T>,
): Promise<PagedDialogResult<T> | null> {
  const {
    data,
    format,
    headers,
    pageSize = 10,
    selectable = true,
    button1 = "确定",
    button2 = "取消",
  } = options;
  if (data.length === 0) return null;
  const isMulti = !!headers && headers.length > 0;

  const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
  let page = 0;

  for (;;) {
    const start = page * pageSize;
    const pageItems = data.slice(start, start + pageSize);
    // 行号 → 全局索引（负数为导航哨兵）
    const nav = new Map<number, number>();
    const lines: string[] = [];

    let row = 0;
    // 多列：表头固定首行（金色），不占可选行号
    if (isMulti) {
      lines.push(headers!.map((h) => `{FFD700}${h}`).join("\t"));
    }
    // 单列：上一页导航在顶部；多列：导航统一放底部
    if (!isMulti && page > 0) {
      lines.push("{FFD700}← 上一页");
      nav.set(row++, NAV_PREV);
    }
    for (let i = 0; i < pageItems.length; i++) {
      const text = format(pageItems[i], start + i);
      lines.push(Array.isArray(text) ? text.join("\t") : text);
      nav.set(row++, start + i);
    }
    // 多列：上一页/下一页统一放底部；单列：上一页已在顶部，底部只放下一页
    if (isMulti && page > 0) {
      lines.push("{FFD700}← 上一页");
      nav.set(row++, NAV_PREV);
    }
    if (page < pageCount - 1) {
      lines.push("{FFD700}下一页 →");
      nav.set(row++, NAV_NEXT);
    }
    if (pageCount > 1) {
      lines.push(`{808080}—— 第 ${page + 1}/${pageCount} 页 ——`);
    }

    const res = await showDialog(
      player,
      new Dialog({
        style: isMulti ? DialogStylesEnum.TABLIST_HEADERS : DialogStylesEnum.LIST,
        caption: options.caption,
        info: lines.join("\n"),
        button1,
        button2,
      }),
    );
    if (!res) return null; // 断线/关闭
    if (res.response !== 1) return null; // 取消
    const target = nav.get(res.listItem);
    if (target === NAV_PREV) {
      page = Math.max(0, page - 1);
      continue;
    }
    if (target === NAV_NEXT) {
      page = Math.min(pageCount - 1, page + 1);
      continue;
    }
    if (target === undefined) continue; // 页脚行/点按钮：留在本页
    if (!selectable) continue; // 浏览模式：点普通条目忽略，留在本页
    return { item: data[target], index: target, page };
  }
}
