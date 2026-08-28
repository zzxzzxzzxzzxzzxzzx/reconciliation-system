'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

type CostVersion = {
  id: string;
  batchId: string;
  status: string;
  effectiveFrom: string | null;
  sourceFileName: string;
  sourceType: 'FILE' | 'MANUAL';
  createdAt: string;
  costRowCount: number;
  snapshotCount: number;
};

type CostItem = {
  id: string;
  productId: string;
  merchantCode: string;
  productName: string | null;
  unitCost: string | null;
  remark: string | null;
  rowNumber: number;
};

type ChangeType = 'ADD' | 'CORRECT';

type CostForm = {
  productId: string;
  merchantCode: string;
  productName: string;
  unitCost: string;
  reason: string;
  effectiveFrom: string;
};

const emptyForm: CostForm = {
  productId: '',
  merchantCode: '',
  productName: '',
  unitCost: '',
  reason: '',
  effectiveFrom: '',
};

function formatDate(value: string | null) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function formatDay(value: string | null) {
  if (!value) return '未指定';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(value));
}

async function getError(response: Response) {
  try {
    const payload = await response.json() as { message?: string | string[] };
    return Array.isArray(payload.message) ? payload.message.join('；') : payload.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export default function CostVersionWorkspace() {
  const [versions, setVersions] = useState<CostVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [items, setItems] = useState<CostItem[]>([]);
  const [itemTotal, setItemTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [query, setQuery] = useState('');
  const [changeType, setChangeType] = useState<ChangeType>('ADD');
  const [form, setForm] = useState<CostForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.id === selectedVersionId) ?? null,
    [selectedVersionId, versions],
  );

  const loadVersions = useCallback(async (preferredVersionId?: string) => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/costs/versions?page=1&pageSize=100`);
      if (!response.ok) throw new Error(await getError(response));
      const payload = await response.json() as { items: CostVersion[] };
      setVersions(payload.items);
      setSelectedVersionId((current) => {
        if (preferredVersionId && payload.items.some((item) => item.id === preferredVersionId)) return preferredVersionId;
        if (payload.items.some((item) => item.id === current)) return current;
        return payload.items[0]?.id ?? '';
      });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '成本版本加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadItems = useCallback(async (versionId: string, targetPage = 1, keyword = '') => {
    if (!versionId) {
      setItems([]);
      setItemTotal(0);
      return;
    }
    setLoadingItems(true);
    try {
      const params = new URLSearchParams({ page: String(targetPage), pageSize: '20' });
      if (keyword.trim()) params.set('query', keyword.trim());
      const response = await fetch(`${API_BASE}/costs/versions/${versionId}/items?${params}`);
      if (!response.ok) throw new Error(await getError(response));
      const payload = await response.json() as { items: CostItem[]; total: number; page: number; totalPages: number };
      setItems(payload.items);
      setItemTotal(payload.total);
      setPage(payload.page);
      setTotalPages(payload.totalPages);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '成本明细加载失败');
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadVersions(), 0);
    return () => window.clearTimeout(timer);
  }, [loadVersions]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(selectedVersionId, 1), 0);
    return () => window.clearTimeout(timer);
  }, [loadItems, selectedVersionId]);

  function switchChangeType(nextType: ChangeType) {
    setChangeType(nextType);
    setForm(emptyForm);
    setError(null);
    setSuccess(null);
  }

  function startCorrection(item: CostItem) {
    setChangeType('CORRECT');
    setForm({
      productId: item.productId,
      merchantCode: item.merchantCode,
      productName: item.productName ?? '',
      unitCost: item.unitCost ?? '',
      reason: '',
      effectiveFrom: '',
    });
    setError(null);
    setSuccess(null);
    document.getElementById('cost-maintenance-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedVersionId) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch(`${API_BASE}/costs/versions/${selectedVersionId}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeType, ...form }),
      });
      if (!response.ok) throw new Error(await getError(response));
      const created = await response.json() as { id: string; sourceFileName: string; costRowCount: number };
      await loadVersions(created.id);
      setQuery('');
      setForm(emptyForm);
      setSuccess(`已生成新成本版本，共 ${created.costRowCount} 条成本。旧版本和历史订单成本未修改。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '成本版本保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cost-version-workspace">
      <section className="cost-version-heading">
        <div><h2>成本版本</h2><p>新增或更正成本时生成完整新版本，历史订单继续使用原成本快照。</p></div>
        <strong>{versions.length} 个版本</strong>
      </section>

      {error && <div className="alert">{error}</div>}
      {success && <div className="cost-success" role="status">{success}</div>}

      <section className="cost-version-selector">
        <label><span>基础成本版本</span><select value={selectedVersionId} disabled={loading || versions.length === 0} onChange={(event) => { setSelectedVersionId(event.target.value); setQuery(''); setPage(1); }}><option value="">请选择成本版本</option>{versions.map((version) => <option key={version.id} value={version.id}>{version.sourceFileName}（{version.costRowCount} 条）</option>)}</select></label>
        {selectedVersion && <div className="cost-version-meta"><span>{selectedVersion.sourceType === 'MANUAL' ? '人工维护' : '文件导入'}</span><small>创建于 {formatDate(selectedVersion.createdAt)} · 适用日期 {formatDay(selectedVersion.effectiveFrom)}</small><a className="secondary-button" href={`${API_BASE}/imports/${selectedVersion.batchId}/raw-file`}>下载原始文件</a></div>}
      </section>

      <section className="cost-maintenance" id="cost-maintenance-form">
        <div className="section-heading"><div><h3>维护商品成本</h3><p>保存后生成新版本，不直接修改当前版本。</p></div><div className="cost-mode" role="group" aria-label="成本维护方式"><button type="button" className={changeType === 'ADD' ? 'active' : ''} onClick={() => switchChangeType('ADD')}>新增成本</button><button type="button" className={changeType === 'CORRECT' ? 'active' : ''} onClick={() => switchChangeType('CORRECT')}>更正成本</button></div></div>
        <form className="cost-form" onSubmit={(event) => void saveChange(event)}>
          <label><span>商品 ID</span><input required value={form.productId} onChange={(event) => setForm((current) => ({ ...current, productId: event.target.value }))} placeholder="订单表中的商品 ID" /></label>
          <label><span>商家编码</span><input required value={form.merchantCode} onChange={(event) => setForm((current) => ({ ...current, merchantCode: event.target.value }))} placeholder="订单表中的商家编码" /></label>
          <label><span>商品名称</span><input value={form.productName} onChange={(event) => setForm((current) => ({ ...current, productName: event.target.value }))} placeholder="便于识别，可不填" /></label>
          <label><span>单位成本</span><input required min="0" step="0.01" type="number" value={form.unitCost} onChange={(event) => setForm((current) => ({ ...current, unitCost: event.target.value }))} placeholder="0.00" /></label>
          {changeType === 'CORRECT' && <label><span>开始适用日期</span><input required type="date" value={form.effectiveFrom} onChange={(event) => setForm((current) => ({ ...current, effectiveFrom: event.target.value }))} /></label>}
          <label className="cost-reason"><span>{changeType === 'ADD' ? '补充原因' : '更正原因'}</span><input required value={form.reason} onChange={(event) => setForm((current) => ({ ...current, reason: event.target.value }))} placeholder="说明为什么需要新增或更正" /></label>
          <button className="primary-button" disabled={saving || !selectedVersionId}>{saving ? '保存中…' : '生成新成本版本'}</button>
        </form>
      </section>

      <section className="content-panel cost-items-panel">
        <div className="panel-heading"><div><h2>版本商品明细</h2><p>共 {itemTotal} 条，商品 ID 与商家编码共同决定匹配对象。</p></div><div className="cost-item-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索商品 ID、商家编码或名称" /><button className="secondary-button" onClick={() => void loadItems(selectedVersionId, 1, query)}>查询</button></div></div>
        <div className="table-wrap"><table><thead><tr><th>商品 ID</th><th>商家编码</th><th>商品名称</th><th>单位成本</th><th>备注</th><th>原始行号</th><th aria-label="操作" /></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.productId}</td><td>{item.merchantCode || '-'}</td><td>{item.productName || '-'}</td><td>{item.unitCost === null ? '-' : `¥${item.unitCost}`}</td><td>{item.remark || '-'}</td><td>{item.rowNumber}</td><td><button className="detail-button" onClick={() => startCorrection(item)}>更正</button></td></tr>)}{!loadingItems && items.length === 0 && <tr><td className="empty" colSpan={7}>当前版本没有符合条件的商品成本</td></tr>}</tbody></table></div>
        {totalPages > 1 && <nav className="pagination" aria-label="成本商品分页"><span className="pagination-summary">第 {page} / {totalPages} 页</span><div className="pagination-controls"><button className="page-button" disabled={page <= 1} onClick={() => void loadItems(selectedVersionId, page - 1, query)}>上一页</button><button className="page-button" disabled={page >= totalPages} onClick={() => void loadItems(selectedVersionId, page + 1, query)}>下一页</button></div></nav>}
      </section>
    </div>
  );
}
