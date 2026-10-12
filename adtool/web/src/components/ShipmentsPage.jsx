import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import SyncProgress from './SyncProgress.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './ReturnsPage.css';
import './ShipmentsPage.css';

const fmt = (value) => value == null ? '' : Number(value).toLocaleString('en-US');
const beijing = (at) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' · ');
const LEVEL = { high: ['red', '要处理'], medium: ['amber', '注意'], low: ['', '参考'] };
const TONE = { working: 'gray', shipped: 'blue', receiving: 'amber', closed: 'green', cancelled: 'gray' };
const STATUS_FILTERS = { open: '未完成', all: '全部', closed: '已完成', cancelled: '已取消/删除' };
const BUCKET_WORD = { working: '处理中', shipped: '已发货', receiving: '正在接收' };
// 可售天数:30 天内标红,60 天内标黄(和价格策略表一样)
const urgency = (row) => row.soldOut && row.speed7d > 0 ? 'danger' : row.stockDays == null ? '' : row.stockDays < 30 ? 'danger' : row.stockDays < 60 ? 'warn' : '';
const daysText = (row) => row.soldOut ? (row.speed7d > 0 ? '断货' : '') : fmt(row.stockDays);
const statusDays = (shipment) => shipment.daysInStatus == null ? '' : `${shipment.statusObserved ? '' : '≥'}${shipment.daysInStatus} 天`;

function Progress({ shipped, received }) {
  const percent = shipped ? Math.min(100, Math.round(received / shipped * 100)) : 0;
  return <span className="shp-progress" title={`已收 ${received} / 发货 ${shipped}`}>
    <span className="shp-progress-track"><span style={{ width: `${percent}%` }} /></span><small>{percent}%</small></span>;
}

/** 一个货件里每个 SKU:发货、已收,和这个 SKU 现在的在库、可售天数 */
function Items({ shipment, focus, onSku }) {
  if (!shipment.items.length) return <p className="hint">{shipment.itemsSyncedAt ? '这个货件里没有商品。' : '货件明细还没同步，下次同步后显示。'}</p>;
  return <table className="tbl ret-records shp-items"><thead><tr><th>SKU</th><th>ASIN</th><th className="num">发货</th><th className="num">已收</th>
    <th className="num">{shipment.open ? '未收' : '少收'}</th><th className="num">每箱</th><th className="num">现在在库</th><th className="num">在库可售天数</th></tr></thead>
    <tbody>{shipment.items.map((item) => <tr key={item.sku} className={focus && item.sku.toLowerCase() === focus.toLowerCase() ? 'shp-focus' : ''}>
      <td className="col-sku"><button type="button" className="inv-link" title="看这个 SKU 的全部货件和库存" onClick={() => onSku(item.sku)}><b>{item.sku}</b></button>
        {nameOf(item) && <small>{nameOf(item)}</small>}</td>
      <td className="mono">{item.asin ?? ''}</td>
      <td className="num">{fmt(item.shipped)}</td><td className="num">{fmt(item.received)}</td>
      <td className={`num strong${!shipment.open && item.shortfall ? ' danger' : ''}`}>{shipment.open ? (item.outstanding ? fmt(item.outstanding) : '') : (item.shortfall ? fmt(item.shortfall) : '')}</td>
      <td className="num">{item.inCase ? fmt(item.inCase) : ''}</td>
      <td className="num">{fmt(item.stock)}</td>
      <td className={`num ${urgency(item)}`}>{daysText(item)}</td></tr>)}</tbody></table>;
}

