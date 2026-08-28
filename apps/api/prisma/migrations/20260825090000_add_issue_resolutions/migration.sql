-- CreateEnum
CREATE TYPE "IssueResolutionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'RESOLVED');

-- CreateTable
CREATE TABLE "order_issue_resolution" (
    "id" UUID NOT NULL,
    "issue_key" TEXT NOT NULL,
    "status" "IssueResolutionStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_issue_resolution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_issue_resolution_issue_key_key" ON "order_issue_resolution"("issue_key");
CREATE INDEX "order_issue_resolution_status_idx" ON "order_issue_resolution"("status");
