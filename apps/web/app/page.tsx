'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import IssueWorkspace from './components/issue-workspace';
import SummaryWorkspace from './components/summary-workspace';
import ReconciliationTaskWorkspace from './components/reconciliation-task-workspace';
import QianchuanWorkspace from './components/qianchuan-workspace';
import CostVersionWorkspace from './components/cost-version-workspace';
import type { ReconciliationDataTarget, ReconciliationSourceIssue } from './components/reconciliation-data-target';
import LoginScreen from './components/login-screen';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type Order = {
  id: string;
  mainOrderNo: string;
  status: string | null;
  submittedAt: string | null;
  merchantIncome: string | number | null;
  settledAmount: string | null;
  costAmount: string | null;
  profit: string | null;
  itemCount: number;
  ownershipType: 'SELF' | 'INFLUENCER' | null;
  liveMatchStatus: 'SELF_LIVE' | 'SELF_NON_LIVE' | 'INFLUENCER' | 'CONFLICT' | 'MISSING_ORDER_TIME' | null;
};

type Issue = {
  id: string;
  issueType: string;
  mainOrderNo: string | null;
  message: string;
};

type ImportBatch = {
  id: string;
  sourceFileName: string;
  totalRows: number;
  successRows: number;
  createdAt: string;
  _count?: { orders?: number };
};

type OrderDetail = Order & {
  batchId: string;
  rowNumber: number;
  sourceFileName: string;
  rawData: unknown;
  settledAmount: string;
  items: Array<{
    id: string;
    productId: string | null;
    merchantCode: string | null;
    productTitle: string | null;
    quantity: number | null;
    costSnapshot: { status: string; unitCost: string | null; totalCost: string | null; source?: { versionId: string; sourceFileName: string; rowNumber: number | null; rawData: unknown } } | null;
  }>;
  settlements: Array<{ id: string; amount: string; settledAt: string | null; settlementType: string | null; batchId: string; rowNumber: number; sourceFileName: string; rawData: unknown }>;
  costSummary: { status: string | null; totalCost: string | null; profit: string | null };
  ownershipType: 'SELF' | 'INFLUENCER' | null;
  liveMatchStatus: 'SELF_LIVE' | 'SELF_NON_LIVE' | 'INFLUENCER' | 'CONFLICT' | 'MISSING_ORDER_TIME' | null;
  liveSession: { liveId: string; anchorNickname: string | null; anchorDouyinId: string; startedAt: string; endedAt: string } | null;
};

const costStatusLabel: Record<string, string> = {
  PENDING_VERSION: '已匹配',
  MISSING: '缺成本',
  CONFLICT: '成本冲突',
  MATCHED: '已匹配',
};

const issueLabel: Record<string, string> = {
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

const ownershipLabel: Record<string, string> = {
  SELF: '自营',
  INFLUENCER: '达人',
};

const liveStatusLabel: Record<string, string> = {
  SELF_LIVE: '自营上播',
  SELF_NON_LIVE: '自营非上播',
  INFLUENCER: '达人订单',
  CONFLICT: '直播冲突',
  MISSING_ORDER_TIME: '缺少下单时间',
};

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatAmount(value: string | number | null) {
  if (value === null || value === undefined) return '-';
  return `¥${Number(value).toFixed(2)}`;
}

export default function HomePage() {
  const [session, setSession] = useState<{ username: string } | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch(`${API_BASE}/auth/session`)
      .then(async (response) => response.ok ? response.json() as Promise<{ username: string }> : null)
      .then((result) => { if (active) setSession(result); })
      .catch(() => { if (active) setSession(null); })
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, []);

  async function logout() {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
    setSession(null);
  }

  if (checkingSession) return <main className="auth-page"><div className="auth-loading">正在验证登录状态…</div></main>;
  if (!session) return <LoginScreen onAuthenticated={(username) => setSession({ username })} />;
  return <ReconciliationWorkspace username={session.username} onLogout={logout} />;
}

