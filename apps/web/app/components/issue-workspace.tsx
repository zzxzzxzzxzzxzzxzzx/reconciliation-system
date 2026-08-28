'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReconciliationDataTarget, ReconciliationSourceIssue } from './reconciliation-data-target';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type Batch = {
  id: string;
  sourceFileName: string;
  successRows: number;
  status: string;
  createdAt: string;
  _count?: { orders?: number };
};

export type Issue = {
  id: string;
  issueType: string;
  mainOrderNo: string | null;
  orderId?: string | null;
  orderAvailable: boolean;
  availableOrderBatchId: string | null;
  availableOrderSourceFileName: string | null;
  message: string;
  detail?: unknown;
  batchId: string;
  rowNumber: number | null;
  sourceFileName: string | null;
  createdAt: string;
  resolutionStatus: 'PENDING' | 'NEEDS_DATA' | 'CONFIRMED' | 'RESOLVED';
  resolutionNote: string | null;
  resolvedAt: string | null;
  sourceRecord?: { batchId: string; rowNumber: number; sourceFileName: string | null; rawData: unknown } | null;
  supplementTasks: Array<{
    id: string;
    accountingMonth: string;
    status: 'READY' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    supplementTarget: string | null;
    createdAt: string;
    archivedAt: string | null;
    orderBatch: { id: string; sourceFileName: string };
    settlementBatch: { id: string; sourceFileName: string };
  }>;
};

type IssueWorkspaceProps = {
  initialBatchId?: string;
  initialIssueType?: string;
  onOpenOrder: (orderNo: string) => Promise<boolean>;
  onOpenTasks: (
    orderBatchId: string,
    target: ReconciliationDataTarget,
    sourceIssue?: ReconciliationSourceIssue,
    taskId?: string,
  ) => void;
  onViewTaskResults: (result: { orderBatchId: string; settlementBatchId: string }) => void;
};

