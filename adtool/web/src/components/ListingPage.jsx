import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, CHANGES_EVENT } from '../api.js';
import AppDialog, { useConfirm } from './AppDialog.jsx';
import SyncProgress from './SyncProgress.jsx';
import { byteLength, changedAttributes, cleanEntries, draftFrom, entryText, isSimple, parseJsonEntries, priceChanges, sameEntries, valuesOf } from '../listingEdit.js';
import './LibraryPage.css';
import './PriceStrategyPage.css';
import './ListingPage.css';

const amazon = (asin) => `https://www.amazon.com/dp/${asin}`;
const short = (time) => (time ? String(time).slice(5, 16) : '');
const nameOf = (row) => [row.style, row.size, row.color].filter(Boolean).join(' · ');
// 编辑中原样保留(空格、空行),上传时再整理
const raw = (values) => values.map((value) => ({ value }));
const STATUS_TONE = { queued: 'gray', running: 'blue', submitted: 'amber', applied: 'green', failed: 'red', pending: 'blue' };
// 常用的几项放在上面单独编辑,下面「全部属性」里不再重复
const COMMON = ['item_name', 'bullet_point', 'generic_keyword', 'product_description'];
const LIMIT = { item_name: 200, bullet: 500, bullets: 10, generic_keyword: 249 };

// ---------- 全店一览 ----------

