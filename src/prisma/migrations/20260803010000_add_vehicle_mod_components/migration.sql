-- 爱车改装件存储（后续由 20260803020000 回滚为存预设，本迁移保留历史完整性）
ALTER TABLE "user_vehicle" ADD COLUMN "mod_components" VARCHAR(255);
