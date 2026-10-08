import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import AppDialog, { useConfirm } from './AppDialog.jsx';
import SyncProgress from './SyncProgress.jsx';
import PetProductPage from './PetProductPage.jsx';
import './LibraryPage.css';
import './PetIntelPage.css';

const money = (value) => value == null ? '' : `$${Number(value).toFixed(2)}`;
const int = (value) => value == null ? '' : Number(value).toLocaleString('en-US');
const pct = (value) => value == null ? '' : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
const beijing = (time) => time ? new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';
const amazon = (asin) => `https://www.amazon.com/dp/${asin}`;
const md = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const range = (min, max) => min == null ? '' : min === max ? money(min) : `${money(min)}–${money(max)}`;
const COVER = { title: ['标题', 'cover-title'], bullets: ['五点', 'cover-bullets'], backend: ['后台', 'cover-backend'] };
const CHANGE_TONE = { price_down: 'red', price_up: 'green', title: 'amber', bullets: 'amber', main_image: 'amber', bsr_up: 'red',
  no_buybox: 'gray', variants_added: 'blue', variants_removed: 'gray' };

/** 小走势图。invert=true 时数字越小画得越高(排名) */
function Spark({ points, field, invert = false, label }) {
  const values = points.map((point) => point[field]).filter((value) => value != null);
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const usable = points.filter((point) => point[field] != null);
  const coords = usable.map((point, index) => {
    const x = (index / (usable.length - 1)) * 78 + 1;
    const ratio = (point[field] - min) / span;
    return `${x.toFixed(1)},${(invert ? 2 + ratio * 18 : 20 - ratio * 18).toFixed(1)}`;
  });
  return <svg className="spark" width="64" height="16" viewBox="0 0 80 22" preserveAspectRatio="none" role="img" aria-label={`${label}：${usable[0].day} ${values[0]} → ${usable.at(-1).day} ${values.at(-1)}`}>
    <polyline points={coords.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>;
}

function changeText(change) {
  if (change.kind === 'price_down' || change.kind === 'price_up') return `${money(change.before)} → ${money(change.after)}`;
  if (change.kind === 'bsr_up') return `#${int(Number(change.before))} → #${int(Number(change.after))}（比 7 天前）`;
  if (change.kind === 'no_buybox') return `原价 ${money(change.before)}`;
  if (change.kind === 'title') return change.after;
  if (change.kind === 'variants_added') return `新增 ${change.after.split(' ').length} 个`;
  if (change.kind === 'variants_removed') return `少了 ${change.after.split(' ').length} 个`;
  return '';
}

function ChangeFeed({ changes, onPick }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('');
  const list = changes.filter((change) => !kind || change.kind === kind);
  const kinds = [...new Set(changes.map((change) => change.kind))];
  const shown = open ? list : list.slice(0, 6);
  return <section className="card intel-changes" aria-label="竞品变化">
    <div className="row wrap"><h2>竞品变化 <span className="hint">近 30 天 {list.length} 条</span></h2><div className="spacer" />
      <div className="chips">{kinds.map((item) => <button key={item} className={`chip${kind === item ? ' on' : ''}`} onClick={() => setKind(kind === item ? '' : item)}>
        {changes.find((change) => change.kind === item).label}</button>)}</div></div>
    {!list.length ? <p className="hint">{changes.length ? '这个筛选下没有变化。' : '还没有变化记录。竞品每天同步一次，第二天起开始对比。'}</p> :
      <ul className="intel-change-list">{shown.map((change) => <li key={change.id}>
        <span className="day">{md(change.day)}</span>
        <span className={`tag ${CHANGE_TONE[change.kind] ?? 'gray'}`}>{change.label}</span>
        <button className="btn ghost sm" onClick={() => onPick(change.styleKey)} title="打开这个款式">{change.styleKey}</button>
        <a href={amazon(change.asin)} target="_blank" rel="noreferrer" className="mono">{change.asin}</a>
        <span className="who" title={change.title ?? ''}>{change.brand ? <b>{change.brand}</b> : null} {[change.size, change.color].filter(Boolean).join(' · ')}</span>
        <span className="what" title={changeText(change)}>{changeText(change)}</span></li>)}</ul>}
    {list.length > 6 && <button className="btn sm" onClick={() => setOpen(!open)}>{open ? '收起' : `展开全部 ${list.length} 条`}</button>}
  </section>;
}

function Suggestions({ items, busy, onDecide }) {
  if (!items.length) return null;
  return <section className="card intel-suggest" aria-label="推荐竞品">
    <h3>推荐竞品 <span className="hint">来自品牌分析搜索词报告：这些商品在本款核心词下点击排前 3。点「加入」才开始每天监控。</span></h3>
    <div className="intel-suggest-list">{items.map((item) => <article key={item.id} className="intel-suggest-item">
      {item.mainImage ? <img src={item.mainImage} alt="" loading="lazy" /> : <div className="img-ph" />}
      <div className="body">
        <div className="row wrap"><a href={amazon(item.asin)} target="_blank" rel="noreferrer" className="mono">{item.asin}</a>
          {item.brand && <b>{item.brand}</b>}<span className="tag blue">重合分 {(item.score * 100).toFixed(1)}</span>
          {item.evidence?.price != null && <span className={`tag ${item.evidence.priceFar ? 'amber' : 'gray'}`} title={item.evidence.priceFar ? '和我们的价格差一倍以上，已降权' : ''}>
            {money(item.evidence.price)}{item.evidence.priceFar ? ' 价差大' : ''}</span>}</div>
        <p className="title" title={item.title ?? ''}>{item.title ?? '（还没读到标题）'}</p>
        <div className="terms">{(item.evidence?.terms ?? []).map((term) => <span key={term.term} className="term" title={`点击份额 ${pct(term.clickShare)}，转化份额 ${pct(term.conversionShare)}`}>
          {term.term} <small>第{term.rank}</small></span>)}</div>
      </div>
      <div className="actions"><button className="btn primary sm" disabled={busy} onClick={() => onDecide(item, 'active')}>加入</button>
        <button className="btn sm" disabled={busy} onClick={() => onDecide(item, 'ignored')}>忽略</button></div>
    </article>)}</div>
  </section>;
}

function Children({ family, sameOnly }) {
  const rows = family.children.filter((child) => !sameOnly || child.sameSize);
  return <table className="tbl intel-children"><thead><tr><th>子体 ASIN</th><th>尺码</th><th>颜色</th><th className="num">价格</th><th className="num">划线价</th>
    <th className="num">大类排名</th><th className="num">小类排名</th><th className="num">月销量</th><th className="num">评分</th><th className="num">评论数</th></tr></thead>
    <tbody>{rows.map((child) => <tr key={child.asin} className={child.sameSize ? 'same' : ''}>
      <td><a href={amazon(child.asin)} target="_blank" rel="noreferrer" className="mono">{child.asin}</a></td>
      <td>{child.size ?? ''}{child.sameSize && <span className="tag green">同码</span>}</td><td>{child.color ?? ''}</td>
      <td className="num">{money(child.price)}</td><td className="num hint">{money(child.listPrice)}</td>
      <td className="num">{child.bsr ? `#${int(child.bsr)}` : ''}</td><td className="num">{child.subBsr ? `#${int(child.subBsr)}` : ''}</td>
      <td className="num">{int(child.units)}</td><td className="num">{child.rating ?? ''}</td><td className="num">{int(child.reviews)}</td></tr>)}
      {!rows.length && <tr><td colSpan={10} className="empty">没有和我们同尺码的子体。</td></tr>}</tbody></table>;
}

function Compare({ own, family, onClose }) {
  const side = (label, item) => <section className="intel-side">
    <h3>{label}</h3>
    {item.mainImage && <img src={item.mainImage} alt={`${label}主图`} />}
    <p className="hint">{item.brand ?? ''} · 图片 {item.imageCount ?? '—'} 张</p>
    <h4>标题（{item.title?.length ?? 0} 字符）</h4><p>{item.title ?? '—'}</p>
    <h4>五点</h4><ol>{(item.bullets ?? []).map((bullet, index) => <li key={index}>{bullet}</li>)}</ol>
    {item.backend !== undefined && <><h4>后台搜索词</h4><p className="mono">{item.backend || '—'}</p></>}
  </section>;
  return <AppDialog title={`对照：${own.key} vs ${family.brand ?? family.asin}`} wide onClose={onClose}>
    <div className="intel-compare">{side('我们', own)}{side(family.brand ?? family.asin, family)}</div>
  </AppDialog>;
}

function StyleDetail({ styleKey, revision, busy, setBusy, onChanged }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [asins, setAsins] = useState(''), [expanded, setExpanded] = useState(new Set()), [sameOnly, setSameOnly] = useState(false);
  const [compare, setCompare] = useState(null);
  const [confirmAction, confirmation] = useConfirm();
  useEffect(() => {
    let alive = true;
    setError('');
    api.competitorStyle(styleKey).then((result) => { if (alive) setData(result); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [styleKey, revision]);
  async function act(work, done) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); if (done) setMessage(done); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const add = () => act(async () => {
    const result = await api.addCompetitors(styleKey, asins);
    setAsins('');
    setMessage(`已加入 ${result.added.length} 个${result.skipped.length ? `，跳过自家 ASIN ${result.skipped.join('、')}` : ''}。下次同步后显示价格和排名。`);
  });
  const decide = (item, status) => act(() => api.updateCompetitor(item.id, { status }), status === 'active' ? `已加入 ${item.asin}` : `已忽略 ${item.asin}，以后不再推荐`);
  async function remove(family) {
    if (!await confirmAction(`把 ${family.brand ?? ''} ${family.asin} 移出监控？以后可能还会被推荐；不想再看到请选「忽略」。`, '移出')) return;
    act(() => api.removeCompetitor(family.id), `已移出 ${family.asin}`);
  }
  const toggle = (asin) => setExpanded((old) => { const next = new Set(old); if (next.has(asin)) next.delete(asin); else next.add(asin); return next; });
  if (error && !data) return <p className="note err" role="alert">{error}</p>;
  if (!data) return <p role="status">正在加载 {styleKey}…</p>;
  const { own, competitors, suggestions, terms, priceBand } = data;
  const columns = [{ key: 'own', label: '我们', coverage: own.coverage }, ...competitors.map((family) => ({ key: family.asin, label: family.brand ?? family.asin, coverage: family.coverage }))];
  return <div className="intel-style">
    {confirmation}
    <div className="intel-style-head">
      <div><h2>{own.key}</h2><p className="hint">{own.skus.length} 个 SKU · 尺码 {own.sizes.join(' / ') || '—'} · 近 7 天 {own.units7} 件 · 近 30 天 {own.units30} 件</p></div>
      {priceBand && <div className="intel-band" aria-label="价格带">
        <span>竞品价格</span><b>{money(priceBand.min)}</b><small>最低</small><b>{money(priceBand.median)}</b><small>中位</small><b>{money(priceBand.max)}</b><small>最高</small>
        <span className="sep" /><span>我们</span><b>{range(own.priceMin, own.priceMax)}</b></div>}
    </div>
    {message && <p className="note ok" role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    <Suggestions items={suggestions} busy={busy} onDecide={decide} />

    <section className="card">
      <div className="row wrap intel-toolbar"><h3>竞品对比 <span className="hint">{competitors.length} 个竞品家族</span></h3><div className="spacer" />
        <label className="intel-check"><input type="checkbox" checked={sameOnly} onChange={(e) => setSameOnly(e.target.checked)} /> 展开时只看同尺码子体</label>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (asins.trim()) add(); }}>
          <input className="inp" aria-label="竞品 ASIN" value={asins} onChange={(e) => setAsins(e.target.value)} placeholder="粘贴竞品 ASIN 或链接，多个用空格分开" />
          <button className="btn primary" disabled={busy || !asins.trim()}>加入监控</button></form></div>
      <div className="intel-table" role="region" tabIndex={0} aria-label="竞品对比表"><table className="tbl">
        <thead><tr><th>主图</th><th>品牌 / 标题</th><th className="num">变体</th><th className="num">价格 · 30 天</th>
          <th className="num">大类排名 · 30 天</th><th className="num">小类排名</th><th className="num">图片</th><th className="num">评分</th><th className="num">评论数</th><th className="num">月销量</th><th>操作</th></tr></thead>
        <tbody>
          <tr className="own"><td>{own.mainImage ? <img src={own.mainImage} alt="" /> : null}</td>
            <td className="title-cell"><b>我们 {own.brand ?? ''}</b><span title={own.title ?? ''}>{own.title ?? '（还没同步到目录）'}</span></td>
            <td className="num">{own.children.length}</td><td className="num">{range(own.priceMin, own.priceMax)}</td>
            <td className="num">{own.bsr ? `#${int(own.bsr)}` : ''}</td><td className="num" title={own.subCategory ?? ''}>{own.subBsr ? `#${int(own.subBsr)}` : ''}</td>
            <td className="num">{own.imageCount ?? ''}</td><td className="num">{own.rating ?? ''}</td><td className="num">{int(own.reviews)}</td>
            <td className="num" title="近 30 天订单">{own.units30}<small className="hint"> 30天</small></td><td /></tr>
          {competitors.map((family) => <FamilyRows key={family.asin} family={family} open={expanded.has(family.asin)} sameOnly={sameOnly}
            onToggle={() => toggle(family.asin)} onCompare={() => setCompare(family)} onRemove={() => remove(family)}
            onIgnore={() => act(() => api.updateCompetitor(family.id, { status: 'ignored' }), `已忽略 ${family.asin}`)} busy={busy} />)}
          {!competitors.length && <tr><td colSpan={11} className="empty">还没有竞品。{suggestions.length ? '从上面的推荐里点「加入」，' : ''}或粘贴竞品 ASIN 加入监控。</td></tr>}
        </tbody></table></div>
      <p className="hint">价格是购物车价（不含优惠券）；排名是亚马逊目录给的当前值，每天同步一次。评分、评论数、月销量来自卖家精灵导入，标了月份的是最近一次导入。</p>
    </section>

    <section className="card">
      <h3>核心词覆盖 <span className="hint">本款最近 4 周 ABA 里市场购买量最大的 {terms.length} 个词，看谁在标题 / 五点里写了</span></h3>
      {!terms.length ? <p className="hint">ABA 还没有本款 ASIN 的搜索词数据。到 ABA 页面同步后这里自动出现。</p> :
        <div className="intel-table" role="region" tabIndex={0} aria-label="核心词覆盖矩阵"><table className="tbl intel-cover">
          <thead><tr><th>搜索词</th><th className="num">市场购买</th><th className="num">我们点击份额</th><th className="num">我们购买份额</th>
            {columns.map((column) => <th key={column.key} className={column.key === 'own' ? 'own' : ''} title={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>{terms.map((term) => {
            const missingOwn = !own.coverage[term.term];
            const othersHave = competitors.filter((family) => family.coverage[term.term]).length;
            return <tr key={term.term} className={missingOwn && othersHave ? 'gap' : ''}>
              <td><b>{term.term}</b>{missingOwn && othersHave > 0 && <span className="tag red">我们没写</span>}</td>
              <td className="num">{int(term.marketPurchases)}</td><td className="num">{pct(term.clickShare)}</td><td className="num">{pct(term.purchaseShare)}</td>
              {columns.map((column) => {
                const where = column.coverage?.[term.term];
                return <td key={column.key} className={`cover ${where ? COVER[where][1] : 'cover-none'}${column.key === 'own' ? ' own' : ''}`}>{where ? COVER[where][0] : '—'}</td>;
              })}</tr>;
          })}</tbody></table></div>}
    </section>
    {compare && <Compare own={own} family={compare} onClose={() => setCompare(null)} />}
  </div>;
}

function FamilyRows({ family, open, sameOnly, onToggle, onCompare, onRemove, onIgnore, busy }) {
  const delta = family.priceChange7;
  return <>
    <tr className={open ? 'open' : ''}>
      <td>{family.mainImage ? <img src={family.mainImage} alt="" loading="lazy" /> : null}</td>
      <td className="title-cell"><span className="row"><b>{family.brand ?? '—'}</b><a href={amazon(family.asin)} target="_blank" rel="noreferrer" className="mono">{family.asin}</a>
        {family.source === 'aba' && <span className="tag blue" title={(family.evidence?.terms ?? []).map((term) => term.term).join('、')}>ABA 推荐</span>}
        {family.source === 'auto' && <span className="tag gray" title={`标题相似度 ${family.evidence?.relevance ?? ''}${family.evidence?.term ? `，从「${family.evidence.term}」搜到` : ''}。不像对手就点「忽略」或「移出」，以后不会再挂回来。`}>自动挂上</span>}</span>
        <span title={family.title ?? ''}>{family.title ?? (family.synced ? '' : '下次同步后显示')}</span></td>
      <td className="num"><button className="btn ghost sm" onClick={onToggle} aria-expanded={open}>{family.children.length} {open ? '▴' : '▾'}</button></td>
      <td className="num with-trend">{range(family.priceMin, family.priceMax)}
        <span className="trend">{delta ? <small className={delta < 0 ? 'down' : 'up'} title="最低价比 7 天前">{delta > 0 ? '+' : ''}{delta.toFixed(2)}</small> : null}
          <Spark points={family.history} field="price" label="最低价走势" /></span></td>
      <td className="num with-trend">{family.bsr ? `#${int(family.bsr)}` : ''}
        <span className="trend"><Spark points={family.history} field="bsr" invert label="大类排名走势" /></span></td>
      <td className="num" title={family.subCategory ?? ''}>{family.subBsr ? `#${int(family.subBsr)}` : ''}</td>
      <td className="num">{family.imageCount ?? ''}</td><td className="num">{family.rating ?? ''}</td><td className="num">{int(family.reviews)}</td>
      <td className="num" title={family.metricsMonth ? `${family.metricsMonth} 卖家精灵，子体合计` : ''}>{int(family.units)}{family.metricsMonth && <small className="hint"> {family.metricsMonth.slice(5)}月</small>}</td>
      <td><div className="row"><button className="btn sm" onClick={onCompare}>对照</button>
        <button className="btn sm" disabled={busy} onClick={onIgnore} title="不再监控，也不再推荐">忽略</button>
        <button className="btn sm danger" disabled={busy} onClick={onRemove}>移出</button></div></td>
    </tr>
    {open && <tr className="children-row"><td colSpan={11}><Children family={family} sameOnly={sameOnly} /></td></tr>}
  </>;
}

const LEVEL = { high: ['要紧', 'red'], medium: ['该看', 'amber'], low: ['可选', 'gray'] };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** 一条事项:级别、标题、依据、建议,以及能做的动作 */
function ActionItem({ action, owner, onFix, onOpenStyle, styleKey }) {
  const [copied, setCopied] = useState(false);
  const [label, tone] = LEVEL[action.level];
  const fix = action.fix;
  return <li className={`intel-action ${action.level}`}>
    <span className={`tag ${tone}`}>{label}</span>
    <div className="intel-action-body">
      <b>{action.title}</b>
      <p>{action.detail}</p>
      {action.hint && <p className="hint">{action.hint}</p>}
    </div>
    <div className="intel-action-do">
      {fix?.type === 'rule' && owner && <button className="btn sm" onClick={() => onFix(fix)}>{fix.label}</button>}
      {fix?.type === 'claude' && <button className="btn sm" title={fix.prompt}
        onClick={async () => { if (await copyText(fix.prompt)) { setCopied(true); setTimeout(() => setCopied(false), 2500); } else window.prompt('复制这段话发给 Claude', fix.prompt); }}>
        {copied ? '已复制，发给 Claude' : fix.label}</button>}
      {['competitor_price_down', 'competitor_out', 'competitor_edit', 'price_high', 'price_low', 'rating_gap', 'no_competitors'].includes(action.kind)
        && <button className="btn ghost sm" onClick={() => onOpenStyle(styleKey)}>看对手</button>}
    </div>
  </li>;
}

/** 本周要做:每个在卖款式这周该处理的事 */
function WeeklyActions({ revision, owner, onOpenStyle }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [showLow, setShowLow] = useState(false);
  useEffect(() => { api.intelActions().then(setData).catch((e) => setError(e.message)); }, [revision]);
  async function fix(item) {
    setError(''); setMessage('');
    try {
      const result = await api.intelFix(item.code, item.skus);
      const made = result.created?.length ?? 0, rejected = result.rejected ?? [];
      setMessage(`已生成 ${made} 条改动，去「待确认」页确认后才会改亚马逊。${rejected.length ? `${rejected.length} 条没生成：${rejected[0].error}` : ''}`);
    } catch (e) { setError(e.message); }
  }
  if (error && !data) return <p className="note err" role="alert">{error}</p>;
  if (!data) return <p role="status">正在整理本周要做的事…</p>;
  const { totals } = data;
  return <section className="intel-weekly">
    <div className="row wrap intel-toolbar">
      <h3>本周要做 <span className="hint">{data.styles.length} 个在卖款式：要紧 {totals.high} 件、该看 {totals.medium} 件、可选 {totals.low} 件
        {data.inactive ? `；另有 ${data.inactive} 个款式近 30 天没销量，没列出` : ''}</span></h3>
      <div className="spacer" />
      <label className="intel-check"><input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} /> 显示可选的</label>
    </div>
    {message && <p className="note ok" role="status">{message} <a href="#changes">去待确认 →</a></p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {!data.styles.length && <p className="note">近 30 天没有销量数据。先在价格策略表同步一次亚马逊数据。</p>}
    <div className="intel-weekly-grid">{data.styles.map((style) => {
      const actions = style.actions.filter((action) => showLow || action.level !== 'low');
      const trend = style.prevUnits7 ? Math.round((style.units7 / style.prevUnits7 - 1) * 100) : null;
      return <article key={style.key} className="card intel-weekly-card">
        <header>
          {style.mainImage ? <img src={style.mainImage} alt="" width="56" height="56" loading="lazy" /> : <span className="intel-thumb" />}
          <div>
            <button className="intel-style-name" onClick={() => onOpenStyle(style.key)}>{style.key}</button>
            <small className="hint">近 7 天 {style.units7} 件{trend != null ? `（${trend >= 0 ? '+' : ''}${trend}%）` : ''} · 30 天 {style.units30} 件 · 在库 {style.stock}
              {style.rating != null ? ` · ${style.rating} 星 ${style.reviews ?? ''} 评` : ''} · 对手 {style.competitors}</small>
          </div>
        </header>
        {actions.length ? <ul className="intel-actions">{actions.map((action) =>
          <ActionItem key={action.id} action={action} owner={owner} onFix={fix} onOpenStyle={onOpenStyle} styleKey={style.key} />)}</ul>
          : <p className="hint intel-none">{style.actions.length ? '只有可选的事项。' : '这周没发现要处理的事。'}</p>}
      </article>;
    })}</div>
    <p className="hint">依据：销量和库存来自每天的亚马逊同步，份额和转化来自品牌分析（ABA）每周数据，对手价格和变化来自每日竞品同步，评分来自卖家精灵导入。
      「生成…改动」只放进待确认，不会直接改亚马逊；「让 Claude…」会复制一段话，发到 Claude 里，它用连接器看数据、起草改动。</p>
  </section>;
}

function Health({ revision }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [redOnly, setRedOnly] = useState(false), [style, setStyle] = useState('');
  const [sellingOnly, setSellingOnly] = useState(true);
  useEffect(() => { api.competitorHealth().then(setData).catch((e) => setError(e.message)); }, [revision]);
  if (error) return <p className="note err" role="alert">{error}</p>;
  if (!data) return <p role="status">正在体检…</p>;
  const styles = [...new Set(data.rows.map((row) => row.styleKey))];
  const rows = data.rows.filter((row) => (!redOnly || row.checks.some((check) => check.level === 'red')) && (!style || row.styleKey === style)
    && (!sellingOnly || row.units30 > 0));
  const reds = data.rows.filter((row) => row.checks.some((check) => check.level === 'red')).length;
  return <section className="card">
    <div className="row wrap intel-toolbar"><h3>自家 Listing 体检 <span className="hint">{data.rows.length} 个 ASIN，{reds} 个有影响展示或收录的问题</span></h3><div className="spacer" />
      <label>款式 <select className="inp" value={style} onChange={(e) => setStyle(e.target.value)}><option value="">全部</option>{styles.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="intel-check"><input type="checkbox" checked={sellingOnly} onChange={(e) => setSellingOnly(e.target.checked)} /> 只看近 30 天有销量的</label>
      <label className="intel-check"><input type="checkbox" checked={redOnly} onChange={(e) => setRedOnly(e.target.checked)} /> 只看红色</label></div>
    <div className="intel-table" role="region" tabIndex={0} aria-label="Listing 体检"><table className="tbl intel-health">
      <thead><tr><th>款式</th><th>ASIN / SKU</th><th>尺码 · 颜色</th><th className="num">30 天销量</th><th>标题</th><th className="num">五点</th><th className="num">图片</th><th className="num">后台词</th><th>问题</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.asin}>
        <td>{row.styleKey}</td><td><a href={amazon(row.asin)} target="_blank" rel="noreferrer" className="mono">{row.asin}</a><small className="hint"> {row.sku ?? ''}</small></td>
        <td>{[row.size, row.color].filter(Boolean).join(' · ')}</td><td className="num">{row.units30}</td>
        <td className="title-cell"><span title={row.title ?? ''}>{row.title ?? ''}</span><small className="hint">{row.title ? `${row.title.length} 字符` : ''}</small></td>
        <td className="num">{row.bulletCount ?? ''}</td><td className="num">{row.imageCount ?? ''}</td><td className="num">{row.backendBytes == null ? '' : `${row.backendBytes}B`}</td>
        <td><ul className="checks">{row.checks.map((check, index) => <li key={index} className={check.level}>{check.text}</li>)}
          {!row.checks.length && <li className="ok">没有发现问题</li>}</ul></td></tr>)}
        {!rows.length && <tr><td colSpan={9} className="empty">{data.rows.length ? '这个筛选下没有 ASIN。' : '还没有数据：先在 SKU 库同步 ASIN，再点「同步竞品数据」。'}</td></tr>}</tbody></table></div>
    <p className="hint">红色＝影响展示或收录，必须改：亚马逊报错（主图被屏蔽、五点违规等）、后台搜索词超过 249 字节（整段不生效）、标题超过 200 字符、没有五点或图片。
      黄色＝建议改：标题没品牌、五点不足 5 条、图片少于 7 张或少于竞品、有量的核心词（近 4 周全市场成交 20 单以上）没写、亚马逊警告、比同尺码竞品中位价高 20% 以上。核心词覆盖同时看标题、五点和后台搜索词。</p>
  </section>;
}

// 卖家精灵导出的表头:按顺序认,前面的优先
const METRIC_FIELDS = [
  { key: 'asin', label: 'ASIN', required: true, patterns: [/^(子体)?asin$/i] },
  { key: 'parentAsin', label: '父 ASIN', patterns: [/父\s*asin|parent/i] },
  { key: 'units', label: '月销量', patterns: [/子体销量/, /月销量/, /销量|units|sales$/i] },
  { key: 'revenue', label: '月销售额', patterns: [/子体销售额/, /月销售额/, /销售额|revenue/i] },
  { key: 'price', label: '价格', patterns: [/^价格|^price/i] },
  { key: 'rating', label: '评分', patterns: [/^(评分|星级|rating)$/i] },
  { key: 'reviews', label: '评论数', patterns: [/评分数|评论数|ratings|reviews/i] },
];
const headerText = (value) => String(value ?? '').replace(/[（(].*?[)）]/g, '').trim();
function guessMetricColumns(headers) {
  const mapping = {};
  for (const field of METRIC_FIELDS) {
    for (const pattern of field.patterns) {
      const index = headers.findIndex((header, column) => pattern.test(headerText(header)) && !Object.values(mapping).includes(column));
      if (index >= 0) { mapping[field.key] = index; break; }
    }
  }
  return mapping;
}

function MetricsImport({ onClose, onDone }) {
  const [upload, setUpload] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function read(file) {
    if (!file) return;
    // 默认上个月:月初导出的一般是上个月的数据
    const month = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 7);
    setError('');
    try {
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const name = book.SheetNames[0], sheet = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
      setUpload({ book, name, sheet, mapping: guessMetricColumns(sheet[0] ?? []), filename: file.name, month });
    } catch (e) { setError(`读取失败：${e.message}`); }
  }
  const rows = useMemo(() => {
    if (!upload || upload.mapping.asin == null) return [];
    return upload.sheet.slice(1).map((line) => Object.fromEntries(METRIC_FIELDS.filter((field) => upload.mapping[field.key] != null)
      .map((field) => [field.key, line[upload.mapping[field.key]]]))).filter((row) => /^[A-Z0-9]{10}$/i.test(String(row.asin ?? '').trim()));
  }, [upload]);
  async function save() {
    setBusy(true); setError('');
    try { const result = await api.importCompetitorMetrics(upload.month, rows, upload.filename); onDone(`已导入 ${result.imported} 行卖家精灵数据（${upload.month}）。`); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <AppDialog title="导入卖家精灵数据" wide busy={busy} onClose={onClose}>
    <p className="hint">导出竞品（和自家）的子体数据表：ASIN、父 ASIN、月销量、评分、评论数、价格。同一个 ASIN 同一个月再导入会覆盖。亚马逊接口没有这些数据。</p>
    <label className="btn">选择 Excel / CSV<input aria-label="选择卖家精灵文件" type="file" accept=".xlsx,.xls,.csv" hidden disabled={busy} onChange={(e) => { read(e.target.files[0]); e.target.value = ''; }} /></label>
    {upload && <>
      <div className="intel-mapping">
        <label>工作表<select className="inp" value={upload.name} disabled={busy} onChange={(e) => { const name = e.target.value, sheet = XLSX.utils.sheet_to_json(upload.book.Sheets[name], { header: 1, defval: '' }); setUpload({ ...upload, name, sheet, mapping: guessMetricColumns(sheet[0] ?? []) }); }}>
          {upload.book.SheetNames.map((name) => <option key={name}>{name}</option>)}</select></label>
        <label>数据月份<input className="inp" type="month" value={upload.month} disabled={busy} onChange={(e) => setUpload({ ...upload, month: e.target.value })} /></label>
        {METRIC_FIELDS.map((field) => <label key={field.key}>{field.label}{field.required ? ' *' : ''}
          <select className="inp" aria-label={field.label} disabled={busy} value={upload.mapping[field.key] ?? -1}
            onChange={(e) => setUpload({ ...upload, mapping: { ...upload.mapping, [field.key]: Number(e.target.value) < 0 ? undefined : Number(e.target.value) } })}>
            <option value={-1}>不导入</option>{(upload.sheet[0] ?? []).map((header, index) => <option key={index} value={index}>{XLSX.utils.encode_col(index)} · {String(header) || '无标题'}</option>)}</select></label>)}
      </div>
      <p role="status">{upload.mapping.asin == null ? '请先选 ASIN 列。' : `识别到 ${rows.length} 行有效 ASIN。`}</p>
      {rows.length > 0 && <div className="intel-table"><table className="tbl"><thead><tr>{METRIC_FIELDS.filter((field) => upload.mapping[field.key] != null).map((field) => <th key={field.key}>{field.label}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 8).map((row, index) => <tr key={index}>{METRIC_FIELDS.filter((field) => upload.mapping[field.key] != null).map((field) => <td key={field.key}>{String(row[field.key] ?? '')}</td>)}</tr>)}</tbody></table></div>}
    </>}
    {error && <p className="note err" role="alert">{error}</p>}
    <footer className="row"><div className="spacer" /><button className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy || !rows.length} onClick={save}>{busy ? '正在导入…' : '确认导入'}</button></footer>
  </AppDialog>;
}

/** 上次推荐各段耗时:亚马逊生成多久、下载多久多大 */
function timingText(timing) {
  if (!timing) return '';
  const parts = [];
  if (timing.amazonMin != null) parts.push(`亚马逊生成 ${timing.amazonMin} 分钟`);
  if (timing.downloadMin != null) parts.push(`下载 ${timing.downloadMin} 分钟${timing.mb ? `（${timing.mb} MB）` : ''}`);
  return parts.length ? `；${parts.join('，')}` : '';
}

const JOB_LABEL = {
  suggest: { label: '竞品推荐进度', hint: '搜索词报告是整个美国站一周的数据，亚马逊生成常要半小时到一个多小时，下载筛选再要十几分钟。' },
  daily: { label: '竞品同步进度', hint: '竞品价格接口每 10 秒只能查 20 个 ASIN，竞品多时要几分钟。' },
};

export default function PetIntelPage({ market, owner = false }) {
  const [tab, setTab] = useState('weekly');
  const [allStyles, setAllStyles] = useState(false);
  const [overview, setOverview] = useState(null), [styleKey, setStyleKey] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0), [importing, setImporting] = useState(false);
  async function load() {
    try {
      const result = await api.competitorOverview();
      setOverview(result); setError('');
      setStyleKey((current) => current && result.styles.some((style) => style.key === current) ? current : result.styles[0]?.key ?? '');
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [revision]);
  const jobs = overview?.sync?.jobs ?? {};
  const running = Object.keys(JOB_LABEL).filter((name) => jobs[name]).join(',');
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(async () => {
      const status = await api.competitorStatus().catch(() => null);
      if (!status) return;
      const still = Object.keys(JOB_LABEL).filter((name) => status.jobs?.[name]).join(',');
      // 有任务跑完就整页重新读,数据才是新的
      if (still !== running) setRevision((n) => n + 1);
      else setOverview((old) => old && { ...old, sync: status });
    }, 5000);
    return () => clearInterval(timer);
  }, [running]);
  async function sync(kind) {
    setBusy(true); setError(''); setMessage('');
    try { await api.syncCompetitors(kind); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const sync_ = overview?.sync;
  const daily = sync_?.daily, suggest = sync_?.suggest;
  const failed = (part) => part?.lastError && (!part.lastSuccess || part.lastError.at > part.lastSuccess.completedAt);
  return <div className="lib pet-intel animate-in">
    <header className="lib-head"><div><h1>产品情报 <span className="tag blue">US 站</span></h1>
      <p className="hint">「本周要做」按款式列出这周该处理的事。在卖款式每天自动挂上同类对手（每款 5 个，不像的移出就不会再挂），同步价格、排名、标题和主图并找出变化。
        {sync_ && (sync_.configured ? ` 上次同步：${daily?.lastSuccess ? beijing(daily.lastSuccess.completedAt) : '尚未同步'}；上次推荐：${suggest?.lastSuccess ? `${beijing(suggest.lastSuccess.completedAt)}（${suggest.lastSuccess.week} 那周${timingText(suggest.lastSuccess.timing)}）` : '尚未生成'}（北京时间）。` : ` ${sync_.issues?.[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证。'}`)}</p></div>
      <div className="row wrap">
        <button className="btn" onClick={() => setImporting(true)}>导入卖家精灵数据</button>
        <button className="btn" disabled={busy || !sync_?.configured || !!jobs.suggest} onClick={() => sync('suggest')} title="下载最近一周的品牌分析搜索词报告(整站几 GB,亚马逊生成常要半小时以上)">{jobs.suggest ? '推荐生成中…' : '重新推荐竞品'}</button>
        <button className="btn primary" disabled={busy || !sync_?.configured || !!jobs.daily} onClick={() => sync('daily')}>{jobs.daily ? '后台同步中…' : '同步竞品数据'}</button></div></header>
    {Object.entries(JOB_LABEL).filter(([name]) => jobs[name]).map(([name, { label, hint }]) =>
      <div key={name} className="card intel-sync"><SyncProgress progress={jobs[name]} label={label} />
        <p className="hint">{hint}完成后自动刷新，关掉页面也会在后台继续。</p></div>)}
    {failed(daily) && <p className="note err" role="status">上次同步失败（{beijing(daily.lastError.at)}）：{daily.lastError.message}</p>}
    {failed(suggest) && <p className="note err" role="status">上次推荐失败（{beijing(suggest.lastError.at)}）：{suggest.lastError.message}{suggest.lastError.where ? `（停在：${suggest.lastError.where}）` : ''}</p>}
    {daily?.autopickError && <p className="note warn" role="status">自动挑对手没跑成（{beijing(daily.autopickError.at)}）：{daily.autopickError.message}。其它竞品数据照常同步了，下次同步会再试。</p>}
    {daily?.pricingError && <p className="note warn" role="status">竞品价格没读到：{daily.pricingError.message}。需要在开发者应用里勾选「定价」角色并重新授权，其它数据不受影响。</p>}
    {message && <p className="note ok" role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    <div className="aba-tabs intel-tabs" role="tablist" aria-label="产品情报视图">
      {[['weekly', '本周要做'], ['monitor', '竞品监控'], ['health', '自家 Listing 体检'], ['legacy', '历史月度表']].map(([key, label]) =>
        <button key={key} role="tab" aria-selected={tab === key} className={`btn${tab === key ? ' primary' : ''}`} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    {tab === 'monitor' && overview && overview.styles.length > 0 && <ChangeFeed changes={overview.changes} onPick={setStyleKey} />}
    {tab === 'monitor' && overview && (!overview.styles.length ? <p className="note">SKU 库还没有商品。先到 SKU 库「从亚马逊同步」。</p> :
      <div className="intel-layout">
        <nav className="card intel-styles" aria-label="自家款式">
          <h3>自家款式</h3>
          {overview.styles.filter((style) => allStyles || style.units30 > 0 || style.active > 0 || style.key === styleKey).map((style) => <button key={style.key} className={`intel-style-btn${style.key === styleKey ? ' on' : ''}`} aria-current={style.key === styleKey ? 'true' : undefined} onClick={() => setStyleKey(style.key)}>
            <b>{style.key}</b><small>30 天 {style.units30} 件 · 竞品 {style.active}</small>
            <span className="badges">{style.suggested > 0 && <span className="tag blue" title="待确认的推荐">荐 {style.suggested}</span>}
              {style.changes7 > 0 && <span className="tag red" title="近 7 天竞品变化">变 {style.changes7}</span>}</span></button>)}
          {overview.styles.some((style) => !(style.units30 > 0 || style.active > 0)) && <button className="btn ghost sm" onClick={() => setAllStyles((value) => !value)}>
            {allStyles ? '只看在卖的款式' : `显示没销量的 ${overview.styles.filter((style) => !(style.units30 > 0 || style.active > 0)).length} 个款式`}</button>}
        </nav>
        <div className="intel-main">
          {styleKey && <StyleDetail key={styleKey} styleKey={styleKey} revision={revision} busy={busy} setBusy={setBusy}
            onChanged={() => setRevision((n) => n + 1)} />}
        </div>
      </div>)}
    {tab === 'weekly' && <WeeklyActions revision={revision} owner={owner} onOpenStyle={(key) => { setStyleKey(key); setTab('monitor'); }} />}
    {tab === 'health' && <Health revision={revision} />}
    {tab === 'legacy' && <PetProductPage market={market} />}
    {importing && <MetricsImport onClose={() => setImporting(false)} onDone={(text) => { setImporting(false); setMessage(text); setRevision((n) => n + 1); }} />}
  </div>;
}