export default function ShipmentsPage({ focusSku = '' }) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('shipments');
  const [statusFilter, setStatusFilter] = useState('open');
  const [query, setQuery] = useState(focusSku), [skuQuery, setSkuQuery] = useState('');
  const [focus, setFocus] = useState(focusSku);
  const [inboundOnly, setInboundOnly] = useState(false);
  // 提醒里点「看这些货件 / SKU」时只显示这几个
  const [pick, setPick] = useState(null);
  const [open, setOpen] = useState(() => new Set());

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try { setData(await api.shipments(days)); setError(''); }
    catch (err) { setError(err.message); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [days]);
  const running = data?.sync?.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(true); }, 5_000);
    return () => clearInterval(timer);
  }, [running]);

  // 从 SKU 库 / 价格策略表点进来:展开装着这个 SKU 的未完成货件
  useEffect(() => {
    if (!data || !focus) return;
    window.scrollTo?.(0, 0);
    const ids = data.shipments.filter((item) => item.open && item.items.some((row) => row.sku.toLowerCase() === focus.toLowerCase())).map((item) => item.shipmentId);
    setOpen(new Set(ids));
  }, [data, focus]);

  const shipments = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    return data.shipments.filter((item) => {
      if (pick?.type === 'shipments') return pick.values.includes(item.shipmentId);
      if (statusFilter === 'open' && !item.open) return false;
      if (statusFilter === 'closed' && item.bucket !== 'closed') return false;
      if (statusFilter === 'cancelled' && item.bucket !== 'cancelled') return false;
      return !term || [item.shipmentId, item.name, item.destination].some((field) => String(field ?? '').toLowerCase().includes(term))
        || item.items.some((row) => [row.sku, row.asin, row.style].some((field) => String(field ?? '').toLowerCase().includes(term)));
    });
  }, [data, query, statusFilter, pick]);

  const skus = useMemo(() => {
    if (!data) return [];
    const term = skuQuery.trim().toLowerCase();
    return data.skus.filter((row) => {
      if (pick?.type === 'skus') return pick.values.includes(row.sku);
      if (inboundOnly && !row.shipments.length && !row.transit) return false;
      return !term || [row.sku, row.asin, row.style, row.size, row.color].some((field) => String(field ?? '').toLowerCase().includes(term));
    });
  }, [data, skuQuery, inboundOnly, pick]);

  const focusRow = focus && data ? data.skus.find((row) => row.sku.toLowerCase() === focus.toLowerCase()) : null;

  async function syncNow() {
    setBusy(true); setError('');
    try { await api.syncShipments(); }
    catch (err) { setError(err.message); }
    finally { await load(true); setBusy(false); }
  }
  const toggle = (id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const showShipment = (id) => { setPick(null); setTab('shipments'); setStatusFilter('all'); setQuery(id); setOpen(new Set([id])); };
  const showSku = (sku) => { setPick(null); setTab('shipments'); setStatusFilter('open'); setQuery(sku); setFocus(sku); };
  const showPick = (type, values, label) => { setPick({ type, values, label }); setTab(type); };

  const sync = data?.sync, totals = data?.totals;
  return <div className="lib returns-page shipments-page animate-in">
    <div className="lib-head"><div><h1>货件 <span className="tag blue">US 站</span></h1>
      <p className="hint">数据来自亚马逊 FBA 入库货件接口，和库存一起每 3 小时自动同步。
        {sync?.configured ? ` 货件上次同步：${sync.lastSuccess ? `${beijing(sync.lastSuccess.completedAt)}` : '尚未同步'}；库存上次同步：${data?.inventorySync?.at ? beijing(data.inventorySync.at) : '尚未同步'}（北京时间）。` : ` ${sync?.issues?.[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证。'}`}</p></div>
      <div className="row wrap">
        <label>已完成的货件 <select className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[30, 90, 180, 365].map((value) => <option key={value} value={value}>近 {value} 天</option>)}</select></label>
        <button className="btn primary" disabled={busy || !sync?.configured || running} onClick={syncNow}>{running ? '后台同步中…' : '立即同步'}</button></div></div>
    {running && <div className="card price-sync-card"><SyncProgress progress={sync.progress} label="货件同步进度" />
      <p className="hint">先查货件列表，再逐个拉货件明细；第一次会回填最近一年的货件，完成后页面自动刷新。</p></div>}
    {sync?.lastError && (!sync.lastSuccess || sync.lastError.at > sync.lastSuccess.completedAt) && <p className="note err" role="status">上次同步失败（{beijing(sync.lastError.at)}）：{sync.lastError.message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {loading && !data ? <p role="status">正在加载货件…</p> : data && <>
      {!sync.lastSuccess && !data.shipments.length && <p className="note">还没有货件数据：网站会自动同步，也可以点「立即同步」。</p>}
      {focusRow && <section className="card shp-focus-card">
        <div className="row wrap"><div className="card-title">SKU {focusRow.sku}{nameOf(focusRow) ? ` · ${nameOf(focusRow)}` : ''}</div><div className="spacer" />
          <button type="button" className="btn sm" onClick={() => { setFocus(''); setQuery(''); setOpen(new Set()); }}>看全部货件</button></div>
        <p>在库 <b>{fmt(focusRow.stock ?? 0)}</b>{focusRow.inventory && focusRow.inventory.available !== focusRow.stock ? <>（前台能买 {fmt(focusRow.inventory.available)}）</> : null}，近 7 天日均卖 <b>{focusRow.speed7d}</b> 件，
          在库可售 <b className={urgency(focusRow)}>{focusRow.soldOut ? '已断货' : focusRow.stockDays == null ? '—' : `${focusRow.stockDays} 天`}</b>
          {focusRow.coverDays != null && <>，算上未收的货件够卖 <b>{focusRow.coverDays} 天</b></>}。
          货件里还没收：处理中 {fmt(focusRow.fromShipments.working)}、已发货 {fmt(focusRow.fromShipments.shipped)}、接收中 {fmt(focusRow.fromShipments.receiving)}。
          {focusRow.inventory && (focusRow.matched ? <span className="shp-ok"> 和库存接口一致。</span>
            : <span className="warn"> 库存接口是处理中 {focusRow.inventory.working}、已发货 {focusRow.inventory.shipped}、正在接收 {focusRow.inventory.receiving}，对不上。</span>)}</p>
      </section>}
      <div className="price-kpis">
        <div className="price-kpi"><span>未完成货件</span><b>{fmt(totals.open)}</b><small>还没收的 {fmt(totals.working + totals.shipped + totals.receiving)} 件</small></div>
        <div className="price-kpi"><span>处理中 / 待发货</span><b>{fmt(totals.working)}</b><small>{totals.workingShipments} 个货件还没发出</small></div>
        <div className="price-kpi"><span>已发货在路上</span><b>{fmt(totals.shipped)}</b><small>{totals.shippedShipments} 个货件</small></div>
        <div className="price-kpi"><span>接收中未上架</span><b>{fmt(totals.receiving)}</b><small>{totals.receivingShipments} 个货件</small></div>
        <div className="price-kpi"><span>近 {data.days} 天已完成</span><b>{fmt(totals.closedReceived)}</b><small>{totals.closed} 个货件{totals.closedShortfall ? <>，<span className="danger">少收 {fmt(totals.closedShortfall)} 件</span></> : ''}</small></div>
      </div>

      {data.findings.length > 0 && !focusRow && <section className="card">
        <div className="card-title">需要留意</div>
        <ul className="ret-findings">{data.findings.map((item, index) => <li key={index} className={`lvl-${item.level}`}>
          <span className={`tag ${LEVEL[item.level][0]}`}>{LEVEL[item.level][1]}</span>
          <div><b>{item.title}</b><p>{item.detail}</p>
            <div className="shp-finding-links">
              {item.shipmentIds?.length > 0 && <button type="button" className="btn sm ghost" onClick={() => showPick('shipments', item.shipmentIds, item.title)}>看这些货件</button>}
              {item.skus?.length > 0 && <button type="button" className="btn sm ghost" onClick={() => showPick('skus', item.skus, item.title)}>看这些 SKU</button>}</div></div></li>)}</ul>
      </section>}


      {pick && <p className="note shp-pick">只显示：{pick.label} <button type="button" className="btn sm" onClick={() => setPick(null)}>显示全部</button></p>}

      <div className="shp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'shipments'} className={tab === 'shipments' ? 'on' : ''} onClick={() => setTab('shipments')}>货件（{data.shipments.length}）</button>
        <button type="button" role="tab" aria-selected={tab === 'skus'} className={tab === 'skus' ? 'on' : ''} onClick={() => setTab('skus')}>按 SKU 看在途（{data.skus.length}）</button>
      </div>

      {tab === 'shipments' ? <section className="card">
        <div className="row wrap price-toolbar">
          <label>状态 <select className="inp" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPick(null); }}>
            {Object.entries(STATUS_FILTERS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>搜索 <input className="inp" value={query} onChange={(e) => { setQuery(e.target.value); setPick(null); }} placeholder="货件编号 / 名称 / 仓库 / SKU" /></label>
          <div className="spacer" /><span className="hint">{shipments.length} 个货件 · 点一行看每个 SKU</span></div>
        {!shipments.length ? <p className="note">{data.shipments.length ? '当前筛选没有货件。' : '还没有货件。'}</p> :
          <div className="scroll ret-table"><table className="tbl">
            <thead><tr><th>货件</th><th>状态</th><th>目的仓</th><th>创建</th><th className="num">这个状态</th><th className="num">SKU</th>
              <th className="num">发货</th><th className="num">已收</th><th>收货进度</th><th className="num">未收 / 少收</th></tr></thead>
            <tbody>{shipments.map((item) => <Fragment key={item.shipmentId}>
              <tr className={`ret-row${open.has(item.shipmentId) ? ' open' : ''}`} onClick={() => toggle(item.shipmentId)} tabIndex={0} aria-expanded={open.has(item.shipmentId)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(item.shipmentId); } }}>
                <td className="col-sku"><b className="mono">{item.shipmentId}</b>{item.name && <small title={item.name}>{item.name}</small>}</td>
                <td><span className={`tag ${TONE[item.bucket]}`}>{item.statusLabel}</span></td>
                <td className="mono">{item.destination ?? ''}</td>
                <td>{item.createdDay ?? ''}</td>
                <td className="num" title={item.statusObserved ? '' : '第一次同步时就已经是这个状态，实际更久'}>{item.open ? statusDays(item) : item.endDay ? `${item.endDay}` : ''}</td>
                <td className="num">{item.skuCount || ''}</td>
                <td className="num">{fmt(item.shipped)}</td><td className="num">{fmt(item.received)}</td>
                <td>{item.shipped > 0 && item.bucket !== 'cancelled' ? <Progress shipped={item.shipped} received={item.received} /> : ''}</td>
                <td className={`num strong${!item.open && item.shortfall ? ' danger' : ''}`}>{item.open ? (item.outstanding ? fmt(item.outstanding) : '') : (item.shortfall ? `少 ${fmt(item.shortfall)}` : '')}</td></tr>
              {open.has(item.shipmentId) && <tr className="ret-detail"><td colSpan={10}>
                <Items shipment={item} focus={focus} onSku={showSku} />
                {item.shipFrom && <p className="hint shp-meta">发货地：{item.shipFrom}</p>}</td></tr>}</Fragment>)}</tbody>
          </table></div>}
      </section> : <section className="card">
        <div className="row wrap price-toolbar">
          <label>搜索 <input className="inp" value={skuQuery} onChange={(e) => { setSkuQuery(e.target.value); setPick(null); }} placeholder="SKU / ASIN / 款式 / 颜色" /></label>
          <label className="price-check"><input type="checkbox" checked={inboundOnly} onChange={(e) => setInboundOnly(e.target.checked)} /> 只看有在途的</label>
          <div className="spacer" /><span className="hint">{skus.length} 个 SKU · 可售天数少的排前面</span></div>
        {!skus.length ? <p className="note">当前筛选没有 SKU。</p> :
          <div className="scroll ret-table"><table className="tbl">
            <thead><tr><th>SKU</th><th>ASIN</th><th className="num">在库</th><th className="num" title="库存接口的可用数量，前台现在能买到的">前台可买</th><th className="num">7 天日均</th><th className="num">在库可售天数</th>
              <th className="num">处理中</th><th className="num">已发货</th><th className="num">接收中</th><th className="num">算上货件可售天数</th><th>和库存接口</th><th>货件</th></tr></thead>
            <tbody>{skus.map((row) => <tr key={row.sku}>
              <td className="col-sku"><b>{row.sku}</b>{nameOf(row) && <small>{nameOf(row)}</small>}</td>
              <td className="mono">{row.asin ?? ''}</td>
              <td className="num">{fmt(row.stock)}</td>
              <td className={`num${row.inventory && row.stock > 0 && row.inventory.available === 0 ? ' warn' : ''}`}>{row.inventory ? fmt(row.inventory.available) : ''}</td>
              <td className="num">{row.speed7d || ''}</td>
              <td className={`num strong ${urgency(row)}`}>{daysText(row)}</td>
              <td className="num">{row.fromShipments.working || ''}</td>
              <td className="num">{row.fromShipments.shipped || ''}</td>
              <td className="num">{row.fromShipments.receiving || ''}</td>
              <td className="num">{fmt(row.coverDays)}</td>
              <td>{row.matched == null ? <span className="hint">—</span> : row.matched ? <span className="shp-ok">一致</span>
                : <span className="warn" title={row.gaps.map((key) => `${BUCKET_WORD[key]}：货件 ${row.fromShipments[key]}，库存接口 ${row.inventory[key]}`).join('\n')}>
                  {row.gaps.map((key) => `${BUCKET_WORD[key]} ${row.inventory[key]}`).join('、')}</span>}</td>
              <td className="shp-chips">{row.shipments.length ? row.shipments.map((item) => <button key={item.shipmentId} type="button" className={`tag ${TONE[item.bucket]}`}
                onClick={() => showShipment(item.shipmentId)} title={`发货 ${item.shipped}，已收 ${item.received}`}>{item.shipmentId} · {item.statusLabel} {item.outstanding} 件</button>)
                : <span className="hint">没有未完成的货件</span>}</td></tr>)}</tbody>
          </table></div>}
      </section>}
      <p className="hint price-legend">{data.notes.join(' ')} 可售天数＝在库÷近 7 天日均销量；「算上货件」把处理中和已发货的件数也加进来（接收中的已算在在库里）。<span className="danger">红色</span> 30 天内卖完，<span className="warn">黄色</span> 60 天内。</p>
    </>}
  </div>;
}
