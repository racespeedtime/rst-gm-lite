-- 赛车回放索引表：元数据存库，录像数据本体存文件（scriptfiles/recordings/）
-- 玩家 uid 稳定；其余展示信息（玩家名/赛道名/爱车模型/名次）在录制结束时
-- 快照落库——这些字段可能随时间变化（改名/删赛道/换车），快照保证回放列表
-- 永远显示录制当时的信息。删除采用软删（deleted_at），文件随之清理。

CREATE TABLE "replay" (
    "id" uuid NOT NULL,
    "type" varchar(16) NOT NULL,
    "user_id" uuid NOT NULL,
    "recorder_name" varchar(255) NOT NULL,
    "race_id" uuid,
    "race_name" varchar(255),
    "vehicle_model_id" integer NOT NULL,
    "file_name" varchar(255) NOT NULL,
    "duration_ms" integer NOT NULL,
    "frame_count" integer NOT NULL,
    "file_size" integer NOT NULL,
    "rank" integer,
    "finished" boolean,
    "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" timestamptz(6),
    CONSTRAINT "replay_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "replay_user_id_idx" ON "replay"("user_id");
CREATE INDEX "replay_deleted_at_idx" ON "replay"("deleted_at");

ALTER TABLE "replay" ADD CONSTRAINT "replay_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
