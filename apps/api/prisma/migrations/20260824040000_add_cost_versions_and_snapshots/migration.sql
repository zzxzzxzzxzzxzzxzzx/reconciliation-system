-- AlterEnum
ALTER TYPE "ImportDataType" ADD VALUE 'DOUYIN_COST';

-- AlterEnum
ALTER TYPE "OrderIssueType" ADD VALUE 'COST_MISSING';
ALTER TYPE "OrderIssueType" ADD VALUE 'COST_CONFLICT';

-- CreateEnum
CREATE TYPE "CostVersionStatus" AS ENUM ('PENDING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "CostSnapshotStatus" AS ENUM ('PENDING_VERSION', 'MATCHED', 'MISSING', 'CONFLICT');

-- CreateTable
CREATE TABLE "cost_version" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "status" "CostVersionStatus" NOT NULL DEFAULT 'PENDING',
    "effective_from" TIMESTAMP(3),
    "source_file_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_cost" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "product_id" TEXT NOT NULL,
    "merchant_code" TEXT NOT NULL DEFAULT '',
    "composite_key" TEXT NOT NULL,
    "product_name" TEXT,
    "unit_cost" DECIMAL(12,2),
    "remark" TEXT,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_cost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_cost_snapshot" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "product_cost_id" UUID,
    "status" "CostSnapshotStatus" NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "quantity" INTEGER,
    "total_cost" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_cost_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_version_batch_id_key" ON "cost_version"("batch_id");

-- CreateIndex
CREATE INDEX "product_cost_version_id_composite_key_idx" ON "product_cost"("version_id", "composite_key");

-- CreateIndex
CREATE INDEX "product_cost_product_id_merchant_code_idx" ON "product_cost"("product_id", "merchant_code");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_cost_snapshot_order_item_id_key" ON "order_item_cost_snapshot"("order_item_id");

-- CreateIndex
CREATE INDEX "order_item_cost_snapshot_version_id_idx" ON "order_item_cost_snapshot"("version_id");

-- CreateIndex
CREATE INDEX "order_item_cost_snapshot_status_idx" ON "order_item_cost_snapshot"("status");

-- AddForeignKey
ALTER TABLE "cost_version" ADD CONSTRAINT "cost_version_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_cost" ADD CONSTRAINT "product_cost_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "cost_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_cost_snapshot" ADD CONSTRAINT "order_item_cost_snapshot_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_cost_snapshot" ADD CONSTRAINT "order_item_cost_snapshot_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "cost_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_cost_snapshot" ADD CONSTRAINT "order_item_cost_snapshot_product_cost_id_fkey" FOREIGN KEY ("product_cost_id") REFERENCES "product_cost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
