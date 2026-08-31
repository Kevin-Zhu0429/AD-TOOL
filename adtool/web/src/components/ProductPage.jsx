import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import {
  COLOR_GROUPS, EDIT_FIELDS, NUMERIC_FIELDS, PRODUCT_COLUMNS, PRODUCT_LABELS,
  average, cleanProduct, fmt, headerField, median, modelKey, money,
  opportunities, priceGrade, priceStats, productNumber,
} from '../productLogic.js';
import './ProductPage.css';

const GRID_FIELDS = [
  'asin', 'brand', 'model', 'color_grp', 'title', 'price', 'rating', 'reviews',
  'reviews_new', 'bsr_small', 'sales', 'child_sales', 'days', 'sellers', 'ship', 'aplus',
];

const DETAIL_GROUPS = [
  ['价格与利润', ['price', 'prime_price', 'coupon', 'fba_fee', 'margin']],
  ['评价', ['rating', 'reviews', 'reviews_new', 'review_rate', 'qa']],
  ['销量与排名', ['sales', 'revenue', 'child_sales', 'child_revenue', 'bsr_big', 'bsr_small', 'cat_small', 'variants']],
  ['上架与配送', ['listed', 'days', 'ship', 'sellers', 'buybox', 'seller_country']],
  ['页面建设', ['lqs', 'aplus', 'video', 'sp_ad', 'brand_story', 'best_seller', 'ac', 'ac_kw']],
  ['规格', ['yield', 'weight', 'size', 'parent', 'sku']],
];

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false });
  let rows = [];
  for (const name of workbook.SheetNames) {
    if (['brands', 'sellers', 'note'].includes(name.trim().toLowerCase())) continue;
    const candidate = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: '' });
    if (candidate.some((row) => row.some((cell) => headerField(cell) === 'asin'))) {
      rows = candidate;
      break;
    }
  }
  if (!rows.length) throw new Error('表格里找不到 ASIN 表头，请使用卖家精灵导出的产品表');
  const headerIndex = rows.findIndex((row) => row.some((cell) => headerField(cell) === 'asin'));
  const positions = {};
  rows[headerIndex].forEach((cell, index) => {
    const field = headerField(cell);
    if (field && positions[field] === undefined) positions[field] = index;
  });
  const products = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const raw = {};
    for (const [, field] of PRODUCT_COLUMNS) raw[field] = positions[field] === undefined ? '' : row[positions[field]];
    if (!String(raw.asin ?? '').trim()) continue;
    products.push(cleanProduct(raw));
  }
  if (!products.length) throw new Error('没有读到有效产品；每行都需要有 ASIN');
  return products;
}

