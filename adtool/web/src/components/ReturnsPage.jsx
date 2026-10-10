import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import SyncProgress from './SyncProgress.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './ReturnsPage.css';

const fmt = (value, digits = 0) => value == null ? '' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value) => value == null ? '—' : `${fmt(value, 1)}%`;
const beijing = (at) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' · ');
const LEVEL = { high: ['red', '偏高'], medium: ['amber', '注意'], low: ['', '参考'], info: ['blue', '总览'] };
// 退货率:是全店 1.5 倍以上且不低于 8% 标红,高于全店标黄;退得少的不标
const rateLevel = (row, store) => row.rate == null || row.returned < 2 ? '' : row.rate >= Math.max(8, store * 1.5) ? 'danger' : row.rate > store ? 'warn' : '';
const SORTS = {
  returned: (row) => row.returned, rate: (row) => row.rate ?? -1, sold: (row) => row.sold, sku: (row) => row.sku.toLowerCase(),
};

/** 横条:每项占比 */
function Bars({ items, empty = '没有数据', tone = '' }) {
  if (!items.length) return <p className="hint">{empty}</p>;
  const max = Math.max(...items.map((item) => item.count));
  return <ul className="ret-bars">{items.map((item) => <li key={item.key}>
    <span className="ret-bar-label" title={item.key}>{item.label}</span>
    <span className="ret-bar-track"><span className={`ret-bar-fill ${tone}`} style={{ width: `${Math.max(4, item.count / max * 100)}%` }} /></span>
    <span className="ret-bar-num">{item.count} 件<small>{pct(item.share)}</small></span></li>)}</ul>;
}

function Records({ sku, days }) {
  const [records, setRecords] = useState(null), [error, setError] = useState('');
  useEffect(() => { api.returnRecords(sku, days).then((data) => setRecords(data.records)).catch((err) => setError(err.message)); }, [sku, days]);
  if (error) return <p className="note err">{error}</p>;
  if (!records) return <p className="hint" role="status">正在加载退货明细…</p>;
  if (!records.length) return <p className="hint">这段时间没有退货。</p>;
  return <table className="tbl ret-records"><thead><tr><th>退货日期</th><th>件数</th><th>原因</th><th>退回后</th><th>买家留言</th></tr></thead>
    <tbody>{records.map((row, index) => <tr key={index}><td>{row.day}</td><td className="num">{row.quantity}</td>
      <td title={row.reasonCode ?? ''}>{row.reason}</td><td className={row.disposition === '可售回库' ? '' : 'warn'}>{row.disposition ?? ''}</td>
      <td className="ret-comment">{row.comment ? <>{row.comment}{row.themes.length > 0 && <span className="ret-themes">{row.themes.map((theme) => <span key={theme} className="tag">{theme}</span>)}</span>}</> : <span className="hint">（没有留言）</span>}</td></tr>)}</tbody></table>;
}

