ALTER TYPE "ImportDataType" ADD VALUE 'QIANCHUAN_SPEND';

CREATE TABLE "qianchuan_spend" (
  "id" UUID NOT NULL,
  "batch_id" UUID NOT NULL,
  "account_name" TEXT NOT NULL,
  "spend_date" DATE NOT NULL,
  "total_spend" DECIMAL(12,2),
  "non_gift_spend" DECIMAL(12,2),
  "gift_spend" DECIMAL(12,2),
  "red_packet_spend" DECIMAL(12,2),
  "discount_spend" DECIMAL(12,2),
  "shared_wallet_spend" DECIMAL(12,2),
  "shared_gift_spend" DECIMAL(12,2),
  "raw_data" JSONB NOT NULL,
  "row_number" INTEGER NOT NULL,
  "source_file_name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qianchuan_spend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "qianchuan_spend_batch_id_account_name_spend_date_key"
  ON "qianchuan_spend"("batch_id", "account_name", "spend_date");
CREATE INDEX "qianchuan_spend_account_name_spend_date_idx"
  ON "qianchuan_spend"("account_name", "spend_date");
CREATE INDEX "qianchuan_spend_batch_id_idx" ON "qianchuan_spend"("batch_id");
ALTER TABLE "qianchuan_spend"
  ADD CONSTRAINT "qianchuan_spend_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
