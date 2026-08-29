-- 5F 赛道导入：race 增加等级数据与失败扣分字段
-- level_data: 5F [LevelInfo] Data 原始格式 "秒,分|秒,分|秒,分|秒,分|秒,分"（null=未设置）
-- failed_score_fix: 挑战失败完成比赛的扣分数
-- AlterTable
ALTER TABLE "race" ADD COLUMN     "failed_score_fix" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "level_data" VARCHAR(255);
