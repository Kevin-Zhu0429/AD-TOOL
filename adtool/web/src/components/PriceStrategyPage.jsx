import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import SyncProgress from './SyncProgress.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const weekOf = (day) => WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()];
const slash = (day) => day.replaceAll('-', '/');
const fmt = (value, digits = 0) => value == null ? '' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
// 可售天数:30 天内断货标红,60 天内标黄
const urgency = (days) => days == null ? '' : days < 30 ? 'danger' : days < 60 ? 'warn' : '';
const heat = (units) => !units ? '' : units >= 10 ? 'heat3' : units >= 3 ? 'heat2' : 'heat1';

const SORTS = {
  sku: (row) => row.sku.toLowerCase(), stock: (row) => row.stock ?? -1, transit: (row) => row.transit ?? -1,
  stockDays: (row) => row.soldOut ? -1 : row.stockDays ?? Infinity,
  stockTransitDays: (row) => row.stockTransitDays ?? Infinity, movement3d: (row) => row.movement3d,
  speed7d: (row) => row.speed7d, monthUnits: (row) => row.monthUnits, price: (row) => row.price ?? -1,
  selloutDate: (row) => row.soldOut ? '0' : row.selloutDate ?? '9',
  profit: (row) => row.profit ?? -Infinity, margin: (row) => row.margin ?? -Infinity,
};
// 毛利率:亏钱标红,低于 15% 标黄
const marginLevel = (row) => row.profit == null ? '' : row.profit < 0 ? 'danger' : row.margin < 15 ? 'warn' : '';
const missingNote = (row) => row.missing?.length ? `缺${row.missing.join('、')}，到 SKU 库补` : undefined;

function exportRows(data, rows) {
  const headers = ['日期', 'SKU', '款式', '尺码', '颜色', 'ASIN', '在库', '在途', '在库可售天数', '在库在途可售天数',
    ...data.days.map((day) => `${md(day)}销量`), '近3日动销', '近7天动销速度', `${Number(data.today.slice(5, 7))}月销量`, '预估售罄日', '售价', '单件毛利', '毛利率(%)'];
  const body = rows.map((row) => [slash(data.today), row.sku, row.style ?? '', row.size ?? '', row.color ?? '', row.asin ?? '',
    row.stock ?? '', row.transit ?? '', row.stockDays ?? '', row.stockTransitDays ?? '', ...row.daily.map((units) => units || ''),
    row.movement3d || '', row.speed7d || '', row.monthUnits || '', row.soldOut ? '已断货' : row.selloutDate ?? '', row.price ?? '', row.profit ?? '', row.margin ?? '']);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([headers, ...body]), '价格策略');
  XLSX.writeFile(book, `价格策略_${data.today}.xlsx`);
}

