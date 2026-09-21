import { downloadReportRows } from '../reportExport.js';
import { isPet } from '../profile.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { BRAND_COLUMNS, brandRates } from '../../../shared/aba.js';
import AbaReportUpload from './AbaReportUpload.jsx';
import AbaTable, { AbaPagination } from './AbaTable.jsx';
import AbaAsinView from './AbaAsinView.jsx';
import './AbaPage.css';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const defaults = { q: '', brand: '', sort: 'impressions', direction: 'desc', page: 1, pageSize: 100, models: '1', wordType: 'all', view: 'queries', merge: '1' };
const storageKey = (userId, market) => `aba-filters:${isPet ? 'pet:' : ''}${userId}:${market}`;
function initialFilters(userId, market) {
  try {
    const saved = { ...defaults, ...JSON.parse(sessionStorage.getItem(storageKey(userId, market)) || '{}') };
    if (!BRAND_COLUMNS.some((c) => c.key === saved.sort) && saved.sort !== 'query_count') saved.sort = 'impressions';
    return { ...saved, ...(isPet ? { models: '0', wordType: 'all', view: 'queries' } : {}) };
  }
  catch { return defaults; }
}
const weekLabel = (r) => `${r.week_end.slice(0, 4)} · 第 ${r.week_number} 周`;

function WeeklyChart({ weeks, metric }) {
  const max = Math.max(1, ...weeks.map((w) => w[metric] ?? 0));
  const format = (value) => value === null ? '—' : BRAND_COLUMNS.find((c) => c.key === metric)?.kind === 'rate' ? `${decimal.format(value)}%` : number.format(value);
  return <div className="aba-chart" aria-label="所选周趋势">
    {weeks.length ? weeks.map((week) => <div className="aba-chart-row" key={week.week_end}>
      <div className="aba-chart-label">{weekLabel(week)}<small>{week.week_start.slice(5)} — {week.week_end.slice(5)}</small></div>
      <div className="aba-track"><div className="aba-bar" style={{ width: `${(week[metric] ?? 0) / max * 100}%` }} /></div>
      <strong className="mono">{format(week[metric])}</strong>
    </div>) : <p className="hint">选择报告周后查看趋势。</p>}
  </div>;
}

