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
  /** 条目 → 显示文本（index 为全局索引，从 0 起） */
  format: (item: T, index: number) => string;
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
 * 通用分页对话框（LIST 样式）。
 * 列表首尾自动追加"← 上一页 / 下一页 →"导航行，末尾带"第 x/y 页"页码。
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
    pageSize = 10,
    selectable = true,
    button1 = "确定",
    button2 = "取消",
  } = options;
  if (data.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
  let page = 0;

  for (;;) {
    const start = page * pageSize;
    const pageItems = data.slice(start, start + pageSize);
    // 行号 → 全局索引（负数为导航哨兵）
    const nav = new Map<number, number>();
    const lines: string[] = [];

    let row = 0;
    if (page > 0) {
      lines.push("{FFD700}← 上一页");
      nav.set(row++, NAV_PREV);
    }
    for (let i = 0; i < pageItems.length; i++) {
      lines.push(format(pageItems[i], start + i));
      nav.set(row++, start + i);
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
        style: DialogStylesEnum.LIST,
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
