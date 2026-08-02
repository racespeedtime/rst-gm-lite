-- 修复 spawn_mode 列超长：LAST_POSITION（13 字符）> VarChar(10)
-- 玩家在大厅选择"上次位置出生"时 upsert 触发 P2000 列超长 → 认证流程异常被踢
ALTER TABLE "sys_user_setting" ALTER COLUMN "spawn_mode" SET DATA TYPE VARCHAR(16);
