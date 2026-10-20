import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import MarkdownView from './MarkdownView.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './ReturnsPage.css';
import './ShipmentsPage.css';
import './AgentPages.css';

const AREA_LABEL = { inventory: '库存', listing: 'Listing', search: '搜索词', rank: '排名与权重', ads: '广告', returns: '退货', competitors: '竞品', other: '其它' };
const SECTION_TONE = { good: ['green', '正常'], watch: ['amber', '留意'], bad: ['red', '有问题'] };
const LEVEL = { high: ['red', '要处理'], medium: ['amber', '留意'], low: ['gray', '参考'] };
const PRIORITY = { high: ['red', '高'], medium: ['amber', '中'], low: ['gray', '低'] };
const ACTION_TYPE = { proposal: ['blue', '已放进待确认'], todo: ['amber', '要你去做'], watch: ['gray', '继续观察'] };
const VERDICT_TONE = { works: 'green', no_effect: 'gray', hurts: 'red', too_early: 'blue', unclear: 'amber' };
const VERDICT_LABEL = { works: '有效', no_effect: '没变化', hurts: '变差', too_early: '数据还不够', unclear: '有干扰，看不清' };
const LESSON_TONE = { works: 'green', no_effect: 'gray', hurts: 'red', rule: 'blue' };
const RUN_LABEL = { done: '已分析', partial: '部分数据缺失', missing: '没跑' };
const CONF_WIDTH = { low: 33, medium: 66, high: 100 };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

const fmt = (value, digits = 0) => (value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const money = (value) => (value == null ? '—' : `$${fmt(value, 2)}`);
const weekday = (day) => WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()];

/** 和前 7 天日均比的变化:涨绿跌红;花费和 ACOS 反过来 */
function Delta({ pct, points, invert = false, suffix = '' }) {
  const value = pct ?? points;
  if (value == null) return <small className="agt-delta">—</small>;
  const good = invert ? value < 0 : value > 0;
  const text = `${value > 0 ? '+' : ''}${fmt(value, 1)}${pct != null ? '%' : ' 个点'}${suffix}`;
  return <small className={`agt-delta ${value === 0 ? '' : good ? 'up' : 'down'}`}>{text} <span>vs 前 7 天日均</span></small>;
}

function Kpis({ kpis }) {
  const sales = kpis?.sales, traffic = kpis?.traffic, ads = kpis?.ads;
  return <div className="price-kpis agt-kpis">
    <div className="price-kpi"><span>销量（件）</span><b>{fmt(sales?.units.value)}</b><Delta pct={sales?.units.changePct} /></div>
    <div className="price-kpi"><span>销售额</span><b>{money(sales?.sales.value)}</b><Delta pct={sales?.sales.changePct} /></div>
    <div className="price-kpi"><span>访问量{traffic?.lagDays ? <em title={`业务报告一般晚 2 天出数，这里是 ${traffic.day} 的`}> {traffic.day.slice(5).replace('-', '/')}</em> : ''}</span>
      <b>{fmt(traffic?.sessions.value)}</b><Delta pct={traffic?.sessions.changePct} /></div>
    <div className="price-kpi"><span>转化率{traffic?.lagDays ? <em> {traffic.day.slice(5).replace('-', '/')}</em> : ''}</span><b>{traffic?.conversion.value == null ? '—' : `${fmt(traffic.conversion.value, 1)}%`}</b><Delta points={traffic?.conversion.changePoints} /></div>
    <div className="price-kpi"><span>广告花费 <em>{ads?.source ?? 'Miguelpet'}</em></span><b>{money(ads?.spend?.value)}</b><Delta pct={ads?.spend?.changePct} invert /></div>
    <div className="price-kpi"><span>ACOS / TACOS</span><b>{ads?.acos?.value == null ? '—' : `${fmt(ads.acos.value, 1)}%`}
      <small className="agt-sub"> / {ads?.tacos?.value == null ? '—' : `${fmt(ads.tacos.value, 1)}%`}</small></b>
      <Delta pct={ads?.acos?.changePct} invert /></div>
  </div>;
}

