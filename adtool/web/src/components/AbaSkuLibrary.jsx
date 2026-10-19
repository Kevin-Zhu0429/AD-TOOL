import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ABA_SKU_COLUMNS, parseAbaSkuSheets } from '../../../shared/abaSkuLibrary.js';
import { AbaPagination } from './AbaTable.jsx';

export default function AbaSkuLibrary({ status, onSaved }) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState({ country: '', brand: '', q: '', page: 1, pageSize: 25 });
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const searchRef = useRef(null), fileRef = useRef(null), mounted = useRef(false), busyRef = useRef(false);
  const [composing, setComposing] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (composing || search === filters.q) return;
    const timer = setTimeout(() => setFilters((old) => ({ ...old, q: search, page: 1 })), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, filters.q, composing]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    api.abaSkus(filters, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, open, revision]);
  async function template() {
    try {
      const XLSX = await import('xlsx');
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([ABA_SKU_COLUMNS.map((c) => c.label)]), 'ABA SKU库');
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
        ['填写说明'], ['必填：国家、品牌、SKU、ASIN、墨盒型号；颜色 / 套组选填。'],
        ['国家可填写 ES、DE、FR、IT、UK、US、CA、AU、AE 或对应中文国家名。'],
        ['一张表可包含全部市场，也可按工作表分国家；每张数据表都保留模板表头。'],
        ['墨盒型号填写 305 / 305XL 等墨盒系列，不填写 ENVY6000 等打印机机型。'],
        ['按国家＋品牌＋SKU 新增或更新，表外旧记录保留；同一文件中的冲突会阻止整批保存。'],
        ['首次保存后，普通和公共 ABA 统一使用此库，不再读取个人 SKU 库。'],
      ]), '填写说明');
      XLSX.writeFile(book, 'ABA专用SKU库模板.xlsx');
    } catch (err) { setError(err.message || '模板下载失败，请重试'); }
  }
  async function choose(file) {
    if (!file || busyRef.current) return;
    busyRef.current = true; setBusy('正在读取并检查文件…'); setPending(null); setError(''); setMessage('');
    try {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name) || file.size > 30 * 1024 * 1024) throw new Error('请选择不超过 30 MB 的 XLSX / XLS / CSV 文件');
      const XLSX = await import('xlsx');
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: 50002 });
      const rows = parseAbaSkuSheets(book.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '', raw: false }) })));
      const preview = await api.previewAbaSkus(rows);
      if (mounted.current) setPending({ rows, filename: file.name, preview });
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function save() {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy('正在保存全部市场的 SKU…'); setError(''); setMessage('');
    try {
      const result = await api.importAbaSkus(pending.rows, pending.filename);
      if (!mounted.current) return;
      setMessage(`保存完成：新增 ${result.added} 条，更新 ${result.updated} 条。表外旧记录保留，普通和公共 ABA 已统一使用专用库。`);
      setPending(null); setRevision((n) => n + 1); onSaved();
    } catch (err) { if (mounted.current) setError(`${err.message}。文件预览仍保留，可重试；如请求中断，可先刷新库确认结果。`); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  }
  return <details className="aba-sku-library" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>ABA 专用 SKU 库（全部市场）<span className="hint">{status?.enabled || data?.enabled ? ` · 已启用 · ${data?.libraryTotal ?? status?.total} 条` : ' · 首次上传后启用'}</span></summary>
    <p className="hint">超级管理员统一维护，普通与公共 ABA 共用。用于 ASIN、品牌、墨盒型号和 SKU 的关联及校验；广告与库存使用的个人 SKU 库独立维护。</p>
    <p className="hint">{data?.enabled ? `已收录 ${data.libraryTotal} 条 · ${data.countries.map((c) => `${c.country} ${c.count} 条`).join(' · ')} · 最近上传 ${data.filename}` : '尚未启用专用库，报告暂沿用原关联。首次成功保存后，全部市场统一切换；未收录的 ASIN 会提示补充，不再回退个人 SKU 库。'}</p>
    {data?.canManage ? <div className="aba-sku-upload">
      <div className="aba-toolbar"><button className="btn" disabled={!!busy} onClick={template}>下载 SKU 模板</button>
        <button className="btn" disabled={!!busy} onClick={() => fileRef.current?.click()}>选择全部市场 SKU 表</button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => choose(e.target.files?.[0])} />
      </div>
      <p className="hint">必填：国家、品牌、SKU、ASIN、墨盒型号；颜色 / 套组选填。支持多工作表，最多 50,000 条、30 MB。按国家＋品牌＋SKU 新增或更新，保留表外旧记录。</p>
      {pending && <div className="aba-sku-preview"><strong>{pending.filename}</strong><p>已检查 {pending.preview.count} 条 · 预计新增 {pending.preview.added} 条、更新 {pending.preview.updated} 条 · 相同重复行 {pending.preview.duplicates} 条</p><p className="hint">{pending.preview.counts.map((c) => `${c.country}：${c.count} 条`).join(' · ')}</p>
        <button className="btn primary" disabled={!!busy} onClick={save}>保存到 ABA 专用库</button>{' '}<button className="btn ghost" disabled={!!busy} onClick={() => setPending(null)}>取消本次上传</button>
      </div>}
    </div> : data && <p className="hint">仅超级管理员可上传和更新；发现资料缺失时，请联系超级管理员统一补充。</p>}
    {!!busy && <p role="status">{busy}</p>}{message && <p role="status">{message}</p>}
    {error && <p className="aba-error-text" role="alert">{error} <button className="btn" disabled={!!busy} onClick={() => { setRevision((n) => n + 1); onSaved(); }}>刷新库</button></p>}
    <div className="aba-toolbar">
      <label>SKU 库国家<select className="inp" aria-label="SKU 库国家" value={filters.country} onChange={(e) => setFilters((old) => ({ ...old, country: e.target.value, brand: '', page: 1 }))}><option value="">全部国家</option>{data?.marketplaces.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      <label>SKU 库品牌<select className="inp" aria-label="SKU 库品牌" value={filters.brand} onChange={(e) => setFilters((old) => ({ ...old, brand: e.target.value, page: 1 }))}><option value="">全部品牌</option>{data?.brands.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></label>
      <label>搜索 SKU / ASIN / 型号<div className="aba-search-control"><input ref={searchRef} className="inp" aria-label="搜索 ABA 专用 SKU" value={search} onChange={(e) => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) setFilters((old) => ({ ...old, q: search, page: 1 })); }} />{search && <button className="btn ghost" onClick={() => { setSearch(''); setFilters((old) => ({ ...old, q: '', page: 1 })); searchRef.current?.focus(); }}>清除 SKU 搜索</button>}</div></label>
    </div>
    {loading ? <p role="status">正在读取专用 SKU 库…</p> : data && <>
      <div className="aba-table-scroll aba-sku-scroll" role="region" tabIndex={0} aria-label="ABA 专用 SKU 库，可横向滚动"><table className="aba-table"><thead><tr>{ABA_SKU_COLUMNS.map((c) => <th scope="col" key={c.key}>{c.label}</th>)}</tr></thead><tbody>{data.items.map((row) => <tr key={row.id}>{ABA_SKU_COLUMNS.map((c) => <td key={c.key}>{row[c.key] || '—'}</td>)}</tr>)}{!data.items.length && <tr><td colSpan={6}>{data.enabled ? '当前筛选下没有 SKU。可调整筛选，或联系超级管理员补充。' : '尚未上传 ABA 专用 SKU。请由超级管理员下载模板并统一上传。'}</td></tr>}</tbody></table></div>
      <AbaPagination data={data} onChange={(patch) => setFilters((old) => ({ ...old, ...patch }))} />
    </>}
  </details>;
}
