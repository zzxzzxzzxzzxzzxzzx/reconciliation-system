export type ReconciliationDataTarget =
  | 'orderBatchId'
  | 'settlementBatchId'
  | 'costBatchId'
  | 'liveBatchId';

export type ReconciliationSourceIssue = {
  id: string;
  issueType: string;
  mainOrderNo: string | null;
};

export const supplementDataTypeByTarget: Record<ReconciliationDataTarget, string> = {
  orderBatchId: 'DOUYIN_ORDER',
  settlementBatchId: 'DOUYIN_SETTLEMENT',
  costBatchId: 'DOUYIN_COST',
  liveBatchId: 'DOUYIN_LIVE',
};
