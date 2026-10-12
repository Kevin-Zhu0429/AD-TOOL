import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { detailText } from '../changeExport.js';
import { ChangeBody } from './PetChangesPage.jsx';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './PetChangesPage.css';
import './ShipmentsPage.css';
import './AgentPages.css';

const STATUS_TONE = { pending: 'blue', queued: 'gray', running: 'blue', submitted: 'amber', applied: 'green', not_applied: 'red',
  export: 'amber', exported: 'amber', failed: 'red', rejected: 'gray', superseded: 'gray' };
const VERDICT_TONE = { works: 'green', no_effect: 'gray', hurts: 'red', too_early: 'blue', unclear: 'amber' };
const STATE_FILTERS = {
  all: ['全部', () => true],
  pending: ['待确认', (item) => item.status === 'pending'],
  flight: ['执行中', (item) => ['queued', 'running', 'submitted', 'export', 'exported'].includes(item.status)],
  applied: ['已生效', (item) => item.status === 'applied'],
  review: ['待复盘', (item) => item.status === 'applied' && (!item.verdict || item.verdict === 'too_early')],
  failed: ['失败 / 未生效', (item) => ['failed', 'not_applied'].includes(item.status)],
  closed: ['已拒绝', (item) => ['rejected', 'superseded'].includes(item.status)],
};
const AI_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', revert: '撤回', manual: '手动', intel: '产品情报' };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const signed = (value, unit = '%') => (value == null ? null : `${value > 0 ? '+' : ''}${value}${unit}`);
const dayTitle = (day) => `${day.slice(5).replace('-', '/')} 周${WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;

/** 提议 → 确认 → 执行 → 生效 → 复盘 */
function Steps({ steps }) {
  return <ol className="cl-steps">{steps.map((step) => <li key={step.key} className={step.state} title={[step.label, step.note, step.at].filter(Boolean).join(' · ')}>
    <span className="cl-step-dot" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'fail' ? '✕' : ''}</span>
    <span className="cl-step-label">{step.note && step.state !== 'done' ? step.note : step.label}</span></li>)}</ol>;
}

function Impact({ impact }) {
  // 执行后不满 7 天的对比不稳,列表里先不显示(展开后能看到)
  if (!impact || impact.afterDays < 7) return null;
  const chips = [['销量/天', impact.unitsPerDayPct, '%'], ['访问量', impact.sessionsPct, '%'], ['转化', impact.conversionPoints, ' 点']]
    .filter(([, value]) => value != null);
  if (!chips.length) return null;
  return <span className="cl-impact">{chips.map(([label, value, unit]) => <span key={label} className={value > 0 ? 'up' : value < 0 ? 'down' : ''}>{label} {signed(value, unit)}</span>)}</span>;
}

function Detail({ item }) {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.changeEvents(item.id).then((data) => setEvents(data.events)).catch(() => setEvents([])); }, [item.id]);
  const impact = item.impact;
  return <div className="cl-detail">
    <div className="cl-detail-grid">
      <div><h4>改了什么</h4><ChangeBody item={item} />
        {item.reason && <p className="cl-reason"><b>为什么：</b>{item.reason}</p>}
        {item.error && <p className="note err">{item.error}</p>}</div>
      <div>
        {impact && <><h4>执行前后各 14 天</h4>
          <dl className="cl-ba">
            <dt>日均销量</dt><dd>{impact.unitsBefore ?? '—'} → <b>{impact.unitsAfter ?? '—'}</b> {impact.unitsPerDayPct != null && <span className={impact.unitsPerDayPct >= 0 ? 'agt-up' : 'agt-down'}>（{signed(impact.unitsPerDayPct)}）</span>}</dd>
            {impact.sessionsPct != null && <><dt>访问量</dt><dd>{signed(impact.sessionsPct)}</dd></>}
            {impact.conversionPoints != null && <><dt>转化率</dt><dd>{signed(impact.conversionPoints, ' 个点')}</dd></>}
          </dl>
          {(impact.caution || impact.otherChanges > 0 || impact.stockEvents > 0) && <p className="hint">{[impact.caution, impact.otherChanges ? `同期这个 SKU 还有 ${impact.otherChanges} 条改动` : '',
            impact.stockEvents ? `同期有 ${impact.stockEvents} 次断货/补货` : ''].filter(Boolean).join('；')}</p>}</>}
        <h4>复盘</h4>
        {!item.reviews.length ? <p className="hint">{item.status === 'applied' ? '生效满 7 天后，每日分析会自动复盘。' : '生效后才复盘。'}</p> :
          <ul className="cl-reviews">{item.reviews.map((review) => <li key={review.day}>
            <span className={`tag ${VERDICT_TONE[review.verdict]}`}>{review.verdictLabel}</span>
            <small>{review.day} · 执行后第 {review.daysAfter ?? '?'} 天</small>
            <p>{review.text}</p>
            {review.lessonTitle && <p className="cl-lesson">→ 记进经验库：{review.lessonTitle}</p>}</li>)}</ul>}
      </div>
    </div>
    <h4>操作记录</h4>
    {!events ? <p className="hint">正在加载…</p> : !events.length ? <p className="hint">没有记录。</p> :
      <ol className="cl-events">{events.map((event) => <li key={event.id}><span className="mono">{event.at.slice(5, 16)}</span>
        <b>{event.actionLabel}</b><span>{AI_LABEL[event.actor] ?? (event.actor === 'system' ? '网站' : event.userName ?? '')}</span>
        <span className="hint">{detailText(event)}</span></li>)}</ol>}
  </div>;
}

export default function ChangeLogPage({ onNav }) {
  const [days, setDays] = useState(60);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [group, setGroup] = useState('all');
  const [state, setState] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());

  useEffect(() => { api.changeTimeline(days).then((result) => { setData(result); setError(''); }).catch((err) => setError(err.message)); }, [days]);

  const items = useMemo(() => {
    if (!data) return [];
    const term = query.trim().toLowerCase();
    const test = STATE_FILTERS[state][1];
    return data.items.filter((item) => (group === 'all' || item.group === group) && test(item)
      && (!term || [item.targetLabel, item.kindLabel, item.reason, item.batch, String(item.id)].some((field) => String(field ?? '').toLowerCase().includes(term))));
  }, [data, group, state, query]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const key = item.createdDay ?? item.createdAt.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return [...map.entries()];
  }, [items]);
  const toggle = (id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const stats = data?.stats;
  const peak = Math.max(1, ...(data?.daily ?? []).map((item) => Math.max(item.proposed, item.executed)));

  return <div className="lib changelog-page animate-in">
    <div className="lib-head"><div><h1>改动日志 <span className="tag blue">US 站</span></h1>
      <p className="hint">Claude 提的每一条 Listing 和广告改动，从提议、你确认、执行、亚马逊生效到执行后 7/14/28 天的效果复盘，都串在一条线上。时间是北京时间。</p></div>
      <div className="row wrap"><label>看最近 <select className="inp" value={days} onChange={(e) => setDays(Number(e.target.value))}>
        {[30, 60, 90, 180].map((value) => <option key={value} value={value}>{value} 天</option>)}</select></label>
        <button type="button" className="btn" onClick={() => onNav('changes')}>去待确认改动</button></div></div>
    {error && <p className="note err" role="alert">{error}</p>}
    {!data ? !error && <p role="status">正在加载…</p> : <>
      <div className="price-kpis cl-kpis">
        <button type="button" className="price-kpi" onClick={() => setState('all')}><span>提议</span><b>{stats.proposed}</b><small>最近 {data.days} 天</small></button>
        <button type="button" className="price-kpi" onClick={() => setState('pending')}><span>等你确认</span><b className={stats.pending ? 'agt-wait' : ''}>{stats.pending}</b><small>确认后才会改</small></button>
        <button type="button" className="price-kpi" onClick={() => setState('flight')}><span>执行中</span><b>{stats.inFlight}</b><small>已提交等生效 / 待上传批量表</small></button>
        <button type="button" className="price-kpi" onClick={() => setState('applied')}><span>已生效</span><b>{stats.applied}</b><small>{stats.failed ? <span className="danger">{stats.failed} 条失败或未生效</span> : '没有失败'}</small></button>
        <button type="button" className="price-kpi" onClick={() => setState('review')}><span>复盘结论</span>
          <b><span className="agt-up">{stats.works}</span> <small className="agt-sub">有效</small> {stats.hurts > 0 && <><span className="agt-down">{stats.hurts}</span> <small className="agt-sub">变差</small></>}</b>
          <small>已复盘 {stats.reviewed} 条 · 待复盘 {stats.awaitingReview} 条</small></button>
      </div>

      <section className="card cl-chart-card">
        <div className="row wrap"><div className="card-title">最近 30 天每天的改动</div><div className="spacer" />
          <span className="cl-legend"><i className="p" /> 提议 <i className="e" /> 执行</span></div>
        <div className="cl-chart" role="img" aria-label="最近 30 天每天提议和执行的改动条数">
          {data.daily.map((item) => <div key={item.day} className="cl-col" title={`${item.day}：提议 ${item.proposed} 条，执行 ${item.executed} 条`}>
            <div className="cl-bars"><span className="p" style={{ height: `${item.proposed / peak * 100}%` }} /><span className="e" style={{ height: `${item.executed / peak * 100}%` }} /></div>
            <small>{Number(item.day.slice(8)) % 5 === 0 || item.day === data.today ? item.day.slice(5).replace('-', '/') : ''}</small></div>)}
        </div>
      </section>

      <section className="card">
        <div className="row wrap price-toolbar">
          <div className="shp-tabs cl-groups" role="tablist">{[['all', '全部'], ['listing', 'Listing'], ['ad', '广告']].map(([key, label]) =>
            <button key={key} type="button" role="tab" aria-selected={group === key} className={group === key ? 'on' : ''} onClick={() => setGroup(key)}>{label}</button>)}</div>
          <label>状态 <select className="inp" value={state} onChange={(e) => setState(e.target.value)}>
            {Object.entries(STATE_FILTERS).map(([key, [label]]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>搜索 <input className="inp" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SKU / 广告活动 / 原因 / 编号" /></label>
          <div className="spacer" /><span className="hint">{items.length} 条 · 点一条看改了什么、效果和每一步记录</span></div>
        {!items.length ? <p className="note">{data.items.length ? '当前筛选没有改动。' : '最近还没有改动。'}</p> :
          <div className="cl-days">{byDay.map(([day, list]) => <Fragment key={day}>
            <h3 className="cl-day">{dayTitle(day)}<small>{list.length} 条</small></h3>
            <ul className="cl-list">{list.map((item) => <li key={item.id} className={open.has(item.id) ? 'open' : ''}>
              <button type="button" className="cl-row" aria-expanded={open.has(item.id)} onClick={() => toggle(item.id)}>
                <span className="cl-what"><span className={`tag ${item.group === 'listing' ? 'blue' : 'amber'}`}>{item.kindLabel}</span>
                  <b>{item.targetLabel}</b><small>#{item.id}{item.batch ? ` · ${item.batch}` : ''}{item.source !== 'claude' ? ` · ${AI_LABEL[item.source] ?? item.source}` : ''}</small></span>
                <Steps steps={item.steps} />
                <span className="cl-outcome">
                  {item.verdict ? <span className={`tag ${VERDICT_TONE[item.verdict]}`}>{item.verdictLabel}</span> : <span className={`tag ${STATUS_TONE[item.status]}`}>{item.statusLabel}</span>}
                  <Impact impact={item.impact} /></span>
              </button>
              {open.has(item.id) && <Detail item={item} />}</li>)}</ul></Fragment>)}</div>}
      </section></>}
  </div>;
}
