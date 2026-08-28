-- CreateEnum
CREATE TYPE "ImportDataType" AS ENUM ('DOUYIN_ORDER');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "import_batch" (
    "id" UUID NOT NULL,
    "data_type" "ImportDataType" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "source_file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "success_rows" INTEGER NOT NULL DEFAULT 0,
    "failed_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "import_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_record" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_error" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "raw_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_error_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_batch_data_type_file_hash_key" ON "import_batch"("data_type", "file_hash");

-- CreateIndex
CREATE INDEX "raw_record_batch_id_idx" ON "raw_record"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "raw_record_batch_id_row_number_key" ON "raw_record"("batch_id", "row_number");

-- CreateIndex
CREATE INDEX "import_error_batch_id_idx" ON "import_error"("batch_id");

-- AddForeignKey
ALTER TABLE "raw_record" ADD CONSTRAINT "raw_record_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_error" ADD CONSTRAINT "import_error_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
