'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type SummaryMonth = {
  accountingMonth: string;
  taskCount: number;
  completedTaskCount: number;
  latestCompletedAt: string;
};

type Summary = {
  accountingMonth: string;
  taskCount: number;
  orderBatchId: string;
  sourceFileName: string;
  orderCount: number;
  itemCount: number;
  settledOrderCount: number;
  unsettledOrderCount: number;
  settlementRecordCount: number;
  settlementAmount: string;
  matchedCostItemCount: number;
  unmatchedCostItemCount: number;
  missingCostItemCount: number;
  conflictCostItemCount: number;
  completeCostOrderCount: number;
  incompleteCostOrderCount: number;
  totalCost: string;
  profitOrderCount: number;
  calculableProfit: string;
  normalOrderCount: number;
  issueCount: number;
  issueCounts: Record<string, number>;
  sourceFiles: string[];
  sourceBatchIds: string[];
  orderBatchIds: string[];
  settlementBatchIds: string[];
  costBatchIds: string[];
  liveBatchIds: string[];
};

const issueLabels: Record<string, string> = {
  SPLIT_AMBIGUOUS: '商品拆分待确认',
  PRODUCT_ID_MISSING: '商品 ID 缺失',
  PRODUCT_UNMATCHED: '商品无法匹配',
  COST_MISSING: '缺成本',
  COST_CONFLICT: '成本冲突',
  ORDER_WITHOUT_SETTLEMENT: '未结算',
  SETTLEMENT_WITHOUT_ORDER: '缺订单',
  CROSS_PERIOD_SETTLEMENT: '跨期结算',
  LIVE_SESSION_CONFLICT: '直播冲突',
  ORDER_TIME_MISSING: '缺少下单时间',
};

function formatAmount(value: string) {
  return `¥${Number(value).toFixed(2)}`;
}

async function errorMessage(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[] };
    return Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

type SummaryWorkspaceProps = {
  onOpenIssues: (batchId: string, issueType: string) => void;
};

