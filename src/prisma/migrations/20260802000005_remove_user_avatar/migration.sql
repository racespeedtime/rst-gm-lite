-- 精简：移除 sys_user 的头像字段（无头像系统的简化方向）
-- 仅 DROP COLUMN，不动其他列与数据
ALTER TABLE "public"."sys_user" DROP COLUMN "avatar";