export default function PriceStrategyPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [query, setQuery] = useState(''), [activeOnly, setActiveOnly] = useState(true);
  const [sort, setSort] = useState({ key: 'speed7d', desc: true });

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try { setData(await api.priceStrategy()); setError(''); }
    catch (err) { setError(err.message); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  const running = data?.sync?.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(true); }, 5_000);
    return () => clearInterval(timer);
  }, [running]);

  const rows = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    const picked = data.rows.filter((row) => (!activeOnly || row.stock > 0 || row.transit > 0 || row.sales7d > 0 || row.monthUnits > 0)
      && (!term || [row.sku, row.asin, row.style, row.size, row.color].some((value) => String(value ?? '').toLowerCase().includes(term))));
    const value = SORTS[sort.key] ?? ((row) => row.daily[Number(sort.key.slice(1))]);
    return picked.sort((a, b) => {
      const left = value(a), right = value(b);
      const order = left < right ? -1 : left > right ? 1 : a.sku.localeCompare(b.sku);
      return sort.desc && left !== right ? -order : order;
    });
  }, [data, query, activeOnly, sort]);

  const totals = useMemo(() => {
    const sum = (key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    return { sales7d: sum('sales7d'), monthUnits: sum('monthUnits'), stock: sum('stock'), transit: sum('transit'),
      today: sum('today'),
      // 近 7 天按销量加权的毛利率:Σ(单件毛利×销量) ÷ Σ(售价×销量),只算毛利算得出来的 SKU
      margin7d: (() => {
        const priced = rows.filter((row) => row.profit != null && row.sales7d > 0);
        const revenue = priced.reduce((total, row) => total + row.price * row.sales7d, 0);
        return revenue ? priced.reduce((total, row) => total + row.profit * row.sales7d, 0) / revenue * 100 : null;
      })(),
      risk: rows.filter((row) => row.sales7d > 0 && (row.soldOut || row.stockDays < 30)).length,
      daily: data ? data.days.map((_, index) => rows.reduce((total, row) => total + row.daily[index], 0)) : [] };
  }, [rows, data]);

  async function syncNow() {
    setBusy(true); setError(''); setMessage('');
    try { await api.syncPriceStrategy(); setMessage(''); }
    catch (err) { setError(err.message); }
    finally { await load(true); setBusy(false); }
  }

  const sync = data?.sync;
  const head = (key, label, extra = '') => <th key={key} rowSpan={2} className={`sortable ${extra}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'sku' })}>{label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}</button></th>;

  return <div className="lib price-strategy animate-in">
    <div className="lib-head"><div><h1>价格策略表 <span className="tag blue">US 站</span></h1>
      <p className="hint">{data ? <>今天 <b>{slash(data.today)}</b>（美国太平洋时间），近 7 天为 {md(data.days[0])}–{md(data.days[6])}，每天自动往后滚。</> : '日期按美国太平洋时间。'}
        {sync?.configured ? ` 每 3 小时自动从亚马逊同步一次，上次同步：${sync.lastSuccess ? new Date(sync.lastSuccess.completedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）' : '尚未同步'}。` : ` ${sync?.issues?.[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证。'}`}</p></div>
      <div className="row wrap">
        <button className="btn" disabled={!rows.length} onClick={() => exportRows(data, rows)}>导出 Excel</button>
        <button className="btn primary" disabled={busy || !sync?.configured || running} onClick={syncNow}>{running ? '后台同步中…' : '立即同步'}</button></div></div>
    {running && <div className="card price-sync-card"><SyncProgress progress={data.sync.progress} />
      <p className="hint">订单报告每段 30 天，生成需要几分钟；第一次同步会回填今年以来的订单，时间更久。完成后表格自动刷新。</p></div>}
    {sync?.lastError && (!sync.lastSuccess || sync.lastError.at > sync.lastSuccess.completedAt) && <p className="note err" role="status">上次同步失败（{new Date(sync.lastError.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}）：{sync.lastError.message}</p>}
    {message && <p className="note ok" role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}

    {data && <div className="price-kpis">
      <div className="price-kpi"><span>近 7 天销量</span><b>{fmt(totals.sales7d)}</b><small>日均 {fmt(totals.sales7d / 7, 1)}</small></div>
      <div className="price-kpi"><span>{Number(data.today.slice(5, 7))} 月销量</span><b>{fmt(totals.monthUnits)}</b><small>今天已出 {fmt(totals.today)}</small></div>
      <div className="price-kpi"><span>在库</span><b>{fmt(totals.stock)}</b><small>在途 {fmt(totals.transit)}</small></div>
      <div className="price-kpi"><span>30 天内断货</span><b className={totals.risk ? 'danger' : ''}>{totals.risk}</b><small>有销量的 SKU</small></div>
    </div>}

    <section className="card">
      <div className="row wrap price-toolbar">
        <label>搜索 <input className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU / ASIN / 款式 / 颜色" /></label>
        <label className="price-check"><input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> 隐藏无库存、无销量的 SKU</label>
        <div className="spacer" /><span className="hint">{rows.length} / {data?.rows.length ?? 0} 个 SKU · 点表头排序</span></div>
      {loading ? <p role="status">正在加载价格策略表…</p> : !rows.length ? <p className="note">{data?.rows.length ? '当前筛选没有结果。' : '还没有数据。配置亚马逊凭证后点「立即同步」。'}</p> :
        <div className="price-table" role="region" tabIndex={0} aria-label="价格策略表"><table className="tbl">
          <thead><tr><th rowSpan={2} className="col-date">日期</th>{head('sku', 'SKU', 'col-sku')}<th rowSpan={2}>ASIN</th>
            {head('stock', '在库', 'num')}{head('transit', '在途', 'num')}{head('stockDays', <>在库<br />可售天数</>, 'num')}{head('stockTransitDays', <>在库在途<br />可售天数</>, 'num')}
            <th colSpan={7} className="group">近 7 日动销</th>
            {head('movement3d', <>近3日<br />动销</>, 'num')}{head('speed7d', <>近7天<br />动销速度</>, 'num')}{head('monthUnits', `${Number(data.today.slice(5, 7))}月销量`, 'num')}
            {head('selloutDate', <>预估<br />售罄日</>)}{head('price', '售价', 'num')}{head('profit', <>单件<br />毛利</>, 'num')}{head('margin', '毛利率', 'num')}</tr>
            <tr>{data.days.map((day, index) => <th key={day} className={`sortable day${index >= 4 ? ' recent' : ''}`} aria-sort={sort.key === `d${index}` ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
              <button type="button" onClick={() => setSort({ key: `d${index}`, desc: sort.key === `d${index}` ? !sort.desc : true })}>{md(day)}<small>{weekOf(day)}</small></button></th>)}</tr></thead>
          <tbody>{rows.map((row) => {
            const level = row.soldOut && row.sales7d > 0 ? 'danger' : urgency(row.stockDays);
            return <tr key={row.sku}>
              <td className="col-date">{slash(data.today)}</td>
              <td className="col-sku"><b>{row.sku}</b>{(row.style || row.size || row.color) && <small title={[row.style, row.size, row.color].filter(Boolean).join(' · ')}>{[row.style, row.size, row.color].filter(Boolean).join(' · ')}</small>}</td>
              <td className="mono">{row.asin ?? ''}</td>
              <td className={`num${row.soldOut ? ' danger' : ''}`}>{row.stock == null ? '' : fmt(row.stock)}</td>
              <td className="num">{row.transit ? fmt(row.transit) : ''}</td>
              <td className={`num ${level}`}>{row.soldOut ? '断货' : fmt(row.stockDays)}</td>
              <td className={`num ${urgency(row.stockTransitDays)}`}>{fmt(row.stockTransitDays)}</td>
              {row.daily.map((units, index) => <td key={index} className={`num day ${heat(units)}`}>{units || ''}</td>)}
              <td className="num strong">{row.movement3d ? fmt(row.movement3d, 2) : ''}</td>
              <td className="num strong">{row.speed7d ? fmt(row.speed7d, 2) : ''}</td>
              <td className="num strong">{row.monthUnits || ''}</td>
              <td className={level}>{row.soldOut ? (row.sales7d > 0 ? '已断货' : '') : row.selloutDate ? slash(row.selloutDate) : ''}</td>
              <td className="num">{row.price == null ? '' : fmt(row.price, 2)}</td>
              <td className={`num ${marginLevel(row)}`} title={missingNote(row)}>{row.profit == null ? '' : fmt(row.profit, 2)}</td>
              <td className={`num strong ${marginLevel(row)}`} title={missingNote(row)}>{row.margin == null ? '' : `${fmt(row.margin, 1)}%`}</td></tr>;
          })}</tbody>
          <tfoot><tr><td className="col-date">合计</td><td className="col-sku" /><td /><td className="num">{fmt(totals.stock)}</td><td className="num">{fmt(totals.transit)}</td><td /><td />
            {totals.daily.map((units, index) => <td key={index} className="num day">{fmt(units)}</td>)}
            <td /><td className="num">{fmt(totals.sales7d / 7, 2)}</td><td className="num">{fmt(totals.monthUnits)}</td><td /><td /><td />
            <td className="num" title="近 7 天按销量加权">{totals.margin7d == null ? '' : `${fmt(totals.margin7d, 1)}%`}</td></tr></tfoot>
        </table></div>}
      <p className="hint price-legend">近3日动销＝最近 3 天销量÷3；近7天动销速度＝近 7 天销量÷7；可售天数＝库存÷近7天动销速度；预估售罄日＝今天＋在库可售天数。
        <span className="danger">红色</span>为 30 天内卖完，<span className="warn">黄色</span>为 60 天内。月销量含今天已同步的订单。
        单件毛利＝售价－落地成本－FBA 配送费－佣金（成本在 SKU 库维护，FBA 费和佣金每天从亚马逊读取），未扣广告费和仓储费；毛利率亏钱标红、低于 15% 标黄，合计行是近 7 天按销量加权的毛利率；空白表示缺成本或费用。广告数据等亚马逊广告 API 开通后再加。</p>
    </section>
  </div>;
}
