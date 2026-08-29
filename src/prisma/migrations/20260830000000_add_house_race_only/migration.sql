-- 赛道专用对象标记：house.race_only = true 时该房屋 obj 只在赛道世界可见
-- （5F 导入的赛道场景对象，避免在公共大世界/战局显示）；false = 普通房屋
-- AlterTable
ALTER TABLE "house" ADD COLUMN     "race_only" BOOLEAN NOT NULL DEFAULT false;
