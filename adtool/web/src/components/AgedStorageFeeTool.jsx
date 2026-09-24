import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { readInventoryRows } from '../agedStorageImport.js';
import { AGE_BUCKETS, calculateInventory, compactInventoryRows, exportRow, FEE_BUCKETS, MARKET_RATES, OUTPUT_COLUMNS, resultForRow, sortAgedFeeRows } from '../../../shared/agedStorageFee.js';
import Icon from './Icon.jsx';
import './ToolsPage.css';
import './AgedStorageFeeTool.css';

const PAGE_SIZE = 50;
const EMPTY_ROWS = [];
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const money = (value) => value == null ? '—' : `$${value.toFixed(2)}`;
const amount = (value, digits = 4) => Number(value.toFixed(digits)).toLocaleString('zh-CN', { maximumFractionDigits: digits });

export default function AgedStorageFeeTool() {
  const fileRef = useRef(null);
  const [shared, setShared] = useState(null);
  const [date, setDate] = useState(today);
  const [scenario, setScenario] = useState('uniform');
  const [busy, setBusy] = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [fileError, setFileError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [corrections, setCorrections] = useState({});
  const [brand, setBrand] = useState('');
  const [market, setMarket] = useState('');
  const [page, setPage] = useState(1);
  const [sortMetric, setSortMetric] = useState('');
  const [sortDirection, setSortDirection] = useState('desc');

  const rows = shared?.rows ?? EMPTY_ROWS;
  const brands = useMemo(() => [...new Set(rows.map((row) => row.brand))].sort(), [rows]);
  const markets = useMemo(() => [...new Set(rows.map((row) => row.market))].sort(), [rows]);
  const filtered = useMemo(() => rows.filter((row) => (!brand || row.brand === brand) && (!market || row.market === market)), [rows, brand, market]);
  const resolved = useMemo(() => filtered.map((row) => resultForRow(row, corrections[row.id], shared.batch.scenario)), [filtered, corrections, shared]);
  const ordered = useMemo(() => sortAgedFeeRows(resolved, sortMetric, sortDirection), [resolved, sortMetric, sortDirection]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = ordered.slice((Math.min(page, pageCount) - 1) * PAGE_SIZE, Math.min(page, pageCount) * PAGE_SIZE);
  const pending = resolved.reduce((count, row) => count + (!row.valid ? 1 : 0), 0);
  const withoutRates = resolved.reduce((count, row) => count + (!MARKET_RATES[row.market] ? 1 : 0), 0);

  function applyShared(data) {
    setShared(data);
    setCorrections(Object.fromEntries(data.rows.map((row) => [row.id, row.correction])));
    if (data.batch) { setDate(data.batch.date); setScenario(data.batch.scenario); }
    setBrand(''); setMarket(''); setPage(1);
    setSaveError('');
  }

  async function refresh() {
    setLoading(true);
    try { applyShared(await api.agedFees()); setFileError(''); }
    catch (error) { setFileError(`共享结果读取失败：${error.message}`); }
    finally { setLoading(false); }
  }

  useEffect(() => { refresh(); }, []);

  async function importFile(file) {
    if (!file) return;
    setBusy(true);
    setImportProgress(null);
    setFileError('');
    try {
      const rows = await readInventoryRows(file);
      const calculated = calculateInventory(rows, date, scenario);
      applyShared(await api.importAgedFees(compactInventoryRows(calculated), date, scenario, file.name,
        (sent, total) => setImportProgress({ sent, total })));
    } catch (error) {
      setFileError(`无法处理表格：${error.message || '请检查文件格式'}`);
    } finally {
      setBusy(false);
      setImportProgress(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function updateCorrection(id, patch) {
    const next = { ...corrections[id], ...patch };
    setCorrections((previous) => ({ ...previous, [id]: next }));
    return next;
  }

  async function saveCorrection(id, next) {
    if (savingId !== null) return;
    setSavingId(id);
    setSaveError('');
    try {
      const result = await api.updateAgedFeeRow(id, {
        special: next.special, value: next.value, reason: next.reason, revision: next.revision,
      });
      setCorrections((previous) => ({ ...previous, [id]: { ...previous[id], revision: result.revision, dirty: false } }));
    } catch (error) {
      setSaveError(`修正未保存：${error.message}。请刷新共享结果后重试。`);
    } finally { setSavingId(null); }
  }

  function download() {
    if (!filtered.length || pending || loading || savingId !== null || Object.values(corrections).some((item) => item.dirty) || saveError) return;
    const rows = ordered.map(exportRow);
    const sheet = XLSX.utils.aoa_to_sheet([OUTPUT_COLUMNS, ...rows]);
    sheet['!cols'] = OUTPUT_COLUMNS.map((header, index) => ({ wch: index === 4 ? 34 : Math.min(32, Math.max(12, header.length * 2 + 2)) }));
    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '计算结果');
    XLSX.writeFile(book, `超龄仓储费_${shared.batch.date}.xlsx`);
    api.recordActivity('agedFees', 'export', '', { files: 1, rows: rows.length }).catch(() => {});
  }

  return <section className="tool-card aged-tool" aria-labelledby="aged-title">
    <div className="tool-title-row">
      <span className="tool-icon"><Icon name="box" size={20} /></span>
      <div><h2 id="aged-title">FBA 超龄仓储费</h2><p className="hint">按每月 15 日库存快照、先进先出和各市场费率估算至售罄日的费用</p></div>
      <span className="tag green">跨账号共享</span>
    </div>
    <div className="aged-settings">
      <label className="field"><span>新批次统计日期</span><input className="inp" type="date" value={date} onChange={(event) => { setDate(event.target.value); setPage(1); }} /></label>
      <label className="field"><span>新批次库龄场景</span><select className="inp" value={scenario} onChange={(event) => setScenario(event.target.value)}>
        <option value="uniform">区间均匀（推荐）</option><option value="youngest">最年轻端（费用下界）</option><option value="oldest">最老端（费用上界）</option>
      </select></label>
      <button className="btn primary" disabled={busy} onClick={() => fileRef.current?.click()}><Icon name="upload" />{busy ? importProgress ? `正在导入 ${importProgress.sent}/${importProgress.total}` : '正在读取表格…' : shared?.batch ? '导入新批次' : '导入库存表'}</button>
      <button className="btn" disabled={loading || busy || savingId !== null} onClick={refresh}>刷新共享结果</button>
      <input ref={fileRef} type="file" hidden accept=".zip,.xlsx,.xls,.csv" onChange={(event) => importFile(event.target.files?.[0])} />
    </div>
    <p className="aged-help">支持 .zip、.xlsx、.xls、.csv；ZIP 内可放库存表。首张工作表需包含市场代码、SKU、7 日均销量和 8 个库龄列。7 天为 0 时取 14 天，两者都为 0 时按 0.14 计算。未配置费率的市场会保留数据，费用留空。任一账号导入新批次后，所有账号查看同一份最新结果。</p>
    <details className="aged-rate-panel" open>
      <summary><span className="aged-rate-title">各市场费率</span><span className="aged-rate-caption">按库龄阶段查看 · 每月 15 日库存快照</span><span className="aged-rate-toggle" aria-hidden="true">⌄</span></summary>
      <div className="aged-rate-table-wrap"><table className="aged-rate-table"><caption>市场超龄仓储费率，美元 / 件 / 次</caption><thead><tr><th scope="col">市场</th>{FEE_BUCKETS.map((bucket) => <th scope="col" key={bucket}>{bucket === '456+' ? '456 天以上' : `${bucket.replace('-', '–')} 天`}</th>)}</tr></thead><tbody>{Object.entries(MARKET_RATES).map(([code, rates]) => <tr key={code}><th scope="row">{code}</th>{rates.map((rate, index) => <td key={FEE_BUCKETS[index]}>${rate.toFixed(2)}</td>)}</tr>)}</tbody></table></div>
    </details>
    {fileError && <div className="tool-error" role="alert"><Icon name="alert" />{fileError}</div>}
    {saveError && <div className="tool-error" role="alert"><Icon name="alert" />{saveError}</div>}
    {loading && <p className="aged-empty" role="status">正在读取共享结果…</p>}
    {!loading && shared && !shared.batch && <p className="aged-empty">还没有共享库存表。导入后，各运营即可按品牌和市场查看数据。</p>}
    {!loading && shared?.batch && !rows.length && <p className="aged-empty">最新批次中没有库存数据。</p>}
    {!!rows.length && <>
      <div className="aged-summary" role="status">
        <span><b>{rows.length}</b> 个可查看 SKU</span><span><b>{filtered.length}</b> 条符合筛选</span>
        <span>已配置费率市场合计 <b>{pending ? '待补正' : money(resolved.reduce((sum, row) => sum + (row.fee.total || 0), 0))}</b></span>
        {withoutRates > 0 && <span className="aged-no-rate">{withoutRates} 条市场无费率，费用留空</span>}
        <span className="aged-source">批次 #{shared.batch.id} · {shared.batch.sourceFile} · {shared.batch.date} · {shared.batch.scenario === 'uniform' ? '区间均匀' : shared.batch.scenario === 'youngest' ? '最年轻端' : '最老端'}</span>
      </div>
      <div className="aged-toolbar">
        <label className="field"><span>品牌</span><select className="inp" value={brand} onChange={(event) => { setBrand(event.target.value); setPage(1); }}><option value="">全部品牌</option>{brands.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>市场</span><select className="inp" value={market} onChange={(event) => { setMarket(event.target.value); setPage(1); }}><option value="">全部市场</option>{markets.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>排序指标</span><select className="inp" value={sortMetric} onChange={(event) => { setSortMetric(event.target.value); setPage(1); }}><option value="">原始顺序</option><option value="average">套均仓储费</option><option value="total">仓储费总额</option><option value="sales">最终计算日销</option></select></label>
        <label className="field"><span>顺序</span><select className="inp" value={sortDirection} disabled={!sortMetric} onChange={(event) => { setSortDirection(event.target.value); setPage(1); }}><option value="desc">从高到低</option><option value="asc">从低到高</option></select></label>
        <div className="spacer" />
        <button className="btn primary" disabled={!filtered.length || pending > 0 || loading || savingId !== null || !!saveError || Object.values(corrections).some((item) => item.dirty)} onClick={download}><Icon name="download" />导出当前筛选 Excel</button>
      </div>
      {pending > 0 && <p className="aged-warning" role="alert">有 {pending} 条已设为“是”但尚未填写有效修正日销；填写大于 0 的数值后即可导出。</p>}
      <div className="aged-table-wrap"><table className="aged-table">
        <thead><tr>{OUTPUT_COLUMNS.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{shown.map((row) => <tr key={row.id}>
          <td>{row.date}</td><td>{row.marketCode}</td><td>{row.brand}</td><td>{row.market || '—'}{!MARKET_RATES[row.market] && <small className="aged-source-label">无费率</small>}</td><td className="aged-sku">{row.sku}</td>
          <td className="aged-number">{money(row.fee.average)}</td><td className="aged-number">{money(row.fee.total)}</td>
          <td className="aged-number">{amount(row.dailySales)}<small className="aged-source-label">{row.salesSource}</small></td>
          <td><select className="inp aged-cell-select" aria-label={`${row.sku} 是否有特殊情况`} disabled={!row.canEdit || loading || savingId !== null} value={row.special ? 'yes' : 'no'} onChange={(event) => { const special = event.target.value === 'yes'; const next = updateCorrection(row.id, { special, value: special ? row.correctionValue : '', reason: special ? row.reason : '', dirty: true }); saveCorrection(row.id, next); }}><option value="no">否</option><option value="yes">是</option></select></td>
          <td><input className="inp aged-cell-input" type="number" min="0.0001" step="any" disabled={!row.canEdit || !row.special || loading || savingId !== null} value={row.correctionValue} aria-label={`${row.sku} 修正日销`} aria-invalid={row.special && !row.valid} onChange={(event) => updateCorrection(row.id, { value: event.target.value, dirty: true })} onBlur={() => { if (corrections[row.id]?.dirty && savingId === null) saveCorrection(row.id, corrections[row.id]); }} /></td>
          <td><input className="inp aged-reason-input" type="text" maxLength={500} disabled={!row.canEdit || !row.special || loading || savingId !== null} value={row.reason} aria-label={`${row.sku} 修正备注理由`} onChange={(event) => updateCorrection(row.id, { reason: event.target.value, dirty: true })} onBlur={() => { if (corrections[row.id]?.dirty && savingId === null) saveCorrection(row.id, corrections[row.id]); }} /></td>
          <td className="aged-number aged-final">{row.finalSales == null ? '待填写' : amount(row.finalSales)}</td>
          <td className="aged-number">{amount(row.inventory)}</td><td className="aged-number">{row.fee.months == null ? '—' : amount(row.fee.months, 2)}</td>
          <td>{row.buckets.slice(4).some((value) => value > 0) ? '是' : '否'}</td>
          {AGE_BUCKETS.map((bucket, index) => <td className="aged-number" key={bucket}>{amount(row.buckets[index])}</td>)}
        </tr>)}</tbody>
      </table></div>
      {!filtered.length && <p className="aged-empty">当前品牌和市场下没有数据，请调整筛选条件。</p>}
      <div className="aged-pagination"><span>每页 {PAGE_SIZE} 条 · 第 {Math.min(page, pageCount)} / {pageCount} 页</span>
        <button className="btn sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
        <button className="btn sm" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
      </div>
    </>}
    <p className="tool-privacy"><Icon name="lock" />库存与修正结果保存在工作台；所有已登录账号均可查看、修正和导出全部市场数据。</p>
  </section>;
}
