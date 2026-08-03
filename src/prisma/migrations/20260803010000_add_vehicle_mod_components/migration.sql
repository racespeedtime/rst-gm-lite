-- 爱车改装件存储：改装店（OnVehicleMod）装的 mod 组件存 user_vehicle.mod_components
-- 重刷车时重新应用（对齐用户"改车之后的 mod_component 要存储"需求）
ALTER TABLE "user_vehicle" ADD COLUMN "mod_components" VARCHAR(255);
