import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ABA_COLUMNS, ABA_PAGE_SIZES } from '../../../shared/aba.js';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function AbaPagination({ data, onChange, nested = false }) {
  return <footer className={`aba-pagination${nested ? ' aba-child-pagination' : ''}`}>
    <span>共 {number.format(data.total)} {data.view === 'printers' ? '类' : '条'}{data.total > 0 && ` · ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)}`}</span>
    <label>每页<select className="inp" aria-label={nested ? '分类明细每页记录数' : '每页记录数'} value={data.pageSize} onChange={(e) => onChange({ pageSize: Number(e.target.value), page: 1 })}>
      {ABA_PAGE_SIZES.map((size) => <option key={size} value={size}>{size} 条</option>)}
    </select></label>
    <button className="btn" disabled={data.page <= 1} onClick={() => onChange({ page: data.page - 1 })}>上一页</button>
    <span>{data.page} / {data.pageCount} 页</span>
    <button className="btn" disabled={data.page >= data.pageCount} onClick={() => onChange({ page: data.page + 1 })}>下一页</button>
  </footer>;
}

function MetricCell({ row, column, maxVolume }) {
  if (column.key === 'week_end') return <span className="aba-date">{row.week_start}<br />— {row.week_end}</span>;
  if (column.key === 'week_number') return <span className="aba-periods">{row.periods?.length > 1 ? row.periods.map((p) => <span key={p.week_end}>{p.week_end.slice(0, 4)} · 第 {p.week_number} 周</span>) : `第 ${row.week_number} 周`}</span>;
  if (column.kind === 'price' && row.record_count > 1) return <details className="aba-prices"><summary>各周中位数</summary>{row.prices.map((p) => <span key={p.week_end}>{p.week_end}：{p.value === null ? '—' : decimal.format(p.value)}</span>)}</details>;
  const value = row[column.key];
  if (value === null || value === undefined) return '—';
  if (column.kind === 'rate') return `${decimal.format(value)}%`;
  if (column.kind === 'price') return decimal.format(value);
  return <>{number.format(value)}{column.key === 'query_volume' && <span className="aba-cell-track" aria-hidden="true"><span style={{ width: `${value / maxVolume * 100}%` }} /></span>}</>;
}

function GroupQueries({ group, params }) {
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.aba({ ...params, ...paging, group: group.key, view: 'queries' }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [group.key, params, paging, revision]);
  return <section className="aba-group-details" aria-label={`${group.query} 下的搜索词`} aria-busy={loading}>
    <p className="aba-group-context">{group.query} · {number.format(group.query_count)} 个搜索词 · 总点击 {number.format(group.clicks)} · 总购买 {number.format(group.purchases)}</p>
    {loading ? <p role="status">正在加载分类明细…</p> : error ? <p role="alert" className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((r) => r + 1)}>重试分类明细</button></p> : data && <>
      <AbaTable data={data} params={params} onSort={(sort) => setPaging((p) => ({ ...p, sort, direction: data.sort === sort && data.direction === 'desc' ? 'asc' : 'desc', page: 1 }))} nested />
      <AbaPagination data={data} onChange={(patch) => setPaging((p) => ({ ...p, ...patch }))} nested />
    </>}
  </section>;
}

export default function AbaTable({ data, params, onSort, empty, nested = false }) {
  const [expanded, setExpanded] = useState(null);
  const grouped = data.view === 'printers';
  const columns = grouped ? [{ key: 'query', label: '机型分类' }, { key: 'query_count', label: '搜索词数量' }, ...ABA_COLUMNS.slice(1).filter((c) => c.key !== 'click_price')] : ABA_COLUMNS;
  const maxVolume = Math.max(1, ...data.items.map((r) => r.query_volume));
  return <div className={`aba-table-scroll${nested ? ' aba-nested-scroll' : ''}`} tabIndex={0} role="region" aria-label={grouped ? '机型分类汇总表，可横向滚动' : '搜索查询明细表，可横向滚动'}>
    <table className={`aba-table${grouped ? ' aba-group-table' : ''}`}><thead><tr>{columns.map((column) => {
      const disabled = column.key === 'click_price' && !data.priceSortable;
      return <th key={column.key} scope="col" aria-sort={data.sort === column.key ? data.direction === 'desc' ? 'descending' : 'ascending' : 'none'}>
        <button disabled={disabled} onClick={() => onSort(column.key)}>{column.label}<span aria-hidden="true">{disabled ? '' : data.sort === column.key ? data.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}</span></button>
      </th>;
    })}</tr></thead><tbody>
      {data.items.map((row) => <Fragment key={row.key ?? `${row.report_id}:${row.query}`}>
        <tr className={grouped ? 'aba-group-row' : undefined}>{columns.map((column) => <td key={column.key} className={column.key === 'query' ? 'aba-query' : 'aba-value'}>
          {column.key === 'query' ? <>
            {grouped ? <button className="aba-group-toggle" aria-expanded={expanded === row.key} aria-label={`${expanded === row.key ? '收起' : '展开'} ${row.query}`} onClick={() => setExpanded((old) => old === row.key ? null : row.key)}><span aria-hidden="true">{expanded === row.key ? '▾' : '▸'}</span> {row.query}</button> : <span>{row.query}</span>}
            {row.record_count > 1 && !grouped && <small className="aba-merged-label">合并 {row.record_count} 周</small>}
            {(grouped ? row.group.kind === 'review' : !nested && row.linked) && <div className="aba-linked"><b>{grouped ? '单列统计，未分摊至候选机型' : '机型关联 · 候选对应墨盒'}</b>{row.candidates.map((candidate) => <small key={candidate}>{candidate}</small>)}</div>}
          </> : <MetricCell row={row} column={column} maxVolume={maxVolume} />}
        </td>)}</tr>
        {grouped && expanded === row.key && <tr className="aba-group-expanded"><td colSpan={columns.length}><GroupQueries group={row} params={params} /></td></tr>}
      </Fragment>)}
      {!data.items.length && <tr><td colSpan={columns.length}>{empty ?? <p className="aba-table-empty">当前筛选下没有搜索词。</p>}</td></tr>}
    </tbody></table>
  </div>;
}
