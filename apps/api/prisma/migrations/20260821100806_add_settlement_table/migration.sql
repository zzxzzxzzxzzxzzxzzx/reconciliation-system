-- AlterEnum
ALTER TYPE "ImportDataType" ADD VALUE 'DOUYIN_SETTLEMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderIssueType" ADD VALUE 'SETTLEMENT_WITHOUT_ORDER';
ALTER TYPE "OrderIssueType" ADD VALUE 'ORDER_WITHOUT_SETTLEMENT';

-- CreateTable
CREATE TABLE "settlement" (
    "id" UUID NOT NULL,
    "order_no_fixed" TEXT NOT NULL,
    "sub_order_no_fixed" TEXT,
    "settled_at" TIMESTAMP(3),
    "amount" DECIMAL(12,2) NOT NULL,
    "account" TEXT,
    "settlement_type" TEXT,
    "has_refund_before" TEXT,
    "ordered_at" TIMESTAMP(3),
    "product_id" TEXT,
    "product_name" TEXT,
    "product_quantity" INTEGER,
    "influencer_id" TEXT,
    "influencer_name" TEXT,
    "business_type" TEXT,
    "order_type" TEXT,
    "order_total_price" DECIMAL(12,2),
    "product_total_price" DECIMAL(12,2),
    "shipping_fee" DECIMAL(12,2),
    "income_total" DECIMAL(12,2),
    "expense_total" DECIMAL(12,2),
    "platform_service_fee" DECIMAL(12,2),
    "influencer_commission" DECIMAL(12,2),
    "merchant_entity" TEXT,
    "app_channel" TEXT,
    "remark" TEXT,
    "order_id" UUID,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_file_name" TEXT NOT NULL,
    "raw_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_order_no_fixed_idx" ON "settlement"("order_no_fixed");

-- CreateIndex
CREATE INDEX "settlement_order_id_idx" ON "settlement"("order_id");

-- CreateIndex
CREATE INDEX "settlement_batch_id_idx" ON "settlement"("batch_id");

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
