'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  supplementDataTypeByTarget,
  type ReconciliationDataTarget,
  type ReconciliationSourceIssue,
} from './reconciliation-data-target';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type Batch = {
  id: string;
  dataType: string;
  status: string;
  sourceFileName: string;
  successRows: number;
  createdAt: string;
  archivedAt?: string | null;
  _count?: Record<string, number>;
};

type Task = {
  id: string;
  accountingMonth: string;
  status: 'READY' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  errorMessage: string | null;
  createdAt: string;
  orderBatch: Batch;
  settlementBatch: Batch;
  costBatch: Batch | null;
  liveBatch: Batch | null;
  sourceIssueKey: string | null;
  sourceIssueType: string | null;
  sourceIssueOrderNo: string | null;
  supplementTarget: string | null;
  archivedAt?: string | null;
  orderBatchReused?: boolean;
  orderBatchReuseMessage?: string;
  duplicate?: boolean;
  duplicateMessage?: string;
  canDelete?: boolean;
  deleteBlockedReason?: string | null;
  duplicateCount?: number;
};

const typeConfig = [
  { key: 'orderBatchId', dataType: 'DOUYIN_ORDER', label: '订单表', required: true, endpoint: '/imports/orders' },
  { key: 'settlementBatchId', dataType: 'DOUYIN_SETTLEMENT', label: '结算表', required: true, endpoint: '/imports/settlements' },
  { key: 'costBatchId', dataType: 'DOUYIN_COST', label: '成本表', required: false, endpoint: '/imports/costs' },
  { key: 'liveBatchId', dataType: 'DOUYIN_LIVE', label: '直播表', required: false, endpoint: '/imports/live-sessions' },
] as const;

const taskStatusLabels: Record<Task['status'], string> = { READY: '待运行', PROCESSING: '处理中', COMPLETED: '已完成', FAILED: '失败' };

type ReconciliationTaskWorkspaceProps = {
  onViewResults: (result: { orderBatchId: string; settlementBatchId: string }) => void;
  initialOrderBatchId?: string;
  initialTarget?: ReconciliationDataTarget;
  initialSourceIssue?: ReconciliationSourceIssue;
  initialTaskId?: string;
};

const issueLabels: Record<string, string> = {
  SPLIT_AMBIGUOUS: '商品拆分待确认',
  PRODUCT_ID_MISSING: '商品 ID 缺失',
  PRODUCT_UNMATCHED: '商品无法匹配',
  COST_MISSING: '缺成本',
  COST_CONFLICT: '成本冲突',
  ORDER_WITHOUT_SETTLEMENT: '未结算',
  SETTLEMENT_WITHOUT_ORDER: '缺订单',
  LIVE_SESSION_CONFLICT: '直播冲突',
  ORDER_TIME_MISSING: '缺少下单时间',
};

