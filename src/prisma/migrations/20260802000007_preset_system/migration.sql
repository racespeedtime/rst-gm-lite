-- 预设系统迁移：玩家装扮 / 车辆装扮引入"预设"概念
-- 结构：资产（去重拥有）+ 预设（每模型最多3套）+ 预设条目（装配明细）
-- 1. 新建 4 张预设表
-- 2. 玩家侧：为有装扮的用户建 1 套默认预设，资产去重，坐标迁入条目表
-- 3. 车辆侧：每用户每模型保留 1 辆车（挂件最多者），有挂件的车各生成一套预设，挂件迁入条目表
-- 4. 补充默认预设引用字段与唯一约束

-- ==================== DDL：新表 ====================

CREATE TABLE "player_preset" (
    "id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "skin_id" integer NOT NULL DEFAULT 0,
    "index" integer NOT NULL DEFAULT 0,
    "name" varchar(255),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    "deleted_at" timestamptz(6),
    CONSTRAINT "player_preset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "player_preset_user_id_idx" ON "player_preset"("user_id");
CREATE INDEX "player_preset_deleted_at_idx" ON "player_preset"("deleted_at");
CREATE UNIQUE INDEX "player_preset_user_id_skin_id_index_key" ON "player_preset"("user_id", "skin_id", "index");

ALTER TABLE "player_preset" ADD CONSTRAINT "player_preset_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "player_preset_item" (
    "id" uuid NOT NULL,
    "preset_id" uuid NOT NULL,
    "sys_user_attire_id" uuid NOT NULL,
    "bone_id" integer NOT NULL,
    "x" numeric(18,6) NOT NULL,
    "y" numeric(18,6) NOT NULL,
    "z" numeric(18,6) NOT NULL,
    "r_x" numeric(18,6) NOT NULL,
    "r_y" numeric(18,6) NOT NULL,
    "r_z" numeric(18,6) NOT NULL,
    "s_x" numeric(18,6) NOT NULL,
    "s_y" numeric(18,6) NOT NULL,
    "s_z" numeric(18,6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "player_preset_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "player_preset_item_preset_id_idx" ON "player_preset_item"("preset_id");
CREATE INDEX "player_preset_item_sys_user_attire_id_idx" ON "player_preset_item"("sys_user_attire_id");
CREATE UNIQUE INDEX "player_preset_item_preset_id_sys_user_attire_id_key" ON "player_preset_item"("preset_id", "sys_user_attire_id");

ALTER TABLE "player_preset_item" ADD CONSTRAINT "player_preset_item_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "player_preset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "player_preset_item" ADD CONSTRAINT "player_preset_item_sys_user_attire_id_fkey" FOREIGN KEY ("sys_user_attire_id") REFERENCES "sys_user_attire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "vehicle_preset" (
    "id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "vehicle_catalog_id" uuid NOT NULL,
    "index" integer NOT NULL DEFAULT 0,
    "name" varchar(255),
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    "deleted_at" timestamptz(6),
    CONSTRAINT "vehicle_preset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_preset_user_id_idx" ON "vehicle_preset"("user_id");
CREATE INDEX "vehicle_preset_vehicle_catalog_id_idx" ON "vehicle_preset"("vehicle_catalog_id");
CREATE INDEX "vehicle_preset_deleted_at_idx" ON "vehicle_preset"("deleted_at");
CREATE UNIQUE INDEX "vehicle_preset_user_id_vehicle_catalog_id_index_key" ON "vehicle_preset"("user_id", "vehicle_catalog_id", "index");

ALTER TABLE "vehicle_preset" ADD CONSTRAINT "vehicle_preset_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_preset" ADD CONSTRAINT "vehicle_preset_vehicle_catalog_id_fkey" FOREIGN KEY ("vehicle_catalog_id") REFERENCES "vehicle_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "vehicle_preset_item" (
    "id" uuid NOT NULL,
    "preset_id" uuid NOT NULL,
    "sys_user_vehicle_attire_id" uuid NOT NULL,
    "slot_id" integer NOT NULL,
    "x" numeric(18,6) NOT NULL,
    "y" numeric(18,6) NOT NULL,
    "z" numeric(18,6) NOT NULL,
    "r_x" numeric(18,6) NOT NULL,
    "r_y" numeric(18,6) NOT NULL,
    "r_z" numeric(18,6) NOT NULL,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamptz(6) NOT NULL,
    CONSTRAINT "vehicle_preset_item_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vehicle_preset_item_preset_id_idx" ON "vehicle_preset_item"("preset_id");
CREATE INDEX "vehicle_preset_item_sys_user_vehicle_attire_id_idx" ON "vehicle_preset_item"("sys_user_vehicle_attire_id");
CREATE UNIQUE INDEX "vehicle_preset_item_preset_id_slot_id_key" ON "vehicle_preset_item"("preset_id", "slot_id");

ALTER TABLE "vehicle_preset_item" ADD CONSTRAINT "vehicle_preset_item_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "vehicle_preset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_preset_item" ADD CONSTRAINT "vehicle_preset_item_sys_user_vehicle_attire_id_fkey" FOREIGN KEY ("sys_user_vehicle_attire_id") REFERENCES "sys_user_vehicle_attire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ==================== 玩家侧数据迁移 ====================

-- 1. 为有角色装扮的用户各建 1 套默认预设（index=0，skinId 取 sys_user_setting，缺失补 0）
INSERT INTO "player_preset" ("id", "user_id", "skin_id", "index", "name", "created_at", "updated_at")
SELECT gen_random_uuid(), sua.user_id, COALESCE(sus.skin_id, 0), 0, '预设1', now(), now()
FROM (SELECT DISTINCT user_id FROM sys_user_attire) sua
LEFT JOIN sys_user_setting sus ON sus.user_id = sua.user_id;

-- 2. sys_user_attire 资产去重：同一 (user, attire) 保留一条（优先 is_enabled=true，其次最小 id）
DELETE FROM sys_user_attire a
USING sys_user_attire b
WHERE a.user_id = b.user_id
  AND a.attire_id = b.attire_id
  AND (a.is_enabled < b.is_enabled OR (a.is_enabled = b.is_enabled AND a.id > b.id));

-- 3. 每条资产生成 1 条预设条目（迁移 boneId + 坐标），挂到该用户 index=0 预设
INSERT INTO "player_preset_item" ("id", "preset_id", "sys_user_attire_id", "bone_id", "x", "y", "z", "r_x", "r_y", "r_z", "s_x", "s_y", "s_z", "created_at", "updated_at")
SELECT gen_random_uuid(), pp.id, sua.id, sua.bone_id, sua.x, sua.y, sua.z, sua.r_x, sua.r_y, sua.r_z, sua.s_x, sua.s_y, sua.s_z, now(), now()
FROM sys_user_attire sua
JOIN player_preset pp ON pp.user_id = sua.user_id AND pp.index = 0;

-- 4. sys_user_attire 删除装配列，仅保留资产属性
ALTER TABLE "sys_user_attire" DROP COLUMN "bone_id";
ALTER TABLE "sys_user_attire" DROP COLUMN "x";
ALTER TABLE "sys_user_attire" DROP COLUMN "y";
ALTER TABLE "sys_user_attire" DROP COLUMN "z";
ALTER TABLE "sys_user_attire" DROP COLUMN "r_x";
ALTER TABLE "sys_user_attire" DROP COLUMN "r_y";
ALTER TABLE "sys_user_attire" DROP COLUMN "r_z";
ALTER TABLE "sys_user_attire" DROP COLUMN "s_x";
ALTER TABLE "sys_user_attire" DROP COLUMN "s_y";
ALTER TABLE "sys_user_attire" DROP COLUMN "s_z";

-- 5. 资产唯一约束（去重后满足）
CREATE UNIQUE INDEX "sys_user_attire_attire_id_user_id_key" ON "sys_user_attire"("attire_id", "user_id");

-- 6. sys_user_setting 补充默认预设引用
ALTER TABLE "sys_user_setting" ADD COLUMN "default_player_preset_id" uuid;
CREATE INDEX "sys_user_setting_default_player_preset_id_idx" ON "sys_user_setting"("default_player_preset_id");
ALTER TABLE "sys_user_setting" ADD CONSTRAINT "sys_user_setting_default_player_preset_id_fkey" FOREIGN KEY ("default_player_preset_id") REFERENCES "player_preset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
UPDATE "sys_user_setting" sus
SET "default_player_preset_id" = pp.id
FROM "player_preset" pp
WHERE pp.user_id = sus.user_id AND pp.index = 0;

-- ==================== 车辆侧数据迁移 ====================

-- 7. 建临时映射：每辆有挂件的车 → 预设 index（组内按挂件数降序、车 id 升序编号）
CREATE TEMP TABLE _vp_map AS
SELECT uv.id AS user_vehicle_id, uv.user_id, uv.vehicle_catalog_id,
       x.rn, gen_random_uuid() AS preset_id
FROM (
  SELECT uv2.id, uv2.user_id, uv2.vehicle_catalog_id,
         row_number() OVER (
           PARTITION BY uv2.user_id, uv2.vehicle_catalog_id
           ORDER BY COUNT(va.id) DESC, uv2.id ASC
         ) AS rn
  FROM user_vehicle uv2
  LEFT JOIN vehicle_attachment va ON va.user_vehicle_id = uv2.id
  GROUP BY uv2.id, uv2.user_id, uv2.vehicle_catalog_id
  HAVING COUNT(va.id) > 0
) x
JOIN user_vehicle uv ON uv.id = x.id;

-- 8. 生成车辆预设（每辆有挂件的车一套，index 从 0 起）
INSERT INTO "vehicle_preset" ("id", "user_id", "vehicle_catalog_id", "index", "name", "created_at", "updated_at")
SELECT preset_id, user_id, vehicle_catalog_id, rn - 1, '预设' || rn, now(), now()
FROM _vp_map;

-- 9. 挂件迁入车辆预设条目（slot + 坐标）
INSERT INTO "vehicle_preset_item" ("id", "preset_id", "sys_user_vehicle_attire_id", "slot_id", "x", "y", "z", "r_x", "r_y", "r_z", "created_at", "updated_at")
SELECT gen_random_uuid(), m.preset_id, va.sys_user_vehicle_attire_id, va.slot_id, va.x, va.y, va.z, va.r_x, va.r_y, va.r_z, now(), now()
FROM vehicle_attachment va
JOIN _vp_map m ON m.user_vehicle_id = va.user_vehicle_id;

-- 10. 删除多余车辆：每个 (user, catalog) 仅保留挂件最多的一辆（并列取最小 id），其余删除（其挂件已迁入预设条目）
DELETE FROM user_vehicle uv
WHERE uv.id IN (
  SELECT t.id FROM (
    SELECT uv2.id,
           row_number() OVER (
             PARTITION BY uv2.user_id, uv2.vehicle_catalog_id
             ORDER BY COUNT(va.id) DESC, uv2.id ASC
           ) AS rn
    FROM user_vehicle uv2
    LEFT JOIN vehicle_attachment va ON va.user_vehicle_id = uv2.id
    GROUP BY uv2.id, uv2.user_id, uv2.vehicle_catalog_id
  ) t
  WHERE t.rn > 1
);

-- 11. user_vehicle 补充默认预设引用（保留车 → 该模型 index=0 的预设，即挂件最多的那套）
ALTER TABLE "user_vehicle" ADD COLUMN "default_preset_id" uuid;
CREATE INDEX "user_vehicle_default_preset_id_idx" ON "user_vehicle"("default_preset_id");
ALTER TABLE "user_vehicle" ADD CONSTRAINT "user_vehicle_default_preset_id_fkey" FOREIGN KEY ("default_preset_id") REFERENCES "vehicle_preset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
UPDATE "user_vehicle" uv
SET "default_preset_id" = vp.id
FROM "vehicle_preset" vp
WHERE vp.user_id = uv.user_id AND vp.vehicle_catalog_id = uv.vehicle_catalog_id AND vp.index = 0;

-- 12. 车辆资产去重 + 唯一约束
DELETE FROM sys_user_vehicle_attire a
USING sys_user_vehicle_attire b
WHERE a.user_id = b.user_id
  AND a.attire_id = b.attire_id
  AND a.id > b.id;
CREATE UNIQUE INDEX "sys_user_vehicle_attire_attire_id_user_id_key" ON "sys_user_vehicle_attire"("attire_id", "user_id");

-- 13. 每用户每模型最多一辆车 硬约束
CREATE UNIQUE INDEX "user_vehicle_user_id_vehicle_catalog_id_key" ON "user_vehicle"("user_id", "vehicle_catalog_id");

-- 14. 废弃历史挂载表（数据已迁入 vehicle_preset_item）
DROP TABLE "vehicle_attachment";

DROP TABLE _vp_map;