export default function ReturnsPage() {
  const [days, setDays] = useState(30), [style, setStyle] = useState('');
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [onlyReturned, setOnlyReturned] = useState(true);
  const [sort, setSort] = useState({ key: 'returned', desc: true }), [open, setOpen] = useState(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try { setData(await api.returns({ days, style })); setError(''); }
    catch (err) { setError(err.message); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [days, style]);
  const running = data?.sync?.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(true); }, 5_000);
    return () => clearInterval(timer);
  }, [running]);

  // 款式下拉:第一次拿到的全部款式,筛选后不缩
  const [styleOptions, setStyleOptions] = useState([]);
  useEffect(() => { if (data && !style) setStyleOptions(data.styles.map((item) => item.style).filter((name) => !name.startsWith('('))); }, [data, style]);

  const rows = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    const value = SORTS[sort.key];
    return data.skus.filter((row) => (!onlyReturned || row.returned > 0)
      && (!term || [row.sku, row.asin, row.style, row.size, row.color].some((field) => String(field ?? '').toLowerCase().includes(term))))
      .sort((a, b) => {
        const left = value(a), right = value(b);
        const order = left < right ? -1 : left > right ? 1 : a.sku.localeCompare(b.sku);
        return sort.desc && left !== right ? -order : order;
      });
  }, [data, query, onlyReturned, sort]);

  async function syncNow() {
    setBusy(true); setError('');
    try { await api.syncReturns(); }
    catch (err) { setError(err.message); }
    finally { await load(true); setBusy(false); }
  }

  const sync = data?.sync, total = data?.total;
  const head = (key, label, extra = '') => <th className={`sortable ${extra}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'sku' })}>{label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}</button></th>;

  return <div className="lib returns-page animate-in">
    <div className="lib-head"><div><h1>退货分析 <span className="tag blue">US 站</span></h1>
      <p className="hint">数据来自亚马逊 FBA 买家退货报告，退货率＝这段时间退回件数÷同期卖出件数（美国太平洋时间）。
        {sync?.configured ? ` 每 12 小时自动同步一次，上次同步：${sync.lastSuccess ? `${beijing(sync.lastSuccess.completedAt)}（北京时间）` : '尚未同步'}${data?.coverage ? `，退货数据从 ${data.coverage.from} 开始` : ''}。` : ` ${sync?.issues?.[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证。'}`}</p></div>
      <div className="row wrap">
        <label>时间 <select className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 60, 90, 180].map((value) => <option key={value} value={value}>近 {value} 天</option>)}</select></label>
        <label>款式 <select className="inp" value={style} onChange={(e) => { setStyle(e.target.value); setOpen(null); }}>
          <option value="">全部款式</option>{styleOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <button className="btn primary" disabled={busy || !sync?.configured || running} onClick={syncNow}>{running ? '后台同步中…' : '立即同步'}</button></div></div>
    {running && <div className="card price-sync-card"><SyncProgress progress={sync.progress} label="退货报告同步进度" />
      <p className="hint">退货报告每份 30 天，第一次会回填最近 180 天（6 份报告），完成后页面自动刷新。</p></div>}
    {sync?.lastError && (!sync.lastSuccess || sync.lastError.at > sync.lastSuccess.completedAt) && <p className="note err" role="status">上次同步失败（{beijing(sync.lastError.at)}）：{sync.lastError.message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {loading && !data ? <p role="status">正在加载退货分析…</p> : data && <>
      {data.notes.length > 2 && <p className="note">{data.notes[0]}</p>}
      <div className="price-kpis">
        <div className="price-kpi"><span>退货率</span><b className={total.rate >= 8 ? 'danger' : ''}>{pct(total.rate)}</b><small>{data.from} 至 {data.to}</small></div>
        <div className="price-kpi"><span>退货件数</span><b>{fmt(total.returned)}</b><small>{total.skus} 个 SKU 有退货</small></div>
        <div className="price-kpi"><span>同期卖出</span><b>{fmt(total.sold)}</b><small>订单报告口径</small></div>
        <div className="price-kpi"><span>可售回库</span><b>{pct(total.sellableShare)}</b><small>{fmt(total.returned - total.sellable)} 件不可售</small></div>
      </div>

      <section className="card">
        <div className="card-title">原因归纳</div>
        {data.findings.length ? <ul className="ret-findings">{data.findings.map((item, index) => <li key={index} className={`lvl-${item.level}`}>
          <span className={`tag ${LEVEL[item.level][0]}`}>{LEVEL[item.level][1]}</span><div><b>{item.title}</b><p>{item.detail}</p></div></li>)}</ul>
          : <p className="hint">这段时间没有退货。</p>}
        <p className="hint">按规则归纳：退货原因代码归大类，买家留言按关键词归主题。想要更细的分析，可以在 Claude 里让它用连接器读退货数据（get_returns）。</p>
      </section>

      <div className="ret-grid">
        <section className="card"><div className="card-title">原因大类</div><Bars items={total.categories} /></section>
        <section className="card"><div className="card-title">亚马逊退货原因</div><Bars items={total.reasons} tone="blue" /></section>
        <section className="card"><div className="card-title">买家留言主题 <small className="hint">（{total.commentCount} 条留言）</small></div>
          <Bars items={total.themes} tone="amber" empty="没有留言或留言没归进主题。" /></section>
      </div>

      {data.styles.some((item) => item.returned > 0) && <section className="card">
        <div className="card-title">按款式</div>
        <div className="scroll"><table className="tbl ret-styles"><thead><tr><th>款式</th><th className="num">卖出</th><th className="num">退货</th><th className="num">退货率</th>
          <th>主要原因</th><th>各尺码退货（嫌小 / 嫌大）</th></tr></thead>
          <tbody>{data.styles.filter((item) => item.returned > 0).map((item) => <tr key={item.style}>
            <td><b>{item.style}</b></td><td className="num">{fmt(item.sold)}</td><td className="num strong">{fmt(item.returned)}</td>
            <td className={`num strong ${rateLevel(item, total.rate ?? 0)}`}>{pct(item.rate)}</td>
            <td>{item.reasons.slice(0, 3).map((reason) => `${reason.label} ${reason.count}`).join('、')}</td>
            <td className="ret-sizes">{item.sizes.filter((size) => size.returned > 0).map((size) => <span key={size.size} title={`卖 ${size.sold} 件，退 ${size.returned} 件`}>
              <b>{size.size}</b> {size.returned} 件{size.rate != null ? `（${fmt(size.rate, 1)}%）` : ''}{size.small || size.large ? <small>{size.small ? ` 小${size.small}` : ''}{size.large ? ` 大${size.large}` : ''}</small> : null}</span>)}</td></tr>)}</tbody></table></div>
      </section>}

      <section className="card">
        <div className="row wrap price-toolbar">
          <div className="card-title">每个 SKU</div>
          <label>搜索 <input className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU / ASIN / 款式 / 颜色" /></label>
          <label className="price-check"><input type="checkbox" checked={onlyReturned} onChange={(e) => setOnlyReturned(e.target.checked)} /> 只看有退货的</label>
          <div className="spacer" /><span className="hint">{rows.length} 个 SKU · 点表头排序，点一行看明细</span></div>
        {!rows.length ? <p className="note">{data.skus.length ? '当前筛选没有结果。' : '还没有数据。'}</p> :
          <div className="scroll ret-table"><table className="tbl">
            <thead><tr>{head('sku', 'SKU')}<th>ASIN</th>{head('sold', '卖出', 'num')}{head('returned', '退货', 'num')}{head('rate', '退货率', 'num')}
              <th>主要原因</th><th>留言主题</th><th className="num">可售回库</th><th>最新留言</th></tr></thead>
            <tbody>{rows.map((row) => <Fragment key={row.sku}>
              <tr className={`ret-row${open === row.sku ? ' open' : ''}`} onClick={() => setOpen(open === row.sku ? null : row.sku)}
                tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(open === row.sku ? null : row.sku); } }} aria-expanded={open === row.sku}>
                <td className="col-sku"><b>{row.sku}</b>{nameOf(row) && <small>{nameOf(row)}</small>}</td>
                <td className="mono">{row.asin ?? ''}</td>
                <td className="num">{fmt(row.sold)}</td><td className="num strong">{row.returned ? fmt(row.returned) : ''}</td>
                <td className={`num strong ${rateLevel(row, total.rate ?? 0)}`}>{row.returned ? (row.rate == null ? <span className="hint" title="这段时间没卖出，退的是之前的订单">没卖</span> : pct(row.rate)) : ''}</td>
                <td>{row.reasons.slice(0, 2).map((reason) => `${reason.label} ${reason.count}`).join('、')}</td>
                <td>{row.themes.slice(0, 3).map((theme) => <span key={theme.key} className="tag amber">{theme.label}</span>)}</td>
                <td className="num">{row.returned ? pct(row.sellableShare) : ''}</td>
                <td className="ret-latest" title={row.comments[0]?.comment ?? ''}>{row.comments[0]?.comment ?? ''}</td></tr>
              {open === row.sku && <tr className="ret-detail"><td colSpan={9}><Records sku={row.sku} days={days} /></td></tr>}</Fragment>)}</tbody>
          </table></div>}
        <p className="hint price-legend">{data.notes.slice(-2).join(' ')} 退货率<span className="danger">红色</span>是全店的 1.5 倍以上（且不低于 8%），<span className="warn">黄色</span>高于全店；只退了 1 件的不标色。</p>
      </section></>}
  </div>;
}
