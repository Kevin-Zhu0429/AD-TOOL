import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AbaPagination } from './AbaTable.jsx';
import './AdminAttention.css';
import './AbaPage.css';

const COUNTRIES = { ES: '西班牙', DE: '德国', FR: '法国', IT: '意大利', UK: '英国', US: '美国', CA: '加拿大' };

/** 登录后在全部页面持续展示，读取不会将未解决事项标为已处理。 */
export default function AdminAttention({ onOpen, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const result = await api.adminAttention(controller.signal);
        if (controller.signal.aborted) return;
        setData(result); setError('');
        timer = setTimeout(poll, 15000);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err.message);
        if (err.status === 401 || err.status === 403) setData(null);
        else timer = setTimeout(poll, 15000);
      }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [retry, refreshKey]);
  const items = data?.items ?? [];
  const { pageSize } = paging;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const shownPage = Math.min(paging.page, pageCount);
  const shown = expanded ? items.slice((shownPage - 1) * pageSize, shownPage * pageSize) : items.slice(0, 3);
  return <section className={'admin-attention' + (items.length ? ' needs-action' : '')} aria-label="超级管理员待处理事项">
    <div className="admin-attention-heading">
      <div><h2>待处理事项{data && <span> · {items.length ? `${data.total} 项` : '暂无待处理事项'}</span>}</h2>
        <p className="hint" role="status">{!data && !error ? '正在检查需要处理的事项…' : items.length ? `公共 ABA 自动补拉后仍有 ${data.asinTotal} 份 ASIN 周报失败，需要核对授权或重新同步。` : data ? '公共 ABA 没有自动补拉后仍失败的报告。' : '暂时无法确认待处理事项。'}</p></div>
      <div className="admin-attention-buttons">{!!items.length && <button className="btn primary" onClick={onOpen}>前往公共 ABA 处理</button>}
        <button className="btn" onClick={() => setRetry((n) => n + 1)}>刷新待处理事项</button></div>
    </div>
    {error && <p className="note err" role="alert">待处理事项读取失败：{error}{data ? '；以下为上次读取的事项。' : ''}</p>}
    {!!items.length && <><ul className="admin-attention-list">{shown.map((item) => <li key={[item.marketplace, item.brand, item.week_end].join(':')}>
      <strong>{COUNTRIES[item.marketplace] || item.marketplace} {item.marketplace} · {item.brand}</strong>
      <span>{item.week_start} — {item.week_end} · {item.asinCount} 个 ASIN</span>
      <span className="admin-attention-reason">{item.error}</span>
    </li>)}</ul>
      {items.length > 3 && <button className="btn ghost" aria-expanded={expanded} onClick={() => { setExpanded((v) => !v); setPaging((p) => ({ ...p, page: 1 })); }}>{expanded ? '收起事项' : `查看全部 ${items.length} 项待处理事项`}</button>}
      {expanded && <AbaPagination nested data={{ page: shownPage, pageSize, pageCount, total: items.length }} onChange={(patch) => setPaging((p) => ({ ...p, ...patch }))} />}
      <p className="hint">事项在对应报告同步成功后自动清除，查看或刷新不会将事项标记为已处理。</p>
    </>}
  </section>;
}
