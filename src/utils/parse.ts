/**
 * 解析闭区间内的整数（输入字符串 → 整数，非法/非整数/越界返回 null）。
 * 统一各流程中「输入整数」对话框的校验写法。
 */
export function parseIntInRange(input: string, min: number, max: number): number | null {
  const n = Number(input.trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}
