-- 精简车辆结构（续）
-- 说明：本迁移的步骤 1-3（user_vehicle.model_id / vehicle_preset.model_id+外观列 / 颜色并入 index=0 预设）
-- 已在首次执行中提交，本文件为剩余步骤 4-8：
--   4. 为无预设的 (user, model) 创建 index=0 预设（不丢颜色配置）
--   5. 删除 user_vehicle 的 catalog 引用与外观字段
--   6. 删除 vehicle_preset 的 catalog 引用
--   7. 重建约束与索引
--   8. 删除 vehicle_catalog
-- 注意：不做 reset/清表

-- ===== 6. 先删除 vehicle_preset 的 catalog 引用（INSERT 新预设前移除 NOT NULL 列） =====
DROP INDEX IF EXISTS "vehicle_preset_user_id_vehicle_catalog_id_index_key";
ALTER TABLE "vehicle_preset" DROP COLUMN "vehicle_catalog_id";

-- ===== 4. 为无预设的 (user, model) 创建 index=0 预设（颜色取车辆当前值） =====
INSERT INTO "vehicle_preset" ("id", "user_id", "model_id", "index", "name", "color1", "color2", "paintjob", "mod_components", "created_at", "updated_at")
SELECT gen_random_uuid(), uv.user_id, uv.model_id, 0, '预设1', uv.color1, uv.color2, uv.paintjob, uv.mod_components, now(), now()
FROM "user_vehicle" uv
WHERE NOT EXISTS (
  SELECT 1 FROM "vehicle_preset" vp WHERE vp.user_id = uv.user_id AND vp.model_id = uv.model_id
);

-- ===== 5. 删除 user_vehicle 的 catalog 引用与外观字段 =====
DROP INDEX IF EXISTS "user_vehicle_user_id_vehicle_catalog_id_key";
ALTER TABLE "user_vehicle" DROP COLUMN "vehicle_catalog_id";
ALTER TABLE "user_vehicle" DROP COLUMN "color1";
ALTER TABLE "user_vehicle" DROP COLUMN "color2";
ALTER TABLE "user_vehicle" DROP COLUMN "mod_components";
ALTER TABLE "user_vehicle" DROP COLUMN "paintjob";

-- ===== 7. 重建约束与索引 =====
CREATE INDEX "user_vehicle_model_id_idx" ON "user_vehicle"("model_id");
CREATE UNIQUE INDEX "user_vehicle_user_id_model_id_key" ON "user_vehicle"("user_id", "model_id");
CREATE INDEX "vehicle_preset_model_id_idx" ON "vehicle_preset"("model_id");
CREATE UNIQUE INDEX "vehicle_preset_user_id_model_id_index_key" ON "vehicle_preset"("user_id", "model_id", "index");

-- ===== 8. 删除 vehicle_catalog（其外键已随列删除，无残留引用） =====
DROP TABLE "vehicle_catalog";
