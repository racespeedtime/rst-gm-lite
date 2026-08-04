/** 构建期注入常量（vite define，见 vite.config.ts）：构建时间点 ISO 字符串 + git 短提交号 */
declare const __BUILD_TIME__: string;
declare const __BUILD_HASH__: string;