export default function SummaryWorkspace({ onOpenIssues }: SummaryWorkspaceProps) {
  const [months, setMonths] = useState<SummaryMonth[]>([]);
  const [accountingMonth, setAccountingMonth] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSummary = useCallback(async (preferredMonth?: string) => {
    setLoading(true);
    setError(null);
    try {
      const monthsResponse = await fetch(`${API_BASE}/orders/summary-months`);
      if (!monthsResponse.ok) throw new Error(await errorMessage(monthsResponse));
      const availableMonths = await monthsResponse.json() as SummaryMonth[];
      const selectedMonth = availableMonths.find((month) => month.accountingMonth === preferredMonth)?.accountingMonth
        ?? availableMonths[0]?.accountingMonth;
      if (!selectedMonth) throw new Error('暂无已完成的对账任务');
      const summaryResponse = await fetch(`${API_BASE}/orders/monthly-summary?accountingMonth=${encodeURIComponent(selectedMonth)}`);
      if (!summaryResponse.ok) throw new Error(await errorMessage(summaryResponse));
      setMonths(availableMonths);
      setAccountingMonth(selectedMonth);
      setSummary(await summaryResponse.json() as Summary);
    } catch (loadError) {
      setSummary(null);
      setError(loadError instanceof Error ? loadError.message : '汇总加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSummary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary]);

  const issueRows = useMemo(() => Object.entries(summary?.issueCounts ?? {})
    .sort(([, countA], [, countB]) => countB - countA)
    .map(([type, count]) => ({ type, count, label: issueLabels[type] ?? type })), [summary]);

  return <section className="summary-workspace" aria-label="对账汇总">
    <div className="summary-heading"><div><span className="eyebrow">RECONCILIATION SUMMARY / DOUYIN</span><h2>对账汇总</h2><p>按结算月份查看已完成任务合并后的结算、成本、利润和问题分布。</p></div><button className="secondary-button" onClick={() => void loadSummary(accountingMonth)} disabled={loading}>{loading ? '加载中…' : '刷新汇总'}</button></div>
    <div className="summary-selector"><label><span>对账月份</span><select value={accountingMonth} onChange={(event) => void loadSummary(event.target.value)} disabled={loading || months.length === 0}>{months.map((month) => <option value={month.accountingMonth} key={month.accountingMonth}>{month.accountingMonth}（{month.completedTaskCount} 个已完成任务）</option>)}</select></label>{summary && <small>来源文件：{summary.sourceFiles.join('、')} · 来源批次 {summary.sourceBatchIds.join('、')}</small>}</div>
    {error && <div className="import-error">{error}</div>}
    {loading && !summary && <div className="summary-loading">正在读取当前订单批次…</div>}
    {summary && <>
      <div className="summary-metric-grid">
        <article className="metric-card accent"><span>订单总数</span><strong>{summary.orderCount}</strong><small>{summary.itemCount} 条商品明细</small></article>
        <article className="metric-card"><span>总结算金额</span><strong>{formatAmount(summary.settlementAmount)}</strong><small>{summary.settledOrderCount} 个订单已结算 · {summary.settlementRecordCount} 条记录</small></article>
        <article className="metric-card"><span>总成本</span><strong>{formatAmount(summary.totalCost)}</strong><small>{summary.completeCostOrderCount} 个订单成本完整</small></article>
        <article className="metric-card"><span>可计算利润</span><strong className={summary.profitOrderCount ? 'profit-value' : 'muted-value'}>{summary.profitOrderCount ? formatAmount(summary.calculableProfit) : '暂不可计算'}</strong><small>{summary.profitOrderCount} 个订单同时有结算和完整成本</small></article>
      </div>
      <div className="summary-columns">
        <section className="summary-section"><div className="section-heading"><h3>处理进度</h3><span>{summary.normalOrderCount} 个订单当前无问题</span></div><div className="progress-list"><div><span>已结算订单</span><b>{summary.settledOrderCount} / {summary.orderCount}</b><i><em style={{ width: `${summary.orderCount ? (summary.settledOrderCount / summary.orderCount) * 100 : 0}%` }} /></i></div><div><span>成本完整订单</span><b>{summary.completeCostOrderCount} / {summary.orderCount}</b><i><em style={{ width: `${summary.orderCount ? (summary.completeCostOrderCount / summary.orderCount) * 100 : 0}%` }} /></i></div><div><span>可计算利润订单</span><b>{summary.profitOrderCount} / {summary.orderCount}</b><i><em style={{ width: `${summary.orderCount ? (summary.profitOrderCount / summary.orderCount) * 100 : 0}%` }} /></i></div></div></section>
        <section className="summary-section"><div className="section-heading"><h3>商品成本状态</h3><span>{summary.matchedCostItemCount} 条已匹配</span></div><div className="summary-breakdown"><div><span>已匹配</span><strong className="success-text">{summary.matchedCostItemCount}</strong></div><div><span>缺成本</span><strong className="warning-text">{summary.missingCostItemCount}</strong></div><div><span>成本冲突</span><strong className="danger-text">{summary.conflictCostItemCount}</strong></div><div><span>尚未匹配</span><strong>{summary.unmatchedCostItemCount}</strong></div></div></section>
      </div>
      <section className="summary-section issue-section"><div className="section-heading"><div><h3>问题分布</h3><p>问题订单不会自动按 0 元成本或 0 元利润计算，点击问题可查看明细。</p></div><strong>{summary.issueCount} 条</strong></div>{issueRows.length ? <div className="issue-breakdown">{issueRows.map((row) => <button type="button" key={row.type} onClick={() => onOpenIssues(summary.orderBatchId, row.type)}><span>{row.label}</span><b>{row.count}</b></button>)}</div> : <p className="empty">该月份没有发现问题</p>}</section>
    </>}
  </section>;
}
