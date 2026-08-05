/**
 * 消息颜色常量（语义化，与 utils/msg.ts 的 MSG_COLOR 分级对齐）：
 * - COLOR_ERROR  错误（操作失败/参数非法）    = MSG_COLOR.error
 * - COLOR_SUCCESS 成功                        = MSG_COLOR.success
 * - COLOR_INFO   信息/模块主题（浅蓝）        = MSG_COLOR.info
 * - COLOR_WARN   警告（规则/条件不满足）      = MSG_COLOR.warn
 * - COLOR_WHITE  常规提示                     = MSG_COLOR.plain
 * 新代码推荐直接走 sysMsg(player, tag, text, level)，本常量保留给
 * 非 sysMsg 场景（如 broadcast、不含前缀的旧调用）。
 */
export const COLOR_ERROR = "#ff5555"; // 错误/拒绝
export const COLOR_SUCCESS = "#55ff55"; // 成功/保存
export const COLOR_WHITE = "#ffffff"; // 常规提示
export const COLOR_INFO = "#98cdfe"; // 信息/模块主题（浅蓝）
export const COLOR_WARN = "#ffa500"; // 警告：规则/条件不满足（原 COLOR_ORANGE 语义升级）
export const COLOR_RACE = "#98cdfe"; // 赛车主题（= info 浅蓝，遗留兼容）
export const COLOR_ORANGE = "#ffa500"; // 观战/警告（= COLOR_WARN，遗留兼容）
export const COLOR_LABEL = "#2ba2d5"; // 3D 标签
