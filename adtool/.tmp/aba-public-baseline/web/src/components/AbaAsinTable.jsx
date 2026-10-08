import { Fragment, useEffect, useState } from 'react';
import { api } from '../api.js';
import { ASIN_COLUMNS } from '../../../shared/abaAsin.js';
import { skusForAsinRow } from '../abaAsinExport.js';
import { AbaPagination } from './AbaTable.jsx';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Identity({ row, data, params, hideCodes = false }) {
  const asins = row.asins ?? [row.asin];
  const skus = skusForAsinRow(row, data, params);
  return <>{!hideCodes && <><small className="aba-asin-id">{row.series_model ? `${row.series_model} · 合并 ${asins.length} 个 ASIN` : row.asin}</small>{row.series_model && <details className="aba-prices"><summary>查看来源 ASIN</summary>{asins.map((asin) => <span key={asin}>{asin}</span>)}</details>}{skus.length ? skus.map((s) => <small className="aba-asin-sku" key={s.id}>{[s.sku, s.brand, s.model ? `${s.model} 系列` : '', s.setGroup].filter(Boolean).join(' · ')}</small>) : <small className="aba-asin-sku">未关联 SKU · 可在 SKU 库补充 ASIN</small>}</>}
    {!!row.conflict_count && <details className="aba-prices aba-market-conflict"><summary>市场数据待核对 · {row.conflict_count} 项</summary>{row.market_conflicts.map((c, i) => <span key={i}>{c.week_end} · {c.query} · {c.label}：{c.values.map((v, valueIndex) => `${hideCodes ? `来源 ${valueIndex + 1}` : v.asin} = ${number.format(v.value)}`).join('；')}</span>)}{row.conflict_count > 20 && <span>仅显示前 20 项；展开分类内搜索词可逐词核对。</span>}</details>}
    {!!row.average_weeks && <small className="aba-asin-sku">周平均 · 按实际出现 {row.average_weeks} 周计算</small>}
    {row.averaged_queries && <small className="aba-asin-sku">各搜索词周平均之和</small>}
    <details className="aba-prices"><summary>{row.periods.length > 1 ? `合并 ${row.periods.length} 周` : `第 ${row.periods[0].week_number} 周 · ${row.periods[0].week_end}`}</summary>{row.periods.map((p) => <span key={p.week_end}>{p.week_end.slice(0, 4)} 第 {p.week_number} 周 · {p.week_start} — {p.week_end}</span>)}</details></>;
}

function GroupQueries({ group, params, hideCodes }) {
  const [paging, setPaging] = useState({ page: 1, pageSize: 25 });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.abaAsin({ ...params, ...paging, asin: params.model ? params.asin : group.asin, group: group.group.key, view: 'queries', merge: '1' }, controller.signal)
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [group.asin, group.group.key, params, paging, revision]);
  const groupLabel = [group.series_model || (!hideCodes ? group.asin : ''), group.recognition].filter(Boolean).join(' ');
  return <section className="aba-group-details" aria-label={`${groupLabel} 下的搜索词`} aria-busy={loading}>
    <p className="aba-group-context">{groupLabel} · {number.format(group.query_count)} 个搜索词 · ASIN {params.aggregation === 'average' ? '周平均点击' : '总点击'} {number.format(group.asin_clicks)} · ASIN {params.aggregation === 'average' ? '周平均购买' : '总购买'} {number.format(group.asin_purchases)}</p>
    {loading ? <p role="status">正在加载分类明细…</p> : error ? <p role="alert" className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((n) => n + 1)}>重试分类明细</button></p> : data && <>
      <AbaAsinTable data={data} params={params} nested hideIdentity={hideCodes} onSort={(sort) => setPaging((p) => ({ ...p, sort, direction: data.sort === sort && data.direction === 'desc' ? 'asc' : 'desc', page: 1 }))} />
      <AbaPagination data={data} nested onChange={(patch) => setPaging((p) => ({ ...p, ...patch }))} />
    </>}
  </section>;
}

export default function AbaAsinTable({ data, params, onSort, empty, nested = false, hideIdentity = false }) {
  const [expanded, setExpanded] = useState(null);
  const grouped = data.view === 'printers';
  const columns = grouped ? [{ key: 'recognition', label: '机型分类', text: true }, { key: 'query_count', label: '搜索词数量' }, ...ASIN_COLUMNS.slice(2)] : ASIN_COLUMNS;
  return <div className={`aba-table-scroll${nested ? ' aba-nested-scroll' : ''}`} tabIndex={0} role="region" aria-label={grouped ? 'ASIN 机型分类汇总表，可横向滚动' : 'ASIN 搜索查询明细表，可横向滚动'}>
    <table className="aba-table aba-asin-table"><thead><tr>{columns.map((c) => <th scope="col" key={c.key} aria-sort={data.sort === c.key ? data.direction === 'desc' ? 'descending' : 'ascending' : 'none'}><button onClick={() => onSort(c.key)}>{c.label}<span aria-hidden="true">{data.sort === c.key ? data.direction === 'desc' ? ' ↓' : ' ↑' : ' ↕'}</span></button></th>)}</tr></thead>
      <tbody>{data.items.map((row) => <Fragment key={row.key}><tr className={grouped ? 'aba-group-row' : undefined}>{columns.map((c) => <td key={c.key} className={c.text ? c.key === 'query' ? 'aba-query' : 'aba-recognition' : 'aba-value'}>
        {c.key === 'recognition' ? <>{grouped ? <button className="aba-group-toggle" aria-expanded={expanded === row.key} aria-label={`${expanded === row.key ? '收起' : '展开'} ${[row.series_model || (!hideIdentity ? row.asin : ''), row.recognition].filter(Boolean).join(' ')}`} onClick={() => setExpanded((old) => old === row.key ? null : row.key)}>{expanded === row.key ? '▾' : '▸'} {row.recognition}</button> : <strong>{row.recognition}</strong>}{row.candidates.map((candidate) => <small key={candidate}>{candidate}</small>)}{grouped && <Identity row={row} data={data} params={params} hideCodes={hideIdentity} />}</>
          : c.key === 'query' ? <><span>{row.query}</span><Identity row={row} data={data} params={params} hideCodes={hideIdentity} /></>
            : row[c.key] === null || row[c.key] === undefined ? '—' : c.rate ? `${percent.format(row[c.key])}%` : number.format(row[c.key])}
      </td>)}</tr>{grouped && expanded === row.key && <tr className="aba-group-expanded"><td colSpan={columns.length}><GroupQueries group={row} params={params} hideCodes={hideIdentity} /></td></tr>}</Fragment>)}
        {!data.items.length && <tr><td colSpan={columns.length}>{empty ?? <p className="aba-table-empty">当前筛选下没有搜索词。</p>}</td></tr>}
      </tbody>
    </table>
  </div>;
}
