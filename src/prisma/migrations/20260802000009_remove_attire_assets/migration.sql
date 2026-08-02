-- 精简：移除资产表（sys_user_attire / sys_user_vehicle_attire）
-- 背景：无购买/拥有系统，玩家可直接从 attire 目录任意挑选装扮搭配预设，
--       预设条目改为直接引用 attire 目录。
-- 1. 删除引用已删装扮的死条目（当前 1 条，配置无意义）
-- 2. 玩家/车辆条目：attire_id 改引 attire（去掉中间层资产表）
-- 3. 删除资产表（数据已并入条目）
-- 注意：不做 reset/清表，仅结构性数据搬移。

-- ===== 玩家侧 =====
-- 1. 删除引用已删装扮(attire 不存在)的死条目（其配置对应的装扮已不存在，无保留价值）
DELETE FROM "player_preset_item" ppi
WHERE ppi."sys_user_attire_id" IN (
  SELECT sua.id FROM sys_user_attire sua
  LEFT JOIN attire a ON a.id = sua.attire_id
  WHERE a.id IS NULL
);

-- 2. 加 attire_id 列并填充（从中间层资产取 attire_id）
ALTER TABLE "player_preset_item" ADD COLUMN "attire_id" uuid;
UPDATE "player_preset_item" ppi
SET "attire_id" = sua.attire_id
FROM "sys_user_attire" sua
WHERE sua.id = ppi."sys_user_attire_id";
ALTER TABLE "player_preset_item" ALTER COLUMN "attire_id" SET NOT NULL;

-- 3. 玩家条目约束调整：换索引/唯一/外键，删除旧列
DROP INDEX IF EXISTS "player_preset_item_sys_user_attire_id_idx";
CREATE INDEX "player_preset_item_attire_id_idx" ON "player_preset_item"("attire_id");
DROP INDEX IF EXISTS "player_preset_item_preset_id_sys_user_attire_id_key";
CREATE UNIQUE INDEX "player_preset_item_preset_id_attire_id_key" ON "player_preset_item"("preset_id", "attire_id");
ALTER TABLE "player_preset_item" DROP CONSTRAINT IF EXISTS "player_preset_item_sys_user_attire_id_fkey";
ALTER TABLE "player_preset_item" ADD CONSTRAINT "player_preset_item_attire_id_fkey" FOREIGN KEY ("attire_id") REFERENCES "attire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "player_preset_item" DROP COLUMN "sys_user_attire_id";

-- ===== 车辆侧 =====
-- 4. 加 attire_id 列并填充（从中间层资产取 attire_id）
ALTER TABLE "vehicle_preset_item" ADD COLUMN "attire_id" uuid;
UPDATE "vehicle_preset_item" vpi
SET "attire_id" = suva.attire_id
FROM "sys_user_vehicle_attire" suva
WHERE suva.id = vpi."sys_user_vehicle_attire_id";
ALTER TABLE "vehicle_preset_item" ALTER COLUMN "attire_id" SET NOT NULL;

-- 5. 车辆条目约束调整：换索引/外键，删除旧列
DROP INDEX IF EXISTS "vehicle_preset_item_sys_user_vehicle_attire_id_idx";
CREATE INDEX "vehicle_preset_item_attire_id_idx" ON "vehicle_preset_item"("attire_id");
ALTER TABLE "vehicle_preset_item" DROP CONSTRAINT IF EXISTS "vehicle_preset_item_sys_user_vehicle_attire_id_fkey";
ALTER TABLE "vehicle_preset_item" ADD CONSTRAINT "vehicle_preset_item_attire_id_fkey" FOREIGN KEY ("attire_id") REFERENCES "attire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_preset_item" DROP COLUMN "sys_user_vehicle_attire_id";

-- ===== 删除资产表 =====
DROP TABLE "sys_user_attire";
DROP TABLE "sys_user_vehicle_attire";
