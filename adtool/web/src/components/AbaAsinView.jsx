import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { buildAsinGroupExport } from '../abaAsinExport.js';
import AbaAsinTable from './AbaAsinTable.jsx';
import { AbaPagination } from './AbaTable.jsx';
import AbaReportUpload from './AbaReportUpload.jsx';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const defaults = { brand: '', aggregation: 'sum', model: '', view: 'queries', month: '', asin: '', skuId: '', q: '', wordType: 'all', merge: '1', sort: 'market_impressions', direction: 'desc', page: 1, pageSize: 100 };
const storageKey = (userId, market) => `aba-asin-filters:${userId}:${market}`;
const displayKey = (userId, market) => `aba-asin-hide-codes:${userId}:${market}`;
function restore(userId, market) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(userId, market)) || '{}');
    if (saved.model?.startsWith('[')) {
      const [brand, model] = JSON.parse(saved.model);
      saved.model = model; saved.brand = brand;
    }
    return { ...defaults, ...saved };
  }
  catch { return defaults; }
}

export default function AbaAsinView({ market, userId }) {
  const [filters, setFilters] = useState(() => restore(userId, market));
  const [search, setSearch] = useState(filters.q);
  const [composing, setComposing] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [hideCodes, setHideCodes] = useState(() => {
    try { return sessionStorage.getItem(displayKey(userId, market)) === '1'; } catch { return false; }
  });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const searchRef = useRef(null);
  const exportControllerRef = useRef(null);
  const change = (patch) => {
    setExportError('');
    setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  };
  useEffect(() => {
    try { sessionStorage.setItem(storageKey(userId, market), JSON.stringify(filters)); } catch { /* Optional filter persistence. */ }
  }, [filters, userId, market]);
  useEffect(() => {
    try { sessionStorage.setItem(displayKey(userId, market), hideCodes ? '1' : '0'); } catch { /* Optional display preference. */ }
  }, [hideCodes, userId, market]);
  useEffect(() => () => exportControllerRef.current?.abort(), []);
  useEffect(() => {
    if (composing || search === filters.q) return;
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: search, page: 1 })), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [composing, search, filters.q]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.abaAsin({ ...filters, marketplace: market }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, market, revision]);
  const clearSearch = () => { setSearch(''); change({ q: '' }); searchRef.current?.focus(); };
  const selected = filters.weeks === undefined ? data?.selectedWeeks ?? [] : filters.weeks.split(',').filter(Boolean);
  const skus = (data?.skuItems ?? []).filter((s) => (!filters.asin || s.asin === filters.asin) && data.asins.includes(s.asin));
  const skuLabel = (s) => [s.sku, s.brand, s.model ? `${s.model} 系列` : '', s.setGroup].filter(Boolean).join(' · ');
  const tableParams = useMemo(() => ({ ...filters, marketplace: market }), [filters, market]);
  function saved(result) {
    const weeks = [...new Set(result.reports.map((r) => r.week_end))].sort().reverse();
    change({ year: '', month: '', model: '', brand: '', asin: '', skuId: '', weeks: weeks.join(',') });
    setRevision((n) => n + 1);
  }
  async function exportGroups() {
    if (exporting) return;
    exportControllerRef.current?.abort();
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setExporting(true); setExportError('');
    try {
      const exported = await api.abaAsin({ ...filters, marketplace: market, view: 'printers', export: '1', page: 1 }, controller.signal);
      const { columns, rows } = buildAsinGroupExport(exported, filters);
      const worksheet = XLSX.utils.aoa_to_sheet([columns.map((column) => column.label), ...rows]);
      columns.forEach((column, columnIndex) => {
        if (!column.rate) return;
        rows.forEach((_, rowIndex) => {
          const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })];
          if (cell) cell.z = '0.00%';
        });
      });
      worksheet['!cols'] = columns.map((column) => ({ wch: column.key === 'sku' ? 28 : column.key === 'recognition' ? 26 : column.key === 'query' ? 42 : column.key === 'asin' ? 16 : 14 }));
      worksheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(columns.length - 1)}${rows.length + 1}` };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, '机型分类汇总');
      XLSX.writeFile(workbook, `ASIN机型分类汇总_${market}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      api.recordActivity('aba', 'export', market, { groups: exported.total, rows: rows.length }).catch(() => {});
    } catch (err) {
      if (!controller.signal.aborted) setExportError(err.message || '导出失败，请重试');
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null;
        setExporting(false);
      }
    }
  }
  return <div className="aba-asin-view">
    <AbaReportUpload market={market} kind="asin" onSaved={saved} />
    <section className="aba-filters" aria-label="ASIN 报告筛选">
      <div className="aba-toolbar aba-asin-selectors">
        <label>年份<select className="inp" aria-label="年份" value={filters.year ?? data?.year ?? ''} onChange={(e) => change({ year: e.target.value, month: '', model: '', brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">全部年份</option>{data?.years.map((y) => <option key={y} value={y}>{y} 年</option>)}</select></label>
        <label>月份<select className="inp" aria-label="月份" value={filters.month} onChange={(e) => change({ month: e.target.value, model: '', brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">全部月份</option>{data?.months.map((m) => <option key={m} value={m}>{Number(m)} 月</option>)}</select></label>
        <label>墨盒型号<select className="inp" aria-label="墨盒型号" value={filters.model} onChange={(e) => change({ model: e.target.value, brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">不合并套组</option>{data?.modelOptions.map((m) => <option key={m.key} value={m.key}>{m.label}（{m.asins.length} 个 ASIN）</option>)}</select></label>
        <label>品牌<select className="inp" aria-label="品牌" value={filters.brand} onChange={(e) => change({ brand: e.target.value, asin: '', skuId: '', weeks: undefined })}><option value="">全部品牌</option>{data?.brands.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></label>
        <label>ASIN<select className="inp" aria-label="ASIN" value={filters.asin} onChange={(e) => change({ asin: e.target.value, skuId: '', weeks: undefined })}><option value="">{filters.model ? '全部套组 ASIN（合并）' : '全部 ASIN（分行展示）'}</option>{data?.asins.map((asin) => <option key={asin} value={asin}>{asin}</option>)}</select></label>
        <label className="aba-asin-sku-select">关联 SKU<select className="inp" aria-label="关联 SKU" value={filters.skuId} onChange={(e) => change({ skuId: e.target.value, weeks: undefined })}><option value="">全部关联 SKU</option>{skus.map((s) => <option key={s.id} value={s.id}>{skuLabel(s)}</option>)}</select></label>
      </div>
      <p className="hint aba-model-note">年份、月份按报告结束日归属，周数取自原始 CSV 的 C1 或合并表的 AJ 列。SKU 仅关联当前账号在 {market} 站的记录；按墨盒型号 → 品牌 → ASIN → SKU 逐级筛选，型号列出各品牌已关联的型号；选择型号后合并筛选范围内的颜色套组；同一 ASIN 对应多个 SKU 只计一次。未关联型号的 ASIN 可单独查看。</p>
      {!!data?.unlinkedAsins?.length && <details className="aba-prices"><summary>{data.unlinkedAsins.length} 个 ASIN 未关联墨盒型号，点击查看</summary><p className="hint">请在当前账号、当前站点的 SKU 库补充 ASIN、品牌和型号，保存后重新加载报告。未关联时仍可从 ASIN 筛选查看。</p>{data.unlinkedAsins.map((asin) => <span key={asin}>{asin}</span>)}</details>}
      <div className="aba-toolbar">
        <div className="aba-search"><label htmlFor="aba-asin-search">搜索查询 / 墨盒型号</label><div className="aba-search-control"><input id="aba-asin-search" ref={searchRef} className="inp" value={search} placeholder="如 305，包含对应机型词" onChange={(e) => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) change({ q: search }); }} />{search && <button className="btn ghost" aria-label="清除搜索" onClick={clearSearch}>清除</button>}</div></div>
        <label>词类型<select className="inp" aria-label="词类型" value={filters.wordType} onChange={(e) => change({ wordType: e.target.value })}><option value="all">全部搜索词</option><option value="printer">仅机型词</option><option value="cartridge">仅墨盒 KW 词</option></select></label>
        <label>显示方式<select className="inp" aria-label="显示方式" value={filters.view} onChange={(e) => change({ view: e.target.value })}><option value="queries">搜索查询明细</option><option value="printers">机型分类汇总</option></select></label>
        <label>多周统计<select className="inp" aria-label="多周统计" value={filters.aggregation} disabled={selected.length < 2} onChange={(e) => change({ aggregation: e.target.value, ...(e.target.value === 'average' ? { merge: '1' } : {}) })}><option value="sum">合计</option><option value="average">周平均（按词出现周数）</option></select></label>
        <label className="aba-model-toggle"><input type="checkbox" disabled={filters.view === 'printers' || (filters.aggregation === 'average' && selected.length > 1)} checked={filters.view === 'printers' || (filters.aggregation === 'average' && selected.length > 1) || filters.merge === '1'} onChange={(e) => change({ merge: e.target.checked ? '1' : '0' })} />多周合并相同搜索词</label>
      </div>
      <div className="aba-week-title"><strong>报告周 <span className="hint">已选 {selected.length} 周</span></strong><div><button className="btn ghost" disabled={!data?.weeks.length} onClick={() => change({ weeks: data.weeks.map((w) => w.week_end).join(',') })}>全选</button><button className="btn ghost" disabled={!data?.weeks.length} onClick={() => change({ weeks: data.weeks[0].week_end })}>仅最新周</button><button className="btn ghost" disabled={!selected.length} onClick={() => change({ weeks: '' })}>清空周选择</button></div></div>
      <div className="aba-weeks">{data?.weeks.map((week) => <label className={`aba-week${selected.includes(week.week_end) ? ' selected' : ''}`} key={week.week_end}><input type="checkbox" checked={selected.includes(week.week_end)} onChange={() => change({ weeks: (selected.includes(week.week_end) ? selected.filter((w) => w !== week.week_end) : [...selected, week.week_end]).join(',') })} /><span><strong>{week.week_end.slice(0, 4)} · 第 {week.week_number} 周</strong><small>{week.week_start} — {week.week_end}</small></span></label>)}{!data?.weeks.length && <p className="hint">{loading ? '正在读取报告周…' : '当前筛选下没有报告周，可调整筛选或上传 CSV。'}</p>}</div>
      {data && !data.hasModelLibrary && <p className="hint aba-model-note">当前区域没有 D 类机型库，搜索词暂归为墨盒 KW 词；补充机型库后会重新识别。</p>}
    </section>
    <div className="aba-load-status" role="status">{loading ? '正在加载筛选结果…' : error ? <span className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((n) => n + 1)}>重新加载</button></span> : `${number.format(data?.total ?? 0)} ${data?.view === 'printers' ? '个分类' : '条明细'} · ${data?.selectedReportCount ?? 0} 份报告 · ${number.format(data?.recordCount ?? 0)} 条周记录`}</div>
    <div className="aba-results" aria-busy={loading}>
      {!loading && !error && data ? <section className="aba-table-panel">
        <div className="aba-table-heading"><div><h2>{data.view === 'printers' ? 'ASIN 机型分类汇总' : 'ASIN 搜索查询明细'}</h2><p className="hint">{data.aggregation === 'average' ? '按搜索词实际出现周数计算周平均，可展开分类核对明细。' : data.view === 'printers' ? '按 ASIN 和机型分类汇总全部所选周，展开查看搜索词；未识别到机型的词归为墨盒 KW 词。' : data.merged ? '同 ASIN、同搜索词跨周合并，百分比按合计次数重算。' : '每行一个 ASIN 的一条搜索词周记录。'} {data.seriesMerged ? '当前型号跨套组合并：同词同周市场数据只计一次，ASIN 指标相加；市场数值冲突时显示待核对。' : '不同 ASIN 的市场数据有重叠，分别展示。'}</p></div>{data.view === 'printers' && <div className="aba-table-actions"><label className="aba-model-toggle"><input type="checkbox" checked={hideCodes} onChange={(event) => setHideCodes(event.target.checked)} />隐藏 ASIN / SKU</label><button className="btn" disabled={exporting || !data.items.length} aria-busy={exporting} onClick={exportGroups}>{exporting ? '正在导出…' : '导出 Excel'}</button></div>}</div>
        {exportError && <p className="aba-export-feedback aba-error-text" role="alert">{exportError}</p>}
        {data.aggregation === 'average' && <p className="hint aba-model-note">周平均：每个搜索词的数量按实际出现周数平均，未出现的周不计入；同词跨套组先合并再平均。机型分类汇总为各词周平均之和，百分比按当前显示的数量重算。</p>}
        <AbaAsinTable data={data} params={tableParams} key={JSON.stringify(tableParams)} hideIdentity={data.view === 'printers' && hideCodes} onSort={(sort) => change({ sort, direction: data.sort === sort && data.direction === 'desc' ? 'asc' : 'desc' })}
          empty={<div className="aba-table-empty"><h3>{!data.reports.length ? '还没有 ASIN 报告' : !selected.length ? '请选择至少一周' : data.selectedReportCount && !data.recordCount && !filters.q && filters.wordType === 'all' ? '所选报告没有搜索词数据' : '没有匹配的搜索查询'}</h3><p className="hint">可上传 CSV 或合并 XLSX，或调整日期、ASIN、SKU 和搜索条件。</p>{search && <button className="btn" onClick={clearSearch}>清除搜索</button>}</div>} />
        <AbaPagination data={data} onChange={change} />
        <p className="hint aba-table-note">市场 CVR = 市场购买 ÷ 市场点击；ASIN CVR = ASIN 购买 ÷ ASIN 点击；品牌占有率 = ASIN 购买 ÷ 市场购买。均以百分比显示，分母为 0 显示「—」。仅统计所选报告收录的搜索词。</p>
      </section> : <div className="aba-result-placeholder">{loading ? '正在读取报告数据…' : '未能加载报告，请重新加载。'}</div>}
    </div>
  </div>;
}
