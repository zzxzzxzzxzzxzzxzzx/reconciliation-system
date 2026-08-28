'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type ImportKind = 'orders' | 'settlements' | 'costs' | 'live-sessions';

type ImportBatch = {
  id: string;
  dataType: string;
  status: 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED' | string;
  sourceFileName: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  duplicateRows?: number;
  createdAt: string;
  completedAt?: string | null;
  errors?: Array<{ rowNumber: number | null; code: string; message: string }>;
  archivedAt?: string | null;
  _count?: Record<string, number>;
  canDelete?: boolean;
  deleteBlockedReason?: string | null;
};

type UploadState = {
  file: File | null;
  uploading: boolean;
  processing: boolean;
  duplicate: boolean;
  batch: ImportBatch | null;
  processResult: Record<string, unknown> | null;
  error: string | null;
};

type ImportWorkspaceProps = {
  onOrderBatchProcessed?: (batchId: string) => void;
  initialOrderBatchId?: string;
  onCostProcessed?: (orderBatchId: string) => void;
};

const configs: Array<{
  kind: ImportKind;
  title: string;
  description: string;
  endpoint: string;
  dataType: string;
  required: string;
  resultLabels: Record<string, string>;
}> = [
  {
    kind: 'orders',
    title: '订单表',
    description: '抖店导出的订单明细，先处理它，再关联其他数据。',
    endpoint: '/imports/orders',
    dataType: 'DOUYIN_ORDER',
    required: '主订单编号',
    resultLabels: { orderCount: '订单', itemCount: '商品明细', issueCount: '问题' },
  },
  {
    kind: 'settlements',
    title: '结算表',
    description: '按订单号关联，可保留一单多条结算和负数退款。',
    endpoint: '/imports/settlements',
    dataType: 'DOUYIN_SETTLEMENT',
    required: '订单号',
    resultLabels: { settlementCount: '结算记录', matchedCount: '已关联', unmatchedCount: '缺订单', crossPeriodCount: '跨期' },
  },
  {
    kind: 'costs',
    title: '商品成本表',
    description: '每次导入都保留为独立版本，不覆盖历史订单成本。',
    endpoint: '/imports/costs',
    dataType: 'DOUYIN_COST',
    required: '商品id修复',
    resultLabels: { costRowCount: '成本行', matchedItemCount: '已匹配', missingCostCount: '缺成本', conflictCostCount: '冲突' },
  },
  {
    kind: 'live-sessions',
    title: '直播明细表',
    description: '用主播和直播时间判断自营上播、非上播或冲突。',
    endpoint: '/imports/live-sessions',
    dataType: 'DOUYIN_LIVE',
    required: '直播开始时间',
    resultLabels: { liveSessionCount: '直播场次', selfLiveCount: '自营上播', selfNonLiveCount: '自营非上播', influencerCount: '达人订单', conflictCount: '冲突' },
  },
];

const emptyState = (): UploadState => ({
  file: null,
  uploading: false,
  processing: false,
  duplicate: false,
  batch: null,
  processResult: null,
  error: null,
});

function formatDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function statusLabel(status: string) {
  return ({ COMPLETED: '导入完成', COMPLETED_WITH_ERRORS: '部分成功', FAILED: '导入失败', PROCESSING: '处理中' } as Record<string, string>)[status] ?? status;
}

