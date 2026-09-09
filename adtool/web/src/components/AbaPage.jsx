import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { ABA_COLUMNS, parseAbaReport } from '../../../shared/aba.js';
import Icon from './Icon.jsx';
import AbaTable, { AbaPagination } from './AbaTable.jsx';
import './AbaPage.css';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const CURRENCIES = { ES: 'EUR', DE: 'EUR', FR: 'EUR', IT: 'EUR', UK: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD' };
const defaults = { q: '', brand: '', sort: 'query_volume', direction: 'desc', page: 1, pageSize: 100, models: '1', wordType: 'all', view: 'queries', merge: '1' };
const storageKey = (userId, market) => `aba-filters:${userId}:${market}`;
function initialFilters(userId, market) {
  try { return { ...defaults, ...JSON.parse(sessionStorage.getItem(storageKey(userId, market)) || '{}') }; }
  catch { return defaults; }
}
const weekLabel = (r) => `${r.week_end.slice(0, 4)} · 第 ${r.week_number} 周`;

function WeeklyChart({ weeks, metric }) {
  const max = Math.max(1, ...weeks.map((w) => w[metric] ?? 0));
  const format = (value) => value === null ? '—' : metric === 'click_rate' ? `${decimal.format(value)}%` : number.format(value);
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
  const [metric, setMetric] = useState('query_volume');
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState([]);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const searchRef = useRef(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
    const result = { query_volume: 0, impressions: 0, clicks: 0, purchases: 0 };
    for (const week of data?.trend ?? []) for (const key of Object.keys(result)) result[key] += week[key];
    return result;
  }, [data]);

  async function chooseFiles(fileList) {
    if (busy.current) return;
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setUploadError(''); setNotice('');
    if (files.length > 10) { setUploadError('每次最多上传 10 份 CSV 报告。'); return; }
    if (files.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) { setUploadError('每批文件合计不能超过 30 MB。'); return; }
    busy.current = true; setReading(true);
    const next = [];
    for (const file of files) {
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('单份 CSV 不能超过 10 MB');
        const buffer = await file.arrayBuffer();
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
        const report = parseAbaReport(text, file.name, market);
        next.push({ name: file.name, text, report });
      } catch (err) { next.push({ name: file.name, error: err.message }); }
    }
    if (mounted.current) { setPending(next); setReading(false); }
    busy.current = false;
  }

  async function upload() {
    if (busy.current || !pending.length || pending.some((f) => f.error)) return;
    busy.current = true; setUploading(true); setUploadError(''); setNotice('');
    try {
      const result = await api.importAba(market, pending.map(({ name, text }) => ({ name, text })));
      if (!mounted.current) return;
      const brand = result.reports[0].brand;
      change({ brand, weeks: result.reports.filter((r) => r.brand === brand).map((r) => r.week_end).join(',') });
      setRevision((v) => v + 1);
      const labels = { added: '已保存', updated: '已更新', unchanged: '已存在，无需重复保存' };
      setNotice(result.reports.map((r) => `${r.brand} ${r.week_end}：${labels[r.status]} ${number.format(r.count)} 条`).join('；'));
      setPending([]);
    } catch (err) {
      if (mounted.current) setUploadError(`${err.message}。文件仍保留，可重试；相同报告重试不会重复累计。`);
    } finally { busy.current = false; if (mounted.current) setUploading(false); }
  }

  function sortBy(key) {
    change({ sort: key, direction: data?.sort === key && data?.direction === 'desc' ? 'asc' : 'desc' });
  }
  function toggleWeek(end) {
    change({ weeks: (selected.includes(end) ? selected.filter((w) => w !== end) : [...selected, end]).join(',') });
  }
  function clearSearch() { setSearch(''); change({ q: '' }); searchRef.current?.focus(); }
  const tableParams = useMemo(() => ({ ...filters, marketplace: market }), [filters, market]);

  return <div className={`aba-page${focused ? ' aba-focused' : ''}`}>
    <header className="aba-heading">
      <div><h1>ABA 报告 <span className="tag blue">{market} 站</span></h1><p className="hint">品牌搜索查询绩效 · 报告保存在服务器，仅当前账号可见</p></div>
    </header>
    <div className="aba-tabs" aria-label="报告视图">
      <button className={`btn ${tab === 'brand' ? 'primary' : 'ghost'}`} aria-pressed={tab === 'brand'} onClick={() => setTab('brand')}>品牌视图</button>
      <button className={`btn ${tab === 'asin' ? 'primary' : 'ghost'}`} aria-pressed={tab === 'asin'} onClick={() => setTab('asin')}>ASIN 视图 <span className="aba-soon">待开发</span></button>
    </div>
    {tab === 'asin' ? <section className="aba-empty"><Icon name="file" size={28} /><h2>ASIN 视图待开发</h2><p className="hint">目前可在品牌视图上传和查看搜索查询周报。</p><button className="btn" onClick={() => setTab('brand')}>返回品牌视图</button></section> : <>
      <section className={`aba-upload${dragging ? ' dragging' : ''}`} aria-label="上传品牌报告"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); chooseFiles(e.dataTransfer.files); }}>
        <div className="aba-upload-top"><div><strong>上传品牌视图周报</strong><p className="hint">拖入原始 CSV，或选择文件。每次最多 10 份，单份 10 MB，合计 30 MB。</p><p className="hint">同品牌同一周再次上传会更新该周，其他周保留。品牌和周数自动读取，文件须属于 {market} 站。</p></div>
          <button className="btn" disabled={reading || uploading} onClick={() => inputRef.current?.click()}><Icon name="upload" />{reading ? '正在读取…' : '选择 CSV'}</button>
          <input ref={inputRef} type="file" accept=".csv" multiple hidden aria-label="选择品牌视图 CSV" onChange={(e) => { chooseFiles(e.target.files); e.target.value = ''; }} />
        </div>
        {pending.length > 0 && <div className="aba-file-list">
          {pending.map((file, i) => <div className="aba-file" key={`${file.name}:${i}`}><div><strong>{file.name}</strong><p className={file.error ? 'aba-error-text' : 'hint'}>{file.error || `${file.report.brand} · ${weekLabel(file.report)} · ${file.report.week_start} — ${file.report.week_end} · ${number.format(file.report.rows.length)} 条`}</p></div><button className="btn ghost" disabled={uploading} aria-label={`移除 ${file.name}`} onClick={() => setPending((p) => p.filter((_, n) => n !== i))}>移除</button></div>)}
          <button className="btn primary aba-save" disabled={uploading || reading || pending.some((f) => f.error)} onClick={upload} aria-busy={uploading}>{uploading ? '正在保存…' : '上传并保存'}</button>
        </div>}
        <div className="aba-feedback" aria-live="polite">{uploadError ? <span className="aba-error-text" role="alert">{uploadError}</span> : notice || (reading ? '正在读取并校验文件…' : '')}</div>
      </section>
      <section className="aba-filters" aria-label="报告筛选">
        <div className="aba-toolbar">
          <label className="aba-brand">品牌<select className="inp" aria-label="品牌" value={activeBrand} onChange={(e) => change({ brand: e.target.value, weeks: undefined })}><option value="" disabled>请选择品牌</option>{data?.brands.map((brand) => <option key={brand}>{brand}</option>)}</select></label>
          <div className="aba-search"><label htmlFor="aba-search">搜索查询 / 墨盒型号</label><div className="aba-search-control"><input ref={searchRef} className="inp" id="aba-search" value={search} placeholder="如 305，包含对应机型词" onChange={(e) => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) change({ q: search }); }} />{search && <button className="btn ghost" aria-label="清除搜索" onClick={clearSearch}>清除</button>}</div></div>
          <label className="aba-model-toggle"><input type="checkbox" checked={filters.models === '1'} disabled={filters.wordType !== 'all'} onChange={(e) => change({ models: e.target.checked ? '1' : '0' })} />包含关联机型词</label>
        </div>
        <div className="aba-view-controls">
          <label>词类型<select className="inp" aria-label="词类型" value={filters.wordType} onChange={(e) => change({ wordType: e.target.value })}><option value="all">全部搜索词</option><option value="printer">仅机型词</option><option value="cartridge">仅墨盒词（不含机型）</option></select></label>
          <label>显示方式<select className="inp" aria-label="显示方式" value={filters.view} onChange={(e) => change({ view: e.target.value })}><option value="queries">搜索查询明细</option><option value="printers">机型分类汇总</option></select></label>
          <label className="aba-model-toggle"><input type="checkbox" checked={filters.merge === '1'} onChange={(e) => change({ merge: e.target.checked ? '1' : '0' })} />多周合并相同搜索词</label>
        </div>
        <div className="aba-week-title"><strong>报告周 <span className="hint">已选 {selected.length} 周</span></strong><div><button className="btn ghost" disabled={!available.length} onClick={() => change({ weeks: available.map((r) => r.week_end).join(',') })}>全选</button><button className="btn ghost" disabled={!available.length} onClick={() => change({ weeks: available.slice(0, 1).map((r) => r.week_end).join(',') })}>仅最新周</button><button className="btn ghost" disabled={!selected.length} onClick={() => change({ weeks: '' })}>清空周选择</button></div></div>
        <div className="aba-weeks">{available.length ? available.map((report) => <label className={`aba-week${selected.includes(report.week_end) ? ' selected' : ''}`} key={report.id}><input type="checkbox" checked={selected.includes(report.week_end)} onChange={() => toggleWeek(report.week_end)} /><span><strong>{weekLabel(report)}</strong><small>{report.week_start} — {report.week_end}</small></span><span className="aba-week-count">{number.format(report.row_count)} 词</span></label>) : <p className="hint">{loading ? '正在读取报告周…' : '还没有报告，上传 CSV 后可选择一周或多周。'}</p>}</div>
        <p className="hint aba-model-note">全部搜索词支持包含匹配；仅机型词 / 仅墨盒词按 D 库核对所属墨盒。HP 的 2820、2820e、2820.e 等写法归为同一机型，多机型或多候选词单列统计。{data && !data.hasModelLibrary && ' 当前区域尚无 D 类机型库，无法筛出已识别机型词或墨盒词，可切换全部搜索词。'}</p>
      </section>
      <div className="aba-load-status" role="status">{loading ? '正在加载筛选结果…' : error ? <span className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((v) => v + 1)}>重新加载</button></span> : `${number.format(data?.total ?? 0)} ${data?.view === 'printers' ? '个机型分类' : data?.merged ? '个搜索词' : '条搜索词周记录'} · 来自 ${number.format(data?.recordCount ?? 0)} 条周记录${data?.linkedCount ? `，其中 ${number.format(data.linkedCount)} 条通过机型关联` : ''}`}</div>
      <div className="aba-results" aria-busy={loading}>
        {!error && !loading && data && <>
          <section className="aba-trend-panel">
            <div className="aba-trend-head"><div><h2>每周趋势</h2><p className="hint">按当前品牌、搜索条件和所选周统计；仅代表报告收录的搜索词。</p></div><label>趋势指标<select className="inp" aria-label="趋势指标" value={metric} onChange={(e) => setMetric(e.target.value)}>{ABA_COLUMNS.filter((c) => ['query_volume', 'impressions', 'clicks', 'purchases', 'click_rate'].includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label></div>
            <WeeklyChart weeks={data.trend} metric={metric} />
            {metric === 'click_rate' && <p className="hint">周点击率 = 点击总次数 ÷ 搜索查询量 × 100%，不平均各词点击率。</p>}
            <div className="aba-totals">{['query_volume', 'impressions', 'clicks', 'purchases'].map((key) => <div key={key}><span>{ABA_COLUMNS.find((c) => c.key === key).label}</span><strong className="mono">{number.format(totals[key])}</strong></div>)}</div>
          </section>
          <section className="aba-table-panel">
            <div className="aba-table-heading"><div><h2>{data.view === 'printers' ? '机型分类汇总' : '搜索查询明细'}</h2><p className="hint">{data.view === 'printers' ? '每个分类统计全部所选周，展开查看其搜索词；仅展示有报告数据的分类。' : data.merged ? '相同搜索词跨周合并，查询量、曝光、点击和购买相加，点击率按总数重算。' : '每行一个搜索词的一周数据。'} 价格单位 {CURRENCIES[market]}</p></div><button className="btn" aria-pressed={focused} onClick={() => setFocused((v) => !v)}>{focused ? '退出专注明细' : '专注明细'}</button></div>
            <AbaTable data={data} params={tableParams} onSort={sortBy} empty={<div className="aba-table-empty"><h3>{!data.reports.length ? '还没有品牌报告' : !selected.length ? '请选择至少一周' : '没有匹配的搜索查询'}</h3><p className="hint">{!data.reports.length ? '在上方上传 CSV，保存后即可查看。' : !selected.length ? '可勾选多个报告周进行对照。' : '试试其他搜索词、词类型，或增加所选报告周。'}</p>{search && <button className="btn" onClick={clearSearch}>清除搜索</button>}</div>} />
            <AbaPagination data={data} onChange={change} />
            <p className="hint aba-table-note">点击列名先降序、再次升序。合并行无法计算整体价格中位数，可展开查看各周值；此时价格列不参与排序。空值显示为「—」。</p>
          </section>
        </>}
        {(loading || error) && <div className="aba-result-placeholder">{loading ? '正在读取报告数据…' : '未能加载报告，请重新加载。'}</div>}
      </div>
    </>}
  </div>;
}
