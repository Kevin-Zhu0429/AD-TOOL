import { useEffect, useState } from 'react';
import { api } from '../api.js';
import AppDialog from './AppDialog.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './SalesStatsPage.css';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const num = (value, digits = 0) => value == null ? '' : Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const usd = (value) => value == null ? '' : `$${num(value, 2)}`;
const pct = (value) => value == null ? '' : `${num(value, 1)}%`;
// 达成率和时间进度比:跟上进度为绿,落后 10 个点以上为红
const pace = (rate, progress) => rate == null || !progress ? '' : rate >= progress ? 'good' : rate < progress - 10 ? 'danger' : 'warn';
const FIELDS = [['targetUnits', '目标销量（件）', 1], ['targetSales', '目标销售额（$）'], ['targetProfit', '目标利润额（$）'],
  ['actualProfit', '实际利润额（$，留空自动计算）'], ['adSpend', '广告花费（$）']];
// 实际利润额的来源说明:自动算的写清楚毛利、广告花费和覆盖了多少销售额
const profitNote = (row) => row.profitSource === 'manual' ? '手填的实际利润额'
  : row.profitSource === 'auto' ? [`按成本自动计算：毛利 ${usd(row.grossProfit)}${row.adSpend ? ` − 广告花费 ${usd(row.adSpend)}` : ''}`,
    row.coverage != null && row.coverage < 99.95 ? `覆盖销售额 ${pct(row.coverage)}，缺成本或 FBA 费的 SKU 没算进去${row.missingCostSkus?.length ? `：${row.missingCostSkus.slice(0, 8).join('、')}${row.missingCostSkus.length > 8 ? ' 等' : ''}` : ''}` : '覆盖全部销售额']
    .join('；') : undefined;
const partialCover = (row) => row.coverage != null && row.coverage < 99.95;

function WeeklyTable({ weekly }) {
  return <div className="scroll stats-table"><table className="tbl">
    <thead><tr><th>周销量</th>{weekly.map((week) => <th key={week.start} className={week.current ? 'current' : ''}>
      WK {week.week}<small>{md(week.start)}–{md(week.end)}</small></th>)}</tr></thead>
    <tbody>{WEEKDAYS.map((label, index) => <tr key={label}><th scope="row">{label}</th>
      {weekly.map((week) => <td key={week.start} className={`num${week.current ? ' current' : ''}`}>{week.days[index] == null ? '' : num(week.days[index])}</td>)}</tr>)}</tbody>
    <tfoot><tr><th scope="row">总计</th>{weekly.map((week) => <td key={week.start} className={`num${week.current ? ' current' : ''}`}>{num(week.total)}</td>)}</tr>
      <tr><th scope="row">日均</th>{weekly.map((week) => {
        const known = week.days.filter((units) => units != null).length;
        return <td key={week.start} className={`num dim${week.current ? ' current' : ''}`}>{known ? num(week.total / known, 1) : ''}</td>;
      })}</tr></tfoot>
  </table></div>;
}

function MonthlyTable({ monthly, onEdit }) {
  const cells = (row, total = false) => <>
    <td className="num">{num(row.targetUnits)}</td><td className="num strong">{num(row.units)}{row.partial ? '*' : ''}</td>
    <td className={`num ${total ? '' : pace(row.unitsRate, row.progress)}`}>{pct(row.unitsRate)}</td>
    <td className="num">{usd(row.targetSales)}</td><td className="num strong">{usd(row.sales)}{row.partial ? '*' : ''}</td>
    <td className={`num ${total ? '' : pace(row.salesRate, row.progress)}`}>{pct(row.salesRate)}</td>
    <td className="num">{usd(row.targetProfit)}</td><td className={`num strong${row.actualProfit < 0 ? ' danger' : ''}`} title={profitNote(row)}>
      {usd(row.actualProfit)}{row.profitSource === 'auto' && <small className="auto-tag">{partialCover(row) ? '自动·部分' : '自动'}</small>}</td>
    <td className={`num ${total ? '' : pace(row.profitRate, row.progress)}`}>{pct(row.profitRate)}</td>
    <td className="progress-cell">{total ? '' : <div className="progress" title={`时间进度 ${pct(row.progress)}`}><span style={{ width: `${row.progress}%` }} /><em>{pct(row.progress)}</em></div>}</td>
    <td className="num">{usd(row.adSpend)}</td><td className="num">{pct(row.adRatio)}</td>
    <td className={`num${row.margin < 0 ? ' danger' : ''}`} title={profitNote(row)}>{pct(row.margin)}</td></>;
  return <div className="scroll stats-table"><table className="tbl">
    <thead><tr><th>月</th><th>目标销量</th><th className="actual">实际销量</th><th>销量达成率</th><th>目标销售额</th><th className="actual">实际销售额</th>
      <th>销售额达成率</th><th>目标利润额</th><th className="actual">实际利润额</th><th>利润达成率</th><th>时间进度</th><th>广告花费</th><th>费比</th><th>利润率</th><th /></tr></thead>
    <tbody>{monthly.months.map((row) => <tr key={row.month} className={row.current ? 'current' : ''}><th scope="row">{row.label}</th>{cells(row)}
      <td><button className="btn sm" onClick={() => onEdit(row)} aria-label={`编辑${row.label}目标`}>编辑</button></td></tr>)}</tbody>
    <tfoot><tr><th scope="row">全年</th>{cells(monthly.total, true)}<td /></tr></tfoot>
  </table></div>;
}

