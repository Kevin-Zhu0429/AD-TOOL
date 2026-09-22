import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { PRICE_ALL_FIELDS, DAILY_KEYS, dailyDates, normalizePriceRow, parsePriceSheet, priceTemplateHeaders } from '../../../shared/priceStrategy.js';
import AppDialog, { useConfirm } from './AppDialog.jsx';
import { AbaPagination } from './AbaTable.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';

const latestCompleteDay = () => new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const groups = [
  ['身份与库存', ['date','asin','sku','style','size','color','fabric','skc','nameZh','totalStock','availableStock','inboundStock']],
  ['销量与流量', ['totalSales','salesThroughLastMonth','monthlySales','monthlyOrders','sales7d','orders7d','adSales7d','adOrders7d','movement7d','movementSpeed7d','clicks7d','conversion7d']],
  ['售价与利润', ['price','promoPrice','currentProfit','monthlyMargin','monthlyAdRatio']],
  ['趋势与周转', ['lastWeekComparison','weekOverWeek','turnoverWeeks','estimatedSelloutDate','movement3d',...DAILY_KEYS]],
];
const fieldByKey = Object.fromEntries(PRICE_ALL_FIELDS.map((field) => [field.key, field]));
const shownValue = (value) => value === null || value === undefined || value === '' ? '—' : String(value);

function download(rows, filename, headers) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '价格策略');
  XLSX.writeFile(book, filename);
}

