-- 撤销 race_only：改为按 house.race 关联判定世界区间（赛道对象放赛道+回放世界）
-- AlterTable
ALTER TABLE "house" DROP COLUMN "race_only";