type IssueAction = {
  label: string;
  target: ReconciliationDataTarget;
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

const issueDescriptions: Record<string, string> = {
  PRODUCT_ID_MISSING: '订单商品没有商品 ID，无法与成本表建立匹配。',
  PRODUCT_UNMATCHED: '商品 ID 和商家编码在成本表中没有唯一匹配记录。',
  COST_MISSING: '成本表未找到可匹配的商品记录，利润暂不计算。',
  COST_CONFLICT: '成本表存在多条可能匹配的记录，需要检查商品编码或成本表。',
  ORDER_WITHOUT_SETTLEMENT: '订单暂时没有找到对应的结算记录。',
  SETTLEMENT_WITHOUT_ORDER: '结算记录没有找到对应的订单。',
  SPLIT_AMBIGUOUS: '订单商品明细无法可靠拆分，需要查看原始数据。',
  CROSS_PERIOD_SETTLEMENT: '结算时间与订单时间不在同一期间，请确认是否属于跨期结算。',
  LIVE_SESSION_CONFLICT: '订单同时匹配到多个直播场次。',
  ORDER_TIME_MISSING: '订单缺少下单时间，暂时无法判断直播归属。',
};

const resolutionLabels: Record<Issue['resolutionStatus'], string> = {
  PENDING: '待处理',
  NEEDS_DATA: '待补订单数据',
  CONFIRMED: '已确认',
  RESOLVED: '已解决',
};

const taskStatusLabels: Record<Issue['supplementTasks'][number]['status'], string> = {
  READY: '待运行',
  PROCESSING: '处理中',
  COMPLETED: '已完成',
  FAILED: '失败',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

async function errorMessage(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[] };
    return Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function detailText(detail: unknown) {
  if (detail === null || detail === undefined) return '系统没有记录额外匹配信息。';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function getIssueAction(issueType: string): IssueAction | null {
  switch (issueType) {
    case 'COST_MISSING':
    case 'PRODUCT_UNMATCHED':
      return { label: '补充成本表', target: 'costBatchId' };
    case 'COST_CONFLICT':
      return { label: '补充或修正成本表', target: 'costBatchId' };
    case 'ORDER_WITHOUT_SETTLEMENT':
      return { label: '补充结算表', target: 'settlementBatchId' };
    case 'SETTLEMENT_WITHOUT_ORDER':
    case 'PRODUCT_ID_MISSING':
    case 'ORDER_TIME_MISSING':
    case 'SPLIT_AMBIGUOUS':
      return { label: '补充订单表', target: 'orderBatchId' };
    case 'LIVE_SESSION_CONFLICT':
      return { label: '补充直播表', target: 'liveBatchId' };
    default:
      return null;
  }
}

export default function IssueWorkspace({ initialBatchId, initialIssueType, onOpenOrder, onOpenTasks, onViewTaskResults }: IssueWorkspaceProps) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState(initialBatchId ?? '');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueType, setIssueType] = useState(initialIssueType ?? 'ALL');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Issue | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingOrderId, setOpeningOrderId] = useState<string | null>(null);
  const [orderOpenError, setOrderOpenError] = useState<string | null>(null);
  const [resolutionFilter, setResolutionFilter] = useState('ALL');
  const [draftStatus, setDraftStatus] = useState<Issue['resolutionStatus']>('PENDING');
  const [draftNote, setDraftNote] = useState('');
  const [savingResolution, setSavingResolution] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadIssues = useCallback(async (preferredBatchId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const batchResponse = await fetch(`${API_BASE}/imports?dataType=DOUYIN_ORDER`);
      if (!batchResponse.ok) throw new Error(await errorMessage(batchResponse));
      const availableBatches = (await batchResponse.json() as Batch[]).filter((batch) => batch.status !== 'FAILED' && batch.successRows > 0 && (batch._count?.orders ?? 0) > 0);
      const selectedId = availableBatches.some((batch) => batch.id === preferredBatchId)
        ? preferredBatchId
        : availableBatches.slice().sort((a, b) => b.successRows - a.successRows || b.createdAt.localeCompare(a.createdAt))[0]?.id;
      if (!selectedId) throw new Error('没有可用的订单批次');
      const issueResponse = await fetch(`${API_BASE}/orders/issues?orderBatchId=${encodeURIComponent(selectedId)}`);
      if (!issueResponse.ok) throw new Error(await errorMessage(issueResponse));
      setBatches(availableBatches);
      setBatchId(selectedId);
      setIssues(await issueResponse.json() as Issue[]);
      setPage(1);
      setSelected(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '异常清单加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadIssues(initialBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [initialBatchId, loadIssues]);

  const issueCounts = useMemo(() => issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.issueType] = (counts[issue.issueType] ?? 0) + 1;
    return counts;
  }, {}), [issues]);
  const filteredIssues = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return issues.filter((issue) => {
      const matchesType = issueType === 'ALL' || issue.issueType === issueType;
      const matchesResolution = resolutionFilter === 'ALL' || issue.resolutionStatus === resolutionFilter;
      const matchesQuery = !normalizedQuery
        || issue.mainOrderNo?.toLowerCase().includes(normalizedQuery)
        || issue.message.toLowerCase().includes(normalizedQuery)
        || issue.sourceFileName?.toLowerCase().includes(normalizedQuery);
      return matchesType && matchesResolution && matchesQuery;
    });
  }, [issueType, issues, query, resolutionFilter]);
  const totalPages = Math.max(1, Math.ceil(filteredIssues.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const visibleIssues = filteredIssues.slice(pageStart, pageStart + pageSize);
  const visiblePageNumbers = Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
    const firstPage = Math.min(Math.max(1, safePage - 2), Math.max(1, totalPages - 4));
    return firstPage + index;
  });
  const issueOptions = Object.entries(issueLabels).filter(([type]) => issueCounts[type]);
  const selectedBatch = batches.find((batch) => batch.id === batchId);
  const costIssueCount = (issueCounts.COST_MISSING ?? 0) + (issueCounts.COST_CONFLICT ?? 0);
  const selectedIssueAction = selected ? getIssueAction(selected.issueType) : null;
  const latestSupplementTask = selected?.supplementTasks[0] ?? null;
  const pendingIssueCount = issues.filter((issue) => issue.resolutionStatus === 'PENDING' || issue.resolutionStatus === 'NEEDS_DATA').length;

  function openIssue(issue: Issue) {
    setSelected(issue);
    setOrderOpenError(null);
    setDraftStatus(issue.resolutionStatus);
    setDraftNote(issue.resolutionNote ?? '');
    setSaveMessage(null);
  }

  async function saveResolution(
    status = draftStatus,
    note = draftNote,
  ) {
    if (!selected) return;
    setSavingResolution(true);
    setError(null);
    setSaveMessage(null);
    try {
      const response = await fetch(`${API_BASE}/orders/issues/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const saved = await response.json() as { resolutionStatus: Issue['resolutionStatus']; resolutionNote: string | null; resolvedAt: string | null };
      const updatedIssue = { ...selected, ...saved };
      setSelected(updatedIssue);
      setIssues((current) => current.map((issue) => issue.id === selected.id ? updatedIssue : issue));
      setDraftStatus(saved.resolutionStatus);
      setDraftNote(saved.resolutionNote ?? '');
      setSaveMessage('处理结果已保存');
      window.setTimeout(() => setSaveMessage(null), 3000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '异常处理保存失败');
    } finally {
      setSavingResolution(false);
    }
  }

  async function openOrder(issue: Issue) {
    if (!issue.mainOrderNo) {
      openIssue(issue);
      return;
    }

    setOpeningOrderId(issue.id);
    setOrderOpenError(null);
    const opened = await onOpenOrder(issue.mainOrderNo);
    setOpeningOrderId(null);
    if (opened) {
      setSelected(null);
      return;
    }

    setSelected(issue);
    setOrderOpenError('已查询全部已导入订单批次，仍未找到对应订单。请导入包含该订单的订单表后重新匹配。');
  }

  async function exportIssues() {
    if (!batchId || filteredIssues.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams({ orderBatchId: batchId });
      if (issueType !== 'ALL') params.set('issueType', issueType);
      if (resolutionFilter !== 'ALL') params.set('status', resolutionFilter);
      if (query.trim()) params.set('query', query.trim());
      const response = await fetch(`${API_BASE}/orders/issues/export?${params.toString()}`);
      if (!response.ok) throw new Error(await errorMessage(response));
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : '异常清单.csv';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '异常清单导出失败');
    } finally {
      setExporting(false);
    }
  }

  return <section className="issue-workspace" aria-label="异常处理">
    <div className="issue-heading"><div><span className="eyebrow">EXCEPTIONS / DOUYIN</span><h2>异常处理</h2><p>按问题类型定位订单、结算和成本异常，查看原因后补充数据再重新匹配。</p></div><div className="issue-heading-actions">{costIssueCount > 0 && <button className="primary-button" onClick={() => onOpenTasks(batchId, 'costBatchId')}>去补充成本</button>}<button className="secondary-button" onClick={() => void loadIssues(batchId)} disabled={loading}>{loading ? '加载中…' : '刷新异常'}</button></div></div>
    <div className="issue-selector"><label><span>订单批次</span><select value={batchId} onChange={(event) => void loadIssues(event.target.value)} disabled={loading || batches.length === 0}>{batches.map((batch) => <option value={batch.id} key={batch.id}>{batch.sourceFileName}（{batch.successRows} 条，{formatDate(batch.createdAt)}）</option>)}</select></label><small>{selectedBatch ? `当前批次共 ${selectedBatch.successRows} 个订单` : '选择订单批次'}</small></div>
    {error && <div className="import-error">{error}</div>}
    {saveMessage && <div className="save-success" role="status">{saveMessage}</div>}
    <div className="issue-summary-grid"><article className="issue-summary-card accent"><span>待处理</span><strong>{pendingIssueCount}</strong><small>含待补数据，共 {issues.length} 条问题记录</small></article><article className="issue-summary-card"><span>问题订单</span><strong>{new Set(issues.filter((issue) => issue.mainOrderNo).map((issue) => issue.mainOrderNo)).size}</strong><small>按订单号去重</small></article><article className="issue-summary-card"><span>成本问题</span><strong>{(issueCounts.COST_MISSING ?? 0) + (issueCounts.COST_CONFLICT ?? 0)}</strong><small>影响利润计算</small></article><article className="issue-summary-card"><span>未结算</span><strong>{issueCounts.ORDER_WITHOUT_SETTLEMENT ?? 0}</strong><small>等待结算数据</small></article></div>
    <section className="issue-panel"><div className="issue-toolbar"><div><h3>问题清单</h3><p>有对应订单时可查看订单详情；缺少订单时可查看结算记录和问题原因。</p></div><div className="issue-filters"><label className="search-field"><span className="sr-only">搜索异常</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索订单号或文件名" /></label><select value={issueType} onChange={(event) => { setIssueType(event.target.value); setPage(1); }} aria-label="异常类型"><option value="ALL">全部问题（{issues.length}）</option>{issueOptions.map(([type, label]) => <option value={type} key={type}>{label}（{issueCounts[type]}）</option>)}</select><select value={resolutionFilter} onChange={(event) => { setResolutionFilter(event.target.value); setPage(1); }} aria-label="处理状态"><option value="ALL">全部处理状态</option><option value="PENDING">待处理</option><option value="NEEDS_DATA">待补订单数据</option><option value="CONFIRMED">已确认</option><option value="RESOLVED">已解决</option></select><button className="secondary-button" onClick={() => void exportIssues()} disabled={exporting || filteredIssues.length === 0}>{exporting ? '导出中…' : `导出异常清单（${filteredIssues.length}）`}</button></div></div>
      <div className="issue-table-wrap"><table className="issue-table"><thead><tr><th>问题类型</th><th>订单号</th><th>问题原因</th><th>来源</th><th>处理状态</th><th>操作</th></tr></thead><tbody>{visibleIssues.map((issue) => <tr key={issue.id} className={selected?.id === issue.id ? 'selected-row' : undefined} onClick={() => openIssue(issue)}><td><span className={`tag ${issue.issueType === 'CROSS_PERIOD_SETTLEMENT' ? 'neutral' : 'danger'}`}>{issueLabels[issue.issueType] ?? issue.issueType}</span></td><td>{issue.mainOrderNo ?? <span className="muted-text">无对应订单</span>}</td><td><strong>{issue.message}</strong><small>{issueDescriptions[issue.issueType] ?? '请查看详情和来源数据。'}</small></td><td><span>{issue.sourceFileName ?? '-'}</span><small>第 {issue.rowNumber ?? '-'} 行</small></td><td><span className={`tag ${issue.resolutionStatus === 'RESOLVED' ? 'success' : issue.resolutionStatus === 'CONFIRMED' ? 'neutral' : issue.resolutionStatus === 'NEEDS_DATA' ? 'neutral' : 'danger'}`}>{resolutionLabels[issue.resolutionStatus]}</span></td><td>{issue.mainOrderNo ? <button className="detail-button" disabled={openingOrderId === issue.id} onClick={(event) => { event.stopPropagation(); void openOrder(issue); }}>{openingOrderId === issue.id ? '加载中…' : '查看订单'}</button> : <button className="detail-button" onClick={(event) => { event.stopPropagation(); openIssue(issue); }}>查看问题</button>}</td></tr>)}{!loading && visibleIssues.length === 0 && <tr><td className="empty" colSpan={6}>当前筛选条件下没有异常</td></tr>}</tbody></table></div>
      {!loading && filteredIssues.length > 0 && <nav className="pagination" aria-label="异常分页"><div className="pagination-summary">共 {filteredIssues.length} 条，第 {pageStart + 1}-{Math.min(pageStart + pageSize, filteredIssues.length)} 条</div><div className="pagination-controls"><label className="page-size"><span>每页</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }} aria-label="异常每页显示条数"><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option></select></label><button className="page-button icon-page-button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1} aria-label="上一页">‹</button>{visiblePageNumbers.map((pageNumber) => <button className={`page-button${pageNumber === safePage ? ' active' : ''}`} key={pageNumber} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}<button className="page-button icon-page-button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={safePage === totalPages} aria-label="下一页">›</button></div></nav>}
    </section>
    {selected && <div className="issue-detail-backdrop" role="presentation" onClick={() => setSelected(null)}><aside className="issue-detail" role="dialog" aria-modal="true" aria-label="异常详情" onClick={(event) => event.stopPropagation()}><div className="issue-detail-heading"><div><span className="eyebrow">ISSUE DETAIL</span><h3>{issueLabels[selected.issueType] ?? selected.issueType}</h3></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="关闭异常详情">×</button></div><dl className="issue-detail-meta"><div><dt>订单号</dt><dd>{selected.mainOrderNo ?? '无对应订单'}</dd></div><div><dt>问题产生时间</dt><dd>{formatDate(selected.createdAt)}</dd></div><div><dt>来源文件</dt><dd>{selected.sourceFileName ?? '-'}</dd></div><div><dt>来源行号</dt><dd>{selected.rowNumber ?? '-'}</dd></div></dl>{selected.orderAvailable && selected.availableOrderSourceFileName && selected.availableOrderSourceFileName !== selected.sourceFileName && <div className="issue-order-found"><strong>已在其他订单批次找到订单</strong><p>订单来源：{selected.availableOrderSourceFileName}，可以打开订单详情。</p></div>}{!selected.orderAvailable && selected.mainOrderNo && <div className="issue-order-missing"><strong>当前没有对应订单</strong><p>已查询全部已导入订单批次，仍未找到该订单。请导入包含该订单的订单表后重新匹配。</p></div>}{latestSupplementTask && <div className="issue-linked-task"><div><strong>已创建补充任务</strong><p>{latestSupplementTask.accountingMonth} · {taskStatusLabels[latestSupplementTask.status]} · {formatDate(latestSupplementTask.createdAt)}</p></div>{latestSupplementTask.status === 'COMPLETED' ? <button className="secondary-button" onClick={() => onViewTaskResults({ orderBatchId: latestSupplementTask.orderBatch.id, settlementBatchId: latestSupplementTask.settlementBatch.id })}>查看新结果</button> : selectedIssueAction && <button className="secondary-button" onClick={() => onOpenTasks(batchId, selectedIssueAction.target, { id: selected.id, issueType: selected.issueType, mainOrderNo: selected.mainOrderNo }, latestSupplementTask.id)}>查看补充任务</button>}</div>}{orderOpenError && <div className="import-error">{orderOpenError}</div>}<div className="issue-detail-explanation"><strong>问题说明</strong><p>{selected.message}</p><small>{issueDescriptions[selected.issueType] ?? '请根据来源数据补充后重新匹配。'}</small></div><h4>匹配详情</h4><pre>{detailText(selected.detail)}</pre><section className="issue-resolution-form"><h4>处理记录</h4><label><span>处理状态</span><select value={draftStatus} onChange={(event) => setDraftStatus(event.target.value as Issue['resolutionStatus'])}><option value="PENDING">待处理</option><option value="NEEDS_DATA">待补订单数据</option><option value="CONFIRMED">已确认</option><option value="RESOLVED">已解决</option></select></label><label><span>处理说明</span><textarea value={draftNote} onChange={(event) => setDraftNote(event.target.value)} placeholder="填写处理原因或后续安排" rows={3} /></label><div className="issue-detail-actions"><button className="primary-button" onClick={() => void saveResolution()} disabled={savingResolution}>{savingResolution ? '保存中…' : '保存处理结果'}</button>{selected.issueType === 'CROSS_PERIOD_SETTLEMENT' && <button className="secondary-button" onClick={() => void saveResolution('CONFIRMED', draftNote.trim() || '已确认跨期结算，按结算月份归属。')} disabled={savingResolution}>确认按结算月归属</button>}{selectedIssueAction && <button className="secondary-button" onClick={() => onOpenTasks(batchId, selectedIssueAction.target, { id: selected.id, issueType: selected.issueType, mainOrderNo: selected.mainOrderNo })}>{latestSupplementTask ? `再次${selectedIssueAction.label}` : selectedIssueAction.label}</button>}{selected.orderAvailable && selected.mainOrderNo && <button className="secondary-button" disabled={openingOrderId === selected.id} onClick={() => void openOrder(selected)}>{openingOrderId === selected.id ? '加载中…' : '打开订单详情'}</button>}</div></section></aside></div>}
  </section>;
}
