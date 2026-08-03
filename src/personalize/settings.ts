import { Dialog, DialogStylesEnum, Player } from "@infernus/core";
import { prisma } from "@/prisma";
import { getAuthState } from "@/auth/auth";
import { showDialog } from "@/utils/dialog";
import { COLOR_SUCCESS, COLOR_ERROR } from "@/utils/colors";
import type { SysUserSettingModel } from "@/prisma/generated/prisma/models/SysUserSetting";

export { COLOR_SUCCESS, COLOR_ERROR };

/**
 * 设置进程内缓存：GUI 200ms 轮询等高频读走缓存，避免每 tick 查库。
 * 变更时写库并同步更新缓存；断线时清理。
 */
const settingCache = new Map<string, SysUserSettingModel>();

/** 缓存失效（设置更新后调用） */
export function invalidateSettingCache(userId: string): void {
  settingCache.delete(userId);
}

/** 读取玩家设置（优先缓存；无设置行返回 null） */
export async function getSetting(player: Player): Promise<SysUserSettingModel | null> {
  const auth = getAuthState(player.id);
  if (!auth) return null;
  const cached = settingCache.get(auth.userId);
  if (cached) return cached;
  const setting = await prisma.sysUserSetting.findUnique({ where: { userId: auth.userId } });
  if (setting) settingCache.set(auth.userId, setting);
  return setting;
}

/** 更新玩家设置（无设置行时自动创建，兼容 admin 等账号）；写库后更新缓存 */
export async function updateSetting(
  player: Player,
  data: Parameters<typeof prisma.sysUserSetting.update>[0]["data"],
): Promise<void> {
  const auth = getAuthState(player.id);
  if (!auth) return;
  const setting = await prisma.sysUserSetting.upsert({
    where: { userId: auth.userId },
    update: data,
    create: { userId: auth.userId, ...(data as object) },
  });
  settingCache.set(auth.userId, setting);
}

/** 表格模式参数（TABLIST_HEADERS 多列：表头 + 每行多列，\t 分隔） */
export interface PickOptionTable {
  headers: string[];
  /** 行 → 各列文本（须与 headers 列数一致）；option 为对应行原始文本 */
  format: (option: string, index: number) => string[];
}

/**
 * 显示一个"选择切换"对话框：返回所选下标；取消返回 -1。
 * 默认 LIST 单列（`1. xxx`）；传 table 时用 TABLIST_HEADERS 多列
 * （表头金色首行不占行号，listItem 从首个数据行起算——与 LIST 语义一致）。
 */
export async function pickOption(
  player: Player,
  caption: string,
  options: string[],
  table?: PickOptionTable,
): Promise<number> {
  const isTable = !!table && table.headers.length > 0;
  const info = isTable
    ? [
        table!.headers.map((h) => `{FFD700}${h}`).join("\t"),
        ...options.map((o, i) => table!.format(o, i).join("\t")),
      ].join("\n")
    : options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const res = await showDialog(
    player,
    new Dialog({
      style: isTable ? DialogStylesEnum.TABLIST_HEADERS : DialogStylesEnum.LIST,
      caption,
      info,
      button1: "确定",
      button2: "取消",
    }),
  );
  if (!res || res.response !== 1) return -1;
  return res.listItem;
}

/** 提示设置已保存 */
export function notifySaved(player: Player, message: string): void {
  player.sendClientMessage(COLOR_SUCCESS, message);
}

/** 开关状态的红绿双色文本（对齐原版 ShowCustomSettings 风格） */
export function toggleText(on: boolean): string {
  return on ? "{00FF00}开" : "{FF0000}关";
}

/** 设置中的布尔字段键（用于开关切换工具） */
type BoolSettingKey = {
  [K in keyof SysUserSettingModel]: SysUserSettingModel[K] extends boolean ? K : never;
}[keyof SysUserSettingModel];

/**
 * 通用开关切换：取反当前值 → 写库 → 提示。
 * 部分开关需联动其他字段时传 extras（同批次写入，如速度表 2d/3d 互斥）。
 * 提示文案统一为「{label}已开启/关闭」。
 */
export async function toggleSetting(
  player: Player,
  key: BoolSettingKey,
  label: string,
  extras?: Partial<Record<BoolSettingKey, boolean>>,
): Promise<void> {
  const setting = await getSetting(player);
  if (!setting) return;
  const next = !setting[key];
  await updateSetting(player, {
    [key]: next,
    ...extras,
  } as Parameters<typeof prisma.sysUserSetting.update>[0]["data"]);
  notifySaved(player, `${label}已${next ? "开启" : "关闭"}`);
}
