/**
 * 全局公共常量。
 */

/**
 * 玩家默认字符集（gbk）：
 * SA-MP 客户端按 gbk 显示中文文本，所有文本交互（TextLabel / materialtext /
 * setAttachedObject 等需要字符集的入口）与 RCON 中文命令（hostname 等）统一用它，
 * 避免散落手写 "gbk" 造成不一致（漏写则中文乱码）。
 */
export const DEFAULT_CHARSET = "gbk";