function ReconciliationWorkspace({ username, onLogout }: { username: string; onLogout: () => Promise<void> }) {
  const [activeView, setActiveView] = useState<'tasks' | 'orders' | 'summary' | 'issues' | 'costs' | 'qianchuan'>('orders');
  const [orders, setOrders] = useState<Order[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedSettlementBatchId, setSelectedSettlementBatchId] = useState('');
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [issueBatchId, setIssueBatchId] = useState('');
  const [taskContext, setTaskContext] = useState<{
    orderBatchId: string;
    target: ReconciliationDataTarget | null;
    sourceIssue: ReconciliationSourceIssue | null;
    taskId: string;
  }>({ orderBatchId: '', target: null, sourceIssue: null, taskId: '' });
  const [issueType, setIssueType] = useState('ALL');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [ownership, setOwnership] = useState('ALL');
  const [liveStatus, setLiveStatus] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [openingSettlementSupplement, setOpeningSettlementSupplement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (preferredBatchId?: string, settlementBatchId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const batchesResponse = await fetch(`${API_BASE}/imports?dataType=DOUYIN_ORDER`);
      if (!batchesResponse.ok) throw new Error('批次接口返回异常');
      const batchData = (await batchesResponse.json() as ImportBatch[]).filter(
        (batch) => (batch._count?.orders ?? 0) > 0,
      );
      const selectedBatch =
        batchData.find((batch) => batch.id === preferredBatchId) ??
        [...batchData].sort((a, b) => b.successRows - a.successRows)[0];
      if (!selectedBatch) throw new Error('当前没有可用的订单批次，请先在“对账任务”中导入并处理订单表，或恢复已归档的业务批次。');
      setBatches(batchData);
      setSelectedBatchId(selectedBatch.id);
      setSelectedSettlementBatchId(settlementBatchId ?? '');
      setCurrentPage(1);

      const [ordersResponse, issuesResponse] = await Promise.all([
        fetch(`${API_BASE}/orders?page=1&pageSize=500&batchId=${selectedBatch.id}${settlementBatchId ? `&settlementBatchId=${encodeURIComponent(settlementBatchId)}` : ''}`),
        fetch(`${API_BASE}/orders/issues?orderBatchId=${selectedBatch.id}${settlementBatchId ? `&settlementBatchId=${encodeURIComponent(settlementBatchId)}` : ''}`),
      ]);
      if (!ordersResponse.ok || !issuesResponse.ok) throw new Error('接口返回异常');
      const ordersData = await ordersResponse.json() as { items?: Order[]; total?: number; pageSize?: number; totalPages?: number };
      const firstPage = ordersData.items ?? [];
      const totalPages = ordersData.totalPages ?? (ordersData.total && ordersData.pageSize ? Math.ceil(ordersData.total / ordersData.pageSize) : 1);
      const remainingPages = await Promise.all(Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
        fetch(`${API_BASE}/orders?page=${index + 2}&pageSize=500&batchId=${selectedBatch.id}${settlementBatchId ? `&settlementBatchId=${encodeURIComponent(settlementBatchId)}` : ''}`),
      ));
      if (remainingPages.some((response) => !response.ok)) throw new Error('订单分页接口返回异常');
      const remainingOrders = await Promise.all(remainingPages.map(async (response) => (await response.json() as { items?: Order[] }).items ?? []));
      setOrders(firstPage.concat(...remainingOrders));
      setIssues(await issuesResponse.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '订单工作台加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const issueCountByType = useMemo(() => issues.reduce<Record<string, number>>((result, issue) => {
    result[issue.issueType] = (result[issue.issueType] ?? 0) + 1;
    return result;
  }, {}), [issues]);

  const filteredOrders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return orders.filter((order) => {
      const matchesQuery = !normalizedQuery || order.mainOrderNo.toLowerCase().includes(normalizedQuery);
      const orderIssues = issues.filter((issue) => issue.mainOrderNo === order.mainOrderNo);
      const matchesStatus = status === 'ALL'
        || (status === 'NORMAL' ? orderIssues.length === 0 : orderIssues.some((issue) => issue.issueType === status));
      const matchesOwnership = ownership === 'ALL' || order.ownershipType === ownership;
      const matchesLiveStatus = liveStatus === 'ALL'
        ? true
        : liveStatus === 'UNMATCHED'
          ? !order.liveMatchStatus
          : order.liveMatchStatus === liveStatus;
      return matchesQuery && matchesStatus && matchesOwnership && matchesLiveStatus;
    });
  }, [issues, liveStatus, orders, ownership, query, status]);

  async function openOrder(orderNo: string, showPageError = true) {
    try {
      const response = await fetch(`${API_BASE}/orders/${encodeURIComponent(orderNo)}${selectedSettlementBatchId ? `?settlementBatchId=${encodeURIComponent(selectedSettlementBatchId)}` : ''}`);
      if (!response.ok) throw new Error('订单查询失败');
      setSelected(await response.json());
      setError(null);
      return true;
    } catch {
      if (showPageError) setError('订单详情加载失败，请稍后重试。');
      return false;
    }
  }

  async function openSettlementSupplement() {
    if (!selected) return;
    const order = selected;
    setOpeningSettlementSupplement(true);
    let sourceIssue = order.settlements.length === 0
      ? issues.find((issue) => issue.issueType === 'ORDER_WITHOUT_SETTLEMENT' && issue.mainOrderNo === order.mainOrderNo)
      : undefined;

    if (order.settlements.length === 0 && !sourceIssue) {
      try {
        const response = await fetch(`${API_BASE}/orders/issues?orderBatchId=${encodeURIComponent(order.batchId)}${selectedSettlementBatchId ? `&settlementBatchId=${encodeURIComponent(selectedSettlementBatchId)}` : ''}`);
        if (response.ok) {
          const orderIssues = await response.json() as Issue[];
          sourceIssue = orderIssues.find((issue) => issue.issueType === 'ORDER_WITHOUT_SETTLEMENT' && issue.mainOrderNo === order.mainOrderNo);
        }
      } catch {
        // 找不到来源异常时仍可进入任务页补充结算表。
      }
    }

    setTaskContext({
      orderBatchId: order.batchId,
      target: 'settlementBatchId',
      sourceIssue: sourceIssue ? { id: sourceIssue.id, issueType: sourceIssue.issueType, mainOrderNo: sourceIssue.mainOrderNo } : null,
      taskId: '',
    });
    setSelected(null);
    setActiveView('tasks');
    setOpeningSettlementSupplement(false);
  }

  function openIssues(batchId = selectedBatchId, type = 'ALL') {
    setIssueBatchId(batchId);
    setIssueType(type);
    setActiveView('issues');
  }

  const issueOptions = Object.entries(issueLabel).filter(([type]) => issueCountByType[type]);
  // 跨期结算可能没有对应的当前订单行，只在异常处理页查看。
  const orderIssueOptions = issueOptions.filter(([type]) => type !== 'CROSS_PERIOD_SETTLEMENT');
  const normalOrderCount = orders.filter(
    (order) => !issues.some((issue) => issue.mainOrderNo === order.mainOrderNo),
  ).length;
  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId);
  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * pageSize;
  const paginatedOrders = filteredOrders.slice(pageStart, pageStart + pageSize);
  const visiblePageNumbers = Array.from(
    { length: Math.min(5, totalPages) },
    (_, index) => {
      const firstPage = Math.min(
        Math.max(1, safeCurrentPage - 2),
        Math.max(1, totalPages - 4),
      );
      return firstPage + index;
    },
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{activeView === 'qianchuan' ? 'QIANCHUAN / SPEND' : 'RECONCILIATION / DOUYIN'}</p>
          <h1>{activeView === 'qianchuan' ? '千川消耗管理' : '抖店对账工作台'}</h1>
          <p className="subtitle">{activeView === 'qianchuan' ? '集中导入和查看三个千川账号的每日消耗。' : '订单、结算与商品成本在同一张明细里核对。'}</p>
        </div>
        <div className="topbar-actions">
          {activeView === 'orders' && <button className="secondary-button" onClick={() => void loadData(selectedBatchId, selectedSettlementBatchId || undefined)} disabled={loading}>{loading ? '刷新中…' : '刷新数据'}</button>}
          <span className="admin-identity">{username}</span>
          <button className="text-button" onClick={() => void onLogout()}>退出</button>
        </div>
      </header>

      <nav className="view-tabs" aria-label="工作台视图">
        <button className={activeView === 'tasks' ? 'active' : ''} onClick={() => { setTaskContext((current) => ({ ...current, target: null, sourceIssue: null, taskId: '' })); setActiveView('tasks'); }} aria-current={activeView === 'tasks' ? 'page' : undefined}>对账任务</button>
        <button className={activeView === 'orders' ? 'active' : ''} onClick={() => setActiveView('orders')} aria-current={activeView === 'orders' ? 'page' : undefined}>订单工作台</button>
        <button className={activeView === 'summary' ? 'active' : ''} onClick={() => setActiveView('summary')} aria-current={activeView === 'summary' ? 'page' : undefined}>对账汇总</button>
        <button className={activeView === 'issues' ? 'active' : ''} onClick={() => openIssues()} aria-current={activeView === 'issues' ? 'page' : undefined}>异常处理</button>
        <button className={activeView === 'costs' ? 'active' : ''} onClick={() => setActiveView('costs')} aria-current={activeView === 'costs' ? 'page' : undefined}>成本版本</button>
        <button className={activeView === 'qianchuan' ? 'active' : ''} onClick={() => setActiveView('qianchuan')} aria-current={activeView === 'qianchuan' ? 'page' : undefined}>千川消耗</button>
      </nav>

      {error && <div className="alert">{error}</div>}

      {activeView === 'tasks' && <ReconciliationTaskWorkspace key={`${taskContext.orderBatchId}:${taskContext.target ?? ''}:${taskContext.sourceIssue?.id ?? ''}:${taskContext.taskId}`} initialOrderBatchId={taskContext.orderBatchId || undefined} initialTarget={taskContext.target ?? undefined} initialSourceIssue={taskContext.sourceIssue ?? undefined} initialTaskId={taskContext.taskId || undefined} onViewResults={({ orderBatchId, settlementBatchId }) => { setActiveView('orders'); void loadData(orderBatchId, settlementBatchId); }} />}

      {activeView === 'summary' && <SummaryWorkspace onOpenIssues={openIssues} />}

      {activeView === 'issues' && <IssueWorkspace key={`${issueBatchId || selectedBatchId}:${issueType}`} initialBatchId={issueBatchId || selectedBatchId} initialIssueType={issueType} onOpenOrder={(orderNo) => openOrder(orderNo, false)} onOpenTasks={(batchId, target, sourceIssue, taskId) => { setTaskContext({ orderBatchId: batchId, target, sourceIssue: sourceIssue ?? null, taskId: taskId ?? '' }); setActiveView('tasks'); }} onViewTaskResults={({ orderBatchId, settlementBatchId }) => { setActiveView('orders'); void loadData(orderBatchId, settlementBatchId); }} />}

      {activeView === 'costs' && <CostVersionWorkspace />}

      {activeView === 'qianchuan' && <QianchuanWorkspace />}

      {activeView === 'orders' && <><section className="summary-grid" aria-label="对账概览">
        <article className="summary-card accent"><span>订单总数</span><strong>{loading ? '—' : orders.length}</strong><small>{selectedBatch?.sourceFileName ?? '当前订单批次'}</small></article>
        <article className="summary-card"><span>待处理问题</span><strong>{loading ? '—' : issues.length}</strong><small>关联、成本和跨期问题</small></article>
        <article className="summary-card"><span>缺成本</span><strong>{issueCountByType.COST_MISSING ?? 0}</strong><small>不按 0 元计算</small></article>
        <article className="summary-card"><span>成本版本</span><strong className="version-text">多版本保留</strong><small>新表不覆盖历史订单</small></article>
      </section>

      <section className="content-panel">
        <div className="panel-heading">
          <div><h2>订单明细</h2><p>点击订单号查看商品成本快照和全部结算记录。</p></div>
          <div className="toolbar">
            <select value={selectedBatchId} onChange={(event) => void loadData(event.target.value)} aria-label="订单导入批次">
              {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.sourceFileName}（{batch.successRows}条）</option>)}
            </select>
            <label className="search-field"><span className="sr-only">搜索订单号</span><input value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="搜索订单号" /></label>
            <select value={ownership} onChange={(event) => { setOwnership(event.target.value); setCurrentPage(1); }} aria-label="订单归属">
              <option value="ALL">全部归属</option>
              <option value="SELF">自营</option>
              <option value="INFLUENCER">达人</option>
            </select>
            <select value={liveStatus} onChange={(event) => { setLiveStatus(event.target.value); setCurrentPage(1); }} aria-label="直播状态">
              <option value="ALL">全部直播状态</option>
              {Object.entries(liveStatusLabel).map(([type, label]) => <option key={type} value={type}>{label}</option>)}
              <option value="UNMATCHED">未匹配直播</option>
            </select>
            <select value={status} onChange={(event) => { setStatus(event.target.value); setCurrentPage(1); }} aria-label="问题类型">
              <option value="ALL">全部状态</option>
              {normalOrderCount > 0 && <option value="NORMAL">正常（{normalOrderCount}）</option>}
              {orderIssueOptions.map(([type, label]) => <option key={type} value={type}>{label}（{issueCountByType[type]}）</option>)}
            </select>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>主订单编号</th><th>下单时间</th><th>订单归属</th><th>直播状态</th><th>商品数</th><th>总结算金额</th><th>总成本</th><th>利润</th><th>问题状态</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {paginatedOrders.map((order) => {
                const orderIssues = issues.filter((issue) => issue.mainOrderNo === order.mainOrderNo);
                const uniqueOrderIssues = Array.from(
                  new Map(orderIssues.map((issue) => [issue.issueType, issue])).values(),
                );
                return <tr key={order.id}>
                  <td><button className="link-button" onClick={() => void openOrder(order.mainOrderNo)}>{order.mainOrderNo}</button></td>
                  <td>{formatDate(order.submittedAt)}</td>
                  <td><span className="tag neutral">{order.ownershipType ? (ownershipLabel[order.ownershipType] ?? order.ownershipType) : '未匹配'}</span></td>
                  <td><span className={`tag ${order.liveMatchStatus === 'CONFLICT' || order.liveMatchStatus === 'MISSING_ORDER_TIME' ? 'danger' : 'neutral'}`}>{order.liveMatchStatus ? (liveStatusLabel[order.liveMatchStatus] ?? order.liveMatchStatus) : '未匹配'}</span></td>
                  <td>{order.itemCount}</td><td>{formatAmount(order.settledAmount)}</td><td>{formatAmount(order.costAmount)}</td><td className={order.profit === null ? 'muted-value' : undefined}>{order.profit === null ? '暂不可计算' : formatAmount(order.profit)}</td>
                  <td>{uniqueOrderIssues.length ? <div className="tag-list">{uniqueOrderIssues.slice(0, 2).map((issue) => <span className="tag danger" key={issue.id}>{issueLabel[issue.issueType] ?? issue.issueType}</span>)}</div> : <span className="tag success">正常</span>}</td>
                  <td><button className="detail-button" onClick={() => void openOrder(order.mainOrderNo)}>查看</button></td>
                </tr>;
              })}
              {!loading && filteredOrders.length === 0 && <tr><td className="empty" colSpan={10}>没有符合条件的订单</td></tr>}
            </tbody>
          </table>
        </div>
        {!loading && filteredOrders.length > 0 && (
          <nav className="pagination" aria-label="订单分页">
            <div className="pagination-summary">
              共 {filteredOrders.length} 条，第 {pageStart + 1}-{Math.min(pageStart + pageSize, filteredOrders.length)} 条
            </div>
            <div className="pagination-controls">
              <label className="page-size">
                <span>每页</span>
                <select
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setCurrentPage(1);
                  }}
                  aria-label="每页显示条数"
                >
                  <option value={10}>10 条</option>
                  <option value={20}>20 条</option>
                  <option value={50}>50 条</option>
                </select>
              </label>
              <button
                className="page-button icon-page-button"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={safeCurrentPage === 1}
                aria-label="上一页"
                title="上一页"
              >
                ‹
              </button>
              {visiblePageNumbers.map((pageNumber) => (
                <button
                  className={`page-button${pageNumber === safeCurrentPage ? ' active' : ''}`}
                  key={pageNumber}
                  onClick={() => setCurrentPage(pageNumber)}
                  aria-current={pageNumber === safeCurrentPage ? 'page' : undefined}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                className="page-button icon-page-button"
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                disabled={safeCurrentPage === totalPages}
                aria-label="下一页"
                title="下一页"
              >
                ›
              </button>
            </div>
          </nav>
        )}
      </section></>}

      {(activeView === 'orders' || activeView === 'issues') && selected && <div className="drawer-backdrop" role="presentation" onClick={() => setSelected(null)}>
        <aside className="drawer" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          <div className="drawer-heading"><div><span className="eyebrow">ORDER DETAIL</span><h2>{selected.mainOrderNo}</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="关闭详情">×</button></div>
          <div className="detail-summary"><div><span>总结算金额</span><strong>{formatAmount(selected.settledAmount)}</strong></div><div><span>总成本</span><strong>{formatAmount(selected.costSummary.totalCost)}</strong></div><div><span>利润</span><strong className={selected.costSummary.profit === null ? 'muted-value' : ''}>{selected.costSummary.profit === null ? '暂不可计算' : formatAmount(selected.costSummary.profit)}</strong></div></div>
          <div className="source-trace"><span>订单来源</span><strong>{selected.sourceFileName}</strong><small>第 {selected.rowNumber} 行 · 批次 {selected.batchId}</small></div>
          <p className="notice">订单成本按首次匹配的成本表保存。以后导入新成本表不会覆盖历史订单；缺成本和成本冲突不会按 0 元处理。</p>
          <div className="ownership-summary"><span className="tag neutral">{selected.ownershipType ? (ownershipLabel[selected.ownershipType] ?? selected.ownershipType) : '未匹配归属'}</span><span className="tag neutral">{selected.liveMatchStatus ? (liveStatusLabel[selected.liveMatchStatus] ?? selected.liveMatchStatus) : '未匹配直播'}</span>{selected.liveSession && <small>{selected.liveSession.liveId} · {formatDate(selected.liveSession.startedAt)} - {formatDate(selected.liveSession.endedAt)}</small>}</div>
          <h3>原始订单行</h3><pre>{JSON.stringify(selected.rawData, null, 2)}</pre>
          <h3>商品成本</h3>
          <div className="detail-list">{selected.items.map((item) => <div className="detail-row" key={item.id}><div><strong>{item.productTitle || '未命名商品'}</strong><small>{item.productId || '-'} · {item.merchantCode || '无商家编码'}</small>{item.costSnapshot?.source && <small>成本来源：{item.costSnapshot.source.sourceFileName} · 第 {item.costSnapshot.source.rowNumber ?? '-'} 行</small>}</div><div className="right"><strong>{formatAmount(item.costSnapshot?.totalCost ?? null)}</strong><small>{item.costSnapshot ? (costStatusLabel[item.costSnapshot.status] ?? item.costSnapshot.status) : '未匹配'}</small></div></div>)}</div>
          <div className="detail-section-heading"><h3>结算记录</h3><button className="secondary-button" disabled={openingSettlementSupplement} onClick={() => void openSettlementSupplement()}>{openingSettlementSupplement ? '定位中…' : selected.settlements.length ? '补充后续结算表' : '补充结算表'}</button></div>
          <div className="detail-list">{selected.settlements.map((settlement) => <div className="detail-row" key={settlement.id}><div><strong>{settlement.settlementType || '平台结算'}</strong><small>{formatDate(settlement.settledAt)} · {settlement.sourceFileName} · 第 {settlement.rowNumber} 行</small><small>{JSON.stringify(settlement.rawData)}</small></div><strong>{formatAmount(settlement.amount)}</strong></div>)}{!selected.settlements.length && <p className="empty">暂无结算记录</p>}</div>
        </aside>
      </div>}
    </main>
  );
}
