'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const ACCOUNTS = ['小象汉字01', '百香果01', '朱颜'];
type Spend = { id: string; accountName: string; spendDate: string; totalSpend: string | null; nonGiftSpend: string | null; giftSpend: string | null; redPacketSpend: string | null; discountSpend: string | null; sharedWalletSpend: string | null; sharedGiftSpend: string | null; sourceFileName: string };
type Summary = Record<string, string | number>;

function amount(value: string | null | undefined) { return value == null ? '-' : `¥${Number(value).toFixed(2)}`; }
async function errorMessage(response: Response) {
  try { const body = await response.json() as { message?: string | string[] }; return Array.isArray(body.message) ? body.message.join('；') : body.message ?? `请求失败（${response.status}）`; } catch { return `请求失败（${response.status}）`; }
}

export default function QianchuanWorkspace() {
  const [accountName, setAccountName] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<Spend[]>([]);
  const [summary, setSummary] = useState<Summary>({});
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (accountName) params.set('accountName', accountName);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return params;
  }, [accountName, from, to]);

  const load = useCallback(async (nextPage = 1) => {
    setLoading(true); setError(null);
    try {
      const listParams = new URLSearchParams(query); listParams.set('page', String(nextPage)); listParams.set('pageSize', '20');
      const [listResponse, summaryResponse] = await Promise.all([fetch(`${API_BASE}/qianchuan?${listParams}`), fetch(`${API_BASE}/qianchuan/summary?${query}`)]);
      if (!listResponse.ok) throw new Error(await errorMessage(listResponse));
      if (!summaryResponse.ok) throw new Error(await errorMessage(summaryResponse));
      const list = await listResponse.json() as { items: Spend[]; total: number; page: number; totalPages: number };
      setItems(list.items); setTotal(list.total); setPage(list.page); setTotalPages(list.totalPages); setSummary(await summaryResponse.json() as Summary);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : '千川数据加载失败'); }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function upload() {
    if (!accountName) { setError('请先选择千川账号'); return; }
    if (!file) { setError('请先选择千川消耗表'); return; }
    setUploading(true); setError(null); setMessage(null);
    try {
      const body = new FormData(); body.append('file', file);
      const params = new URLSearchParams({ accountName });
      const response = await fetch(`${API_BASE}/qianchuan/import?${params}`, { method: 'POST', body });
      if (!response.ok) throw new Error(await errorMessage(response));
      const result = await response.json() as { duplicate?: boolean; restored?: boolean; batch?: { successRows: number; failedRows: number; sourceFileName: string } };
      setMessage(result.duplicate ? (result.restored ? '文件已导入过，已恢复原批次。' : '文件已导入过，当前批次已存在，无需重复导入。') : `导入完成：成功 ${result.batch?.successRows ?? 0} 行，失败 ${result.batch?.failedRows ?? 0} 行。`);
      setFile(null); await load(1);
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : '千川文件导入失败'); }
    finally { setUploading(false); }
  }

  async function exportCsv() {
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/qianchuan/export?${query}`);
      if (!response.ok) throw new Error(await errorMessage(response));
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'qianchuan-spend.csv';
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (exportError) { setError(exportError instanceof Error ? exportError.message : '导出失败'); }
  }

  return <section className="qianchuan-workspace" aria-label="千川消耗">
    <div className="qianchuan-heading"><div><span className="eyebrow">QIANCHUAN / SPEND</span><h2>千川消耗</h2><p>按千川账号和日期查看每日广告消耗。</p></div><button className="secondary-button" onClick={() => void load(page)} disabled={loading}>{loading ? '刷新中…' : '刷新数据'}</button></div>
    {error && <div className="import-error">{error}</div>}
    {message && <div className="qianchuan-success">{message}</div>}
    <section className="qianchuan-import"><div><h3>导入千川消耗表</h3><p>每个文件对应一个账号；文件中的“总计”行会自动跳过。</p></div><div className="qianchuan-import-form"><label><span>千川账号</span><select value={accountName} onChange={(event) => { setAccountName(event.target.value); setError(null); setMessage(null); }}><option value="">请选择账号</option>{ACCOUNTS.map((account) => <option key={account}>{account}</option>)}</select></label><label><span>消耗表文件</span><input type="file" accept=".csv,.xlsx" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(null); setMessage(null); }} /></label><button className="primary-button" onClick={() => void upload()} disabled={uploading}>{uploading ? '导入中…' : '导入文件'}</button></div></section>
    <p className="qianchuan-notice">千川消耗当前独立统计，不分摊到订单、商品或直播场次，也不计入订单利润。</p>
    <section className="qianchuan-filters"><label><span>账号</span><select value={accountName} onChange={(event) => { setAccountName(event.target.value); setPage(1); }}><option value="">全部账号</option>{ACCOUNTS.map((account) => <option key={account}>{account}</option>)}</select></label><label><span>开始日期</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label><label><span>结束日期</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label><button className="secondary-button" onClick={() => void load(1)}>查询</button><button className="secondary-button" onClick={() => void exportCsv()} disabled={!total}>导出查询结果</button></section>
    <section className="qianchuan-summary"><Metric label="总消耗" value={amount(String(summary.totalSpend ?? '0'))} /><Metric label="非赠款消耗" value={amount(String(summary.nonGiftSpend ?? '0'))} /><Metric label="赠款消耗" value={amount(String(summary.giftSpend ?? '0'))} /><Metric label="红包及共享消耗" value={amount(String(Number(summary.redPacketSpend ?? 0) + Number(summary.discountSpend ?? 0) + Number(summary.sharedWalletSpend ?? 0) + Number(summary.sharedGiftSpend ?? 0)))} /></section>
    <section className="content-panel qianchuan-table-panel"><div className="panel-heading"><div><h2>每日消耗明细</h2><p>共 {total} 条记录</p></div></div><div className="table-wrap"><table><thead><tr><th>账号</th><th>日期</th><th>总消耗</th><th>非赠款</th><th>赠款</th><th>消返红包</th><th>立减红包</th><th>共享钱包</th><th>共享赠款</th><th>来源文件</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.accountName}</td><td>{item.spendDate.slice(0, 10)}</td><td>{amount(item.totalSpend)}</td><td>{amount(item.nonGiftSpend)}</td><td>{amount(item.giftSpend)}</td><td>{amount(item.redPacketSpend)}</td><td>{amount(item.discountSpend)}</td><td>{amount(item.sharedWalletSpend)}</td><td>{amount(item.sharedGiftSpend)}</td><td title={item.sourceFileName}>{item.sourceFileName}</td></tr>)}{!loading && !items.length && <tr><td className="empty" colSpan={10}>暂无千川消耗数据</td></tr>}</tbody></table></div>{totalPages > 1 && <div className="pagination"><span className="pagination-summary">第 {page} / {totalPages} 页</span><div className="pagination-controls"><button className="page-button" disabled={page <= 1} onClick={() => void load(page - 1)}>上一页</button><button className="page-button" disabled={page >= totalPages} onClick={() => void load(page + 1)}>下一页</button></div></div>}</section>
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>当前筛选范围</small></article>; }