const supplementTargetLabels: Record<string, string> = {
  DOUYIN_ORDER: '订单表',
  DOUYIN_SETTLEMENT: '结算表',
  DOUYIN_COST: '成本表',
  DOUYIN_LIVE: '直播表',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

async function getError(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[] };
    return Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export default function ReconciliationTaskWorkspace({ onViewResults, initialOrderBatchId, initialTarget, initialSourceIssue, initialTaskId }: ReconciliationTaskWorkspaceProps) {
  const [month, setMonth] = useState('2026-07');
  const [batches, setBatches] = useState<Batch[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [uploadingType, setUploadingType] = useState('');
  const [runningId, setRunningId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [batchSearch, setBatchSearch] = useState<Record<string, string>>({});
  const [createdMessage, setCreatedMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [batchResponse, taskResponse] = await Promise.all([fetch(`${API_BASE}/imports`), fetch(`${API_BASE}/reconciliation-tasks?includeArchived=${showArchived}`)]);
      if (!batchResponse.ok) throw new Error(await getError(batchResponse));
      if (!taskResponse.ok) throw new Error(await getError(taskResponse));
      const availableBatches = (await batchResponse.json() as Batch[]).filter((batch) => batch.status !== 'FAILED' && batch.successRows > 0);
      setBatches(availableBatches);
      setTasks(await taskResponse.json() as Task[]);
      setSelection((current) => {
        const next = { ...current };
        for (const config of typeConfig) {
          if (config.key === 'orderBatchId' && initialOrderBatchId && availableBatches.some((batch) => batch.id === initialOrderBatchId && batch.dataType === config.dataType)) {
            next[config.key] = initialOrderBatchId;
          } else if (!availableBatches.some((batch) => batch.id === next[config.key] && batch.dataType === config.dataType)) {
            next[config.key] = availableBatches.filter((batch) => batch.dataType === config.dataType).sort((a, b) => b.successRows - a.successRows || b.createdAt.localeCompare(a.createdAt))[0]?.id ?? '';
          }
        }
        return next;
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '对账任务加载失败');
    } finally {
      setLoading(false);
    }
  }, [initialOrderBatchId, showArchived]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  useEffect(() => {
    if (!initialTaskId || loading) return;
    document.getElementById(`task-${initialTaskId}`)?.scrollIntoView({ block: 'center' });
  }, [initialTaskId, loading]);

  const batchesByType = useMemo(() => Object.fromEntries(typeConfig.map((config) => [config.dataType, batches.filter((batch) => batch.dataType === config.dataType)])) as Record<string, Batch[]>, [batches]);
  const filteredBatchesByType = useMemo(() => Object.fromEntries(typeConfig.map((config) => {
    const keyword = (batchSearch[config.key] ?? '').trim().toLowerCase();
    const typeBatches = batchesByType[config.dataType] ?? [];
    return [config.dataType, keyword ? typeBatches.filter((batch) => batch.sourceFileName.toLowerCase().includes(keyword)) : typeBatches];
  })) as Record<string, Batch[]>, [batchSearch, batchesByType]);

  async function createTask() {
    setCreating(true);
    setError(null);
    setCreatedMessage(null);
    try {
      const response = await fetch(`${API_BASE}/reconciliation-tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountingMonth: month, ...selection, sourceIssueId: initialSourceIssue?.id, supplementTarget: initialSourceIssue && initialTarget ? supplementDataTypeByTarget[initialTarget] : undefined }) });
      if (!response.ok) throw new Error(await getError(response));
      const task = await response.json() as Task;
      await loadData();
      setCreatedMessage(task.duplicate
        ? (task.duplicateMessage ?? '相同对账任务已存在，未重复创建')
        : task.orderBatchReused
        ? `${task.orderBatchReuseMessage ?? '已自动使用原订单批次'}。对账任务已创建。`
        : task.sourceIssueKey
          ? '补充任务已创建。请点击“开始对账”，完成后查看新结果。'
          : '对账任务已创建。');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建对账任务失败');
    } finally {
      setCreating(false);
    }
  }

  async function uploadBatch(config: typeof typeConfig[number], event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadingType(config.key);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`${API_BASE}${config.endpoint}`, { method: 'POST', body });
      if (!response.ok) throw new Error(await getError(response));
      const payload = await response.json() as { duplicate?: boolean; batch: Batch };
      await loadData();
      setSelection((current) => ({ ...current, [config.key]: payload.batch.id }));
      if (payload.duplicate) setError(`文件已导入过，已自动选中原批次：${payload.batch.sourceFileName}${(payload as { restored?: boolean }).restored ? '（已从归档中恢复）' : ''}`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : `${config.label}上传失败`);
    } finally {
      setUploadingType('');
    }
  }

  async function runTask(taskId: string) {
    setRunningId(taskId);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/reconciliation-tasks/${taskId}/run`, { method: 'POST' });
      if (!response.ok) throw new Error(await getError(response));
      const payload = await response.json() as { task: Task };
      setTasks((current) => current.map((task) => task.id === taskId ? payload.task : task));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '对账任务运行失败');
      await loadData();
    } finally {
      setRunningId('');
    }
  }

  async function archiveTask(task: Task) {
    setError(null);
    try {
      const action = task.archivedAt ? 'restore' : 'archive';
      const response = await fetch(`${API_BASE}/reconciliation-tasks/${task.id}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error(await getError(response));
      await loadData();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : '任务归档操作失败');
    }
  }

  async function deleteTask(task: Task) {
    if (!task.canDelete) return;
    if (!window.confirm('确认删除这条任务记录？只删除任务记录，不删除订单、结算、成本、直播文件和对账结果。')) return;
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/reconciliation-tasks/${task.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await getError(response));
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '任务删除失败');
    }
  }

  const canCreate = Boolean(month && selection.orderBatchId && selection.settlementBatchId);
  const targetConfig = initialTarget ? typeConfig.find((config) => config.key === initialTarget) : undefined;

  return <section className="task-workspace" aria-label="对账任务">
    <div className="task-heading"><div><span className="eyebrow">RECONCILIATION TASK / DOUYIN</span><h2>对账任务</h2><p>按月份绑定订单、结算、成本和直播批次，避免不同月份数据混用。</p></div><button className="secondary-button" onClick={() => void loadData()} disabled={loading}>{loading ? '加载中…' : '刷新任务'}</button></div>
    {error && <div className="import-error">{error}</div>}
    {createdMessage && <div className="task-success" role="status">{createdMessage}</div>}
    <section className="task-create-panel"><div className="section-heading"><div><h3>新建对账</h3><p>按结算时间归属月份；订单表和结算表必选，成本表、直播表可后续补充。</p></div></div>{targetConfig && <div className="task-context-notice" role="status">正在补充：{targetConfig.label}{initialSourceIssue ? `，来源异常：${issueLabels[initialSourceIssue.issueType] ?? initialSourceIssue.issueType}${initialSourceIssue.mainOrderNo ? `（订单 ${initialSourceIssue.mainOrderNo}）` : ''}` : ''}。导入后，请确认批次组合并创建新的对账任务，旧任务会保留用于追溯。</div>}<div className="task-form"><label><span>结算月份（对账归属月）</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>{typeConfig.map((config) => { const filteredBatches = filteredBatchesByType[config.dataType] ?? []; const selectedBatch = (batchesByType[config.dataType] ?? []).find((batch) => batch.id === selection[config.key]); const selectableBatches = selectedBatch && !filteredBatches.some((batch) => batch.id === selectedBatch.id) ? [selectedBatch, ...filteredBatches] : filteredBatches; return <div className={`task-field${config.key === initialTarget ? ' target-field' : ''}`} key={config.key}><label htmlFor={`task-search-${config.key}`}>{config.label}{config.required ? '' : '（可选）'}</label><div className="task-batch-control"><div className="task-batch-picker"><input id={`task-search-${config.key}`} aria-label={`搜索${config.label}`} placeholder={`搜索${config.label}文件名`} value={batchSearch[config.key] ?? ''} onChange={(event) => setBatchSearch((current) => ({ ...current, [config.key]: event.target.value }))} /><select id={`task-select-${config.key}`} aria-label={`选择${config.label}`} value={selection[config.key] ?? ''} onChange={(event) => setSelection((current) => ({ ...current, [config.key]: event.target.value }))}><option value="">{config.required ? `请选择${config.label}` : `暂不选择${config.label}`}</option>{selectableBatches.map((batch) => <option value={batch.id} key={batch.id}>{batch.sourceFileName}（{batch.successRows} 条，{formatDate(batch.createdAt)}）</option>)}</select>{filteredBatches.length === 0 && (batchesByType[config.dataType] ?? []).length > 0 && <small>没有匹配的{config.label}</small>}</div><input id={`task-upload-${config.key}`} className="task-upload-input" type="file" accept=".csv,.xlsx" disabled={uploadingType === config.key} onChange={(event) => void uploadBatch(config, event)} /><label className="task-upload-button" htmlFor={`task-upload-${config.key}`}>{uploadingType === config.key ? '上传中…' : '导入'}</label></div></div>; })}</div><div className="task-create-actions"><button className="primary-button" disabled={!canCreate || creating} onClick={() => void createTask()}>{creating ? '创建中…' : '创建对账任务'}</button></div></section>
    <section className="task-list-panel"><div className="section-heading"><div><h3>任务记录</h3><p>相同月份和批次只保留一条任务。归档只会隐藏记录，删除只删除任务记录，不会删除业务数据。</p></div><div className="section-heading-actions"><button className="secondary-button" onClick={() => setShowArchived((current) => !current)}>{showArchived ? '隐藏已归档' : '显示已归档'}</button><strong>{tasks.length} 个任务</strong></div></div><div className="task-list">{tasks.map((task) => <article id={`task-${task.id}`} className={`task-row${task.archivedAt ? ' archived-row' : ''}${task.id === initialTaskId ? ' target-task-row' : ''}`} key={task.id}><div className="task-month"><strong>{task.accountingMonth}</strong><span className={`status-pill ${task.status.toLowerCase()}`}>{taskStatusLabels[task.status]}</span>{task.duplicateCount && task.duplicateCount > 1 && <span className="status-pill archived">重复 {task.duplicateCount} 条</span>}{task.archivedAt && <span className="status-pill archived">已归档</span>}</div><div className="task-files">{task.sourceIssueKey && <strong className="task-source-issue">异常补充：{issueLabels[task.sourceIssueType ?? ''] ?? task.sourceIssueType} · {supplementTargetLabels[task.supplementTarget ?? ''] ?? '补充数据'}{task.sourceIssueOrderNo ? ` · 订单 ${task.sourceIssueOrderNo}` : ''}</strong>}<span>订单：{task.orderBatch.sourceFileName}</span><span>结算：{task.settlementBatch.sourceFileName}</span><span>成本：{task.costBatch?.sourceFileName ?? '未选择'}</span><span>直播：{task.liveBatch?.sourceFileName ?? '未选择'}</span><small>创建于 {formatDate(task.createdAt)}</small>{task.errorMessage && <small className="danger-text">{task.errorMessage}</small>}{task.deleteBlockedReason && <small>{task.deleteBlockedReason}</small>}</div><div className="task-row-actions">{!task.archivedAt && (task.status === 'COMPLETED' ? <button className="secondary-button" onClick={() => onViewResults({ orderBatchId: task.orderBatch.id, settlementBatchId: task.settlementBatch.id })}>{task.sourceIssueKey ? '查看新结果' : '查看结果'}</button> : <button className="primary-button" disabled={runningId === task.id || task.status === 'PROCESSING'} onClick={() => void runTask(task.id)}>{runningId === task.id ? '处理中…' : '开始对账'}</button>)}<button className="text-button" onClick={() => void archiveTask(task)}>{task.archivedAt ? '恢复' : '归档'}</button>{task.canDelete && <button className="text-button danger-text" onClick={() => void deleteTask(task)}>删除</button>}</div></article>)}{!loading && tasks.length === 0 && <p className="empty">还没有对账任务</p>}</div></section>
  </section>;
}
