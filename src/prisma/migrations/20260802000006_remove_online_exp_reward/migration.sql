-- 精简：移除 sys_user_game_session 的在线经验奖励时间字段（无经验系统的简化方向）
-- 表当前 0 行且该字段全为 NULL，仅 DROP COLUMN
ALTER TABLE "public"."sys_user_game_session" DROP COLUMN "online_exp_rewarded_at";
