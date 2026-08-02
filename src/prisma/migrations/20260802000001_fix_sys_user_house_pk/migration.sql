-- 修复：恢复 sys_user_house 的 id 主键
-- schema 中 SysUserHouse 以 id 为主键（@@id），(house_id, sys_user_id) 仅为 @@unique
-- 表当前 0 行，无数据风险；唯一索引 sys_user_house_house_id_sys_user_id_key 已存在无需重建
ALTER TABLE "public"."sys_user_house" DROP CONSTRAINT "sys_user_house_pkey";
ALTER TABLE "public"."sys_user_house" ADD COLUMN "id" uuid NOT NULL;
ALTER TABLE "public"."sys_user_house" ADD CONSTRAINT "sys_user_house_pkey" PRIMARY KEY ("id");