function guessOwnBrand(products) {
  const counts = new Map();
  products.forEach((item) => item.brand && counts.set(item.brand, (counts.get(item.brand) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function productUrl(product, market) {
  if (product?.url) return product.url;
  const domains = { UK: 'co.uk', US: 'com', CA: 'ca', ES: 'es', DE: 'de', FR: 'fr', IT: 'it' };
  return product?.asin ? `https://www.amazon.${domains[market] ?? 'com'}/dp/${product.asin}` : '';
}

function GradeBadge({ grade, large = false }) {
  return <span className={`price-grade grade-${grade.key}${large ? ' large' : ''}`}>{grade.key}</span>;
}

function EmptyState({ onImport }) {
  return (
    <div className="product-empty">
      <span className="product-empty-icon"><Icon name="box" size={25} /></span>
      <h2>这个站点还没有产品数据</h2>
      <p>导入卖家精灵导出的 xlsx / csv 后，系统会自动识别品牌、型号和色组。</p>
      <button className="btn primary" onClick={onImport}><Icon name="upload" />导入产品表</button>
    </div>
  );
}

function DetailPanel({ product, products, ownBrand, market, minSales, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditing(false);
    setForm(Object.fromEntries(EDIT_FIELDS.map((field) => [field, product?.[field] ?? ''])));
  }, [product]);

  if (!product) return <div className="detail-placeholder">选择一条产品查看完整信息</div>;
  const peers = products.filter((item) => modelKey(item.model) === modelKey(product.model) && item.color_grp === product.color_grp);
  const stats = priceStats(peers);
  const grade = priceGrade(product.price, stats);
  const opps = opportunities(peers, product, minSales);
  const isOwn = ownBrand && product.brand.toLowerCase() === ownBrand.toLowerCase();

  async function save() {
    setSaving(true);
    try {
      const changes = {};
      for (const field of EDIT_FIELDS) {
        const value = NUMERIC_FIELDS.has(field) ? productNumber(form[field]) : String(form[field] ?? '').trim();
        if (value !== (product[field] ?? '')) changes[field] = value;
      }
      if (Object.keys(changes).length) await onSaved(product.asin, changes);
      setEditing(false);
    } finally { setSaving(false); }
  }

  return (
    <aside className="product-detail">
      <div className="detail-cover">
        {product.image ? <img src={product.image} alt="商品主图" /> : <span><Icon name="box" size={28} /></span>}
      </div>
      <div className="detail-heading">
        <div className="row wrap">
          <span className="mono detail-asin">{product.asin}</span>
          {isOwn && <span className="tag green">自家</span>}
          <span className="tag gray">{product.model || '型号未识别'}</span>
          <span className="tag gray">{product.color_grp}</span>
        </div>
        <h2>{product.title || '无商品标题'}</h2>
      </div>
      <div className="detail-actions">
        <a className="btn" href={productUrl(product, market)} target="_blank" rel="noreferrer"><Icon name="external" />商品页</a>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(product.asin)}><Icon name="copy" />复制 ASIN</button>
        <button className="btn" onClick={() => setEditing((value) => !value)}><Icon name="edit" />{editing ? '取消编辑' : '编辑'}</button>
      </div>

      <div className="detail-competition">
        <div><GradeBadge grade={grade} large /><span><b>{grade.label}</b><small>{grade.note}</small></span></div>
        <p>{product.model || '未识别型号'} · {product.color_grp} 共 {peers.length} 条，市场均价 {money(stats?.average)}，机会竞品 {opps.length} 个。</p>
      </div>

      {editing ? (
        <div className="detail-edit">
          {EDIT_FIELDS.map((field) => (
            <label className={`field${field === 'title' ? ' full' : ''}`} key={field}>
              <span>{PRODUCT_LABELS[field]}</span>
              {field === 'color_grp' ? (
                <select className="inp" value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })}>
                  {COLOR_GROUPS.map((value) => <option key={value}>{value}</option>)}
                </select>
              ) : (
                <input className="inp" value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
              )}
            </label>
          ))}
          <button className="btn primary detail-save" disabled={saving} onClick={save}>{saving ? '保存中…' : '保存这条'}</button>
        </div>
      ) : (
        <div className="detail-groups">
          {DETAIL_GROUPS.map(([name, fields]) => (
            <section key={name}>
              <h3>{name}</h3>
              <dl>
                {fields.filter((field) => product[field] !== '' && product[field] !== null && product[field] !== undefined).map((field) => (
                  <div key={field}><dt>{PRODUCT_LABELS[field]}</dt><dd>{String(product[field])}</dd></div>
                ))}
              </dl>
            </section>
          ))}
          {product.bullets && <section><h3>产品卖点</h3><p>{product.bullets}</p></section>}
          {product.params && <section><h3>详细参数</h3><p>{product.params}</p></section>}
        </div>
      )}
    </aside>
  );
}

