import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api, CHANGES_EVENT } from '../api.js';
import AppDialog, { useConfirm } from './AppDialog.jsx';
import { byteLength, changeSheetRows, SHEET, termChanges, wordDiff } from '../changeExport.js';
import './LibraryPage.css';
import './PetChangesPage.css';

const money = (value) => (value == null ? '—' : `$${Number(value).toFixed(2)}`);
const amazon = (asin) => `https://www.amazon.com/dp/${asin}`;
const short = (time) => (time ? time.slice(5, 16) : '');
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const STATUS_TONE = { pending: 'blue', queued: 'gray', running: 'blue', submitted: 'amber', applied: 'green', not_applied: 'red',
  export: 'amber', exported: 'amber', failed: 'red', rejected: 'gray', superseded: 'gray' };
const ENTITY_LABEL = { campaign: '广告活动', adGroup: '广告组', keyword: '关键词', productTarget: '商品定向', productAd: '商品广告' };
const MATCH_LABEL = { exact: '否定精准', phrase: '否定词组', asin: '否定商品' };
const STATE_LABEL = { enabled: '启用', paused: '暂停' };
const VIEWS = [['pending', '待确认'], ['active', '处理中'], ['history', '历史'], ['log', '日志']];
const EDITABLE = new Set(['listing_title', 'listing_bullets', 'listing_search_terms', 'listing_price', 'ad_bid', 'ad_budget']);
const NUMERIC = new Set(['listing_price', 'ad_bid', 'ad_budget']);
const SOURCE_LABEL = { claude: 'Claude 提议', revert: '撤回', manual: '手动' };

