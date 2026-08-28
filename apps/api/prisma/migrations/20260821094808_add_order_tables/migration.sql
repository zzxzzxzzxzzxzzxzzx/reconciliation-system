-- CreateEnum
CREATE TYPE "OrderIssueType" AS ENUM ('SPLIT_AMBIGUOUS');

-- CreateTable
CREATE TABLE "shop_order" (
    "id" UUID NOT NULL,
    "main_order_no" TEXT NOT NULL,
    "status" TEXT,
    "pay_type" TEXT,
    "order_type" TEXT,
    "app_channel" TEXT,
    "payable_amount" DECIMAL(12,2),
    "merchant_income" DECIMAL(12,2),
    "total_product_amount" DECIMAL(12,2),
    "total_quantity" INTEGER,
    "submitted_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "promised_delivery_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "after_sale_status" TEXT,
    "cancel_reason" TEXT,
    "buyer_message" TEXT,
    "merchant_remark" TEXT,
    "influencer_id" TEXT,
    "influencer_nickname" TEXT,
    "traffic_source" TEXT,
    "traffic_channel" TEXT,
    "is_sample_order" TEXT,
    "is_channel_product" TEXT,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_file_name" TEXT NOT NULL,
    "raw_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sub_order_no" TEXT,
    "product_id" TEXT,
    "merchant_code" TEXT,
    "product_title" TEXT,
    "sku_code" TEXT,
    "quantity" INTEGER,
    "product_amount" DECIMAL(12,2),
    "item_index" INTEGER NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "source_file_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_issue" (
    "id" UUID NOT NULL,
    "issue_type" "OrderIssueType" NOT NULL,
    "main_order_no" TEXT,
    "order_id" UUID,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER,
    "source_file_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_issue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shop_order_batch_id_idx" ON "shop_order"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_order_main_order_no_key" ON "shop_order"("main_order_no");

-- CreateIndex
CREATE INDEX "order_item_product_id_idx" ON "order_item"("product_id");

-- CreateIndex
CREATE INDEX "order_item_merchant_code_idx" ON "order_item"("merchant_code");

-- CreateIndex
CREATE INDEX "order_item_batch_id_idx" ON "order_item"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_order_id_item_index_key" ON "order_item"("order_id", "item_index");

-- CreateIndex
CREATE INDEX "order_issue_issue_type_idx" ON "order_issue"("issue_type");

-- CreateIndex
CREATE INDEX "order_issue_batch_id_idx" ON "order_issue"("batch_id");

-- AddForeignKey
ALTER TABLE "shop_order" ADD CONSTRAINT "shop_order_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shop_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
