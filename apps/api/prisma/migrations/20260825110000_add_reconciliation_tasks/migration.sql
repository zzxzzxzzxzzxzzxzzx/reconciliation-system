-- CreateEnum
CREATE TYPE "ReconciliationTaskStatus" AS ENUM ('READY', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "reconciliation_task" (
    "id" UUID NOT NULL,
    "accounting_month" TEXT NOT NULL,
    "status" "ReconciliationTaskStatus" NOT NULL DEFAULT 'READY',
    "order_batch_id" UUID NOT NULL,
    "settlement_batch_id" UUID NOT NULL,
    "cost_batch_id" UUID,
    "live_batch_id" UUID,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_task_accounting_month_idx" ON "reconciliation_task"("accounting_month");
CREATE INDEX "reconciliation_task_status_idx" ON "reconciliation_task"("status");

-- AddForeignKey
ALTER TABLE "reconciliation_task" ADD CONSTRAINT "reconciliation_task_order_batch_id_fkey" FOREIGN KEY ("order_batch_id") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_task" ADD CONSTRAINT "reconciliation_task_settlement_batch_id_fkey" FOREIGN KEY ("settlement_batch_id") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_task" ADD CONSTRAINT "reconciliation_task_cost_batch_id_fkey" FOREIGN KEY ("cost_batch_id") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_task" ADD CONSTRAINT "reconciliation_task_live_batch_id_fkey" FOREIGN KEY ("live_batch_id") REFERENCES "import_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