function targetText(item) {
  const t = item.target ?? {};
  if (item.group === 'listing') return [t.sku, [t.style, t.size, t.color].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return [t.campaignName ?? `活动 ${t.campaignId}`, t.adGroupName, t.label].filter(Boolean).join(' / ');
}

function Words({ parts, side }) {
  const keep = side === 'before' ? 'del' : 'add';
  return parts.filter((part) => part.type === 'same' || part.type === keep)
    .map((part, index) => <span key={index} className={part.type === 'same' ? undefined : `w-${part.type}`}>{part.text} </span>);
}

function AdBody({ item }) {
  const { kind, target, before, after } = item;
  let change;
  if (kind === 'ad_state') change = <b>{before?.state ? STATE_LABEL[before.state] : '?'} → {STATE_LABEL[after.state]}</b>;
  else if (kind === 'ad_bid') change = <b>{money(before?.bid)} → {money(after.bid)}{target.entity === 'adGroup' ? '（广告组默认竞价）' : ''}</b>;
  else if (kind === 'ad_budget') change = <b>{money(before?.budget)} → {money(after.budget)} / 天</b>;
  else change = <b>{MATCH_LABEL[after.matchType]}「{after.text}」加在{target.level === 'campaign' ? '广告活动' : '广告组'}上</b>;
  return <div className="chg-numbers">
    {kind !== 'ad_negative' && <span className="tag gray">{ENTITY_LABEL[target.entity]}</span>}{change}
    <span className="hint mono">活动 #{target.campaignId}{target.adGroupId ? ` · 广告组 #${target.adGroupId}` : ''}
      {target.entityId && !['campaign', 'adGroup'].includes(target.entity) ? ` · 编号 #${target.entityId}` : ''}</span>
    {target.currentReported && <span className="hint">当前值来自 Claude 读到的数据，未核实</span>}
  </div>;
}

function ChangeBody({ item }) {
  const { kind, before, after, target } = item;
  if (kind === 'listing_title') {
    const parts = wordDiff(before ?? '', after);
    return <dl className="chg-diff">
      <dt>现在</dt><dd><Words parts={parts} side="before" /><small>{norm(before).length} 字符</small></dd>
      <dt>改成</dt><dd><Words parts={parts} side="after" /><small>{after.length} / 200 字符</small></dd>
    </dl>;
  }
  if (kind === 'listing_search_terms') {
    const { added, removed } = termChanges(before, after);
    return <dl className="chg-diff">
      <dt>现在</dt><dd className="mono">{before || '（空）'}<small>{byteLength(before)} 字节</small></dd>
      <dt>改成</dt><dd className="mono">{after}<small>{byteLength(after)} / 249 字节</small></dd>
      {(added.length > 0 || removed.length > 0) && <><dt>变化</dt><dd>
        {added.length > 0 && <span className="w-add">新增 {added.join(' ')}</span>} {removed.length > 0 && <span className="w-del">去掉 {removed.join(' ')}</span>}</dd></>}
    </dl>;
  }
  if (kind === 'listing_bullets') {
    const rows = Math.max(before?.length ?? 0, after.length);
    return <ol className="chg-bullets">{Array.from({ length: rows }, (_, index) => {
      const was = before?.[index], now = after[index];
      if (was != null && now != null && norm(was) === norm(now)) return <li key={index}><p className="same">{now} <small>不变</small></p></li>;
      return <li key={index}>{was != null && <p className="w-del">{was}</p>}{now != null ? <p className="w-add">{now}</p> : <p className="hint">（删掉这条）</p>}</li>;
    })}</ol>;
  }
  if (kind === 'listing_price') {
    const impact = target.priceImpact ?? {};
    const change = before ? (after - before) / before * 100 : null;
    return <div className="chg-numbers"><b>{money(before)} → {money(after)}</b>
      {change != null && <span className="hint">（{change > 0 ? '+' : ''}{change.toFixed(1)}%）</span>}
      {impact.profitAfter != null && <span>单件毛利 {money(impact.profitBefore)} → <b className={impact.profitAfter < 0 ? 'loss' : undefined}>{money(impact.profitAfter)}</b>
        {impact.marginAfter != null && `（${impact.marginAfter}%）`}</span>}
      {impact.breakEven != null && <span className="hint">保本价 {money(impact.breakEven)}</span>}</div>;
  }
  return <AdBody item={item} />;
}

function Result({ item }) {
  const result = item.result ?? {};
  const issues = [...(result.listingIssues ?? []), ...(result.issues ?? [])];
  let text = '';
  if (item.status === 'submitted') text = `亚马逊已接受${result.submissionId ? `（提交编号 ${result.submissionId}）` : ''}，网站每 20 分钟核对一次是否生效。`;
  if (item.status === 'applied') {
    text = result.manual ? `批量表上传后标记为已生效（${short(item.verifiedAt)}）。` : item.channel === 'ads_api' ? `已通过广告 API 执行（${short(item.executedAt)}）。`
      : result.note ? result.note : `核对亚马逊上已是新值（${short(item.verifiedAt)}）。`;
  }
  if (item.status === 'running') text = '正在提交亚马逊…';
  if (item.status === 'queued') text = '排队中，马上提交。';
  if (!text && !issues.length) return null;
  return <div className="chg-result">{text && <p>{text}</p>}
    {issues.length > 0 && <ul>{issues.map((issue, index) => <li key={index}><span className={`tag ${issue.severity === 'ERROR' ? 'red' : 'amber'}`}>{issue.severity === 'ERROR' ? '错误' : '提醒'}</span> {issue.message}</li>)}</ul>}
  </div>;
}

function ChangeItem({ item, checked, onCheck, busy, onEdit, onAction, onRevert }) {
  const meta = [`${item.createdBy ?? ''} ${SOURCE_LABEL[item.source] === 'Claude 提议' ? '经 Claude ' : ''}提议于 ${short(item.createdAt)}`,
    item.decidedAt ? `${item.decidedBy ?? ''} ${item.status === 'rejected' ? '拒绝' : '确认'}于 ${short(item.decidedAt)}` : ''].filter(Boolean).join(' · ');
  const canRevert = ['applied', 'submitted', 'not_applied'].includes(item.status) && item.kind !== 'ad_negative' && item.before != null;
  return <article className={`chg-item s-${item.status}${onCheck ? ' checkable' : ''}`}>
    {onCheck && <input type="checkbox" checked={checked} disabled={busy} onChange={() => onCheck(item.id)} aria-label={`选择第 ${item.id} 条：${item.kindLabel} ${targetText(item)}`} />}
    <div className="chg-main">
      <header className="row wrap">
        <span className={`tag ${item.group === 'listing' ? 'blue' : 'amber'}`}>{item.kindLabel}</span>
        <b className="chg-target">{targetText(item)}</b>
        {item.target?.asin && <a className="mono" href={amazon(item.target.asin)} target="_blank" rel="noreferrer">{item.target.asin}</a>}
        <div className="spacer" />
        {item.status !== 'pending' && <span className={`tag ${STATUS_TONE[item.status] ?? 'gray'}`}>{item.statusLabel}</span>}
        <span className="hint">#{item.id}</span>
      </header>
      <ChangeBody item={item} />
      {item.reason && <p className="chg-reason"><span>理由</span>{item.reason}</p>}
      {item.warnings?.length > 0 && <ul className="chg-warn" aria-label="提醒">{item.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {item.error && <p className="note err">{item.error}</p>}
      <Result item={item} />
      <footer className="row wrap chg-actions">
        <span className="hint">{meta}</span><div className="spacer" />
        {['pending', 'failed'].includes(item.status) && EDITABLE.has(item.kind) && <button className="btn sm" disabled={busy} onClick={() => onEdit(item)}>修改</button>}
        {item.status === 'pending' && <button className="btn sm danger" disabled={busy} onClick={() => onAction('reject', [item.id])}>拒绝</button>}
        {item.status === 'failed' && <button className="btn sm primary" disabled={busy} onClick={() => onAction('retry', [item.id])}>重试</button>}
        {['failed', 'export'].includes(item.status) && <button className="btn sm" disabled={busy} onClick={() => onAction('drop', [item.id])}>放弃</button>}
        {canRevert && <button className="btn sm" disabled={busy} onClick={() => onRevert(item)}>撤回</button>}
      </footer>
    </div>
  </article>;
}

function EditDialog({ item, onClose, onSaved }) {
  const initial = item.kind === 'listing_bullets' ? item.after.join('\n')
    : String(item.kind === 'ad_bid' ? item.after.bid : item.kind === 'ad_budget' ? item.after.budget : item.after);
  const [text, setText] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const numeric = NUMERIC.has(item.kind);
  const value = item.kind === 'listing_bullets' ? text.split('\n').map((line) => line.trim()).filter(Boolean) : numeric ? Number(text) : text;
  const count = item.kind === 'listing_title' ? `${norm(text).length} / 200 字符` : item.kind === 'listing_search_terms' ? `${byteLength(norm(text))} / 249 字节`
    : item.kind === 'listing_bullets' ? `${value.length} 条，每行一条` : '美元';
  async function save() {
    setBusy(true); setError('');
    try { await api.editChange(item.id, value); onSaved(); } catch (e) { setError(e.message); setBusy(false); }
  }
  return <AppDialog title={`修改${item.kindLabel}：${targetText(item)}`} wide busy={busy} onClose={onClose}>
    {numeric ? <input className="inp" type="number" step="0.01" min="0" value={text} disabled={busy} aria-label="新值" onChange={(e) => setText(e.target.value)} />
      : <textarea className="inp chg-edit" rows={item.kind === 'listing_bullets' ? 12 : 4} value={text} disabled={busy} aria-label="新值" onChange={(e) => setText(e.target.value)} />}
    <p className="hint">{count}。保存后会重新检查，仍需勾选确认才会执行。</p>
    {error && <p className="note err" role="alert">{error}</p>}
    <footer className="row"><div className="spacer" /><button className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button></footer>
  </AppDialog>;
}

function detailText(event) {
  const detail = event.detail;
  if (!detail) return '';
  const show = (value) => {
    if (value == null) return '（空）';
    if (Array.isArray(value)) return value.join(' / ');
    if (typeof value === 'object') return Object.values(value).join(' ');
    return String(value);
  };
  let text = '';
  if (detail.error) text = detail.error;
  else if (detail.submissionId) text = `提交编号 ${detail.submissionId}`;
  else if ('from' in detail) text = `${show(detail.from)} → ${show(detail.to)}`;
  else if ('found' in detail) text = `亚马逊上现在是：${show(detail.found)}`;
  else if (detail.revertId) text = `生成撤回改动 #${detail.revertId}`;
  else if ('after' in detail) text = show(detail.after);
  else if ('current' in detail) text = `亚马逊上仍是：${show(detail.current)}`;
  else if (detail.batchId) text = `被第 ${detail.batchId} 批的新提议替代`;
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function LogTable({ events }) {
  if (!events.length) return <p className="note">还没有记录。</p>;
  const who = (event) => (event.actor === 'claude' ? `Claude（${event.userName ?? ''} 授权）` : event.actor === 'system' ? '网站' : event.userName ?? '');
  return <div className="card chg-log"><table className="tbl"><thead><tr><th>时间</th><th>谁</th><th>动作</th><th>改动</th><th>对象</th><th>详情</th></tr></thead>
    <tbody>{events.map((event) => <tr key={event.id}><td className="mono">{event.at}</td><td>{who(event)}</td><td>{event.actionLabel}</td>
      <td>#{event.proposalId} {event.kindLabel}</td><td>{event.target}</td><td className="chg-log-detail">{detailText(event)}</td></tr>)}</tbody></table></div>;
}

export default function PetChangesPage() {
  const [view, setView] = useState('pending');
  const [data, setData] = useState(null), [events, setEvents] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [editing, setEditing] = useState(null), [revision, setRevision] = useState(0);
  const [ask, confirmation] = useConfirm();

  useEffect(() => {
    let alive = true;
    const load = view === 'log' ? api.changeLog().then((result) => alive && setEvents(result.events))
      : api.changes(view).then((result) => alive && setData({ ...result, view }));
    load.then(() => alive && setError('')).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [view, revision]);
  useEffect(() => { setSelected(new Set()); }, [view]);

  const shown = data?.view === view ? data : null;
  const items = useMemo(() => shown?.items ?? [], [shown]);
  // 有正在提交的就每 3 秒刷新,看到结果为止
  const working = items.some((item) => item.status === 'queued' || item.status === 'running');
  useEffect(() => {
    if (!working) return undefined;
    const timer = setInterval(() => setRevision((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [working]);

  const groups = useMemo(() => {
    const batches = new Map((shown?.batches ?? []).map((batch) => [batch.id, batch]));
    const map = new Map();
    for (const item of items) {
      const key = item.batchId ?? 0;
      if (!map.has(key)) map.set(key, { batch: batches.get(item.batchId) ?? null, items: [] });
      map.get(key).items.push(item);
    }
    return [...map.values()];
  }, [shown, items]);

  const config = shown?.config ?? data?.config;
  const selectable = view === 'pending';
  const chosen = items.filter((item) => selected.has(item.id));
  const toggle = (id) => setSelected((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const toggleMany = (list) => setSelected((old) => {
    const next = new Set(old);
    const all = list.every((item) => next.has(item.id));
    for (const item of list) { if (all) next.delete(item.id); else next.add(item.id); }
    return next;
  });

  async function act(action, ids, done) {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.changeAction(action, ids);
      setSelected(new Set());
      setMessage(done(result));
      setRevision((n) => n + 1);
      window.dispatchEvent(new Event(CHANGES_EVENT));
      return result;
    } catch (e) {
      setError(e.message);
      setRevision((n) => n + 1);
      return null;
    } finally { setBusy(false); }
  }

  async function approve() {
    const listing = chosen.filter((item) => item.group === 'listing').length, ads = chosen.length - listing;
    const parts = [listing && `${listing} 条 Listing 改动会马上提交到亚马逊（先让亚马逊预检，不通过就不提交）`,
      ads && (config?.adsApi ? `${ads} 条广告改动会通过广告 API 直接执行` : `${ads} 条广告改动会转成批量表，要下载后到广告后台上传`)].filter(Boolean);
    if (!await ask(`确认执行这 ${chosen.length} 条改动？${parts.join('；')}。`, '确认执行')) return;
    const result = await act('approve', chosen.map((item) => item.id), (r) => `已确认 ${chosen.length} 条：${[r.queued && `${r.queued} 条正在提交亚马逊`, r.export && `${r.export} 条待导出批量表`].filter(Boolean).join('，')}。`);
    if (result) setView('active');
  }

  async function reject(ids) {
    await act('reject', ids, (r) => `已拒绝 ${r.updated} 条。`);
  }

  async function onAction(action, ids) {
    if (action === 'reject') return reject(ids);
    if (action === 'retry') return act('retry', ids, () => '已重新排队。');
    if (action === 'drop' && await ask('放弃这条改动？不会执行，记录留在历史里。', '放弃')) return act('drop', ids, () => '已放弃。');
    return null;
  }

  async function revert(item) {
    if (!await ask(`把「${targetText(item)}」的${item.kindLabel}改回原来的值？会生成一条新的待确认改动，确认后才执行。`, '生成撤回改动')) return;
    setBusy(true); setError('');
    try {
      const result = await api.revertChange(item.id);
      setMessage(`已生成撤回改动 #${result.id}，在「待确认」里确认后执行。`);
      setView('pending');
      setRevision((n) => n + 1);
      window.dispatchEvent(new Event(CHANGES_EVENT));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function downloadSheet(list, mark) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(changeSheetRows(list)), SHEET);
    XLSX.writeFile(book, `广告改动批量表_${new Date().toISOString().slice(0, 10)}.xlsx`);
    if (mark) await act('exported', list.map((item) => item.id), () => `已导出 ${list.length} 条。到广告后台「批量操作」上传成功后，回来点「已上传到广告后台」。`);
  }

  async function markUploaded(list) {
    if (!await ask(`这 ${list.length} 条已经在广告后台上传成功了吗？上传后亚马逊会给一份处理结果，有报错的行请先在后台处理。`, '已上传')) return;
    await act('uploaded', list.map((item) => item.id), (r) => `已标记 ${r.updated} 条为已生效。`);
  }

  const toExport = view === 'active' ? items.filter((item) => item.status === 'export') : [];
  const exported = view === 'active' ? items.filter((item) => item.status === 'exported') : [];
  const counts = shown?.counts ?? data?.counts;

  return <div className="lib pet-changes animate-in">
    <header className="lib-head"><div><h1>待确认改动 <span className="tag blue">US 站</span></h1>
      <p className="hint">Claude 通过连接器提出的 Listing 和广告改动先放在这里，勾选「确认执行」后才会动亚马逊。Listing 改动用 SP-API 提交，提交前先让亚马逊预检，
        提交后每 20 分钟核对一次是否生效；广告改动{config?.adsApi ? '通过广告 API 直接执行' : '在广告 API 开通前生成批量表，下载后到广告后台上传'}。每一步都记在「日志」里。</p></div></header>
    {config && !config.spApi && <p className="note warn">服务器还没有配置宠物店铺的 SP-API 凭证，Listing 改动确认后会失败。</p>}
    {config?.issues?.length > 0 && <p className="note warn">{config.issues.join('；')}</p>}
    {message && <p className="note ok" role="status">{message}</p>}
    {error && <p className="note err" role="alert">{error}</p>}
    <div className="aba-tabs chg-tabs" role="tablist" aria-label="改动视图">
      {VIEWS.map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} className={`btn${view === key ? ' primary' : ''}`} onClick={() => setView(key)}>
        {label}{counts?.[key] ? ` ${counts[key]}` : ''}</button>)}
    </div>

    {view === 'log' && events && <LogTable events={events} />}

    {view === 'active' && (toExport.length > 0 || exported.length > 0) && <section className="card chg-export" aria-label="广告改动批量表">
      <h2>广告改动批量表</h2>
      <p className="hint">广告 API 还没开通，确认过的广告改动用批量表上传：下载 → 亚马逊广告后台「批量操作」上传 → 回来点「已上传到广告后台」。表头和手动广告页生成的批量表一样。</p>
      <div className="row wrap">
        {toExport.length > 0 && <button className="btn primary" disabled={busy} onClick={() => downloadSheet(toExport, true)}>下载批量表（{toExport.length} 条）</button>}
        {exported.length > 0 && <>
          <button className="btn" disabled={busy} onClick={() => downloadSheet(exported, false)}>重新下载已导出的（{exported.length} 条）</button>
          <button className="btn primary" disabled={busy} onClick={() => markUploaded(exported)}>已上传到广告后台（{exported.length} 条）</button></>}
      </div>
    </section>}

    {view !== 'log' && shown && !items.length && <p className="note">{view === 'pending' ? '没有待确认的改动。在 Claude 里分析完产品，让它「提议修改」，改动就会出现在这里。'
      : view === 'active' ? '没有正在处理的改动。' : '还没有历史记录。'}</p>}

    {view !== 'log' && groups.map(({ batch, items: list }) => <section key={batch?.id ?? 0} className="card chg-batch">
      <header className="row wrap">
        <h2>{batch?.title ?? '其它改动'}</h2>
        {batch && <span className="tag gray">{SOURCE_LABEL[batch.source] ?? batch.source}</span>}
        {batch && <span className="hint">{batch.createdBy ?? ''} · {short(batch.createdAt)} · {list.length} 条</span>}
        <div className="spacer" />
        {selectable && <button className="btn sm" disabled={busy} onClick={() => toggleMany(list)}>{list.every((item) => selected.has(item.id)) ? '取消全选' : '全选本批'}</button>}
      </header>
      {batch?.summary && <p className="chg-summary">{batch.summary}</p>}
      {list.map((item) => <ChangeItem key={item.id} item={item} busy={busy} checked={selected.has(item.id)} onCheck={selectable ? toggle : null}
        onEdit={setEditing} onAction={onAction} onRevert={revert} />)}
    </section>)}

    {selectable && items.length > 0 && <div className="chg-bar" role="toolbar" aria-label="批量操作">
      <label className="row"><input type="checkbox" checked={items.length > 0 && items.every((item) => selected.has(item.id))} disabled={busy}
        onChange={() => toggleMany(items)} />全选</label>
      <span>已选 {chosen.length} 条</span><div className="spacer" />
      <button className="btn danger" disabled={busy || !chosen.length} onClick={() => reject(chosen.map((item) => item.id))}>拒绝</button>
      <button className="btn primary" disabled={busy || !chosen.length} onClick={approve}>确认执行</button>
    </div>}

    {editing && <EditDialog item={editing} onClose={() => setEditing(null)} onSaved={() => { setMessage(editing.status === 'failed' ? '已修改，退回「待确认」，确认后执行。' : '已修改，确认后执行。'); setEditing(null); setRevision((n) => n + 1); }} />}
    {confirmation}
  </div>;
}
