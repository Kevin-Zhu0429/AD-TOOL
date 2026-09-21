import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { PET_PRODUCT_COLUMNS as columns, petHeaderMap, parsePetProductSheet, normalizePetProduct } from '../../../shared/petProducts.js';
import AppDialog, { useConfirm } from './AppDialog.jsx';
import { AbaPagination } from './AbaTable.jsx';
import './LibraryPage.css';
import './ProductPage.css';
import './PetProductPage.css';

const fields = ['product_type', 'style', 'size', 'color', 'fabric', 'comparison_group'];
const monthNow = () => new Date().toISOString().slice(0, 7);
const display = (p, c) => p[c.key] == null || p[c.key] === '' ? '—' : c.bool ? p[c.key] ? '是' : '否' : c.key === 'price' ? `$${Number(p.price).toFixed(2)}` : p[c.key];

export default function PetProductPage({ market }) {
  const [data, setData] = useState(null), [month, setMonth] = useState('');
  const [revision, setRevision] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [facets, setFacets] = useState({}), [ownOnly, setOwnOnly] = useState(false);
  const [paging, setPaging] = useState({ page: 1, pageSize: 100 }), [sort, setSort] = useState({ key: 'asin', direction: 1 });
  const [upload, setUpload] = useState(null), [editor, setEditor] = useState(null), [editError, setEditError] = useState('');
  const [confirmAction, confirmation] = useConfirm();
  const searchRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.products(market, month, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [market, month, revision]);
  const products = data?.products ?? [];
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (data?.products ?? []).filter((p) => (!ownOnly || p.is_own)
      && fields.every((key) => !facets[key] || p[key] === facets[key])
      && (!text || columns.some((c) => String(p[c.key] ?? '').toLowerCase().includes(text))))
      .sort((a, b) => {
        const av = a[sort.key], bv = b[sort.key];
        if (av == null || av === '') return bv == null || bv === '' ? 0 : 1;
        if (bv == null || bv === '') return -1;
        return (typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true })) * sort.direction;
      });
  }, [data, query, facets, ownOnly, sort]);
  useEffect(() => setPaging((p) => ({ ...p, page: 1 })), [query, facets, ownOnly, data]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / paging.pageSize));
  const page = Math.min(paging.page, pageCount);
  const shown = filtered.slice((page - 1) * paging.pageSize, page * paging.pageSize);
  const prices = filtered.map((p) => p.price).filter((v) => typeof v === 'number');
  const preview = useMemo(() => {
    if (!upload) return null;
    try { return { products: parsePetProductSheet(upload.sheet, upload.mapping) }; }
    catch (e) { return { error: e.message }; }
  }, [upload]);

  function exportRows(rows, name, example = false) {
    const ws = XLSX.utils.aoa_to_sheet([columns.map((c) => c.label), ...rows.map((p) => columns.map((c) => c.bool ? p[c.key] ? '是' : '否' : p[c.key] ?? ''))]);
    ws['!cols'] = columns.map((c) => ({ wch: c.key === 'title' ? 48 : 18 }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '产品数据');
    if (example) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['说明'], ['每行一个 ASIN；示例请删除后填写真实产品。'], ['价格以美元保存；销量和排名以原始来源口径为准，未提供请留空。'], ['对比组由运营手动填写，只把用途、规格可比的产品放入同一组。'], ['同月同 ASIN 更新；手动维护的品类属性和对比组优先保留。']]), '填写说明');
    XLSX.writeFile(wb, `${name}.xlsx`);
  }
  async function readFile(file) {
    if (!file) return;
    setMessage(''); setError('');
    try {
      const book = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const name = book.SheetNames[0], sheet = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
      setUpload({ book, name, sheet, mapping: petHeaderMap(sheet[0] ?? []), filename: file.name, month: data?.dataMonth && data.dataMonth !== 'legacy' ? data.dataMonth : monthNow() });
    } catch (e) { setError(`读取失败：${e.message}`); }
  }
  async function saveImport() {
    if (!preview?.products || busy) return;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(upload.month)) return setError('请选择有效的数据月份');
    setBusy(true); setError('');
    try {
      const result = await api.importProducts(market, preview.products, upload.month, upload.filename);
      setMonth(upload.month); setUpload(null); setRevision((n) => n + 1);
      setMessage(`已导入：新增 ${result.added} 条，更新 ${result.updated} 条。`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function saveEditor() {
    setEditError('');
    let product;
    try { product = normalizePetProduct(editor.product); }
    catch (e) { setEditError(e.message); return; }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(editor.month) && editor.month !== 'legacy') return setEditError('请选择数据月份');
    setBusy(true);
    try {
      if (editor.existing) await api.updateProduct(market, editor.month, product.asin, product);
      else await api.importProducts(market, [product], editor.month, '手动添加');
      setMonth(editor.month); setEditor(null); setRevision((n) => n + 1); setMessage('产品已保存。');
    } catch (e) { setEditError(e.message); } finally { setBusy(false); }
  }
  async function remove(product) {
    if (!await confirmAction(`删除 ${data.dataMonth} 月的产品 ${product.asin}？此操作无法撤销。`, '删除产品')) return;
    setBusy(true); setError('');
    try { await api.deleteProducts(market, data.dataMonth, [product.asin]); setRevision((n) => n + 1); setMessage(`已删除 ${product.asin}`); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const changeFacet = (key, value) => setFacets((f) => ({ ...f, [key]: value }));
  return <div className="lib pet-products">
    {confirmation}
    <header className="lib-head"><div><h1>美国站产品情报</h1><p className="hint">按月维护产品数据。价格为 USD；销量、排名等保留来源口径，缺失值显示“—”。</p></div><div className="spacer" />
      <button className="btn" onClick={() => exportRows([{ asin: 'B000000001', title: '示例宠物雨衣', product_type: '雨衣', style: '雨衣 A 款', size: 'L', color: '黄色', fabric: '防水涂层 / 纯色', comparison_group: '同规格雨衣', is_own: true }], '宠物产品情报模板', true)}>下载模板</button>
      <label className="btn">导入 Excel / CSV<input aria-label="导入产品文件" type="file" accept=".xlsx,.xls,.csv" disabled={busy} hidden onChange={(e) => { readFile(e.target.files[0]); e.target.value = ''; }} /></label>
      <button className="btn primary" disabled={busy} onClick={() => { setEditError(''); setEditor({ product: {}, month: data?.dataMonth && data.dataMonth !== 'legacy' ? data.dataMonth : monthNow(), existing: false }); }}>添加产品</button>
    </header>
    {message && <p className="note ok" role="status">{message}</p>}
    {error && !upload && <p className="note err" role="alert">{error} <button className="btn" onClick={() => setRevision((n) => n + 1)}>重新加载</button></p>}
    <section className="card">
      <div className="pet-filters">
        <label>数据月份<select className="inp" value={month || data?.dataMonth || ''} onChange={(e) => setMonth(e.target.value)}><option value="">最新月份</option>{data?.months.map((m) => <option key={m.month} value={m.month}>{m.month}（{m.count} 条）</option>)}</select></label>
        <label className="pet-product-search">搜索产品<input ref={searchRef} className="inp" value={query} placeholder="ASIN / 标题 / 品牌 / 属性" onChange={(e) => setQuery(e.target.value)} /></label>
        {query && <button className="btn" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>清除搜索</button>}
        {fields.map((key) => <label key={key}>{columns.find((c) => c.key === key).label}<select className="inp" aria-label={columns.find((c) => c.key === key).label} value={facets[key] || ''} onChange={(e) => changeFacet(key, e.target.value)}><option value="">全部</option>{[...new Set(products.map((p) => p[key]).filter(Boolean))].sort().map((v) => <option key={v}>{v}</option>)}</select></label>)}
      </div>
      <div className="row wrap"><label className="row"><input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} />只看自家产品</label><button className="btn sm" onClick={() => { setFacets({}); setQuery(''); setOwnOnly(false); }}>清空筛选</button><div className="spacer" /><button className="btn" disabled={loading || !filtered.length} onClick={() => exportRows(filtered, `宠物产品_${data.dataMonth}`)}>导出筛选结果</button></div>
      {facets.comparison_group ? <p className="note info">对比组“{facets.comparison_group}”：当前筛选 {filtered.length} 个产品，{prices.length} 个有价格{prices.length ? `，最低 $${Math.min(...prices).toFixed(2)}，最高 $${Math.max(...prices).toFixed(2)}` : ''}。优惠说明未自动折算，不同品牌尺码需自行核对。</p> : <p className="hint">编辑产品并填写“对比组”，再选择该组查看可比产品。首期不自动推断同款或机会竞品。</p>}
      <div role="status" className="pet-product-status">{loading ? '正在加载产品…' : `共 ${filtered.length} 个产品`}</div>
      {!loading && !error && <>
        <div className="scroll pet-product-table" tabIndex={0} role="region" aria-label="产品列表，可横向滚动"><table className="tbl"><thead><tr>{columns.map((c) => <th key={c.key} aria-sort={sort.key === c.key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}><button className="btn ghost sm" onClick={() => setSort({ key: c.key, direction: sort.key === c.key ? -sort.direction : 1 })}>{c.label}</button></th>)}<th>操作</th></tr></thead><tbody>
          {shown.map((product) => <tr key={product.asin}>{columns.map((c) => <td key={c.key}>{c.key === 'asin' ? <a href={`https://www.amazon.com/dp/${product.asin}`} target="_blank" rel="noreferrer">{product.asin}</a> : display(product, c)}</td>)}<td><div className="row"><button className="btn sm" disabled={busy} onClick={() => { setEditError(''); setEditor({ product: { ...product }, existing: true, month: data.dataMonth }); }}>编辑</button><button className="btn sm danger" disabled={busy} onClick={() => remove(product)}>删除</button></div></td></tr>)}
          {!shown.length && <tr><td colSpan={columns.length + 1} className="empty">{products.length ? '没有匹配的产品，请调整筛选。' : '还没有产品数据。下载模板导入，或添加第一条产品。'}</td></tr>}
        </tbody></table></div>
        <AbaPagination data={{ ...paging, page, pageCount, total: filtered.length }} onChange={(p) => setPaging((old) => ({ ...old, ...p }))} />
      </>}
    </section>
    {upload && <AppDialog title="核对产品导入" wide busy={busy} onClose={() => { setUpload(null); setError(''); }}>
      <div className="pet-filters"><label>工作表<select className="inp" value={upload.name} disabled={busy} onChange={(e) => { const name = e.target.value, sheet = XLSX.utils.sheet_to_json(upload.book.Sheets[name], { header: 1, defval: '' }); setUpload({ ...upload, name, sheet, mapping: petHeaderMap(sheet[0] ?? []) }); }}>{upload.book.SheetNames.map((name) => <option key={name}>{name}</option>)}</select></label><label>数据月份<input className="inp" type="month" value={upload.month} disabled={busy} onChange={(e) => setUpload({ ...upload, month: e.target.value })} /></label></div>
      <p className="hint">第一行作为表头。核对每个字段对应的原始列；未映射字段留空。同月同 ASIN 更新，其他产品保留。</p>
      <div className="pet-filters">{columns.map((c) => <label key={c.key}>{c.label}{c.required ? ' *' : ''}<select className="inp" aria-label={c.label} disabled={busy} value={upload.mapping[c.key] ?? -1} onChange={(e) => setUpload({ ...upload, mapping: { ...upload.mapping, [c.key]: Number(e.target.value) } })}><option value={-1}>不导入此字段</option>{(upload.sheet[0] ?? []).map((h, i) => <option key={i} value={i}>{XLSX.utils.encode_col(i)} · {String(h) || '无标题'}</option>)}</select></label>)}</div>
      {preview?.error && <p className="note err" role="alert">{preview.error}</p>}
      {error && <p className="note err" role="alert">{error}</p>}
      {preview?.products && <><p role="status">校验通过，共 {preview.products.length} 行，预览前 10 行：</p><div className="scroll pet-product-table"><table className="tbl"><thead><tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{preview.products.slice(0, 10).map((p) => <tr key={p.asin}>{columns.map((c) => <td key={c.key}>{display(p, c)}</td>)}</tr>)}</tbody></table></div></>}
      <footer className="row"><div className="spacer" /><button className="btn" disabled={busy} onClick={() => { setUpload(null); setError(''); }}>取消</button><button className="btn primary" disabled={busy || !preview?.products} onClick={saveImport}>{busy ? '正在导入…' : '确认导入'}</button></footer>
    </AppDialog>}
    {editor && <AppDialog title={editor.existing ? `编辑 ${editor.product.asin}` : '添加产品'} wide busy={busy} onClose={() => setEditor(null)}>
      <form noValidate onSubmit={(e) => { e.preventDefault(); saveEditor(); }}>
        {!editor.existing && <label className="field">数据月份<input className="inp" type="month" value={editor.month} onChange={(e) => setEditor({ ...editor, month: e.target.value })} /></label>}
        <div className="pet-product-fields">{columns.map((c) => <label className="field" key={c.key}><span>{c.label}{c.required ? ' *' : ''}</span>{c.bool ? <select className="inp" aria-label={c.label} value={String(!!editor.product[c.key])} onChange={(e) => setEditor({ ...editor, product: { ...editor.product, [c.key]: e.target.value === 'true' } })}><option value="false">否</option><option value="true">是</option></select> : <input className="inp" disabled={busy || (editor.existing && c.key === 'asin')} type={c.num ? 'number' : 'text'} min={c.num ? 0 : undefined} step={c.int ? 1 : 'any'} value={editor.product[c.key] ?? ''} aria-describedby={editError ? 'pet-product-error' : undefined} onChange={(e) => setEditor({ ...editor, product: { ...editor.product, [c.key]: e.target.value } })} />}</label>)}</div>
        {editError && <p id="pet-product-error" className="note err" role="alert">{editError}</p>}
        <footer className="row"><div className="spacer" /><button type="button" className="btn" disabled={busy} onClick={() => setEditor(null)}>取消</button><button className="btn primary" disabled={busy}>{busy ? '正在保存…' : '保存产品'}</button></footer>
      </form>
    </AppDialog>}
  </div>;
}
