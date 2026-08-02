import crypto from "node:crypto";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

/** 判断存储的密码是否为 bcrypt 格式（$2a/$2b/$2y） */
function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$\d{2}\$/.test(hash);
}

/** 旧版密码哈希：sha256(密码 + salt)，结果大写 hex */
function legacySha256Hex(plain: string, salt: string): string {
  return crypto
    .createHash("sha256")
    .update(plain + salt)
    .digest("hex")
    .toUpperCase();
}

/** 生成 bcrypt 密码哈希（新注册用户使用） */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * 校验密码。
 * - 存储值为 bcrypt 格式 → bcrypt 比对
 * - 否则按旧版 sha256(密码 + salt) 校验（兼容历史数据）
 */
export async function verifyPassword(
  plain: string,
  stored: string,
  salt: string | null,
): Promise<boolean> {
  if (isBcryptHash(stored)) {
    return bcrypt.compare(plain, stored);
  }
  if (!salt) {
    return false;
  }
  return legacySha256Hex(plain, salt) === stored;
}

/** 判断是否需要升级为 bcrypt（旧版 sha256 格式） */
export function isLegacyPassword(stored: string): boolean {
  return !isBcryptHash(stored);
}
