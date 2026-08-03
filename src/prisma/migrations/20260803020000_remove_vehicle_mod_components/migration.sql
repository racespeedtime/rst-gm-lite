-- 回滚：改装店 mod 存储改为更新爱车当前预设（vehicle_preset.mod_components），
-- 无需 user_vehicle 冗余字段（上一条迁移误加，applyVehiclePreset 应用预设时已带改装件）
ALTER TABLE "user_vehicle" DROP COLUMN "mod_components";
