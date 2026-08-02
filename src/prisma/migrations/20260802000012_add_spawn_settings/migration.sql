-- 出生设置：sys_user_setting 增加出生方式与最后在线位置
ALTER TABLE "sys_user_setting"
  ADD COLUMN "spawn_mode" VARCHAR(10) NOT NULL DEFAULT 'RANDOM',
  ADD COLUMN "last_x" DECIMAL(18, 6),
  ADD COLUMN "last_y" DECIMAL(18, 6),
  ADD COLUMN "last_z" DECIMAL(18, 6),
  ADD COLUMN "last_angle" DECIMAL(18, 6);