export default function PriceStrategyPage() {
  const fileRef = useRef(null);
  const [date, setDate] = useState(latestCompleteDay());
  const [items, setItems] = useState([]), [dates, setDates] = useState([]), [syncState, setSyncState] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [query, setQuery] = useState(''), [page, setPage] = useState(1), [pageSize, setPageSize] = useState(50);
  const [editor, setEditor] = useState(null), [upload, setUpload] = useState(null);
  const [confirmAction, confirmDialog] = useConfirm();

  async function load(selectedDate = date) {
    setLoading(true); setError('');
    try { const data = await api.priceStrategy(selectedDate); setItems(data.items); setDates(data.dates); setSyncState(data.sync); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(date); }, [date]);
  useEffect(() => { setPage(1); }, [date, query]);
  const filtered = useMemo(() => items.filter((row) => !query || [row.sku,row.asin,row.skc,row.nameZh,row.style,row.color,row.size]
    .some((value) => String(value ?? '').toLowerCase().includes(query.trim().toLowerCase()))), [items, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const headers = priceTemplateHeaders(date);

  async function save() {
    setError('');
    let row;
    try { row = normalizePriceRow(editor); } catch (err) { setError(err.message); return; }
    if (editor.id && (editor.sku !== items.find((item) => item.id === editor.id)?.sku || editor.date !== date)) {
      setError('编辑时不能更改日期或 SKU；请新建记录。'); return;
    }
    setBusy(true);
    try { await api.savePriceStrategy([row]); setEditor(null); setMessage('价格策略记录已保存'); await load(date); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(row) {
    if (!await confirmAction(`删除 ${row.date} 的 SKU ${row.sku} 价格策略记录？此操作无法撤销。`, '确认删除')) return;
    setBusy(true); setError('');
    try { await api.deletePriceStrategy(row.id); setMessage('记录已删除'); await load(date); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function readFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
      const sheet = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: '' });
      const rows = parsePriceSheet(sheet, date);
      setUpload({ filename: file.name, rows });
    } catch (err) { setError(err.message); }
  }
  async function importRows() {
    setBusy(true); setError('');
    try { const result = await api.savePriceStrategy(upload.rows); setUpload(null); setMessage(`已导入 ${result.count} 行`); await load(date); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function syncNow() {
    setBusy(true); setError(''); setMessage('');
    try { const result = await api.syncPriceStrategy(date); setMessage(`船长同步完成：${result.channels} 个店铺，${result.skus} 个 SKU。${result.unmappedAds ? `${result.unmappedAds} 条广告记录未匹配 SKU。` : ''}`); await load(date); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const labels = (key, valueDate = editor?.date || date) => DAILY_KEYS.includes(key)
    ? `${dailyDates(valueDate)[DAILY_KEYS.indexOf(key)] ?? '第' + (DAILY_KEYS.indexOf(key) + 1) + '天'}销量`
    : fieldByKey[key].label;

  return <div className="lib price-strategy animate-in">
    <div className="lib-head"><div><h1>价格策略表 <span className="tag blue">US 站</span></h1>
      <p className="hint">店铺共享的每日 SKU 快照。船长自动填销量、广告点击/订单和可售/在途库存；利润和总库存按录入值保存。</p></div>
      <div className="row wrap"><button className="btn" onClick={() => download([
        PRICE_ALL_FIELDS.map((field) => field.key === 'date' ? date : field.key === 'marketplace' ? 'US' : field.key === 'sku' ? 'PET-SKU-001' : '')
      ], '价格策略模板.xlsx', headers)}>下载模板</button>
        <button className="btn" type="button" onClick={() => fileRef.current?.click()}>导入 Excel</button><input ref={fileRef} className="price-file" type="file" accept=".xlsx,.xls,.csv" onChange={readFile} tabIndex={-1} aria-hidden="true" />
        <button className="btn" disabled={busy || !syncState?.configured} onClick={syncNow}>{busy ? '正在同步…' : '同步船长数据'}</button>
        <button className="btn primary" onClick={() => { setError(''); setEditor({ date, marketplace: 'US' }); }}>添加记录</button></div></div>
    <p className="hint">{syncState?.configured ? `北京时间每天 10 时后自动同步前一天数据。上次成功：${syncState.lastSuccess ? `${syncState.lastSuccess.date}，${syncState.lastSuccess.completedAt}` : '尚未同步'}` : '船长 API 未配置；可以先手动录入或导入。'} 动销速度＝近7日销量÷7；周转周数＝总库存÷近7日销量；预估售罄日按该速度推算；7天环比＝本期销量与前7日相比；转化率＝广告订单数÷广告点击数。利润、费比和广告销量暂无可靠自动口径。</p>
    {syncState?.lastError && <p className="note err" role="status">上次同步失败：{syncState.lastError.message}。可核对船长授权后手动重试。</p>}
    {message && <p className="note ok" role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    <section className="card">
      <div className="row wrap price-toolbar"><label>快照日期 <input className="inp" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>SKU / ASIN / 款式搜索 <input className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入关键词" /></label>
        <div className="spacer" /><button className="btn" disabled={!filtered.length} onClick={() => download(filtered.map((row) => PRICE_ALL_FIELDS.map((field) => row[field.key] ?? '')), `价格策略_${date}.xlsx`, headers)}>导出筛选结果</button></div>
      <p className="hint">{dates.length ? `已有数据日期：${dates.map((entry) => `${entry.date}（${entry.count}）`).join('、')}` : '尚无记录。可下载模板后导入，或手动添加。'} 同日期同 SKU 再导入会更新该行。</p>
      {loading ? <p role="status">正在加载价格策略表…</p> : !filtered.length ? <p className="note">{query ? '当前筛选没有结果。' : '该日期没有记录。'}</p> : <>
        <div className="scroll price-table" role="region" tabIndex={0} aria-label="价格策略表，可横向滚动"><table className="tbl"><thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}<th>操作</th></tr></thead>
          <tbody>{visible.map((row) => <tr key={row.id}>{PRICE_ALL_FIELDS.map((field) => <td key={field.key} className={field.key === 'sku' ? 'price-sku' : ''}>{shownValue(row[field.key])}</td>)}<td><div className="row"><button className="btn sm" onClick={() => { setError(''); setEditor({ ...row }); }}>编辑</button><button className="btn sm danger" onClick={() => remove(row)}>删除</button></div></td></tr>)}</tbody></table></div>
        <AbaPagination data={{ total: filtered.length, page: currentPage, pageSize, pageCount }} onChange={(patch) => { if (patch.pageSize) setPageSize(patch.pageSize); setPage(patch.page ?? 1); }} />
      </>}
    </section>
    {editor && <AppDialog title={editor.id ? `编辑 ${editor.sku}` : '添加价格策略记录'} wide busy={busy} onClose={() => setEditor(null)}>
      <form noValidate onSubmit={(event) => { event.preventDefault(); save(); }}>
        {groups.map(([title, keys]) => <fieldset className="price-fieldset" key={title}><legend>{title}</legend><div className="price-fields">{keys.map((key) => {
          const field = fieldByKey[key], numeric = ['integer','number','money','signedMoney','percent'].includes(field.type);
          const signed = ['currentProfit','monthlyMargin','lastWeekComparison','weekOverWeek'].includes(key);
          return <label className="field" key={key}><span>{labels(key)}{key === 'sku' ? ' *' : ''}</span><input className="inp" type={field.type === 'date' ? 'date' : numeric ? 'number' : 'text'} min={numeric && !signed ? 0 : undefined} step={field.type === 'integer' ? 1 : numeric ? 'any' : undefined} value={editor[key] ?? ''} disabled={busy || !!editor.id && ['date','sku'].includes(key)} onChange={(event) => setEditor({ ...editor, [key]: event.target.value })} /></label>;
        })}</div></fieldset>)}
        {error && <p className="note err" role="alert">{error}</p>}
        <footer className="row"><div className="spacer" /><button className="btn" type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={busy}>{busy ? '正在保存…' : '保存记录'}</button></footer>
      </form>
    </AppDialog>}
    {upload && <AppDialog title="核对价格策略导入" wide busy={busy} onClose={() => setUpload(null)}>
      <p>文件：{upload.filename}，共 {upload.rows.length} 行。相同日期和 SKU 会更新；其他记录保留。</p>
      <div className="scroll price-preview"><table className="tbl"><thead><tr><th>日期</th><th>SKU</th><th>售价</th><th>本月销量</th></tr></thead><tbody>{upload.rows.slice(0,10).map((row) => <tr key={`${row.date}:${row.sku}`}><td>{row.date}</td><td>{row.sku}</td><td>{shownValue(row.price)}</td><td>{shownValue(row.monthlySales)}</td></tr>)}</tbody></table></div>
      {error && <p className="note err" role="alert">{error}</p>}
      <footer className="row"><div className="spacer" /><button className="btn" disabled={busy} onClick={() => setUpload(null)}>取消</button><button className="btn primary" disabled={busy} onClick={importRows}>{busy ? '正在导入…' : '确认导入'}</button></footer>
    </AppDialog>}
    {confirmDialog}
  </div>;
}
