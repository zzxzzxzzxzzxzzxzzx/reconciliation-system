ALTER TABLE "reconciliation_task"
ADD COLUMN "source_issue_key" TEXT,
ADD COLUMN "source_issue_type" "OrderIssueType",
ADD COLUMN "source_issue_order_no" TEXT,
ADD COLUMN "supplement_target" "ImportDataType";

CREATE INDEX "reconciliation_task_source_issue_key_idx"
ON "reconciliation_task"("source_issue_key");
