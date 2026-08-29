-- 赛道专属对象标记：house.race_only = true 时该房屋是某条赛道的专属场景
-- （5F 空中赛道/护栏等），只在游玩对应赛道/影子挑战/回放时动态加载，
-- 其他时间不显示；false = 普通房屋（静态显示）
-- AlterTable
ALTER TABLE "house" ADD COLUMN     "race_only" BOOLEAN NOT NULL DEFAULT false;