function CompareView({ products, settings, market, initialAsin }) {
  const mineChoices = useMemo(() => {
    const own = products.filter((item) => settings.own_brand && item.brand.toLowerCase() === settings.own_brand.toLowerCase());
    return (own.length ? own : products).slice().sort((a, b) => `${a.model}${a.color_grp}`.localeCompare(`${b.model}${b.color_grp}`));
  }, [products, settings.own_brand]);
  const [targetAsin, setTargetAsin] = useState(initialAsin ?? mineChoices[0]?.asin ?? '');
  const [scope, setScope] = useState('model-color');
  const [brandedOnly, setBrandedOnly] = useState(false);

  useEffect(() => {
    if (initialAsin && products.some((item) => item.asin === initialAsin)) setTargetAsin(initialAsin);
    else if (!products.some((item) => item.asin === targetAsin)) setTargetAsin(mineChoices[0]?.asin ?? '');
  }, [initialAsin, mineChoices, products, targetAsin]);

  const mine = products.find((item) => item.asin === targetAsin) ?? mineChoices[0];
  const rows = useMemo(() => {
    if (!mine) return [];
    const key = modelKey(mine.model);
    let result = products;
    if (scope === 'model-color') result = products.filter((item) => modelKey(item.model) === key && item.color_grp === mine.color_grp);
    if (scope === 'model-all') result = products.filter((item) => modelKey(item.model) === key);
    if (scope === 'color-all') result = products.filter((item) => item.color_grp === mine.color_grp);
    if (brandedOnly) result = result.filter((item) => item.brand || item.asin === mine.asin);
    return result.slice().sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  }, [products, mine, scope, brandedOnly]);
  const stats = priceStats(rows);
  const mineGrade = priceGrade(mine?.price, stats);
  const opps = opportunities(rows, mine, settings.min_sales);
  const maxPrice = Math.max(...rows.map((item) => typeof item.price === 'number' ? item.price : 0), 1);
  const minBar = (stats?.min ?? 0) * 0.8;
  const span = Math.max(maxPrice - minBar, 1);

  if (!mine) return null;
  return (
    <div className="compare-view">
      <div className="compare-controls card">
        <label className="field compare-mine"><span>我的产品</span>
          <select className="inp" value={mine.asin} onChange={(e) => setTargetAsin(e.target.value)}>
            {mineChoices.map((item) => <option key={item.asin} value={item.asin}>{item.model || '?'} · {item.color_grp} · {money(item.price)} · {item.asin}</option>)}
          </select>
        </label>
        <label className="field"><span>对比范围</span>
          <select className="inp" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="model-color">同型号 · 当前色组</option>
            <option value="model-all">同型号 · 全部色组</option>
            <option value="color-all">同色组 · 全部型号</option>
            <option value="all">全产品库</option>
          </select>
        </label>
        <label className="compare-check"><input type="checkbox" checked={brandedOnly} onChange={(e) => setBrandedOnly(e.target.checked)} />仅显示有品牌名的 ASIN</label>
      </div>

      <div className="compare-summary">
        <div className="compare-main-grade card"><GradeBadge grade={mineGrade} large /><div><span>我的价格档位</span><b>{mineGrade.label}</b><small>{mineGrade.note}</small></div></div>
        <div className="metric card"><span>我的价格</span><b>{money(mine.price)}</b><small>{mine.brand} · {mine.model} · {mine.color_grp}</small></div>
        <div className="metric card"><span>B 档基准</span><b>{money(stats?.average)}</b><small>当前范围市场平均价</small></div>
        <div className="metric card"><span>D 档基准</span><b>{money(stats?.min)}</b><small>当前范围市场最低价</small></div>
        <div className="metric card"><span>机会竞品</span><b>{opps.length}</b><small>评分更低、价格更高、销量达标</small></div>
      </div>

      <section className="tier-explain card">
        {[
          ['A', '高于市场均价', '价格高于 B 档均价带'],
          ['B', '市场平均价', '以当前筛选范围均价 ±5% 为均价带'],
          ['C', '低于市场均价', '低于均价但还不是最低价'],
          ['D', '市场最低价', '价格优势最明显'],
        ].map(([key, title, desc]) => <div key={key}><GradeBadge grade={{ key }} /><span><b>{title}</b><small>{desc}</small></span></div>)}
      </section>

      <section className="price-ladder card">
        <div className="section-heading"><div><h2>价格阶梯</h2><p>{market} 站 · {scope === 'model-all' ? `${mine.model} 全部色组` : scope === 'model-color' ? `${mine.model} · ${mine.color_grp}` : '当前筛选范围'} · {rows.length} 条</p></div><span className="hint">条形起点为最低价的 80%，便于观察细微差距</span></div>
        <div className="ladder-head"><span>产品</span><span>评分</span><span>评价数</span><span>子体销量</span><span>价格 / 档位</span></div>
        <div className="ladder-rows">
          {rows.map((item) => {
            const grade = priceGrade(item.price, stats);
            const width = typeof item.price === 'number' ? Math.max(3, ((item.price - minBar) / span) * 100) : 0;
            const isMine = item.asin === mine.asin;
            const isOpp = opps.some((opp) => opp.asin === item.asin);
            return (
              <a className={`ladder-row${isMine ? ' mine' : ''}${isOpp ? ' opportunity' : ''}`} key={item.asin} href={productUrl(item, market)} target="_blank" rel="noreferrer">
                <span className="ladder-product">{isMine && <b>★</b>}<span><strong>{item.brand || '无品牌'}</strong><small>{item.model} · {item.color_grp} · {item.asin}</small></span></span>
                <span>{typeof item.rating === 'number' ? `${fmt(item.rating, 1)} ★` : '—'}</span>
                <span>{fmt(item.reviews)}</span><span>{fmt(item.child_sales)}</span>
                <span className="bar-cell"><i style={{ width: `${width}%` }} /><em>{money(item.price)}</em><GradeBadge grade={grade} /></span>
              </a>
            );
          })}
        </div>
      </section>

      <section className="opportunity-section card">
        <div className="section-heading"><div><h2>机会竞品</h2><p>评分比我低 + 价格比我高 + 子体销量 &gt; {settings.min_sales}</p></div><span className="tag amber">{opps.length} 个目标</span></div>
        <div className="scroll">
          <table className="tbl"><thead><tr><th>ASIN</th><th>品牌</th><th>型号</th><th>色组</th><th>价格</th><th>比我贵</th><th>评分</th><th>评分数</th><th>子体销量</th><th>标题</th></tr></thead>
            <tbody>{opps.map((item) => <tr key={item.asin}><td><a href={productUrl(item, market)} target="_blank" rel="noreferrer" className="asin-link">{item.asin}</a></td><td>{item.brand || '—'}</td><td>{item.model}</td><td>{item.color_grp}</td><td>{money(item.price)}</td><td className="positive">+{money(item.price - mine.price)}</td><td>{fmt(item.rating, 1)}</td><td>{fmt(item.reviews)}</td><td>{fmt(item.child_sales)}</td><td className="title-cell">{item.title}</td></tr>)}</tbody>
          </table>
          {!opps.length && <div className="empty">当前范围没有符合条件的机会竞品</div>}
        </div>
      </section>
    </div>
  );
}

