import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import SyncProgress from './SyncProgress.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './ReturnsPage.css';
import './StoragePage.css';

const fmt = (value, digits = 0) => value == null ? '' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const usd = (value) => value == null ? '—' : `$${fmt(value, 2)}`;
const beijing = (at) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' · ');
const LEVEL = { high: ['red', '要处理'], medium: ['amber', '注意'], low: ['', '参考'], info: ['blue', '提示'] };
const AGES = [['d0_90', '0–90 天', 'a0'], ['d91_180', '91–180 天', 'a1'], ['d181_365', '181–365 天', 'a2'], ['d365plus', '365 天以上', 'a3']];
const SORTS = {
  aisFee: (row) => row.aisFee, aged181: (row) => row.aged181, aged91: (row) => row.aged91, stock: (row) => row.stock,
  storageNextMonth: (row) => row.storageNextMonth ?? -1, lastMonthFee: (row) => row.lastMonthFee ?? -1, feePerSold: (row) => row.feePerSold ?? -1,
  stockDays: (row) => row.stockDays ?? 99999, sold30: (row) => row.sold30, sku: (row) => row.sku.toLowerCase(),
};

/** 库龄分段横条:每段占在库的比例 */
function AgeBar({ ages }) {
  const total = AGES.reduce((sum, [key]) => sum + (ages[key] ?? 0), 0);
  if (!total) return <span className="hint">—</span>;
  return <span className="stg-age" title={AGES.map(([key, label]) => `${label} ${ages[key] ?? 0} 件`).join('\n')}>
    {AGES.map(([key, , tone]) => ages[key] ? <span key={key} className={tone} style={{ width: `${ages[key] / total * 100}%` }} /> : null)}</span>;
}

/** 按月:仓储费和已收超龄附加费 */
function Monthly({ rows }) {
  const max = Math.max(1, ...rows.map((row) => (row.storageFee ?? 0) + (row.agedCharged ?? 0)));
  return <ul className="stg-months">{rows.map((row) => <li key={row.month}>
    <span className="stg-month">{row.month}</span>
    <span className="ret-bar-track stg-track">
      <span className="stg-fill fee" style={{ width: `${(row.storageFee ?? 0) / max * 100}%` }} />
      <span className="stg-fill aged" style={{ width: `${(row.agedCharged ?? 0) / max * 100}%` }} /></span>
    <span className="stg-month-num">{row.storageFee == null ? <span className="hint">仓储费未出</span> : usd(row.storageFee)}
      {row.agedCharged ? <small className="danger"> ＋超龄 {usd(row.agedCharged)}</small> : null}
      {row.sold ? <small>卖 {fmt(row.sold)} 件{row.storageFee ? ` · 每件 ${usd((row.storageFee + (row.agedCharged ?? 0)) / row.sold)}` : ''}</small> : null}</span></li>)}</ul>;
}

function Detail({ row }) {
  return <div className="stg-detail">
    <div><b>库龄</b>{AGES.map(([key, label]) => <span key={key}>{label} <b>{fmt(row.ages[key] ?? 0)}</b> 件</span>)}</div>
    {row.aisTiers.length > 0 && <div><b>下次超龄附加费</b>{row.aisTiers.map((tier) => <span key={tier.tier}>{tier.label} {fmt(tier.quantity)} 件 <b className="danger">{usd(tier.fee)}</b></span>)}</div>}
    <div><b>库存</b><span>可售 {fmt(row.available ?? 0)}</span><span>不可售 {fmt(row.unfulfillable)}</span>
      {row.excess > 0 && <span className="warn">亚马逊判定冗余 {fmt(row.excess)} 件</span>}
      {row.recommendedRemoval > 0 && <span>建议移除 {fmt(row.recommendedRemoval)} 件</span>}</div>
    <div><b>仓储费</b><span>上月 {usd(row.lastMonthFee)}{row.lastMonthAvgQty != null ? `（日均在库 ${fmt(row.lastMonthAvgQty, 1)} 件，每件 ${usd(row.feePerUnit)}）` : ''}</span>
      <span>下月预估 {usd(row.storageNextMonth)}</span>
      {row.sizeTier && <span>尺寸分段 {row.sizeTier}</span>}
      {row.itemVolume != null && <span>单件体积 {fmt(row.itemVolume, 2)} {row.volumeUnit ?? ''}</span>}
      {row.agedCharged > 0 && <span className="danger">近几个月已收超龄附加费 {usd(row.agedCharged)}（{fmt(row.agedChargedUnits)} 件次）</span>}</div>
    {!row.inReport && <p className="hint">亚马逊库存规划报告里没有这个 SKU（可能没有 FBA 库存），库龄和预估费用为空。</p>}
  </div>;
}

