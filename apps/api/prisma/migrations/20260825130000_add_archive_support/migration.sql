ALTER TABLE "import_batch" ADD COLUMN "archived_at" TIMESTAMP(3);
ALTER TABLE "reconciliation_task" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "import_batch_archived_at_idx" ON "import_batch"("archived_at");
CREATE INDEX "reconciliation_task_archived_at_idx" ON "reconciliation_task"("archived_at");
