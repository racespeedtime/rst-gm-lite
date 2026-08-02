-- 精简：移除 sys_user 的交易/积分/经验字段（无交易系统的简化方向）
-- 仅 DROP COLUMN，不动其他列与数据
ALTER TABLE "public"."sys_user" DROP COLUMN "score";
ALTER TABLE "public"."sys_user" DROP COLUMN "balance";
ALTER TABLE "public"."sys_user" DROP COLUMN "exp";
