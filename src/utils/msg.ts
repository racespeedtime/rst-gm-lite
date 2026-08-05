import { Player } from "@infernus/core";

/**
 * 统一消息模块（模块前缀 + 分级颜色规范）。
 *
 * 用法：sysMsg(player, "race", "不能进入比赛", "warn")
 *   →  黄色  "[赛车] 不能进入比赛"
 *
 * 规范：
 * - 所有 sendClientMessage 统一带模块前缀，前缀在此集中登记，禁止手写 "[xxx]"
 * - 颜色按"程度"分级（见 MSG_COLOR），不要用颜色表达模块（模块主题色 = info 级）
 * - 新模块先在此登记前缀，再通过 sysMsg 输出
 */

/** 模块前缀表（集中登记；键名即 sysMsg 的 tag） */
export const PREFIX = {
  /** 赛车 / 比赛 / 赛道编辑 */
  race: "[赛车]",
  /** 传送 / 传送点 */
  tp: "[传送]",
  /** 观战 */
  observe: "[观战]",
  /** 战局 / 公共大世界 */
  session: "[战局]",
  /** 聊天 / 私聊 */
  chat: "[聊天]",
  /** 私聊（独立前缀，消息高频） */
  pm: "[私聊]",
  /** 装扮 / 挂件 */
  attire: "[装扮]",
  /** 房屋 */
  house: "[房屋]",
  /** 电梯 */
  elevator: "[电梯]",
  /** 漂移 NPC */
  drift: "[漂移]",
  /** 回放 */
  replay: "[回放]",
  /** 影子挑战 */
  challenge: "[影子]",
  /** 爱车 / 车辆 */
  vehicle: "[爱车]",
  /** 动作 */
  action: "[动作]",
  /** 账号 / 认证 / 登录 */
  auth: "[账号]",
  /** 通用系统 */
  system: "[系统]",
} as const;
export type MsgTag = keyof typeof PREFIX;

/** 消息级别颜色（语义化分级，按"程度"选色） */
export const MSG_COLOR = {
  /** 错误：操作失败 / 参数非法 / 流程冲突（真正的错误才用红） */
  error: "#ff5555",
  /** 成功：操作完成 / 保存成功 */
  success: "#55ff55",
  /** 信息：进度 / 状态 / 模块主题（统一浅蓝，模块差异靠前缀区分） */
  info: "#98cdfe",
  /** 警告：规则 / 条件不满足（"比赛中不能…""需要先…才能…"——此前大量误用 error 红的场景） */
  warn: "#ffa500",
  /** 常规提示 */
  plain: "#ffffff",
} as const;
export type MsgLevel = keyof typeof MSG_COLOR;

/** 输出带模块前缀 + 分级颜色的消息 */
export function sysMsg(player: Player, tag: MsgTag, text: string, level: MsgLevel = "plain"): void {
  player.sendClientMessage(MSG_COLOR[level], `${PREFIX[tag]} ${text}`);
}
