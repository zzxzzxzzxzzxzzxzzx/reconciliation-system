-- AlterEnum
ALTER TYPE "ImportDataType" ADD VALUE 'DOUYIN_LIVE';

-- AlterEnum
ALTER TYPE "OrderIssueType" ADD VALUE 'LIVE_SESSION_CONFLICT';
ALTER TYPE "OrderIssueType" ADD VALUE 'ORDER_TIME_MISSING';

-- CreateEnum
CREATE TYPE "OrderOwnershipType" AS ENUM ('SELF', 'INFLUENCER');

-- CreateEnum
CREATE TYPE "LiveMatchStatus" AS ENUM ('SELF_LIVE', 'SELF_NON_LIVE', 'INFLUENCER', 'CONFLICT', 'MISSING_ORDER_TIME');

-- AlterTable
ALTER TABLE "shop_order"
ADD COLUMN "ownership_type" "OrderOwnershipType",
ADD COLUMN "live_match_status" "LiveMatchStatus",
ADD COLUMN "live_session_id" UUID;

-- CreateTable
CREATE TABLE "live_session" (
    "id" UUID NOT NULL,
    "live_id" TEXT NOT NULL,
    "anchor_nickname" TEXT,
    "anchor_douyin_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" DECIMAL(10,2),
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_file_name" TEXT NOT NULL,
    "raw_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_session_live_id_key" ON "live_session"("live_id");
CREATE UNIQUE INDEX "live_session_batch_id_row_number_key" ON "live_session"("batch_id", "row_number");
CREATE INDEX "live_session_batch_id_idx" ON "live_session"("batch_id");
CREATE INDEX "live_session_started_at_ended_at_idx" ON "live_session"("started_at", "ended_at");
CREATE INDEX "shop_order_ownership_type_idx" ON "shop_order"("ownership_type");
CREATE INDEX "shop_order_live_match_status_idx" ON "shop_order"("live_match_status");
CREATE INDEX "shop_order_live_session_id_idx" ON "shop_order"("live_session_id");

-- AddForeignKey
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