export default function AbaPage({ market, userId }) {
  const [filters, setFilters] = useState(() => initialFilters(userId, market));
  const [search, setSearch] = useState(filters.q);
  const [composing, setComposing] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState('brand');
  const [metric, setMetric] = useState('impressions');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [focused, setFocused] = useState(false);
  const searchRef = useRef(null);
  useEffect(() => {
    const oldTitle = document.title;
    document.title = `ABA 报告 · ${market} 站`;
    return () => { document.title = oldTitle; };
  }, [market]);
  useEffect(() => {
    if (composing || search === filters.q) return;
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: search, page: 1 })), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, composing, filters.q]);
  useEffect(() => {
    try { sessionStorage.setItem(storageKey(userId, market), JSON.stringify(filters)); } catch { /* Browser storage is optional. */ }
  }, [filters, userId, market]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.aba({ ...filters, marketplace: market }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((err) => {
      if (!controller.signal.aborted) setError(err.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, market, revision]);
  const change = (patch) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const activeBrand = filters.brand || data?.brand || '';
  const available = (data?.reports ?? []).filter((r) => r.brand === activeBrand);
  const selected = filters.weeks === undefined ? data?.selectedWeeks ?? [] : filters.weeks.split(',').filter(Boolean);
  const totals = useMemo(() => {
    const result = { impressions: 0, clicks: 0, purchases: 0, brand_impressions: 0, brand_clicks: 0, brand_purchases: 0 };
    for (const week of data?.trend ?? []) for (const key of Object.keys(result)) result[key] = result[key] == null || week[key] == null ? null : result[key] + week[key];
    return brandRates(result);
  }, [data]);

  async function exportBrand() {
    setExporting(true); setExportError('');
    try {
      const result = await api.aba({ ...filters, marketplace: market, export: '1' });
      downloadReportRows([...BRAND_COLUMNS.slice(1), { key: 'period', label: '报告周' }],
        result.items.map((row) => ({ ...row, period: row.periods?.map((p) => p.week_end).join(' / ') || row.week_end })), '美国站品牌搜索词');
    } catch (e) { setExportError(e.message); } finally { setExporting(false); }
  }
  function sortBy(key) {
    change({ sort: key, direction: data?.sort === key && data?.direction === 'desc' ? 'asc' : 'desc' });
  }
  function toggleWeek(end) {
    change({ weeks: (selected.includes(end) ? selected.filter((w) => w !== end) : [...selected, end]).join(',') });
  }
  function clearSearch() { setSearch(''); change({ q: '' }); searchRef.current?.focus(); }
  const tableParams = useMemo(() => ({ ...filters, marketplace: market }), [filters, market]);

  return <div className={`aba-page${focused && tab === 'brand' ? ' aba-focused' : ''}`}>
    <header className="aba-heading">
      <div><h1>ABA 报告 <span className="tag blue">{market} 站</span></h1><p className="hint">{isPet ? '搜索查询绩效 · 报告保存在服务器，所有账号共享' : '搜索查询绩效 · 报告保存在服务器，仅当前账号可见'}</p></div>
    </header>
    <div className="aba-tabs" aria-label="报告视图">
      <button className={`btn ${tab === 'brand' ? 'primary' : 'ghost'}`} aria-pressed={tab === 'brand'} onClick={() => setTab('brand')}>品牌视图</button>
      <button className={`btn ${tab === 'asin' ? 'primary' : 'ghost'}`} aria-pressed={tab === 'asin'} onClick={() => setTab('asin')}>ASIN 视图</button>
    </div>
    {tab === 'asin' ? <AbaAsinView key={`${userId}:${market}`} market={market} userId={userId} /> : <>
      <AbaReportUpload market={market} onSaved={(result) => {
        const brand = result.reports[0].brand;
        change({ brand, weeks: result.reports.filter((r) => r.brand === brand).map((r) => r.week_end).join(',') });
        setRevision((v) => v + 1);
      }} />
      <section className="aba-filters" aria-label="报告筛选">
        <div className="aba-toolbar">
          <label className="aba-brand">品牌<select className="inp" aria-label="品牌" value={activeBrand} onChange={(e) => change({ brand: e.target.value, weeks: undefined })}><option value="" disabled>请选择品牌</option>{data?.brands.map((brand) => <option key={brand}>{brand}</option>)}</select></label>
          <div className="aba-search"><label htmlFor="aba-search">{isPet ? '搜索查询' : '搜索查询 / 墨盒型号'}</label><div className="aba-search-control"><input ref={searchRef} className="inp" id="aba-search" value={search} placeholder={isPet ? "如 dog raincoat，按搜索词原文查找" : "如 305，包含对应机型词"} onChange={(e) => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) change({ q: search }); }} />{search && <button className="btn ghost" aria-label="清除搜索" onClick={clearSearch}>清除</button>}</div></div>
          {!isPet && <label className="aba-model-toggle"><input type="checkbox" checked={filters.models === '1'} disabled={filters.wordType !== 'all'} onChange={(e) => change({ models: e.target.checked ? '1' : '0' })} />包含关联机型词</label>}
        </div>
        <div className="aba-view-controls">
          {!isPet && <label>词类型<select className="inp" aria-label="词类型" value={filters.wordType} onChange={(e) => change({ wordType: e.target.value })}><option value="all">全部搜索词</option><option value="printer">仅机型词</option><option value="cartridge">仅墨盒词（不含机型）</option></select></label>}
          {!isPet && <label>显示方式<select className="inp" aria-label="显示方式" value={filters.view} onChange={(e) => change({ view: e.target.value })}><option value="queries">搜索查询明细</option><option value="printers">机型分类汇总</option></select></label>}
          <label className="aba-model-toggle"><input type="checkbox" checked={filters.merge === '1'} onChange={(e) => change({ merge: e.target.checked ? '1' : '0' })} />多周合并相同搜索词</label>
        </div>
        <div className="aba-week-title"><strong>报告周 <span className="hint">已选 {selected.length} 周</span></strong><div><button className="btn ghost" disabled={!available.length} onClick={() => change({ weeks: available.map((r) => r.week_end).join(',') })}>全选</button><button className="btn ghost" disabled={!available.length} onClick={() => change({ weeks: available.slice(0, 1).map((r) => r.week_end).join(',') })}>仅最新周</button><button className="btn ghost" disabled={!selected.length} onClick={() => change({ weeks: '' })}>清空周选择</button></div></div>
        <div className="aba-weeks">{available.length ? available.map((report) => <label className={`aba-week${selected.includes(report.week_end) ? ' selected' : ''}`} key={report.id}><input type="checkbox" checked={selected.includes(report.week_end)} onChange={() => toggleWeek(report.week_end)} /><span><strong>{weekLabel(report)}</strong><small>{report.week_start} — {report.week_end}</small></span><span className="aba-week-count">{number.format(report.row_count)} 词</span></label>) : <p className="hint">{loading ? '正在读取报告周…' : '还没有报告，上传 CSV 后可选择一周或多周。'}</p>}</div>
        {!isPet && <p className="hint aba-model-note">全部搜索词支持包含匹配；仅机型词 / 仅墨盒词按 D 库核对所属墨盒。HP 的 2820、2820e、2820.e 等写法归为同一机型，多机型或多候选词单列统计。{data && !data.hasModelLibrary && ' 当前区域尚无 D 类机型库，无法筛出已识别机型词或墨盒词，可切换全部搜索词。'}</p>}
      </section>
      <div className="aba-load-status" role="status">{loading ? '正在加载筛选结果…' : error ? <span className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((v) => v + 1)}>重新加载</button></span> : `${number.format(data?.total ?? 0)} ${data?.view === 'printers' ? '个机型分类' : data?.merged ? '个搜索词' : '条搜索词周记录'} · 来自 ${number.format(data?.recordCount ?? 0)} 条周记录${data?.linkedCount ? `，其中 ${number.format(data.linkedCount)} 条通过机型关联` : ''}`}</div>
      {!loading && data?.missingBrandData && <p className="aba-error-text" role="status">部分报告尚未保存品牌指标，请重新上传原始品牌 CSV 补齐；缺失值显示为「—」。</p>}
      <div className="aba-results" aria-busy={loading}>
        {!error && !loading && data && <>
          <section className="aba-trend-panel">
            <div className="aba-trend-head"><div><h2>每周趋势</h2><p className="hint">按当前品牌、搜索条件和所选周统计；仅代表报告收录的搜索词。</p></div><label>趋势指标<select className="inp" aria-label="趋势指标" value={metric} onChange={(e) => setMetric(e.target.value)}>{BRAND_COLUMNS.slice(2).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label></div>
            <WeeklyChart weeks={data.trend} metric={metric} />
            {BRAND_COLUMNS.find((c) => c.key === metric)?.kind === 'rate' && <p className="hint">CVR 按购买次数 ÷ 点击次数计算；品牌占有率按品牌购买 ÷ 市场购买计算。</p>}
            <div className="aba-totals aba-brand-totals">{['impressions', 'clicks', 'purchases', 'brand_impressions', 'brand_clicks', 'brand_purchases'].map((key) => <div key={key}><span>{BRAND_COLUMNS.find((c) => c.key === key).label}</span><strong className="mono">{totals[key] == null ? '—' : number.format(totals[key])}</strong></div>)}</div>
          </section>
          <section className="aba-table-panel">
            <div className="aba-table-heading"><div><h2>{data.view === 'printers' ? '机型分类汇总' : '搜索查询明细'}</h2><p className="hint">{data.view === 'printers' ? '每个分类统计全部所选周，展开查看其搜索词；仅展示有报告数据的分类。' : data.merged ? '相同搜索词跨周合并，市场与品牌的数量分别相加，百分比按总数重算。' : '每行一个搜索词的一周数据。'}</p></div>{isPet && <button className="btn" disabled={exporting || !data.items.length} onClick={exportBrand}>{exporting ? '正在导出…' : '导出 Excel'}</button>}<button className="btn" aria-pressed={focused} onClick={() => setFocused((v) => !v)}>{focused ? '退出专注明细' : '专注明细'}</button></div>
            {exportError && <p className="note err" role="alert">{exportError}</p>}
            <AbaTable data={data} params={tableParams} onSort={sortBy} empty={<div className="aba-table-empty"><h3>{!data.reports.length ? '还没有品牌报告' : !selected.length ? '请选择至少一周' : '没有匹配的搜索查询'}</h3><p className="hint">{!data.reports.length ? '在上方上传 CSV，保存后即可查看。' : !selected.length ? '可勾选多个报告周进行对照。' : '试试其他搜索词、词类型，或增加所选报告周。'}</p>{search && <button className="btn" onClick={clearSearch}>清除搜索</button>}</div>} />
            <AbaPagination data={data} onChange={change} />
            <p className="hint aba-table-note">点击列名先降序、再次升序。市场 CVR = 市场购买 ÷ 市场点击；品牌 CVR = 品牌购买 ÷ 品牌点击；品牌占有率 = 品牌购买 ÷ 市场购买。零分母或缺失值显示「—」。</p>
          </section>
        </>}
        {(loading || error) && <div className="aba-result-placeholder">{loading ? '正在读取报告数据…' : '未能加载报告，请重新加载。'}</div>}
      </div>
    </>}
  </div>;
}