async function getErrorMessage(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[]; error?: string };
    const message = payload.message ?? payload.error;
    return Array.isArray(message) ? message.join('；') : message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export default function ImportWorkspace({ onOrderBatchProcessed, initialOrderBatchId, onCostProcessed }: ImportWorkspaceProps) {
  const [states, setStates] = useState<Record<ImportKind, UploadState>>({
    orders: emptyState(), settlements: emptyState(), costs: emptyState(), 'live-sessions': emptyState(),
  });
  const [orderBatches, setOrderBatches] = useState<ImportBatch[]>([]);
  const [orderBatchId, setOrderBatchId] = useState('');
  const [loadingBatches, setLoadingBatches] = useState(true);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [allBatches, setAllBatches] = useState<ImportBatch[]>([]);
  const [showArchivedBatches, setShowArchivedBatches] = useState(false);
  const [batchSearch, setBatchSearch] = useState('');
  const [orderBatchSearch, setOrderBatchSearch] = useState('');
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [batchActionPending, setBatchActionPending] = useState(false);
  const [batchPage, setBatchPage] = useState(1);
  const batchPageSize = 8;

  const loadOrderBatches = useCallback(async (preferredBatchId?: string) => {
    setLoadingBatches(true);
    try {
      const response = await fetch(`${API_BASE}/imports?dataType=DOUYIN_ORDER`);
      if (!response.ok) throw new Error(await getErrorMessage(response));
      const batches = (await response.json() as ImportBatch[]).filter(
        (batch) => batch.status !== 'FAILED' && batch.successRows > 0,
      );
      setOrderBatches(batches);
      setOrderBatchId((current) => batches.some((batch) => batch.id === preferredBatchId)
        ? preferredBatchId ?? ''
        : batches.some((batch) => batch.id === current)
        ? current
        : [...batches].sort((a, b) => b.successRows - a.successRows || b.createdAt.localeCompare(a.createdAt))[0]?.id ?? '');
      setBatchError(null);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '订单批次加载失败');
    } finally {
      setLoadingBatches(false);
    }
  }, []);

  const loadAllBatches = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/imports?includeArchived=${showArchivedBatches}`);
      if (!response.ok) throw new Error(await getErrorMessage(response));
      setAllBatches(await response.json() as ImportBatch[]);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '批次列表加载失败');
    }
  }, [showArchivedBatches]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOrderBatches(initialOrderBatchId), 0);
    return () => window.clearTimeout(timer);
  }, [initialOrderBatchId, loadOrderBatches]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAllBatches(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAllBatches]);

  const filteredBatches = useMemo(() => {
    const keyword = batchSearch.trim().toLowerCase();
    return allBatches.filter((batch) => !keyword || batch.sourceFileName.toLowerCase().includes(keyword));
  }, [allBatches, batchSearch]);
  const batchPageCount = Math.max(1, Math.ceil(filteredBatches.length / batchPageSize));
  const visibleBatches = filteredBatches.slice((batchPage - 1) * batchPageSize, batchPage * batchPageSize);
  const filteredOrderBatches = useMemo(() => {
    const keyword = orderBatchSearch.trim().toLowerCase();
    if (!keyword) return orderBatches;
    return orderBatches.filter((batch) => batch.sourceFileName.toLowerCase().includes(keyword));
  }, [orderBatches, orderBatchSearch]);
  const selectedOrderBatch = useMemo(() => orderBatches.find((batch) => batch.id === orderBatchId), [orderBatchId, orderBatches]);
  const selectableOrderBatches = selectedOrderBatch && !filteredOrderBatches.some((batch) => batch.id === selectedOrderBatch.id)
    ? [selectedOrderBatch, ...filteredOrderBatches]
    : filteredOrderBatches;
  const visibleBatchIds = visibleBatches.map((batch) => batch.id);
  const allVisibleSelected = visibleBatchIds.length > 0 && visibleBatchIds.every((id) => selectedBatchIds.includes(id));

  async function archiveBatch(batch: ImportBatch) {
    setBatchError(null);
    try {
      const action = batch.archivedAt ? 'restore' : 'archive';
      const response = await fetch(`${API_BASE}/imports/${batch.id}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      await Promise.all([loadOrderBatches(orderBatchId), loadAllBatches()]);
      setBatchPage(1);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '批次归档操作失败');
    }
  }

  function toggleBatchSelection(batchId: string) {
    setSelectedBatchIds((current) => current.includes(batchId)
      ? current.filter((id) => id !== batchId)
      : [...current, batchId]);
  }

  function toggleVisibleBatchSelection() {
    setSelectedBatchIds((current) => allVisibleSelected
      ? current.filter((id) => !visibleBatchIds.includes(id))
      : Array.from(new Set([...current, ...visibleBatchIds])));
  }

  async function updateSelectedBatches(action: 'archive' | 'restore' | 'delete') {
    if (selectedBatchIds.length === 0) return;
    const selectedBatches = allBatches.filter((batch) => selectedBatchIds.includes(batch.id));
    if (action === 'delete' && selectedBatches.some((batch) => !batch.canDelete)) {
      setBatchError('选中的批次包含已使用数据，只能归档，不能删除');
      return;
    }
    if (action === 'delete' && !window.confirm(`确认删除选中的 ${selectedBatchIds.length} 个未使用批次？删除后无法恢复，但不会影响其他历史数据。`)) return;
    setBatchActionPending(true);
    setBatchError(null);
    try {
      const response = await fetch(`${API_BASE}/imports/batch${action === 'delete' ? '' : `/${action}`}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchIds: selectedBatchIds }),
      });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      setSelectedBatchIds([]);
      await Promise.all([loadOrderBatches(orderBatchId), loadAllBatches()]);
      setBatchPage(1);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : action === 'delete' ? '批量删除操作失败' : '批量归档操作失败');
    } finally {
      setBatchActionPending(false);
    }
  }

  async function deleteSingleBatch(batch: ImportBatch) {
    if (!batch.canDelete || !window.confirm(`确认删除“${batch.sourceFileName}”？删除后无法恢复。`)) return;
    setBatchActionPending(true);
    setBatchError(null);
    try {
      const response = await fetch(`${API_BASE}/imports/${batch.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      await Promise.all([loadOrderBatches(orderBatchId), loadAllBatches()]);
      setBatchPage(1);
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : '批次删除操作失败');
    } finally {
      setBatchActionPending(false);
    }
  }

  const updateState = useCallback((kind: ImportKind, update: Partial<UploadState>) => {
    setStates((current) => ({ ...current, [kind]: { ...current[kind], ...update } }));
  }, []);

  function selectFile(kind: ImportKind, event: ChangeEvent<HTMLInputElement>) {
    updateState(kind, { file: event.target.files?.[0] ?? null, error: null, processResult: null });
  }

  async function upload(kind: ImportKind, config: typeof configs[number]) {
    const state = states[kind];
    if (!state.file) {
      updateState(kind, { error: '请先选择 CSV 或 XLSX 文件' });
      return;
    }
    updateState(kind, { uploading: true, error: null, processResult: null });
    try {
      const body = new FormData();
      body.append('file', state.file);
      const response = await fetch(`${API_BASE}${config.endpoint}`, { method: 'POST', body });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      const payload = await response.json() as { duplicate?: boolean; batch: ImportBatch };
      updateState(kind, { batch: payload.batch, duplicate: Boolean(payload.duplicate), uploading: false });
      if (kind === 'orders') {
        setOrderBatchId(payload.batch.id);
        await loadOrderBatches(payload.batch.id);
      }
    } catch (error) {
      updateState(kind, { uploading: false, error: error instanceof Error ? error.message : '文件上传失败' });
    }
  }

  async function process(kind: ImportKind, config: typeof configs[number]) {
    const state = states[kind];
    if (!state.batch) return;
    if (kind !== 'orders' && !orderBatchId) {
      updateState(kind, { error: '请先选择要关联的订单批次' });
      return;
    }
    updateState(kind, { processing: true, error: null });
    try {
      const params = kind === 'orders' ? '' : `?orderBatchId=${encodeURIComponent(orderBatchId)}`;
      const response = await fetch(`${API_BASE}${kind === 'orders' ? `/orders/standardize/${state.batch.id}` : `${config.endpoint.replace('/imports', '')}/standardize/${state.batch.id}${params}`}`, { method: 'POST' });
      if (!response.ok) throw new Error(await getErrorMessage(response));
      const result = await response.json() as Record<string, unknown>;
      updateState(kind, { processing: false, processResult: result });
      if (kind === 'orders') {
        await loadOrderBatches();
        onOrderBatchProcessed?.(state.batch.id);
      } else if (kind === 'costs') {
        onCostProcessed?.(orderBatchId);
      }
    } catch (error) {
      updateState(kind, { processing: false, error: error instanceof Error ? error.message : '处理失败' });
    }
  }

  return (
    <section className="import-workspace" aria-label="数据导入">
      <div className="import-heading">
        <div><span className="eyebrow">DATA IMPORT / DOUYIN</span><h2>数据导入</h2><p>按“订单 → 结算、成本、直播”的顺序导入。每一步都可以单独查看结果。</p></div>
        <button className="secondary-button" onClick={() => void Promise.all([loadOrderBatches(), loadAllBatches()])} disabled={loadingBatches}>{loadingBatches ? '加载中…' : '刷新批次'}</button>
      </div>
      <div className="import-linkage">
        <label><span>后续数据关联到订单批次</span><input aria-label="搜索关联订单表" placeholder="先输入文件名搜索" value={orderBatchSearch} onChange={(event) => setOrderBatchSearch(event.target.value)} /><select value={orderBatchId} onChange={(event) => setOrderBatchId(event.target.value)} disabled={loadingBatches || orderBatches.length === 0}>
          {!orderBatches.length && <option value="">暂无订单批次</option>}
          {filteredOrderBatches.length === 0 && orderBatches.length > 0 && <option value="">没有匹配的订单表</option>}
          {selectableOrderBatches.map((batch) => <option key={batch.id} value={batch.id}>{batch.sourceFileName}（{batch.successRows} 条，{formatDate(batch.createdAt)}）</option>)}
        </select></label>
        {selectedOrderBatch && <small>当前关联批次：{selectedOrderBatch.id}</small>}
      </div>
      {batchError && <div className="import-error">{batchError}</div>}
      <section className="batch-management" aria-label="导入批次管理">
        <div className="section-heading"><div><h3>导入批次管理</h3><p>归档后不会出现在新建对账的下拉框；未使用的误导入文件可以删除。</p></div><div className="section-heading-actions"><button className="secondary-button" onClick={() => { setShowArchivedBatches((current) => !current); setSelectedBatchIds([]); setBatchPage(1); }}>{showArchivedBatches ? '隐藏已归档' : '显示已归档'}</button><strong>{filteredBatches.length} 个批次</strong></div></div>
        <div className="batch-management-toolbar"><input aria-label="搜索批次文件名" placeholder="搜索文件名" value={batchSearch} onChange={(event) => { setBatchSearch(event.target.value); setBatchPage(1); }} /><button className="secondary-button" disabled={visibleBatches.length === 0} onClick={toggleVisibleBatchSelection}>{allVisibleSelected ? '取消本页' : '选择本页'}</button><button className="secondary-button" disabled={selectedBatchIds.length === 0 || batchActionPending} onClick={() => void updateSelectedBatches('archive')}>归档选中</button>{showArchivedBatches && <button className="secondary-button" disabled={selectedBatchIds.length === 0 || batchActionPending} onClick={() => void updateSelectedBatches('restore')}>恢复选中</button>}<button className="danger-button" disabled={selectedBatchIds.length === 0 || batchActionPending || allBatches.some((batch) => selectedBatchIds.includes(batch.id) && !batch.canDelete)} onClick={() => void updateSelectedBatches('delete')}>删除选中</button><span>{selectedBatchIds.length > 0 ? `已选 ${selectedBatchIds.length} 个` : '未选择'}</span></div>
        <div className="batch-management-list">{visibleBatches.map((batch) => <div className={`batch-management-row${batch.archivedAt ? ' archived-row' : ''}`} key={batch.id}><input aria-label={`选择批次 ${batch.sourceFileName}`} type="checkbox" checked={selectedBatchIds.includes(batch.id)} onChange={() => toggleBatchSelection(batch.id)} /><div><strong>{batch.sourceFileName}</strong><small>{({ DOUYIN_ORDER: '订单表', DOUYIN_SETTLEMENT: '结算表', DOUYIN_COST: '成本表', DOUYIN_LIVE: '直播表', QIANCHUAN_SPEND: '千川消耗表' } as Record<string, string>)[batch.dataType] ?? batch.dataType} · {batch.successRows} 条 · 导入于 {formatDate(batch.createdAt)}</small></div><div className="batch-management-meta"><span>{batch.deleteBlockedReason ?? (batch.canDelete ? '可删除' : '只能归档')}</span>{batch.archivedAt && <span className="status-pill archived">已归档</span>}<button className="text-button" onClick={() => void archiveBatch(batch)}>{batch.archivedAt ? '恢复' : '归档'}</button>{batch.canDelete && <button className="text-button danger-text" onClick={() => void deleteSingleBatch(batch)}>删除</button>}</div></div>)}{visibleBatches.length === 0 && <p className="empty">没有符合条件的批次</p>}</div>
        {batchPageCount > 1 && <div className="batch-pagination"><button className="secondary-button" disabled={batchPage <= 1} onClick={() => setBatchPage((page) => page - 1)}>上一页</button><span>第 {batchPage} / {batchPageCount} 页</span><button className="secondary-button" disabled={batchPage >= batchPageCount} onClick={() => setBatchPage((page) => page + 1)}>下一页</button></div>}
      </section>
      <div className="import-grid">
        {configs.map((config) => {
          const state = states[config.kind];
          const resultEntries = state.processResult ? Object.entries(state.processResult).filter(([key, value]) => config.resultLabels[key] && typeof value !== 'object') : [];
          return <article className="import-card" key={config.kind}>
            <div className="import-card-heading"><div><h3>{config.title}</h3><p>{config.description}</p></div><span className="file-type">CSV / XLSX</span></div>
            <p className="required-field">必需字段：{config.required}</p>
            <div className="file-picker"><input id={`file-${config.kind}`} type="file" accept=".csv,.xlsx,.xls" onChange={(event) => selectFile(config.kind, event)} /><label htmlFor={`file-${config.kind}`}>选择文件</label><span title={state.file?.name}>{state.file?.name ?? '尚未选择文件'}</span></div>
            <div className="import-actions"><button className="primary-button" onClick={() => void upload(config.kind, config)} disabled={state.uploading}>{state.uploading ? '上传中…' : '上传文件'}</button><button className="secondary-button" onClick={() => void process(config.kind, config)} disabled={!state.batch || state.processing}>{state.processing ? '处理中…' : config.kind === 'costs' ? '匹配成本' : '开始处理'}</button></div>
            {state.error && <div className="import-error">{state.error}</div>}
            {state.batch && <div className="batch-result"><div className="batch-result-title"><strong>{state.duplicate ? '文件已导入过' : '文件已上传'}</strong><span className={`status-pill ${state.batch.status.toLowerCase()}`}>{statusLabel(state.batch.status)}</span></div><div className="batch-stats"><span>总行数 <b>{state.batch.totalRows}</b></span><span>成功 <b>{state.batch.successRows}</b></span><span>失败 <b>{state.batch.failedRows}</b></span></div><small>批次：{state.batch.id}</small>{state.batch.errors?.slice(0, 2).map((error, index) => <p className="batch-warning" key={`${error.rowNumber}-${index}`}>{error.rowNumber ? `第 ${error.rowNumber} 行：` : ''}{error.message}</p>)}</div>}
            {resultEntries.length > 0 && <div className="process-result"><strong>处理结果</strong><div>{resultEntries.map(([key, value]) => <span key={key}>{config.resultLabels[key]} <b>{String(value)}</b></span>)}</div></div>}
          </article>;
        })}
      </div>
    </section>
  );
}
