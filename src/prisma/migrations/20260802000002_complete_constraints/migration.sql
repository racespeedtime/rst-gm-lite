-- 补齐 schema 要求但数据库缺失的约束与索引
-- 均已核验无孤儿行/无重复数据，仅补约束与索引，不动数据

-- 1. sys_user_house 外键（表当前 0 行，schema 要求必填级联删除）
ALTER TABLE "public"."sys_user_house" ADD CONSTRAINT "sys_user_house_house_id_fkey" FOREIGN KEY ("house_id") REFERENCES "public"."house"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."sys_user_house" ADD CONSTRAINT "sys_user_house_sys_user_id_fkey" FOREIGN KEY ("sys_user_id") REFERENCES "public"."sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. sys_user_role 外键（schema 要求必填级联删除，孤儿行核验为 0）
ALTER TABLE "public"."sys_user_role" ADD CONSTRAINT "sys_user_role_sys_role_id_fkey" FOREIGN KEY ("sys_role_id") REFERENCES "public"."sys_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."sys_user_role" ADD CONSTRAINT "sys_user_role_sys_user_id_fkey" FOREIGN KEY ("sys_user_id") REFERENCES "public"."sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. race_group_race 外键（schema 要求必填级联删除，孤儿行核验为 0）
ALTER TABLE "public"."race_group_race" ADD CONSTRAINT "race_group_race_race_group_id_fkey" FOREIGN KEY ("race_group_id") REFERENCES "public"."race_group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."race_group_race" ADD CONSTRAINT "race_group_race_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "public"."race"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. teleport.house_id 普通索引（schema 的 @@index([houseId])）
CREATE INDEX "teleport_house_id_idx" ON "public"."teleport"("house_id");

-- 5. 索引改名对齐 schema 默认命名（仅重命名，索引定义与行为不变）
ALTER INDEX "public"."house_name_unique_active" RENAME TO "house_name_key";
ALTER INDEX "public"."sys_user_username_unique_active" RENAME TO "sys_user_username_key";
ALTER INDEX "public"."teleport_name_unique_active" RENAME TO "teleport_name_key";