export default function SalesStatsPage() {
  const [year, setYear] = useState(null), [weeks, setWeeks] = useState(8);
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [editor, setEditor] = useState(null), [busy, setBusy] = useState(false), [formError, setFormError] = useState('');

  async function load() {
    setLoading(true);
    try { setData(await api.salesStats({ year: year ?? '', weeks })); setError(''); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [year, weeks]);

  async function save(event) {
    event.preventDefault();
    setBusy(true); setFormError('');
    try {
      await api.saveMonthlyTarget(editor.month, Object.fromEntries(FIELDS.map(([key]) => [key, editor[key] ?? ''])));
      setEditor(null); await load();
    } catch (err) { setFormError(err.message); }
    finally { setBusy(false); }
  }

  const thisYear = Number((data?.today ?? new Date().toISOString()).slice(0, 4));
  const shownYear = year ?? data?.year ?? thisYear;
  return <div className="lib sales-stats animate-in">
    <div className="lib-head"><div><h1>销售统计 <span className="tag blue">US 站</span></h1>
      <p className="hint">全店销量按美国太平洋时间统计，和价格策略表用同一份亚马逊订单数据，同步后自动更新。{data?.coveredFrom ? `订单数据从 ${data.coveredFrom} 开始。` : '还没有同步过订单数据。'}</p></div></div>
    {error && <p className="note err" role="alert">{error}</p>}
    {loading && !data ? <p role="status">正在加载销售统计…</p> : data && <>
      <section className="card">
        <div className="row wrap stats-head"><div className="card-title">周销量</div><div className="spacer" />
          <label>显示 <select className="inp" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[4, 8, 12, 26].map((count) => <option key={count} value={count}>最近 {count} 周</option>)}</select></label></div>
        <WeeklyTable weekly={data.weekly} />
        <p className="hint">按 ISO 周（周一到周日）。本周标蓝，今天之后的日子留空；今天的数字截至上次同步。</p>
      </section>
      <section className="card">
        <div className="row wrap stats-head"><div className="card-title">每月数据</div><div className="spacer" />
          <label>年份 <select className="inp" value={shownYear} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear - 1, thisYear, thisYear + 1].map((option) => <option key={option} value={option}>{option} 年</option>)}</select></label></div>
        <MonthlyTable monthly={data.monthly} onEdit={(row) => { setFormError(''); setEditor({ ...row, actualProfit: row.profitSource === 'manual' ? row.actualProfit : '' }); }} />
        <p className="hint">实际销量和销售额来自亚马逊订单（不含税、已排除取消；待付款订单按当前售价估算）。目标和广告花费点「编辑」填写，费比＝广告花费÷实际销售额。
          实际利润额默认自动计算（标「自动」）：每天每个 SKU 的销售额 − 销量×（落地成本＋FBA 配送费）− 佣金，再减广告花费；成本在 SKU 库维护，没扣仓储费和退货。缺成本的 SKU 不算进去（标「自动·部分」，鼠标放上去看缺哪些），利润率＝利润额÷算进去的销售额。在「编辑」里手填实际利润额会以手填为准。
          达成率<span className="good">绿色</span>表示跟上时间进度，<span className="warn">黄色</span>略落后，<span className="danger">红色</span>落后 10 个点以上。{data.monthly.months.some((row) => row.partial) ? ' 带 * 的月份只有部分订单数据。' : ''}</p>
      </section></>}
    {editor && <AppDialog title={`${shownYear} 年${editor.label}目标与数据`} busy={busy} onClose={() => setEditor(null)}>
      <form noValidate onSubmit={save}><div className="stats-fields">
        {FIELDS.map(([key, label, integer]) => <label className="field" key={key}><span>{label}</span>
          <input className="inp" type="number" step={integer ? 1 : 'any'} min={key === 'actualProfit' ? undefined : 0} value={editor[key] ?? ''} disabled={busy}
            onChange={(e) => setEditor({ ...editor, [key]: e.target.value })} /></label>)}</div>
        <p className="hint">实际销量 {num(editor.units) || '—'} 件、实际销售额 {usd(editor.sales) || '—'} 由亚马逊数据自动计算。{editor.grossProfit != null ? `按成本自动算的毛利 ${usd(editor.grossProfit)}，实际利润额留空就用它减广告花费。` : '实际利润额留空时，有成本数据就自动计算。'}</p>
        {formError && <p className="note err" role="alert">{formError}</p>}
        <footer className="row"><div className="spacer" /><button className="btn" type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button>
          <button className="btn primary" disabled={busy}>{busy ? '正在保存…' : '保存'}</button></footer>
      </form></AppDialog>}
  </div>;
}
