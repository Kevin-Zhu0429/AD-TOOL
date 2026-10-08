import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import AbaAsinView from './AbaAsinView.jsx';
import { AbaPagination } from './AbaTable.jsx';
import './AbaPage.css';

const COUNTRIES = { ES: '西班牙', DE: '德国', FR: '法国', IT: '意大利', UK: '英国', US: '美国', CA: '加拿大', AU: '澳大利亚', AE: '阿联酋' };
const STAGES = { queued: '等待请求', requesting: '正在申请报告', waiting: '等待亚马逊生成', waiting_download: '等待下载额度', downloading: '正在下载', saving: '正在保存', done: '已保存', failed: '失败' };
const STATES = { running: '同步进行中', done: '同步完成', partial: '部分报告失败', failed: '同步失败' };
const time = (value) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(value) : '—';
const fallbackMarkets = ['ES', 'DE', 'FR', 'IT', 'UK', 'US', 'CA'];

export default function AbaPublicPage({ user }) {
  const [market, setMarket] = useState(() => {
    try { return sessionStorage.getItem('aba-public-country:' + user.id) || 'ES'; } catch { return 'ES'; }
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const startRef = useRef(null);
  useEffect(() => () => startRef.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = await api.abaPublicStatus(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(result); setError('');
        timer = setTimeout(poll, result.job?.state === 'running' ? 3000 : 15000);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err.message);
        if (err.status !== 401 && err.status !== 403) timer = setTimeout(poll, 15000);
      }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [retry]);
  useEffect(() => {
    try { sessionStorage.setItem('aba-public-country:' + user.id, market); } catch { /* Optional preference. */ }
  }, [user.id, market]);
  const markets = status?.markets?.length ? status.markets : fallbackMarkets;
  useEffect(() => {
    if (status?.markets?.length && !status.markets.includes(market)) setMarket(status.markets[0]);
  }, [status?.markets, market]);
  async function synchronize() {
    if (startRef.current) return;
    const controller = new AbortController();
    startRef.current = controller;
    setStarting(true); setError('');
    try {
      const result = await api.syncPublicAba(controller.signal);
      if (!controller.signal.aborted) { setStatus(result); setPaging((p) => ({ ...p, page: 1 })); }
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message + '；请刷新进度确认任务是否已启动。');
    } finally {
      if (startRef.current === controller) {
        startRef.current = null; setStarting(false);
        setRetry((n) => n + 1);
      }
    }
  }
  const job = status?.job;
  const summary = status?.summary;
  const tasks = status?.tasks ?? [];
  const pageCount = Math.max(1, Math.ceil(tasks.length / paging.pageSize));
  const page = Math.min(paging.page, pageCount);
  const shown = tasks.slice((page - 1) * paging.pageSize, page * paging.pageSize);
  const counts = status?.targets?.filter((t) => t.marketplace === market) ?? [];
  const activeTasks = job?.state === 'running' ? tasks.filter((task) => !['queued', 'done', 'failed'].includes(task.stage)) : [];
  return <div className="aba-page aba-public-page">
    <header className="aba-public-heading"><div><h1>ABA报告（公共）</h1><p className="hint">全部账号共享报告 · 型号与 SKU 关联全部账号的 SKU 库</p></div>
      <div className="aba-public-actions">{user.role === 'owner' ? <button className="btn primary" disabled={!status || starting || job?.state === 'running'} aria-busy={starting || job?.state === 'running'} onClick={synchronize}>{starting ? '正在启动…' : job?.state === 'running' ? '正在同步…' : job?.state === 'failed' || job?.state === 'partial' ? '重试同步' : '手动同步'}</button> : <span className="hint">由超级管理员手动同步</span>}
        <button className="btn" onClick={() => setRetry((n) => n + 1)}>刷新进度</button></div>
    </header>
    <nav className="aba-public-countries" aria-label="公共报告国家切换">
      {markets.map((code) => <button key={code} type="button" aria-pressed={market === code} className={'aba-public-country' + (market === code ? ' selected' : '')} onClick={() => setMarket(code)}><strong>{COUNTRIES[code] || code}</strong><span>{code} 站</span></button>)}
    </nav>
    <p className="hint aba-public-catalog">{counts.length ? counts.map((t) => t.brand + ' ' + t.count + ' 个 ASIN').join(' · ') : '正在读取国家与品牌清单…'}</p>
    <section className="aba-public-sync" aria-label="公共报告同步进度">
      <div className="aba-public-sync-head"><h2>{job ? STATES[job.state] : status ? '尚未同步公共报告' : '正在读取同步状态…'}</h2><span className="hint">每周二 12:00（北京时间）自动同步 · 下次 {time(status?.nextDue)}</span></div>
      <p className="hint">首次拉取前四个完整周，此后拉取上一完整周；失败或遗漏的历史报告会补拉。亚马逊报告按周日到周六统计。</p>
      {summary?.total > 0 && <><p role="status">已处理 {summary.completed + summary.failed} / {summary.total} 批 · 已保存 {summary.asinCompleted} / {summary.asinTotal} 份 ASIN 周报 · {summary.rows.toLocaleString('zh-CN')} 条搜索词记录 · 失败 {summary.failed} 批</p>
        <progress aria-label="报告批次处理进度" max={summary.total} value={summary.completed + summary.failed} />
        <p className="hint">开始 {time(job.created_at)} · 最近进展 {time(job.updated_at)} · 同步期间可继续筛选和导出已保存的数据。等待生成和限流排队时间由亚马逊决定。</p></>}
      {!!activeTasks.length && <div className="aba-public-active" role="status"><strong>当前处理</strong>{activeTasks.slice(0, 4).map((task) => <p key={task.id}>{COUNTRIES[task.marketplace]} {task.marketplace} · {task.brand} · {task.week_start} — {task.week_end} · {task.asinCount} 个 ASIN · {STAGES[task.stage]}</p>)}{activeTasks.length > 4 && <p className="hint">另有 {activeTasks.length - 4} 批报告在生成或等待下载，可在明细中查看。</p>}</div>}
      {job?.error && <p className="aba-error-text" role="status">{job.error}</p>}
      {error && <p className="aba-error-text" role="alert">进度读取或同步请求失败：{error} <button className="btn" onClick={() => setRetry((n) => n + 1)}>重新读取</button></p>}
      {!!status?.issues?.length && <details className="aba-public-issues"><summary>有 {status.issues.length} 组国家与品牌尚未配置授权</summary>{status.issues.map((issue) => <p key={issue}>{issue}</p>)}<p className="hint">请由超级管理员核对服务器品牌授权，并确认已开通 Brand Analytics 权限。</p></details>}
      {!!tasks.length && <details className="aba-public-task-details" open={job?.state === 'running'}>
        <summary>查看各国家、品牌与报告周的同步明细</summary>
        <div className="aba-public-task-scroll" tabIndex={0} role="region" aria-label="同步任务明细，可横向滚动"><table className="aba-table"><thead><tr><th scope="col">国家</th><th scope="col">品牌</th><th scope="col">报告周</th><th scope="col">ASIN 数</th><th scope="col">当前状态</th><th scope="col">结果 / 原因</th></tr></thead><tbody>{shown.map((task) => <tr key={task.id}><td>{COUNTRIES[task.marketplace]} {task.marketplace}</td><td>{task.brand}</td><td>{task.week_start} — {task.week_end}</td><td>{task.asinCount}</td><td className={task.stage === 'failed' ? 'aba-error-text' : ''}>{STAGES[task.stage]}</td><td>{task.error || (task.stage === 'done' ? task.rows_saved + ' 条搜索词' : task.stage === 'waiting' ? '已检查 ' + task.polls + ' 次，等待生成' : task.stage === 'queued' || task.stage === 'waiting_download' ? '按卖家账号限速排队' : '正在处理')}</td></tr>)}</tbody></table></div>
        <AbaPagination nested data={{ ...paging, page, pageCount, total: tasks.length }} onChange={(patch) => setPaging((p) => ({ ...p, ...patch }))} />
      </details>}
    </section>
    <AbaAsinView key={user.id + ':' + market} market={market} userId={user.id} publicReport reportRevision={(job?.id ?? 0) + ':' + (summary?.completed ?? 0)} />
  </div>;
}