export default function ProductPage({ market }) {
  const [products, setProducts] = useState([]);
  const [settings, setSettings] = useState({ own_brand: '', min_sales: 100 });
  const [tab, setTab] = useState('library');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState(null);
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [group, setGroup] = useState('');
  const [ownerView, setOwnerView] = useState('all');
  const [brandedOnly, setBrandedOnly] = useState(false);
  const [sort, setSort] = useState(['', false]);
  const [selected, setSelected] = useState(new Set());
  const [compareAsin, setCompareAsin] = useState('');
  const [bulkGroup, setBulkGroup] = useState('黑彩');
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.products(market);
      setProducts(data.products);
      setSettings(data.settings);
      setSelected(new Set());
    } catch (error) { setMessage({ kind: 'err', text: error.message }); }
    finally { setLoading(false); }
  }, [market]);
  useEffect(() => { load(); }, [load]);

  const brands = useMemo(() => [...new Set(products.map((item) => item.brand).filter(Boolean))].sort(), [products]);
  const models = useMemo(() => [...new Set(products.map((item) => item.model).filter(Boolean))].sort(), [products]);
  const filtered = useMemo(() => {
    const own = settings.own_brand.toLowerCase();
    let rows = products.filter((item) => {
      if (brand && item.brand !== brand) return false;
      if (model && item.model !== model) return false;
      if (group && item.color_grp !== group) return false;
      if (brandedOnly && !item.brand) return false;
      const isOwn = own && item.brand.toLowerCase() === own;
      if (ownerView === 'own' && !isOwn) return false;
      if (ownerView === 'rival' && isOwn) return false;
      if (search && !['asin', 'sku', 'brand', 'model', 'color', 'title', 'buybox'].some((field) => String(item[field] ?? '').toLowerCase().includes(search.toLowerCase()))) return false;
      return true;
    });
    if (sort[0]) rows = rows.slice().sort((a, b) => {
      const av = a[sort[0]] ?? ''; const bv = b[sort[0]] ?? '';
      const result = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort[1] ? -result : result;
    });
    return rows;
  }, [products, brand, model, group, brandedOnly, ownerView, search, settings.own_brand, sort]);

  const selectedProduct = products.find((item) => selected.has(item.asin));
  const filteredStats = priceStats(filtered);

  async function importFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setMessage({ kind: 'info', text: `正在读取 ${file.name}…` });
    try {
      const parsed = parseWorkbook(await file.arrayBuffer());
      const result = await api.importProducts(market, parsed);
      if (!settings.own_brand) {
        const guessed = guessOwnBrand(parsed);
        if (guessed) {
          const saved = await api.productSettings(market, guessed, settings.min_sales);
          setSettings(saved.settings);
        }
      }
      await load();
      setMessage({ kind: 'ok', text: `导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}` });
    } catch (error) { setMessage({ kind: 'err', text: error.message }); }
  }

  async function saveSettings(next) {
    setSettings(next);
    try {
      const data = await api.productSettings(market, next.own_brand, next.min_sales);
      setSettings(data.settings);
    } catch (error) { setMessage({ kind: 'err', text: error.message }); }
  }

  async function updateProduct(asin, changes) {
    const data = await api.updateProduct(market, asin, changes);
    setProducts((items) => items.map((item) => item.asin === asin ? data.product : item));
    setMessage({ kind: 'ok', text: `${asin} 已保存；手工修改的品牌和色组再次导入时会保留` });
  }

  async function applyGroup() {
    if (!selected.size) return;
    const count = selected.size;
    await Promise.all([...selected].map((asin) => api.updateProduct(market, asin, { color_grp: bulkGroup })));
    await load();
    setMessage({ kind: 'ok', text: `已将 ${count} 条产品改为「${bulkGroup}」` });
  }

  async function removeSelected() {
    if (!selected.size || !confirm(`确定删除选中的 ${selected.size} 条产品吗？`)) return;
    const result = await api.deleteProducts(market, [...selected]);
    await load();
    setMessage({ kind: 'ok', text: `已删除 ${result.deleted} 条产品` });
  }

  function exportRows() {
    const rows = filtered.map((item) => Object.fromEntries(PRODUCT_COLUMNS.map(([label, field]) => [label, item[field] ?? ''])));
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '产品库');
    XLSX.writeFile(workbook, `${market}站产品库.xlsx`);
  }

  function changeSort(field) {
    setSort(([current, reverse]) => [field, current === field ? !reverse : false]);
  }

  function openCompare(asin) {
    setCompareAsin(asin);
    setTab('compare');
  }

  const ownCount = filtered.filter((item) => settings.own_brand && item.brand.toLowerCase() === settings.own_brand.toLowerCase()).length;
  return (
    <div className="products-page animate-in">
      <div className="products-head">
        <div><h1>产品情报</h1><p className="hint">{market} 站产品库 · 数据与其他市场完全隔离</p></div>
        <div className="products-tabs">
          <button className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}><Icon name="box" />产品库 <span>{products.length}</span></button>
          <button className={tab === 'compare' ? 'on' : ''} onClick={() => setTab('compare')} disabled={!products.length}><Icon name="chart" />竞品对比</button>
        </div>
        <button className="btn primary" onClick={() => inputRef.current?.click()}><Icon name="upload" />导入产品表</button>
        <input ref={inputRef} type="file" accept=".xlsx,.xlsm,.csv" hidden onChange={importFile} />
      </div>

      {message && <div className={`note ${message.kind} product-note`}>{message.text}<button onClick={() => setMessage(null)}>×</button></div>}
      {loading ? <div className="product-loading">正在加载 {market} 站产品库…</div> : !products.length ? <EmptyState onImport={() => inputRef.current?.click()} /> : tab === 'compare' ? (
        <CompareView products={products} settings={settings} market={market} initialAsin={compareAsin} />
      ) : (
        <>
          <section className="product-toolbar card">
            <div className="filter-grid">
              <label className="field search-field"><span>搜索</span><div className="input-icon"><Icon name="search" /><input className="inp" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ASIN / 标题 / 品牌 / 型号" /></div></label>
              <label className="field"><span>品牌</span><select className="inp" value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">全部品牌</option>{brands.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>型号</span><select className="inp" value={model} onChange={(e) => setModel(e.target.value)}><option value="">全部型号</option>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>色组</span><select className="inp" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">全部色组</option>{COLOR_GROUPS.map((value) => <option key={value}>{value}</option>)}</select></label>
              <label className="field"><span>自家品牌</span><input className="inp" value={settings.own_brand} onChange={(e) => setSettings({ ...settings, own_brand: e.target.value })} onBlur={() => saveSettings(settings)} placeholder="例如 CYES" /></label>
              <label className="field min-sales"><span>机会竞品子体销量 &gt;</span><input className="inp" type="number" min="0" value={settings.min_sales} onChange={(e) => setSettings({ ...settings, min_sales: Math.max(0, Number(e.target.value)) })} onBlur={() => saveSettings(settings)} /></label>
            </div>
            <div className="filter-actions">
              <div className="segmented"><button className={ownerView === 'all' ? 'on' : ''} onClick={() => setOwnerView('all')}>全部</button><button className={ownerView === 'own' ? 'on' : ''} onClick={() => setOwnerView('own')}>只看自家</button><button className={ownerView === 'rival' ? 'on' : ''} onClick={() => setOwnerView('rival')}>只看竞品</button></div>
              <label className="inline-check"><input type="checkbox" checked={brandedOnly} onChange={(e) => setBrandedOnly(e.target.checked)} />仅有品牌名</label>
              <span className="toolbar-divider" />
              <select className="inp bulk-select" value={bulkGroup} onChange={(e) => setBulkGroup(e.target.value)}>{COLOR_GROUPS.map((value) => <option key={value}>{value}</option>)}</select>
              <button className="btn" disabled={!selected.size} onClick={applyGroup}>批量改色组</button>
              <button className="btn" onClick={exportRows}><Icon name="download" />导出结果</button>
              <button className="btn danger" disabled={!selected.size} onClick={removeSelected}><Icon name="trash" />删除</button>
            </div>
          </section>

          <section className="library-summary">
            <div><span>筛选结果</span><b>{filtered.length}</b><small>产品库共 {products.length} 条</small></div>
            <div><span>均价</span><b>{money(filteredStats?.average)}</b><small>中位 {money(median(filtered.map((item) => item.price)))}</small></div>
            <div><span>平均评分</span><b>{fmt(average(filtered.map((item) => item.rating)), 2)}</b><small>评价数中位 {fmt(median(filtered.map((item) => item.reviews)))}</small></div>
            <div><span>自家 / 竞品</span><b>{ownCount} / {filtered.length - ownCount}</b><small>{settings.own_brand || '请先填写自家品牌'}</small></div>
          </section>

          <div className="product-workspace">
            <section className="product-table-card card">
              <div className="table-caption"><span>按表头排序 · 勾选可批量操作 · 点击行查看详情</span>{selected.size > 0 && <b>已选 {selected.size} 条</b>}</div>
              <div className="scroll product-table-scroll"><table className="tbl product-table"><thead><tr><th className="check-col"></th>{GRID_FIELDS.map((field) => <th key={field} onClick={() => changeSort(field)} className="sortable">{PRODUCT_LABELS[field]}{sort[0] === field && (sort[1] ? ' ↓' : ' ↑')}</th>)}</tr></thead>
                <tbody>{filtered.map((item) => {
                  const isOwn = settings.own_brand && item.brand.toLowerCase() === settings.own_brand.toLowerCase();
                  return <tr key={item.asin} className={`${isOwn ? 'own-row ' : ''}${selectedProduct?.asin === item.asin ? 'active-row' : ''}`} onClick={() => setSelected(new Set([item.asin]))} onDoubleClick={() => window.open(productUrl(item, market), '_blank')}><td className="check-col"><input type="checkbox" checked={selected.has(item.asin)} onClick={(e) => e.stopPropagation()} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(item.asin)) next.delete(item.asin); else next.add(item.asin); return next; })} /></td>{GRID_FIELDS.map((field) => <td key={field} className={field === 'title' ? 'title-cell' : ''}>{field === 'price' ? money(item[field]) : field === 'asin' ? <button className="asin-button" onClick={(e) => { e.stopPropagation(); openCompare(item.asin); }}>{item.asin}</button> : typeof item[field] === 'number' ? fmt(item[field]) : item[field] || '—'}</td>)}</tr>;
                })}</tbody></table>{!filtered.length && <div className="empty">没有符合当前筛选条件的产品</div>}</div>
            </section>
            <DetailPanel product={selectedProduct} products={products} ownBrand={settings.own_brand} market={market} minSales={settings.min_sales} onSaved={updateProduct} />
          </div>
        </>
      )}
    </div>
  );
}