function Board({ owner, onOpen }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [q, setQ] = useState(''), [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  async function load() {
    try { setData(await api.listings()); setError(''); } catch (e) { setError(e.message); }
  }
  useEffect(() => { void load(); }, []);
  const running = data?.sync?.running;
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [running]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((row) => (!term || [row.sku, row.asin, row.title, nameOf(row)].some((field) => String(field ?? '').toLowerCase().includes(term)))
      && (filter === 'all' || (filter === 'issues' && row.errors > 0) || (filter === 'buyable' && row.statusText === '可售')
        || (filter === 'cooldown' && row.cooldown) || (filter === 'open' && row.openChanges > 0)));
  }, [data, q, filter]);

  async function sync() {
    setBusy(true);
    try { await api.syncListings(); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function exportAll() {
    setBusy(true);
    try {
      const { columns, rows: records } = await api.listingExport();
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...records.map((record) => columns.map((column) => record[column] ?? ''))]), 'Listing 属性');
      XLSX.writeFile(book, `Listing属性_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const sync0 = data?.sync;
  const progress = sync0?.progress && { total: sync0.progress.total, done: sync0.progress.done,
    detail: `${sync0.progress.stage}：已读 ${sync0.progress.done}${sync0.progress.total ? ` / ${sync0.progress.total}` : ''} 个 SKU` };
  const all = data?.rows ?? [];
  return <>
    <header className="lib-head"><div><h1>Listing <span className="tag blue">US 站</span></h1>
      <p className="hint">店铺所有 SKU 在亚马逊上的完整 Listing 属性，每 12 小时自动同步一次，点开某个 SKU 时会实时再读一次。
        改完点「上传到亚马逊」：先让亚马逊预检，通过才提交，提交后每 20 分钟核对是否生效，记进「改动日志」，每日分析的冷却期和复盘都会算上。
        {sync0?.lastSyncedAt && ` 上次同步 ${sync0.lastSyncedAt}（北京时间）。`}</p></div>
      <div className="row wrap">
        <button className="btn" disabled={busy || !all.length} onClick={exportAll}>导出全部属性</button>
        {owner && <button className="btn primary" disabled={busy || running || !sync0?.configured} onClick={sync}>{running ? '同步中…' : '从亚马逊同步'}</button>}
      </div></header>
    {sync0 && !sync0.configured && <p className="note warn">{sync0.issues?.[0] ?? '服务器还没有配置宠物店铺的 SP-API 凭证。'}</p>}
    {running && <div className="card price-sync-card"><SyncProgress progress={progress} label="Listing 同步进度" /></div>}
    {sync0?.lastError && <p className="note err">上次同步失败：{sync0.lastError}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {!data ? <p role="status">正在加载…</p> : !all.length ? <p className="note">还没有 Listing 数据{owner ? '，点「从亚马逊同步」读一次全店。' : '，等店主同步。'}</p> : <section className="card">
      <div className="row wrap price-toolbar">
        <label>搜索 <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="SKU / ASIN / 标题 / 款式" /></label>
        <label>筛选 <select className="inp" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">全部</option><option value="buyable">可售</option><option value="issues">有亚马逊报错</option>
          <option value="cooldown">冷却期内</option><option value="open">有没处理完的改动</option></select></label>
        <div className="spacer" /><span className="hint">{rows.length} / {all.length} 个 SKU · 点一行查看和修改</span></div>
      <div className="scroll lst-table"><table className="tbl">
        <thead><tr><th>SKU</th><th>ASIN</th><th>状态</th><th>标题</th><th className="num">五点</th><th className="num">后台词</th><th>描述</th>
          <th className="num">属性</th><th>亚马逊问题</th><th>改动</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.sku} className="lst-row" tabIndex={0} onClick={() => onOpen(row.sku)}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpen(row.sku); }}>
          <td className="col-sku"><b>{row.sku}</b>{nameOf(row) && <small>{nameOf(row)}</small>}</td>
          <td className="mono">{row.asin ?? ''}</td>
          <td><span className={`tag ${row.statusText === '可售' ? 'green' : 'gray'}`}>{row.statusText}</span></td>
          <td className="lst-title" title={row.title ?? ''}>{row.title ?? <span className="hint">（没有标题）</span>}</td>
          <td className={`num${row.bullets < 5 ? ' warn' : ''}`}>{row.bullets}</td>
          <td className={`num${row.searchTermBytes > 249 ? ' danger' : ''}`}>{row.searchTermBytes ? `${row.searchTermBytes} B` : ''}</td>
          <td>{row.hasDescription ? '有' : <span className="warn">无</span>}</td>
          <td className="num">{row.attributeCount}</td>
          <td>{row.errors > 0 && <span className="tag red">错误 {row.errors}</span>} {row.warnings > 0 && <span className="tag amber">提醒 {row.warnings}</span>}</td>
          <td>{row.cooldown && <span className="tag amber" title={`${row.cooldown.lastChangeDay} 改过 Listing`}>冷却 {row.cooldown.daysLeft} 天</span>}
            {row.openChanges > 0 && <span className="tag blue">{row.openChanges} 条处理中</span>}</td>
        </tr>)}</tbody></table></div>
    </section>}
  </>;
}

// ---------- 单个属性的编辑 ----------

function SimpleValues({ id, values, info, disabled, onChange, max, multiline }) {
  const options = info?.options ?? [];
  const list = values.length ? values : [''];
  const set = (index, value) => onChange(list.map((item, i) => (i === index ? value : item)));
  const numeric = ['number', 'integer'].includes(info?.valueType);
  return <div className="lst-values">
    {options.length > 0 && <datalist id={`${id}-options`}>{options.map((option) => <option key={String(option.value)} value={option.value}>{option.label}</option>)}</datalist>}
    {list.map((value, index) => <div key={index} className="row lst-value">
      {info?.valueType === 'boolean' ? <select className="inp" value={String(value)} disabled={disabled} onChange={(e) => set(index, e.target.value === 'true')}>
        <option value="">（空）</option><option value="true">是 true</option><option value="false">否 false</option></select>
        : multiline ? <textarea className="inp resize-none" rows={3} value={value} disabled={disabled} aria-label={`${info?.title ?? id} 第 ${index + 1} 个值`} onChange={(e) => set(index, e.target.value)} />
          : <input className="inp" type={numeric ? 'number' : 'text'} value={value} disabled={disabled} list={options.length ? `${id}-options` : undefined}
            aria-label={`${info?.title ?? id} 第 ${index + 1} 个值`} onChange={(e) => set(index, numeric && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
      {!disabled && list.length > 1 && <button type="button" className="btn sm ghost" aria-label="删掉这个值" onClick={() => onChange(list.filter((_, i) => i !== index))}>删</button>}
    </div>)}
    {!disabled && (max == null || list.length < max) && <button type="button" className="btn sm ghost" onClick={() => onChange([...list, ''])}>+ 加一个值</button>}
    {info?.maxLength && <small className="hint">每个值最多 {info.maxLength} 个字符</small>}
  </div>;
}

function JsonValues({ entries, disabled, onChange }) {
  const [text, setText] = useState(() => JSON.stringify(entries, null, 1));
  const [error, setError] = useState('');
  useEffect(() => {
    // 外面还原了就跟着变
    const parsed = parseJsonEntries(text);
    if (parsed.error || !sameEntries(parsed.value, entries)) { setText(JSON.stringify(entries, null, 1)); setError(''); }
  }, [entries]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="lst-values">
    <textarea className="inp mono lst-json resize-none" rows={Math.min(12, Math.max(3, text.split('\n').length))} value={text} disabled={disabled} spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseJsonEntries(e.target.value);
        setError(parsed.error ?? '');
        if (!parsed.error) onChange(parsed.value);
      }} />
    {error ? <small className="danger">{error}</small> : <small className="hint">结构化属性，按 JSON 改；站点和语言标记上传时自动补上</small>}
  </div>;
}

function AttributeRow({ name, info, readOnly, original, value, owner, onChange }) {
  const changed = value !== undefined && !sameEntries(original ?? [], cleanEntries(value));
  const entries = value ?? original ?? [];
  const simple = isSimple(name, info, entries);
  const locked = !owner || !!readOnly;
  return <div className={`lst-attr${changed ? ' changed' : ''}`}>
    <div className="lst-attr-name">
      <b>{info?.title ?? name}</b>{info?.required && <span className="tag red">必填</span>}
      <small className="mono">{name}</small>
      {changed && <button type="button" className="btn sm ghost" onClick={() => onChange(undefined)}>还原</button>}
    </div>
    <div className="lst-attr-value">
      {readOnly ? <><p className="lst-readonly">{(original ?? []).map(entryText).join(' | ') || '（空）'}</p><small className="hint">{readOnly}</small></>
        : simple ? <SimpleValues id={`attr-${name}`} values={valuesOf(entries)} info={info} disabled={locked} max={info?.maxItems}
          multiline={(info?.maxLength ?? 0) > 300} onChange={(values) => onChange(raw(values))} />
          : <JsonValues entries={entries} disabled={locked} onChange={onChange} />}
    </div>
  </div>;
}

// ---------- 单个 SKU ----------

function Editor({ sku, owner, onBack, onNav }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState('');
  const [draft, setDraft] = useState({});
  const [form, setForm] = useState({ price: '', salePrice: '', saleStart: '', saleEnd: '' });
  const [filter, setFilter] = useState(''), [showEmpty, setShowEmpty] = useState(false);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState(null), [message, setMessage] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [ask, confirmation] = useConfirm();

  async function load(keepDraft = false) {
    try {
      const data = await api.listing(sku);
      setDetail(data); setError('');
      if (!keepDraft) {
        setDraft({});
        setForm({ price: data.price ?? '', salePrice: data.sale?.price ?? '', saleStart: data.sale?.start ?? '', saleEnd: data.sale?.end ?? '' });
      }
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { void load(); }, [sku]); // eslint-disable-line react-hooks/exhaustive-deps

  const original = useMemo(() => draftFrom(detail?.attributes), [detail]);
  const pending = detail?.pending ?? [];
  const working = pending.some((item) => ['queued', 'running'].includes(item.status));
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => { void load(true); }, 3000);
    return () => clearInterval(timer);
  }, [working]); // eslint-disable-line react-hooks/exhaustive-deps

  const schema = useMemo(() => detail?.schema?.attributes ?? {}, [detail]);
  const readOnly = detail?.readOnly ?? {};
  const merged = { ...original, ...Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== undefined)) };
  const changes = [...changedAttributes(original, merged), ...(detail ? priceChanges(detail, form) : [])];
  const setAttr = (name, value) => setDraft((old) => ({ ...old, [name]: value }));
  const current = (name) => merged[name] ?? [];

  const others = useMemo(() => {
    const names = new Set([...Object.keys(original), ...(showEmpty ? Object.keys(schema) : [])]);
    COMMON.forEach((name) => names.delete(name));
    const term = filter.trim().toLowerCase();
    const list = [...names].filter((name) => !term || name.includes(term) || String(schema[name]?.title ?? '').toLowerCase().includes(term));
    const groups = new Map();
    for (const name of list.sort((a, b) => Number(!!schema[b]?.required) - Number(!!schema[a]?.required) || a.localeCompare(b))) {
      const group = schema[name]?.group ?? (original[name] ? '已填写' : '其它');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(name);
    }
    return [...groups];
  }, [original, schema, showEmpty, filter]);

  async function preview() {
    setBusy(true); setResult(null); setMessage('');
    try { setResult({ kind: 'preview', ...(await api.previewListing(sku, changes)) }); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function submit() {
    setReviewing(false);
    const cooldown = detail.cooldown ? `这个 SKU ${detail.cooldown.lastChangeDay} 改过 Listing，冷却期还剩 ${detail.cooldown.daysLeft} 天，现在再改，复盘时分不清是哪次改动的效果。` : '';
    if (!await ask(`${cooldown}把这 ${changes.length} 项修改上传到亚马逊？先让亚马逊预检，通过才提交；会记进改动日志。`, '上传')) return;
    setBusy(true); setResult(null); setMessage('');
    try {
      const data = await api.submitListing(sku, changes, reason);
      if (data.rejected?.length) setResult({ kind: 'rejected', rejected: data.rejected });
      else {
        setMessage(`已提交 ${data.submitted.length} 项，状态见下面「改动进度」；生效后会显示在改动日志里。`);
        setReason('');
        window.dispatchEvent(new Event(CHANGES_EVENT));
        await load();
      }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!detail) return <>
    <button className="btn sm" onClick={onBack}>← 返回全部 SKU</button>
    {error ? <p className="note err" role="alert">{error}</p> : <p role="status">正在从亚马逊读取 {sku}…</p>}
  </>;

  const bullets = valuesOf(current('bullet_point'));
  const title = valuesOf(current('item_name'))[0] ?? '';
  const terms = valuesOf(current('generic_keyword')).join(' ');
  const description = valuesOf(current('product_description'))[0] ?? '';
  const locked = !owner;
  return <div className="lst-editor">
    <div className="row wrap"><button className="btn sm" onClick={onBack}>← 返回全部 SKU</button><div className="spacer" />
      <button className="btn sm" disabled={busy} onClick={() => load(true)}>重新读取亚马逊</button></div>
    <header className="lib-head"><div>
      <h1>{detail.sku} <span className={`tag ${detail.statusText === '可售' ? 'green' : 'gray'}`}>{detail.statusText}</span></h1>
      <p className="hint">{[nameOf(detail), detail.asin && <a key="asin" className="mono" href={amazon(detail.asin)} target="_blank" rel="noreferrer">{detail.asin}</a>,
        `商品类型 ${detail.productType ?? '?'}`, detail.lastUpdated && `亚马逊最后更新 ${short(detail.lastUpdated)}`].filter(Boolean)
        .map((part, index) => <span key={index}>{index > 0 && ' · '}{part}</span>)}</p></div></header>
    {detail.cooldown && <p className="note warn">冷却期：{detail.cooldown.lastChangeDay} 改过 Listing，还剩 {detail.cooldown.daysLeft} 天。每日分析在冷却期内不会提 Listing 改动；这时再改，复盘时分不清效果。</p>}
    {detail.schema?.error && <p className="note info">没取到亚马逊的属性定义（{detail.schema.error}），属性名显示英文，没填的属性看不到。</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    {message && <p className="note ok" role="status">{message}</p>}

    {pending.length > 0 && <section className="card"><div className="card-title">改动进度</div>
      <ul className="lst-pending">{pending.map((item) => <li key={item.id}>
        <span className={`tag ${STATUS_TONE[item.status] ?? 'gray'}`}>{item.statusLabel}</span> <b>{item.kindLabel}</b>
        <span className="hint"> #{item.id} · {item.source === 'listing' ? '在这里修改' : item.source === 'claude' ? 'Claude 提议' : item.source} · {short(item.createdAt)}</span>
        {item.status === 'pending' && onNav && <button type="button" className="btn sm ghost" onClick={() => onNav('changes')}>去待确认页</button>}
        {item.error && <p className="note err">{item.error}</p>}
        {(item.result?.issues ?? []).filter((issue) => issue.severity === 'ERROR').map((issue, index) => <p key={index} className="danger">{issue.message}</p>)}
      </li>)}</ul></section>}

    {detail.issues?.length > 0 && <section className="card"><div className="card-title">亚马逊报的问题（{detail.issues.length}）</div>
      <ul className="lst-issues">{detail.issues.map((issue, index) => <li key={index}><span className={`tag ${issue.severity === 'ERROR' ? 'red' : 'amber'}`}>{issue.severity === 'ERROR' ? '错误' : '提醒'}</span>
        {' '}{issue.message}{issue.attributeNames?.length > 0 && <small className="mono"> （{issue.attributeNames.join(', ')}）</small>}</li>)}</ul></section>}

    <section className="card lst-common">
      <div className="card-title">常用</div>
      <label className="lst-field"><span>标题 <small className={title.length > LIMIT.item_name ? 'danger' : 'hint'}>{title.length} / {LIMIT.item_name} 字符</small></span>
        <textarea className={`inp resize-none${!sameEntries(original.item_name, cleanEntries(current('item_name'))) ? ' changed' : ''}`} rows={3} value={title} disabled={locked}
          onChange={(e) => setAttr('item_name', raw([e.target.value]))} /></label>
      <div className="lst-field"><span>五点描述 <small className="hint">{bullets.length} / {LIMIT.bullets} 条</small></span>
        <ol className={`lst-bullets${!sameEntries(original.bullet_point, cleanEntries(current('bullet_point'))) ? ' changed' : ''}`}>{(bullets.length ? bullets : ['']).map((bullet, index) => <li key={index}>
          <textarea className="inp resize-none" rows={2} value={bullet} disabled={locked} aria-label={`第 ${index + 1} 条五点`}
            onChange={(e) => setAttr('bullet_point', raw(bullets.length ? bullets.map((item, i) => (i === index ? e.target.value : item)) : [e.target.value]))} />
          <small className={String(bullet).length > LIMIT.bullet ? 'danger' : 'hint'}>{String(bullet).length} 字符</small>
          {!locked && bullets.length > 1 && <button type="button" className="btn sm ghost" onClick={() => setAttr('bullet_point', raw(bullets.filter((_, i) => i !== index)))}>删掉这条</button>}
        </li>)}</ol>
        {!locked && bullets.length < LIMIT.bullets && <button type="button" className="btn sm ghost" onClick={() => setAttr('bullet_point', raw([...bullets, '']))}>+ 加一条</button>}
      </div>
      <label className="lst-field"><span>后台搜索词 <small className={byteLength(terms) > LIMIT.generic_keyword ? 'danger' : 'hint'}>{byteLength(terms)} / {LIMIT.generic_keyword} 字节，空格分隔</small></span>
        <textarea className={`inp resize-none mono${!sameEntries(original.generic_keyword, cleanEntries(current('generic_keyword'))) ? ' changed' : ''}`} rows={3} value={terms} disabled={locked}
          onChange={(e) => setAttr('generic_keyword', raw([e.target.value]))} /></label>
      <label className="lst-field"><span>产品描述 <small className="hint">{description.length}{schema.product_description?.maxLength ? ` / ${schema.product_description.maxLength}` : ''} 字符；有 A+ 时前台显示 A+</small></span>
        <textarea className={`inp resize-none${!sameEntries(original.product_description, cleanEntries(current('product_description'))) ? ' changed' : ''}`} rows={5} value={description} disabled={locked}
          onChange={(e) => setAttr('product_description', raw([e.target.value]))} /></label>
      <div className="row wrap lst-prices">
        <label>原价 $<input className="inp" type="number" step="0.01" min="0" value={form.price} disabled={locked} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
        <label>促销价 $<input className="inp" type="number" step="0.01" min="0" value={form.salePrice} disabled={locked} placeholder="不做促销留空"
          onChange={(e) => setForm({ ...form, salePrice: e.target.value })} /></label>
        <label>开始<input className="inp" type="date" value={form.saleStart} disabled={locked} onChange={(e) => setForm({ ...form, saleStart: e.target.value })} /></label>
        <label>结束<input className="inp" type="date" value={form.saleEnd} disabled={locked} onChange={(e) => setForm({ ...form, saleEnd: e.target.value })} /></label>
        <span className="hint">清空促销价就是取消促销；有促销时前台显示促销价。改价会检查保本价。</span>
      </div>
    </section>

    <section className="card">
      <div className="row wrap"><div className="card-title">全部属性</div><div className="spacer" />
        <input className="inp lst-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="找属性：material、size…" aria-label="找属性" />
        <label className="row"><input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} disabled={!Object.keys(schema).length} />显示没填的属性</label></div>
      {others.map(([group, names]) => <div key={group} className="lst-group"><h3>{group} <small className="hint">{names.length}</small></h3>
        {names.map((name) => <AttributeRow key={name} name={name} info={schema[name]} readOnly={readOnly[name]} original={original[name]} value={draft[name]} owner={owner}
          onChange={(value) => setAttr(name, value)} />)}</div>)}
    </section>

    {result?.kind === 'preview' && <div className={`note ${result.ok ? 'ok' : 'err'}`} role="status">
      {result.ok ? '亚马逊预检通过，可以上传。' : '预检没通过：'}
      <ul>{(result.rejected ?? []).map((item, index) => <li key={`r${index}`}>{item.error}</li>)}
        {(result.issues ?? []).map((issue, index) => <li key={`i${index}`}>{issue.severity === 'ERROR' ? '错误' : '提醒'}：{issue.message}{issue.attributes?.length ? `（${issue.attributes.join(', ')}）` : ''}</li>)}</ul>
      {result.warnings?.length > 0 && <ul className="warn">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>}
    {result?.kind === 'rejected' && <div className="note err" role="alert">没有上传，先改好这些：<ul>{result.rejected.map((item, index) => <li key={index}>{item.error}</li>)}</ul></div>}

    {owner && <div className="lst-bar" role="toolbar" aria-label="上传">
      <span>已改 <b>{changes.length}</b> 项</span>
      {changes.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setReviewing(true)}>看改了什么</button>}
      <input className="inp lst-reason" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="为什么改（选填，记进改动日志）" />
      <div className="spacer" />
      <button className="btn" disabled={busy || !changes.length} onClick={() => { setDraft({}); void load(); }}>全部还原</button>
      <button className="btn" disabled={busy || !changes.length} onClick={preview}>亚马逊预检</button>
      <button className="btn primary" disabled={busy || !changes.length} onClick={submit}>{busy ? '处理中…' : '上传到亚马逊'}</button>
    </div>}
    {reviewing && <AppDialog title={`${detail.sku} 改了什么`} wide onClose={() => setReviewing(false)}>
      <ul className="lst-review">{changes.map((change) => <li key={change.attribute ?? change.field}>
        <b>{change.field === 'price' ? '原价' : change.field === 'sale_price' ? '促销价' : schema[change.attribute]?.title ?? change.attribute}</b>
        {change.field ? <p className="w-add">{change.field === 'sale_price' && !change.value ? '取消促销价' : `$${change.value}${change.saleEnd ? `（${change.saleStart ?? '今天'} 到 ${change.saleEnd}）` : ''}`}</p>
          : <><p className="w-del">{(original[change.attribute] ?? []).map(entryText).join(' | ') || '（空）'}</p><p className="w-add">{change.value.map(entryText).join(' | ') || '（删掉）'}</p></>}
      </li>)}</ul>
      <footer className="row"><div className="spacer" /><button className="btn" onClick={() => setReviewing(false)}>关闭</button></footer>
    </AppDialog>}
    {confirmation}
  </div>;
}

export default function ListingPage({ owner, onNav }) {
  const [sku, setSku] = useState('');
  return <div className="lib listing-page animate-in">
    {sku ? <Editor key={sku} sku={sku} owner={owner} onNav={onNav} onBack={() => setSku('')} /> : <Board owner={owner} onOpen={setSku} />}
  </div>;
}
