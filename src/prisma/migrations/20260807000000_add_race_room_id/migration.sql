-- AlterTable
ALTER TABLE "replay" ADD COLUMN     "race_room_id" INTEGER;

-- CreateIndex
CREATE INDEX "replay_race_room_id_idx" ON "replay"("race_room_id");
