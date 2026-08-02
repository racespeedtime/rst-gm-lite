-- 以 schema.prisma 为基准对齐数据库结构
-- 1. 删除 schema 中不存在的多余字段（交易/审核/奖励相关，精简方向）
-- 2. 重建 sys_user_house 主键为复合主键 (house_id, sys_user_id)
-- 3. 创建 schema 中存在但数据库缺失的 sys_user_game_session 表
-- 注意：仅 DROP COLUMN / 重建约束 / 建新表，不做任何清表、重置操作，保留全部数据。

-- attire.price
ALTER TABLE "public"."attire" DROP COLUMN "price";

-- house.status
ALTER TABLE "public"."house" DROP COLUMN "status";

-- race.status
ALTER TABLE "public"."race" DROP COLUMN "status";

-- race_record.reward_cash / reward_exp
ALTER TABLE "public"."race_record" DROP COLUMN "reward_cash";
ALTER TABLE "public"."race_record" DROP COLUMN "reward_exp";

-- sys_user_house: 删除 id 主键及交易字段，重建复合主键
ALTER TABLE "public"."sys_user_house" DROP CONSTRAINT "sys_user_house_pkey";
ALTER TABLE "public"."sys_user_house" DROP COLUMN "id";
ALTER TABLE "public"."sys_user_house" DROP COLUMN "is_sale";
ALTER TABLE "public"."sys_user_house" DROP COLUMN "sale_price";
ALTER TABLE "public"."sys_user_house" ADD CONSTRAINT "sys_user_house_pkey" PRIMARY KEY ("house_id", "sys_user_id");

-- sys_user_vehicle_attire.purchase_price
ALTER TABLE "public"."sys_user_vehicle_attire" DROP COLUMN "purchase_price";

-- user_vehicle.purchase_price / is_sale / sale_price
ALTER TABLE "public"."user_vehicle" DROP COLUMN "purchase_price";
ALTER TABLE "public"."user_vehicle" DROP COLUMN "is_sale";
ALTER TABLE "public"."user_vehicle" DROP COLUMN "sale_price";

-- vehicle_catalog.price
ALTER TABLE "public"."vehicle_catalog" DROP COLUMN "price";

-- 创建 sys_user_game_session 表
CREATE TABLE "sys_user_game_session" (
    "id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "login_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logout_at" timestamptz(6),
    "last_heartbeat_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "online_exp_rewarded_at" timestamptz(6),
    "status" varchar(10) NOT NULL DEFAULT 'ONLINE'::character varying,
    "duration" integer,
    "ip" varchar(45),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "sys_user_game_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sys_user_game_session_user_id_idx" ON "sys_user_game_session"("user_id");
CREATE INDEX "sys_user_game_session_status_last_heartbeat_at_idx" ON "sys_user_game_session"("status", "last_heartbeat_at");

ALTER TABLE "sys_user_game_session" ADD CONSTRAINT "sys_user_game_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
