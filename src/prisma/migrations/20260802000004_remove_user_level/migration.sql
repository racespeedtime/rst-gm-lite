-- 精简：移除 sys_user 的等级字段（无等级系统的简化方向）
-- 仅 DROP COLUMN，不动其他列与数据
ALTER TABLE "public"."sys_user" DROP COLUMN "level";