export default function StoragePage({ onOpenShipments }) {
  const [months, setMonths] = useState(6), [style, setStyle] = useState('');
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [query, setQuery] = useState(''), [onlyStock, setOnlyStock] = useState(true);
  const [sort, setSort] = useState({ key: 'aisFee', desc: true }), [open, setOpen] = useState(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try { setData(await api.storage({ months, style })); setError(''); }
    catch (err) { setError(err.message); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [months, style]);
  const running = data?.sync?.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(true); }, 5_000);
    return () => clearInterval(timer);
  }, [running]);

  const [styleOptions, setStyleOptions] = useState([]);
  useEffect(() => { if (data && !style) setStyleOptions(data.styles.map((item) => item.style).filter((name) => !name.startsWith('('))); }, [data, style]);

  const rows = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    const value = SORTS[sort.key];
    return data.skus.filter((row) => (!onlyStock || row.stock > 0 || row.transit > 0 || row.aisFee > 0)
      && (!term || [row.sku, row.asin, row.style, row.size, row.color].some((field) => String(field ?? '').toLowerCase().includes(term))))
      .sort((a, b) => {
        const left = value(a), right = value(b);
        const order = left < right ? -1 : left > right ? 1 : a.sku.localeCompare(b.sku);
        return sort.desc && left !== right ? -order : order;
      });
  }, [data, query, onlyStock, sort]);

  async function syncNow() {
    setBusy(true); setError('');
    try { await api.syncStorage(); }
    catch (err) { setError(err.message); }
    finally { await load(true); setBusy(false); }
  }

  const sync = data?.sync, totals = data?.totals;
  const head = (key, label, extra = '') => <th className={`sortable ${extra}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
    <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : key !== 'sku' && key !== 'stockDays' })}>{label}{sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}</button></th>;
  const toggle = (sku) => setOpen(open === sku ? null : sku);

  return <div className="lib returns-page storage-page animate-in">
    <div className="lib-head"><div><h1>仓储费 <span className="tag blue">US 站</span></h1>
      <p className="hint">数据来自亚马逊库存规划报告、月度仓储费报告和超龄库存附加费报告。
        {sync?.configured ? ` 每天自动同步一次，上次同步：${sync.lastSuccess ? `${beijing(sync.lastSuccess.completedAt)}（北京时间）` : '尚未同步'}${data?.snapshotDate ? `，库龄快照 ${data.snapshotDate}` : ''}。` : ` ${sync?.issues?.[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证。'}`}</p></div>
      <div className="row wrap">
        <label>按月看 <select className="inp" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          {[3, 6, 12].map((value) => <option key={value} value={value}>近 {value} 个月</option>)}</select></label>
        <label>款式 <select className="inp" value={style} onChange={(e) => { setStyle(e.target.value); setOpen(null); }}>
          <option value="">全部款式</option>{styleOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <button className="btn primary" disabled={busy || !sync?.configured || running} onClick={syncNow}>{running ? '后台同步中…' : '立即同步'}</button></div></div>
    {running && <div className="card price-sync-card"><SyncProgress progress={sync.progress} label="仓储费报告同步进度" />
      <p className="hint">第一次会回填最近 6 个月的仓储费和超龄附加费（十几份报告），完成后页面自动刷新。</p></div>}
    {sync?.lastError && (!sync.lastSuccess || sync.lastError.at >= sync.lastSuccess.completedAt) && <p className="note err" role="status">上次同步有报告没拉到（{beijing(sync.lastError.at)}）：{sync.lastError.message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {loading && !data ? <p role="status">正在加载仓储费…</p> : data && <>
      {data.notes.length > 2 && data.notes.slice(0, -2).map((note) => <p key={note} className="note">{note}</p>)}
      <div className="price-kpis stg-kpis">
        <div className="price-kpi"><span>在库 / 在途</span><b>{fmt(totals.stock)}<small className="stg-sub"> / {fmt(totals.transit)}</small></b><small>{totals.skus} 个 SKU</small></div>
        <div className="price-kpi"><span>超过 180 天</span><b className={totals.aged181 ? 'danger' : ''}>{fmt(totals.aged181)} 件</b><small>{totals.aisSkus} 个 SKU · 91–180 天 {fmt(totals.aged91)} 件</small></div>
        <div className="price-kpi"><span>下次超龄附加费（预估）</span><b className={totals.aisFee ? 'danger' : ''}>{usd(totals.aisFee)}</b><small>每月 15 号前后收</small></div>
        <div className="price-kpi"><span>下月仓储费（预估）</span><b>{usd(totals.storageNextMonth)}</b><small>上月实际 {usd(totals.lastMonthFee)}{totals.lastFeeMonth ? `（${totals.lastFeeMonth}）` : ''}</small></div>
      </div>

      <section className="card">
        <div className="card-title">提醒</div>
        {data.findings.length ? <ul className="ret-findings">{data.findings.map((item, index) => <li key={index} className={`lvl-${item.level}`}>
          <span className={`tag ${LEVEL[item.level][0]}`}>{LEVEL[item.level][1]}</span><div><b>{item.title}</b><p>{item.detail}</p>
            {item.sku && <button type="button" className="btn sm ghost" onClick={() => { setQuery(item.sku); setOnlyStock(false); setOpen(item.sku); }}>看这个 SKU</button>}</div></li>)}</ul>
          : <p className="hint">没有快超龄或冗余的库存。</p>}
      </section>

      <div className="stg-grid">
        <section className="card"><div className="card-title">每月仓储费 <small className="hint">（<span className="stg-dot fee" />月度仓储费 <span className="stg-dot aged" />已收超龄附加费）</small></div>
          <Monthly rows={data.monthly} /></section>
        <section className="card"><div className="card-title">按款式</div>
          <div className="scroll"><table className="tbl"><thead><tr><th>款式</th><th className="num">在库</th><th className="num">在途</th><th className="num">可售天数</th>
            <th className="num">91–180 天</th><th className="num">180 天以上</th><th className="num">下次超龄费</th><th className="num">下月仓储费</th><th className="num">上月仓储费</th></tr></thead>
            <tbody>{data.styles.map((item) => <tr key={item.style}>
              <td><b>{item.style}</b>{item.sizes.length > 0 && <small className="stg-sizes">超龄：{item.sizes.join('、')}</small>}</td>
              <td className="num">{fmt(item.stock)}</td><td className="num">{fmt(item.transit)}</td>
              <td className={`num ${item.stockDays > 120 ? 'warn' : ''}`}>{item.stockDays ?? '—'}</td>
              <td className={`num ${item.aged91 ? 'warn' : ''}`}>{item.aged91 ? fmt(item.aged91) : ''}</td>
              <td className={`num strong ${item.aged181 ? 'danger' : ''}`}>{item.aged181 ? fmt(item.aged181) : ''}</td>
              <td className={`num ${item.aisFee ? 'danger' : ''}`}>{item.aisFee ? usd(item.aisFee) : ''}</td>
              <td className="num">{item.storageNextMonth ? usd(item.storageNextMonth) : ''}</td><td className="num">{item.lastMonthFee ? usd(item.lastMonthFee) : ''}</td></tr>)}</tbody></table></div></section>
      </div>

      <section className="card">
        <div className="row wrap price-toolbar">
          <div className="card-title">每个 SKU</div>
          <label>搜索 <input className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU / ASIN / 款式 / 颜色" /></label>
          <label className="price-check"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> 只看有库存的</label>
          <div className="spacer" /><span className="hint">{rows.length} 个 SKU · 点表头排序，点一行看明细
            <span className="stg-legend">{AGES.map(([, label, tone]) => <span key={tone}><span className={`stg-dot ${tone}`} />{label}</span>)}</span></span></div>
        {!rows.length ? <p className="note">{data.skus.length ? '当前筛选没有结果。' : '还没有数据。'}</p> :
          <div className="scroll ret-table"><table className="tbl">
            <thead><tr>{head('sku', 'SKU')}{head('stock', '在库', 'num')}<th className="num">在途</th>{head('sold30', '近30天卖', 'num')}{head('stockDays', '可售天数', 'num')}
              <th>库龄分布</th>{head('aged91', '91–180 天', 'num')}{head('aged181', '180 天以上', 'num')}{head('aisFee', '下次超龄费', 'num')}
              {head('storageNextMonth', '下月仓储费', 'num')}{head('lastMonthFee', '上月仓储费', 'num')}{head('feePerSold', '每卖一件摊', 'num')}<th>亚马逊建议</th></tr></thead>
            <tbody>{rows.map((row) => <Fragment key={row.sku}>
              <tr className={`ret-row${open === row.sku ? ' open' : ''}`} onClick={() => toggle(row.sku)}
                tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row.sku); } }} aria-expanded={open === row.sku}>
                <td className="col-sku"><b>{row.sku}</b>{nameOf(row) && <small>{nameOf(row)}</small>}</td>
                <td className="num strong">{fmt(row.stock)}</td>
                <td className="num">{row.transit ? (onOpenShipments ? <button type="button" className="link-btn" title="看这个 SKU 的货件"
                  onClick={(e) => { e.stopPropagation(); onOpenShipments(row.sku); }}>{fmt(row.transit)}</button> : fmt(row.transit)) : ''}</td>
                <td className="num">{fmt(row.sold30)}</td>
                <td className={`num ${row.stockDays > 120 ? 'warn' : ''}`}>{row.stockDays ?? (row.stock ? <span className="hint">没卖</span> : '')}</td>
                <td><AgeBar ages={row.ages} /></td>
                <td className={`num ${row.aged91 ? 'warn' : ''}`}>{row.aged91 ? fmt(row.aged91) : ''}</td>
                <td className={`num strong ${row.aged181 ? 'danger' : ''}`}>{row.aged181 ? fmt(row.aged181) : ''}</td>
                <td className={`num strong ${row.aisFee ? 'danger' : ''}`}>{row.aisFee ? usd(row.aisFee) : ''}</td>
                <td className="num">{row.storageNextMonth ? usd(row.storageNextMonth) : ''}</td>
                <td className="num">{row.lastMonthFee != null ? usd(row.lastMonthFee) : ''}</td>
                <td className={`num ${row.feePerSold >= 2 ? 'warn' : ''}`}>{row.feePerSold != null ? usd(row.feePerSold) : ''}</td>
                <td>{row.health && <span className={`tag ${row.health === '健康' ? 'green' : row.health === '冗余' || row.health === '库龄偏长' ? 'amber' : 'gray'}`}>{row.health}</span>}
                  {row.recommendedAction && row.recommendedAction !== '无需处理' ? <small className="stg-action">{row.recommendedAction}</small> : null}</td></tr>
              {open === row.sku && <tr className="ret-detail"><td colSpan={13}><Detail row={row} /></td></tr>}</Fragment>)}</tbody>
          </table></div>}
        <p className="hint price-legend">{data.notes.slice(-2).join(' ')} 「每卖一件摊」= 上月仓储费 ÷ 上月卖出件数。可售天数 = 在库 ÷ 近 30 天日均销量，超过 120 天标黄。</p>
      </section></>}
  </div>;
}
