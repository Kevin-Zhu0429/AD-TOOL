import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { buildAsinExport } from '../abaAsinExport.js';
import AbaAsinTable from './AbaAsinTable.jsx';
import { AbaPagination } from './AbaTable.jsx';
import AbaReportUpload from './AbaReportUpload.jsx';
import AbaSkuLibrary from './AbaSkuLibrary.jsx';

const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const defaults = { brand: '', aggregation: 'sum', alignment: 'normal', model: '', view: 'queries', month: '', asin: '', skuId: '', q: '', wordType: 'all', merge: '1', sort: 'market_impressions', direction: 'desc', page: 1, pageSize: 100 };
const storageKey = (userId, market) => `aba-asin-filters:${userId}:${market}`;
const displayKey = (userId, market) => `aba-asin-hide-codes:${userId}:${market}`;
function restore(userId, market) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(userId, market)) || '{}');
    if (saved.model?.startsWith('[')) {
      const [brand, model] = JSON.parse(saved.model);
      saved.model = model; saved.brand = brand;
    }
    if (saved.view === 'cores') saved.wordType = 'cartridge';
    return { ...defaults, ...saved };
  }
  catch { return defaults; }
}

export default function AbaAsinView({ market, userId, publicReport = false, reportRevision = 0 }) {
  const preferenceId = publicReport ? `public:${userId}` : userId;
  const [filters, setFilters] = useState(() => restore(preferenceId, market));
  const [search, setSearch] = useState(filters.q);
  const [composing, setComposing] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [hideCodes, setHideCodes] = useState(() => {
    try { return sessionStorage.getItem(displayKey(preferenceId, market)) === '1'; } catch { return false; }
  });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const searchRef = useRef(null);
  const exportControllerRef = useRef(null);
  const change = (patch) => {
    exportControllerRef.current?.abort();
    setExportError('');
    setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  };
  useEffect(() => {
    try { sessionStorage.setItem(storageKey(preferenceId, market), JSON.stringify(filters)); } catch { /* Optional filter persistence. */ }
  }, [filters, preferenceId, market]);
  useEffect(() => {
    try { sessionStorage.setItem(displayKey(preferenceId, market), hideCodes ? '1' : '0'); } catch { /* Optional display preference. */ }
  }, [hideCodes, preferenceId, market]);
  useEffect(() => () => exportControllerRef.current?.abort(), []);
  useEffect(() => { exportControllerRef.current?.abort(); }, [filters]);
  useEffect(() => {
    if (composing || search === filters.q) return;
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: search, page: 1 })), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [composing, search, filters.q]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.abaAsin({ ...filters, marketplace: market, publicReport: publicReport ? '1' : undefined }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, market, revision, publicReport, reportRevision]);
  useEffect(() => {
    if (data?.skuSource === 'aba' && filters.skuId && !String(filters.skuId).startsWith('aba:'))
      setFilters((old) => ({ ...old, skuId: '', page: 1 }));
  }, [data?.skuSource, filters.skuId]);
  const clearSearch = () => { setSearch(''); change({ q: '' }); searchRef.current?.focus(); };
  const selected = filters.weeks === undefined ? data?.selectedWeeks ?? [] : filters.weeks.split(',').filter(Boolean);
  const grouping = filters.view === 'printers' || filters.view === 'cores';
  const grouped = data?.view === 'printers' || data?.view === 'cores';
  const skus = (data?.skuItems ?? []).filter((s) => (!filters.asin || s.asin === filters.asin) && data.asins.includes(s.asin));
  const skuLabel = (s) => [s.sku, s.brand, s.model ? `${s.model} 系列` : '', s.setGroup].filter(Boolean).join(' · ');
  const tableParams = useMemo(() => ({ ...filters, marketplace: market, publicReport: publicReport ? '1' : undefined }), [filters, market, publicReport]);
  const allMismatchesExcluded = data?.alignmentFilter === 'normal' && data?.alignmentSummary?.mismatchRecords > 0 && !data?.recordCount;
  function saved(result) {
    const weeks = [...new Set(result.reports.map((r) => r.week_end))].sort().reverse();
    change({ year: '', month: '', model: '', brand: '', asin: '', skuId: '', weeks: weeks.join(',') });
    setRevision((n) => n + 1);
  }
  async function exportResults() {
    if (exporting) return;
    exportControllerRef.current?.abort();
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setExporting(true); setExportError('');
    try {
      const params = { ...filters, marketplace: market, publicReport: publicReport ? '1' : undefined,
        year: filters.year ?? data?.year, weeks: selected.join(','), export: '1', page: 1 };
      const exported = await api.abaAsin(params, controller.signal);
      const { columns, rows, sheetName } = buildAsinExport(exported, params);
      const XLSX = await import('xlsx');
      if (controller.signal.aborted) return;
      const worksheet = XLSX.utils.aoa_to_sheet([columns.map((column) => column.label), ...rows]);
      columns.forEach((column, columnIndex) => {
        if (!column.rate) return;
        rows.forEach((_, rowIndex) => {
          const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })];
          if (cell) cell.z = '0.00%';
        });
      });
      worksheet['!cols'] = columns.map((column) => ({ wch: ['periods', 'links', 'market_conflicts', 'alignment_reason', 'alignment_sources'].includes(column.key) ? 48 : column.key.endsWith('_original') ? 28 : column.key === 'sku' ? 28 : column.key === 'recognition' ? 26 : column.key === 'query' ? 42 : column.key === 'asin' ? 16 : 14 }));
      worksheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(columns.length - 1)}${rows.length + 1}` };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
      XLSX.writeFile(workbook, `ASIN${sheetName}_${market}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      api.recordActivity(publicReport ? 'abaPublic' : 'aba', 'export', market, { view: exported.view,
        ...(exported.view !== 'queries' ? { groups: exported.total } : { count: exported.total }), rows: rows.length }).catch(() => {});
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
    <AbaSkuLibrary status={data?.skuLibrary} onSaved={() => { change({ skuId: '' }); setRevision((n) => n + 1); }} />
    {!publicReport && <AbaReportUpload market={market} kind="asin" onSaved={saved} />}
    <section className="aba-filters" aria-label="ASIN 报告筛选">
      <div className="aba-toolbar aba-asin-selectors">
        <label>年份<select className="inp" aria-label="年份" value={filters.year ?? data?.year ?? ''} onChange={(e) => change({ year: e.target.value, month: '', model: '', brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">全部年份</option>{data?.years.map((y) => <option key={y} value={y}>{y} 年</option>)}</select></label>
        <label>月份<select className="inp" aria-label="月份" value={filters.month} onChange={(e) => change({ month: e.target.value, model: '', brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">全部月份</option>{data?.months.map((m) => <option key={m} value={m}>{Number(m)} 月</option>)}</select></label>
        <label>墨盒型号<select className="inp" aria-label="墨盒型号" value={filters.model} onChange={(e) => change({ model: e.target.value, brand: '', asin: '', skuId: '', weeks: undefined })}><option value="">{grouping ? '全部墨盒型号' : '不合并套组'}</option>{data?.modelOptions.map((m) => <option key={m.key} value={m.key}>{m.label}（{m.asins.length} 个 ASIN）</option>)}</select></label>
        <label>品牌<select className="inp" aria-label="品牌" value={filters.brand} onChange={(e) => change({ brand: e.target.value, asin: '', skuId: '', weeks: undefined })}><option value="">全部品牌</option>{data?.brands.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}</select></label>
        <label>ASIN<select className="inp" aria-label="ASIN" value={filters.asin} onChange={(e) => change({ asin: e.target.value, skuId: '', weeks: undefined })}><option value="">{filters.model ? '全部套组 ASIN（合并）' : filters.view === 'cores' ? '全部 ASIN（合并核心词）' : grouping ? '全部 ASIN（合并机型）' : '全部 ASIN（分行展示）'}</option>{data?.asins.map((asin) => <option key={asin} value={asin}>{asin}</option>)}</select></label>
        <label className="aba-asin-sku-select">关联 SKU<select className="inp" aria-label="关联 SKU" value={filters.skuId} onChange={(e) => change({ skuId: e.target.value, weeks: undefined })}><option value="">全部关联 SKU</option>{skus.map((s) => <option key={s.id} value={s.id}>{skuLabel(s)}</option>)}</select></label>
      </div>
      <p className="hint aba-model-note">{data?.skuSource === 'aba' ? `SKU 关联由超级管理员统一维护的 ABA 专用 SKU 库，只读取 ${market} 站；年份、月份按报告结束日归属。` : publicReport ? `年份、月份按报告结束日归属，周数按亚马逊周口径计算。SKU 关联全部账号在 ${market} 站的记录；` : `年份、月份按报告结束日归属，周数取自原始 CSV 的 C1 或合并表的 AJ 列。SKU 仅关联当前账号在 ${market} 站的记录；`}按墨盒型号 → 品牌 → ASIN → SKU 逐级筛选，型号列出各品牌已关联的型号；机型分类汇总按同一机型合并当前筛选内的全部 ASIN；查询明细选择型号后合并颜色套组；同一 ASIN 对应多个 SKU 只计一次。未关联型号的 ASIN 可单独查看。</p>
      {!!data?.unlinkedAsins?.length && <details className="aba-prices"><summary>{data.unlinkedAsins.length} 个 ASIN {data.skuSource === 'aba' ? '未收录于专用 SKU 库' : '未关联墨盒型号'}，点击查看</summary><p className="hint">{data?.skuSource === 'aba' ? '请由超级管理员在上方 ABA 专用 SKU 库补充该国家的 ASIN、品牌和墨盒型号。专用库启用后不再使用个人 SKU 库。' : publicReport ? '可由对应负责人在该国家的 SKU 库补充 ASIN、品牌和型号，公共报告会关联全部账号的记录。' : '请在当前账号、当前站点的 SKU 库补充 ASIN、品牌和型号，保存后重新加载报告。'}未关联时仍可从 ASIN 筛选查看。</p>{data.unlinkedAsins.map((asin) => <span key={asin}>{asin}</span>)}</details>}
      <div className="aba-toolbar">
        <div className="aba-search"><label htmlFor="aba-asin-search">搜索查询 / 墨盒型号</label><div className="aba-search-control"><input id="aba-asin-search" ref={searchRef} className="inp" value={search} placeholder="如 305，包含对应机型词" onChange={(e) => setSearch(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) change({ q: search }); }} />{search && <button className="btn ghost" aria-label="清除搜索" onClick={clearSearch}>清除</button>}</div></div>
        <label>词类型<select className="inp" aria-label="词类型" value={filters.wordType} onChange={(e) => change({ wordType: e.target.value, ...(filters.view === 'cores' && e.target.value !== 'cartridge' ? { view: 'queries' } : {}) })}><option value="all">全部搜索词</option><option value="printer">仅机型词</option><option value="cartridge">仅墨盒 KW 词</option></select></label>
        <label>机型与 SKU<select className="inp" aria-label="机型与 SKU" value={filters.alignment} onChange={(e) => change({ alignment: e.target.value })}><option value="normal">排除不匹配数据</option><option value="all">保留不匹配数据</option><option value="mismatch">仅型号不匹配</option></select></label>
        <label>显示方式<select className="inp" aria-label="显示方式" value={filters.view} onChange={(e) => change({ view: e.target.value })}><option value="queries">搜索查询明细</option><option value="printers">机型分类汇总</option>{filters.wordType === 'cartridge' && <option value="cores">核心词分类汇总</option>}</select></label>
        <label>多周统计<select className="inp" aria-label="多周统计" value={filters.aggregation} disabled={selected.length < 2} onChange={(e) => change({ aggregation: e.target.value, ...(e.target.value === 'average' ? { merge: '1' } : {}) })}><option value="sum">合计</option><option value="average">周平均（按词出现周数）</option></select></label>
        <label className="aba-model-toggle"><input type="checkbox" disabled={grouping || (filters.aggregation === 'average' && selected.length > 1)} checked={grouping || (filters.aggregation === 'average' && selected.length > 1) || filters.merge === '1'} onChange={(e) => change({ merge: e.target.checked ? '1' : '0' })} />多周合并相同搜索词</label>
      </div>
      {filters.wordType === 'cartridge' && <p className="hint aba-model-note">两位或三位墨盒型号即可识别核心词，不要求包含品牌或墨水／墨盒用词，词序与 XL 不影响归类；未写品牌时仅在机型库能唯一确定品牌时合并，否则按型号分类。无型号的词归为超大词；含四位型号的词归为机型词。</p>}
      <div className="aba-week-title"><strong>报告周 <span className="hint">已选 {selected.length} 周</span></strong><div><button className="btn ghost" disabled={!data?.weeks.length} onClick={() => change({ weeks: data.weeks.map((w) => w.week_end).join(',') })}>全选</button><button className="btn ghost" disabled={!data?.weeks.length} onClick={() => change({ weeks: data.weeks[0].week_end })}>仅最新周</button><button className="btn ghost" disabled={!selected.length} onClick={() => change({ weeks: '' })}>清空周选择</button></div></div>
      <div className="aba-weeks">{data?.weeks.map((week) => <label className={`aba-week${selected.includes(week.week_end) ? ' selected' : ''}`} key={week.week_end}><input type="checkbox" checked={selected.includes(week.week_end)} onChange={() => change({ weeks: (selected.includes(week.week_end) ? selected.filter((w) => w !== week.week_end) : [...selected, week.week_end]).join(',') })} /><span><strong>{week.week_end.slice(0, 4)} · 第 {week.week_number} 周</strong><small>{week.week_start} — {week.week_end}</small></span></label>)}{!data?.weeks.length && <p className="hint">{loading ? '正在读取报告周…' : publicReport ? '当前筛选下没有报告周，可调整筛选或查看同步进度。' : '当前筛选下没有报告周，可调整筛选或上传 CSV。'}</p>}</div>
      {data && !data.hasModelLibrary && <p className="hint aba-model-note">当前区域没有 D 类机型库，四位型号保留为待识别机型，其余未识别词归入墨盒 KW；补充机型库后会重新识别。</p>}
    </section>
    <div className="aba-load-status" role="status">{loading ? '正在加载筛选结果…' : error ? <span className="aba-error-text">{error} <button className="btn" onClick={() => setRevision((n) => n + 1)}>重新加载</button></span> : `${number.format(data?.total ?? 0)} ${grouped ? '个分类' : '条明细'} · ${data?.selectedReportCount ?? 0} 份报告 · ${number.format(data?.recordCount ?? 0)} 条周记录`}</div>
    {!loading && !error && data && <p className="hint aba-model-note" role="status">{data.alignmentFilter === 'normal' && data.alignmentSummary?.mismatchRecords ? `已排除 ${data.alignmentSummary.mismatchRecords} 条机型与来源 SKU 型号不匹配的周记录，可切换“仅型号不匹配”查看。` : '机型与 SKU 校验使用当前区域机型库及来源 ASIN 的 SKU 型号。'} 原报告指标保留在来源 ASIN，不转移到其他型号。{data.alignmentFilter !== 'mismatch' && !!data.alignmentSummary?.reviewRecords && ` ${data.alignmentSummary.reviewRecords} 条周记录对应关系待核对或 SKU 资料不足，仍予保留。`}</p>}
    <div className="aba-results" aria-busy={loading}>
      {!loading && !error && data ? <section className="aba-table-panel">
        <div className="aba-table-heading"><div><h2>{data.view === 'cores' ? 'ASIN 核心词分类汇总' : grouped ? 'ASIN 机型分类汇总' : 'ASIN 搜索查询明细'}</h2><p className="hint">{data.aggregation === 'average' ? '按搜索词实际出现周数计算周平均，可展开分类核对明细。' : data.view === 'cores' ? '按两位／三位墨盒型号汇总，不要求包含品牌或墨盒用词；四位型号归为机型词，无型号的超大词单独保留。' : grouped ? '按机型汇总全部所选周，展开查看搜索词及来源 ASIN / SKU；未识别到机型的词归为墨盒 KW 词。' : data.merged ? '同 ASIN、同搜索词跨周合并，百分比按合计次数重算。' : '每行一个 ASIN 的一条搜索词周记录。'} {data.seriesMerged ? '当前筛选内跨 ASIN 合并：同词同周市场数据只计一次，ASIN 指标相加；市场数值冲突时显示待核对。' : '不同 ASIN 的市场数据有重叠，分别展示。'}</p></div><div className="aba-table-actions">{grouped && <label className="aba-model-toggle"><input type="checkbox" checked={hideCodes} onChange={(event) => setHideCodes(event.target.checked)} />隐藏 ASIN / SKU</label>}<button className="btn" disabled={exporting || !data.items.length} aria-busy={exporting} onClick={exportResults} title="导出当前筛选的全部结果，不受页码限制">{exporting ? '正在导出…' : '导出 Excel'}</button></div></div>
        {exportError && <p className="aba-export-feedback aba-error-text" role="alert">{exportError}</p>}
        {data.aggregation === 'average' && <p className="hint aba-model-note">周平均：每个搜索词的数量按实际出现周数平均，未出现的周不计入；同词跨套组先合并再平均。分类汇总为各词周平均之和，百分比按当前显示的数量重算。</p>}
        {grouped && <p className="hint aba-model-note">Excel 保留原指标；新增四列“原始总量”为每个搜索词按实际出现周数计算的完整市场周平均，不按 ASIN / SKU 分摊，同词在不同行重复展示，不可直接相加。市场来源冲突或缺失时，对应新列留空。</p>}
        <AbaAsinTable data={data} params={tableParams} key={JSON.stringify(tableParams)} hideIdentity={grouped && hideCodes} onSort={(sort) => change({ sort, direction: data.sort === sort && data.direction === 'desc' ? 'asc' : 'desc' })}
          empty={<div className="aba-table-empty"><h3>{!data.reports.length ? '还没有 ASIN 报告' : !selected.length ? '请选择至少一周' : allMismatchesExcluded ? '不匹配数据已全部排除' : data.alignmentFilter === 'mismatch' ? '没有型号不匹配的记录' : data.selectedReportCount && !data.recordCount && !filters.q && filters.wordType === 'all' ? '所选报告没有搜索词数据' : '没有匹配的搜索查询'}</h3><p className="hint">{allMismatchesExcluded ? '可将“机型与 SKU”切换为“保留不匹配数据”或“仅型号不匹配”，核对原始记录。' : publicReport ? '报告由 API 同步，可查看上方同步进度，或调整日期、ASIN、SKU 和搜索条件。' : '可上传 CSV 或合并 XLSX，或调整日期、ASIN、SKU 和搜索条件。'}</p>{search && <button className="btn" onClick={clearSearch}>清除搜索</button>}</div>} />
        <AbaPagination data={data} onChange={change} />
        <p className="hint aba-table-note">市场 CVR = 市场购买 ÷ 市场点击；ASIN CVR = ASIN 购买 ÷ ASIN 点击；品牌占有率 = ASIN 购买 ÷ 市场购买。均以百分比显示，分母为 0 显示「—」。仅统计所选报告收录的搜索词。</p>
      </section> : <div className="aba-result-placeholder">{loading ? '正在读取报告数据…' : '未能加载报告，请重新加载。'}</div>}
    </div>
  </div>;
}