function ReportView({ report, onNav }) {
  const changes = report.changes ?? {};
  const pendingIds = (report.proposalIds ?? []).filter((id) => changes[id]?.status === 'pending');
  const sections = report.sections ?? [];
  return <>
    <section className={`card agt-headline ${report.status === 'partial' ? 'partial' : ''}`}>
      <div className="agt-headline-day">{report.day.slice(5).replace('-', '/')}<small>周{weekday(report.day)}</small></div>
      <div><p className="agt-eyebrow">Claude 的结论 · 分析于 {report.updatedAt?.slice(5, 16)}（北京时间）{report.status === 'partial' ? ' · 部分数据缺失' : ''}</p>
        <h2>{report.headline}</h2>
        {pendingIds.length > 0 && <button type="button" className="btn sm primary" onClick={() => onNav('changes')}>去确认 {pendingIds.length} 条改动</button>}</div>
    </section>
    <Kpis kpis={report.kpis} />

    {(report.actions ?? []).length > 0 && <section className="card">
      <div className="card-title">今天要做</div>
      <ol className="agt-actions">{report.actions.map((action, index) => <li key={index}>
        <span className={`tag ${PRIORITY[action.priority]?.[0] ?? 'gray'}`}>{PRIORITY[action.priority]?.[1] ?? ''}</span>
        <div><p>{action.text}</p>
          <div className="agt-action-meta"><span className={`tag ${ACTION_TYPE[action.type]?.[0] ?? 'gray'}`}>{ACTION_TYPE[action.type]?.[1] ?? action.type}</span>
            {(action.proposalIds ?? []).map((id) => changes[id] && <span key={id} className="agt-chip" title={changes[id].target}>
              #{id} {changes[id].kindLabel} · <b className={changes[id].status === 'pending' ? 'agt-wait' : ''}>{changes[id].statusLabel}</b></span>)}</div></div></li>)}</ol>
    </section>}

    <div className="agt-sections">{sections.map((section, index) => <section key={index} className={`card agt-section s-${section.status}`}>
      <div className="agt-section-head"><span className={`agt-dot ${SECTION_TONE[section.status]?.[0]}`} aria-hidden="true" />
        <b>{AREA_LABEL[section.area] ?? section.area}</b><span className={`tag ${SECTION_TONE[section.status]?.[0]}`}>{SECTION_TONE[section.status]?.[1]}</span></div>
      <p className="agt-section-sum">{section.summary}</p>
      {(section.findings ?? []).length > 0 && <ul className="agt-findings">{section.findings.map((item, i) => <li key={i}>
        <span className={`agt-dot ${LEVEL[item.level]?.[0]}`} title={LEVEL[item.level]?.[1]} aria-label={LEVEL[item.level]?.[1]} />
        <span>{item.sku && <b className="mono">{item.sku} </b>}{item.text}</span></li>)}</ul>}
    </section>)}</div>

    {(report.reviews ?? []).length > 0 && <section className="card">
      <div className="row wrap"><div className="card-title">改动复盘</div><div className="spacer" />
        <button type="button" className="btn sm ghost" onClick={() => onNav('changelog')}>在改动日志里看全部</button></div>
      <div className="scroll"><table className="tbl agt-reviews"><thead><tr><th>改动</th><th>结论</th><th className="num">销量/天</th><th className="num">访问量</th>
        <th className="num">转化率</th><th>依据</th></tr></thead>
      <tbody>{report.reviews.map((review) => { const change = changes[review.changeId]; const m = review.metrics ?? {};
        return <tr key={review.changeId}>
          <td className="col-sku"><b>#{review.changeId} {change?.kindLabel}</b><small>{change?.target}</small></td>
          <td><span className={`tag ${VERDICT_TONE[review.verdict]}`}>{VERDICT_LABEL[review.verdict]}</span></td>
          <td className={`num ${m.unitsPerDayPct > 0 ? 'agt-up' : m.unitsPerDayPct < 0 ? 'agt-down' : ''}`}>{m.unitsPerDayPct == null ? '' : `${m.unitsPerDayPct > 0 ? '+' : ''}${m.unitsPerDayPct}%`}</td>
          <td className="num">{m.sessionsPct == null ? '' : `${m.sessionsPct > 0 ? '+' : ''}${m.sessionsPct}%`}</td>
          <td className="num">{m.conversionPoints == null ? '' : `${m.conversionPoints > 0 ? '+' : ''}${m.conversionPoints} 点`}</td>
          <td className="agt-review-text">{review.text}</td></tr>; })}</tbody></table></div>
    </section>}

    <div className="agt-foot">
      {(report.lessons ?? []).length > 0 && <section className="card"><div className="card-title">这次用到的经验</div>
        <ul className="agt-used">{report.lessons.map((lesson) => <li key={lesson.id}><span className={`tag ${LESSON_TONE[lesson.verdict]}`}>#{lesson.id}</span> {lesson.title}</li>)}</ul></section>}
      {(report.dataGaps ?? []).length > 0 && <section className="card"><div className="card-title">数据缺口</div>
        <ul className="agt-gaps">{report.dataGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></section>}
    </div>
  </>;
}

const KPI_TONE = { good: 'up', bad: 'down', neutral: '' };
const shortDay = (day) => day.slice(5).replace('-', '/');

/** 周报:按周列出,正文是 Claude 写的 Markdown */
function Weekly() {
  const [list, setList] = useState(null);
  const [week, setWeek] = useState('');
  const [report, setReport] = useState(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    api.agentWeekly().then((data) => { setList(data.reports); setWeek(data.reports[0]?.weekStart ?? ''); }).catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!week) return;
    setReport(undefined);
    api.agentWeeklyReport(week).then((data) => setReport(data.report)).catch((err) => setError(err.message));
  }, [week]);
  if (error) return <p className="note err" role="alert">{error}</p>;
  if (!list) return <p role="status">正在加载周报…</p>;
  if (!list.length) return <p className="note">还没有周报。每周一的定时分析会在日报之外写一份上周（周一到周日）的周报，写好后在这里看。</p>;
  return <>
    <div className="agt-weeks" role="list" aria-label="选择周">
      {list.map((item) => <button key={item.weekStart} type="button" role="listitem" className={`agt-week${item.weekStart === week ? ' on' : ''}`}
        aria-pressed={item.weekStart === week} title={item.headline} onClick={() => setWeek(item.weekStart)}>
        {shortDay(item.weekStart)}–{shortDay(item.weekEnd)}</button>)}
    </div>
    {report === undefined ? <p role="status">正在加载…</p> : !report ? <p className="note">这一周的周报找不到了。</p> : <>
      <section className="card agt-headline">
        <div className="agt-headline-day agt-week-range">{shortDay(report.weekStart)}<small>到 {shortDay(report.weekEnd)}</small></div>
        <div><p className="agt-eyebrow">Claude 的周报 · 写于 {report.updatedAt?.slice(5, 16)}（北京时间）</p><h2>{report.headline}</h2></div>
      </section>
      {report.kpis.length > 0 && <div className="price-kpis agt-kpis">{report.kpis.map((kpi, index) => <div key={index} className="price-kpi">
        <span>{kpi.label}</span><b>{kpi.value}</b>
        <small className={`agt-delta ${KPI_TONE[kpi.tone] ?? ''}`}>{kpi.change ?? ''}{kpi.prev != null && <span> 前一周 {kpi.prev}</span>}</small></div>)}</div>}
      <section className="card agt-weekly"><MarkdownView text={report.markdown} /></section>
    </>}
  </>;
}

function Lessons({ owner }) {
  const [status, setStatus] = useState('active');
  const [area, setArea] = useState('');
  const [lessons, setLessons] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(0);
  const load = () => api.agentLessons(status, area).then((data) => { setLessons(data.lessons); setError(''); }).catch((err) => setError(err.message));
  useEffect(() => { load(); }, [status, area]);
  async function flip(lesson) {
    setBusy(lesson.id);
    try { await api.agentLessonStatus(lesson.id, lesson.status === 'active' ? 'retired' : 'active'); await load(); }
    catch (err) { setError(err.message); } finally { setBusy(0); }
  }
  return <section className="card">
    <div className="row wrap price-toolbar">
      <label>状态 <select className="inp" value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="active">生效中</option><option value="retired">已停用</option><option value="all">全部</option></select></label>
      <label>方面 <select className="inp" value={area} onChange={(e) => setArea(e.target.value)}><option value="">全部</option>
        {Object.entries(AREA_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <div className="spacer" /><span className="hint">每次分析前 Claude 先读生效中的经验；写错或过时的可以停用，它就不会再按这条做。</span></div>
    {error && <p className="note err" role="alert">{error}</p>}
    {!lessons ? <p role="status">正在加载…</p> : !lessons.length ? <p className="note">还没有经验。改动执行满 7 天、复盘出结论后会自动积累到这里。</p> :
      <ul className="agt-lessons">{lessons.map((lesson) => <li key={lesson.id} className={lesson.status === 'retired' ? 'retired' : ''}>
        <div className="agt-lesson-head">
          <span className={`tag ${LESSON_TONE[lesson.verdict]}`}>{lesson.verdictLabel}</span>
          <b>{lesson.title}</b>
          <div className="spacer" />
          <span className="agt-conf" title={`可信度：${lesson.confidenceLabel}`}>可信度 <span className="agt-conf-track"><span style={{ width: `${CONF_WIDTH[lesson.confidence]}%` }} /></span> {lesson.confidenceLabel}</span>
        </div>
        <p>{lesson.body}</p>
        <div className="agt-lesson-meta">
          <span>{lesson.areaLabel}{lesson.changeKindLabel ? ` · ${lesson.changeKindLabel}` : ''}{lesson.style ? ` · ${lesson.style}` : ''}</span>
          {lesson.changeIds.length > 0 && <span>证据：{lesson.changeIds.map((id) => `#${id}`).join(' ')}</span>}
          {lesson.evidence && <span className="agt-evidence">{lesson.evidence}</span>}
          <span>用过 {lesson.timesUsed} 次 · {lesson.source === 'claude' ? 'Claude' : lesson.source} 记于 {lesson.fromDay ?? lesson.createdAt.slice(0, 10)}</span>
          {lesson.status === 'retired' && <span className="agt-retired">已停用：{lesson.retiredReason}</span>}
          {owner && <button type="button" className="btn sm ghost" disabled={busy === lesson.id} onClick={() => flip(lesson)}>{lesson.status === 'active' ? '停用' : '恢复'}</button>}
        </div></li>)}</ul>}
  </section>;
}

export default function AgentReportPage({ owner, onNav }) {
  const [meta, setMeta] = useState(null);
  const [day, setDay] = useState('');
  const [report, setReport] = useState(undefined);
  const [tab, setTab] = useState('report');
  const [error, setError] = useState('');

  useEffect(() => {
    api.agentReports().then((data) => { setMeta(data); setDay(data.reports[0]?.day ?? ''); if (!data.reports.length) setReport(null); })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    if (!day) return;
    setReport(undefined);
    api.agentReport(day).then((data) => setReport(data.report)).catch((err) => setError(err.message));
  }, [day]);

  const calendar = useMemo(() => [...(meta?.calendar ?? [])].reverse(), [meta]);
  const missed = calendar.filter((item) => item.status === 'missing').length;
  return <div className="lib agent-page animate-in">
    <div className="lib-head"><div><h1>AI 日报 <span className="tag blue">US 站</span></h1>
      <p className="hint">{meta?.schedule?.label ?? '每天美国太平洋时间凌晨 2:00'}，Claude 用 Miguel_Agent（网站数据）和 Miguelpet（广告数据）分析前一天的全店情况，结论写在这里，每周一另写上周的周报；
        要改的 Listing 和广告放进「待确认改动」，你确认后才执行。</p></div></div>
    {error && <p className="note err" role="alert">{error}</p>}

    {calendar.length > 0 && <div className="agt-calendar" role="list" aria-label="最近 14 天">
      {calendar.map((item) => <button key={item.day} type="button" role="listitem" className={`agt-day ${item.status}${item.day === day ? ' on' : ''}`}
        disabled={item.status === 'missing'} title={`${item.day} ${RUN_LABEL[item.status]}`} onClick={() => { setDay(item.day); setTab('report'); }}>
        <small>周{weekday(item.day)}</small><b>{item.day.slice(8)}</b><span className="agt-day-dot" /></button>)}
      <span className="hint agt-cal-note">{missed ? `最近 14 天有 ${missed} 天没跑` : '最近 14 天每天都跑了'}</span>
    </div>}

    <div className="shp-tabs agt-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'on' : ''} onClick={() => setTab('report')}>每日分析</button>
      <button type="button" role="tab" aria-selected={tab === 'weekly'} className={tab === 'weekly' ? 'on' : ''} onClick={() => setTab('weekly')}>周报</button>
      <button type="button" role="tab" aria-selected={tab === 'lessons'} className={tab === 'lessons' ? 'on' : ''} onClick={() => setTab('lessons')}>经验库</button>
    </div>

    {tab === 'lessons' ? <Lessons owner={owner} /> : tab === 'weekly' ? <Weekly /> : report === undefined ? <p role="status">正在加载日报…</p>
      : report === null ? <p className="note">还没有日报。每天定时分析开启后，第二天早上就能在这里看到前一天的结论。</p>
        : <ReportView report={report} onNav={onNav} />}
  </div>;
}
