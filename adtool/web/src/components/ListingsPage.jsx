import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  diffAttributes, localeOf, pageYieldOf, priceOf, salePriceOf, setPageYield, setPrice, setSalePrice, setTextValues, textValues,
} from '../listingEdit.js';
import VariationPanel from './VariationPanel.jsx';
import './ListingsPage.css';

const STATUS_LABEL = { BUYABLE: '可购买', DISCOVERABLE: '可搜索到' };
const SEVERITY = { ERROR: { label: '错误', cls: 'red' }, WARNING: { label: '警告', cls: 'amber' }, INFO: { label: '提示', cls: 'gray' } };
const TEXT_LIMITS = { item_name: 200, bullet_point: 500, product_description: 2000, generic_keyword: 249 };
const storeKey = (store) => `${store.brand}|${store.country}`;
const formatTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '');
const money = (price) => (price ? `${price.amount.toFixed(2)} ${price.currency}` : '—');

function pullText(progress) {
  if (!progress) return '正在拉取…';
  if (progress.phase === 'report') return progress.current || '店铺超过 1000 个 SKU，正在等亚马逊生成全店商品报告…';
  if (progress.phase === 'detail') return `正在逐个读取剩下的 SKU ${progress.done}/${progress.total}`;
  if (progress.phase === 'save') return '正在保存…';
  return `正在读取 Listing ${progress.done ?? 0}/${progress.total || '?'}`;
}

export default function ListingsPage() {
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState('');
  const [items, setItems] = useState([]);
  const [fetchedAt, setFetchedAt] = useState(null);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [message, setMessage] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [openSku, setOpenSku] = useState('');
  const [view, setView] = useState('list');
  const abort = useRef(null);

  const store = useMemo(() => {
    const [brand, country] = selected.split('|');
    return brand && country ? { brand, country } : null;
  }, [selected]);

  useEffect(() => {
    api.listingStores().then((data) => {
      setConfig(data);
      if (data.stores.length) setSelected(storeKey(data.stores[0]));
    }).catch((error) => setMessage({ kind: 'err', text: error.message }));
    return () => abort.current?.abort();
  }, []);

  async function loadItems(target = store) {
    if (!target) return;
    const data = await api.listingItems(target);
    setItems(data.items);
    setFetchedAt(data.fetchedAt);
  }

  // 换店铺:读本地缓存,如果这家店正在拉取就接着看进度
  useEffect(() => {
    if (!store) return;
    setItems([]);
    setFetchedAt(null);
    setOpenSku('');
    setMessage(null);
    loadItems(store).catch((error) => setMessage({ kind: 'err', text: error.message }));
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    api.resumeListingPull(store, { signal: controller.signal, onProgress: (p) => { setBusy('pull'); setProgress(p); } })
      .then((result) => { if (result) return finishPull(result, store); })
      .catch((error) => { if (!controller.signal.aborted) setMessage({ kind: 'err', text: error.message }); })
      .finally(() => { if (!controller.signal.aborted) { setBusy(''); setProgress(null); } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function finishPull(result, target) {
    await loadItems(target);
    const warn = result.warningCount ? `，${result.warningCount} 个有问题：${result.warnings.slice(0, 3).join('；')}` : '';
    setMessage({ kind: result.warningCount ? 'warn' : 'ok', text: `拉取完成，共 ${result.count} 个 SKU${warn}` });
  }

  async function pull() {
    if (!store) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy('pull');
    setMessage(null);
    try {
      const result = await api.pullListings(store, { signal: controller.signal, onProgress: setProgress });
      await finishPull(result, store);
    } catch (error) {
      if (!controller.signal.aborted) setMessage({ kind: 'err', text: error.message });
    } finally {
      if (!controller.signal.aborted) { setBusy(''); setProgress(null); }
    }
  }

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === 'issues' && !item.issues.error && !item.issues.warning) return false;
      if (filter === 'notBuyable' && item.status.includes('BUYABLE')) return false;
      if (filter === 'fbm' && item.channel !== 'FBM') return false;
      if (filter === 'fba' && item.channel !== 'FBA') return false;
      if (!needle) return true;
      return [item.sku, item.asin, item.itemName, item.parent].some((value) => String(value ?? '').toLowerCase().includes(needle));
    });
  }, [items, query, filter]);

  if (!config) {
    return <div className="listings-page animate-in">{message && <div className={`note ${message.kind}`}>{message.text}</div>}</div>;
  }

  return (
    <div className="listings-page animate-in">
      <div className="page-head">
        <h1>Listing 管理 <span className="tag amber">内测</span></h1>
        <p className="hint">
          只有超级管理员能看到。{config.liveSubmit
            ? '「校验」不会改线上；「提交到亚马逊」会先自动校验，没有错误才改线上 Listing。'
            : '服务器关闭了正式提交，现在只能校验，不会改线上 Listing。'}
        </p>
      </div>

      {config.configIssues?.length > 0 && (
        <div className="note warn">{config.configIssues.join('；')}</div>
      )}

      <div className="card listings-bar">
        <label className="field">
          <span>品牌 - 站点</span>
          <select className="inp" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!config.stores.length}>
            {config.stores.map((row) => (
              <option key={storeKey(row)} value={storeKey(row)}>{row.brand} - {row.country}</option>
            ))}
          </select>
        </label>
        <button className="btn primary" onClick={pull} disabled={!store || busy === 'pull'}>
          {busy === 'pull' ? '拉取中…' : '从亚马逊拉取全部 SKU'}
        </button>
        <span className="stat">
          {busy === 'pull' ? pullText(progress) : fetchedAt ? <>本地 <b>{items.length}</b> 个 SKU，{formatTime(fetchedAt)} 拉取</> : '这个站点还没拉取过'}
        </span>
      </div>

      {!config.stores.length && <div className="note warn">还没有配置好的亚马逊授权，先在服务器 .env 填好品牌的 SP-API 凭证。</div>}
      {message && <div className={`note ${message.kind}`}>{message.text}</div>}

      {items.length > 0 && (
        <div className="chips">
          {[['list', '商品列表'], ['variation', '变体合并（借评）']].map(([id, label]) => (
            <button key={id} className={`chip${view === id ? ' on' : ''}`} onClick={() => setView(id)}>{label}</button>
          ))}
        </div>
      )}

      {items.length > 0 && view === 'variation' && store && (
        <VariationPanel key={selected} store={store} items={items} liveSubmit={config.liveSubmit} onChanged={() => loadItems().catch(() => {})} />
      )}

      {items.length > 0 && view === 'list' && (
        <div className="card">
          <div className="row wrap listings-filters">
            <input className="inp" placeholder="搜 SKU / ASIN / 标题 / 父 SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="chips">
              {[['all', '全部'], ['issues', '有问题'], ['notBuyable', '不可购买'], ['fbm', '自发货'], ['fba', 'FBA']].map(([id, label]) => (
                <button key={id} className={`chip${filter === id ? ' on' : ''}`} onClick={() => setFilter(id)}>{label}</button>
              ))}
            </div>
            <span className="stat">显示 <b>{shown.length}</b> / {items.length}</span>
          </div>
          <div className="scroll listings-table">
            <table className="tbl">
              <thead>
                <tr>
                  <th />
                  <th>SKU</th>
                  <th>ASIN</th>
                  <th>标题</th>
                  <th>价格</th>
                  <th>配送 / 库存</th>
                  <th>状态</th>
                  <th>问题</th>
                  <th>最后修改</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => (
                  <tr key={item.sku} className={openSku === item.sku ? 'on' : ''} onClick={() => setOpenSku(item.sku)}>
                    <td>{item.image ? <img className="listings-thumb" src={item.image} alt="" loading="lazy" /> : <span className="listings-thumb blank" />}</td>
                    <td className="mono">{item.sku}{item.parent && <div className="hint">父：{item.parent}</div>}{item.childCount > 0 && <div className="hint">父体，{item.childCount} 个子体</div>}</td>
                    <td className="mono">{item.asin ?? '—'}</td>
                    <td><div className="listings-title" title={item.itemName ?? ''}>{item.itemName ?? '—'}</div></td>
                    <td className="mono">{money(item.price)}</td>
                    <td>{item.channel ?? '—'}{item.quantity !== null && <> · {item.quantity}</>}</td>
                    <td>
                      {item.status.length
                        ? item.status.map((s) => <span key={s} className="tag green">{STATUS_LABEL[s] ?? s}</span>)
                        : <span className="tag gray">不可售</span>}
                    </td>
                    <td>
                      {item.issues.error > 0 && <span className="tag red">{item.issues.error} 错误</span>}
                      {item.issues.warning > 0 && <span className="tag amber">{item.issues.warning} 警告</span>}
                    </td>
                    <td className="hint">{item.lastUpdatedDate ? item.lastUpdatedDate.slice(0, 10) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openSku && store && (
        <ListingEditor
          key={`${selected}:${openSku}`}
          store={store}
          sku={openSku}
          liveSubmit={config.liveSubmit}
          onClose={() => setOpenSku('')}
          onRefreshed={() => loadItems().catch(() => {})}
        />
      )}
    </div>
  );
}

function ListingEditor({ store, sku, liveSubmit, onClose, onRefreshed }) {
  const [data, setData] = useState(null);
  const [edited, setEdited] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [result, setResult] = useState(null);
  // 价格输入框自己留一份文字,输到「17.」这种半截数字时不被改写
  const [priceDraft, setPriceDraft] = useState(null);
  const [saleDraft, setSaleDraft] = useState(null);

  async function load(refresh = false) {
    setBusy(refresh ? 'refresh' : 'load');
    setMessage(null);
    try {
      const next = await api.listingItem(store, sku, refresh);
      setData(next);
      setEdited(next.item.attributes ?? {});
      setPriceDraft(null);
      setSaleDraft(null);
      setResult(null);
      if (refresh) onRefreshed();
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  useEffect(() => {
    load(false);
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const original = useMemo(() => data?.item.attributes ?? {}, [data]);
  const changes = useMemo(() => (edited ? diffAttributes(original, edited) : {}), [original, edited]);
  const changedKeys = Object.keys(changes);
  const locale = useMemo(() => localeOf(original, { marketplaceId: data?.marketplaceId, country: store.country }), [original, data, store.country]);

  async function submit(live) {
    if (live && !window.confirm(`确定把 ${changedKeys.length} 项改动提交到亚马逊？会先自动校验，没有错误就直接修改 ${store.brand}-${store.country} 的线上 Listing（${sku}）。`)) return;
    setBusy(live ? 'live' : 'preview');
    setMessage(null);
    try {
      const res = await api.submitListing({ ...store, sku, changes, live });
      if (res.mode === 'live' && res.status === 'ACCEPTED') {
        // 服务器已把改动写进本地缓存,重新读一次,改过的值变成新的原值
        const next = await api.listingItem(store, sku);
        setData(next);
        setEdited(next.item.attributes ?? {});
        setPriceDraft(null);
        setSaleDraft(null);
        onRefreshed();
      }
      setResult(res);
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  const summary = data?.item.summaries?.[0] ?? {};
  const issues = data?.item.issues ?? [];
  const price = edited ? priceOf(edited) : { value: '', currency: '' };
  const sale = edited ? salePriceOf(edited) : { value: '', start: '', end: '' };
  const saleValue = saleDraft ?? sale.value;
  const updateSale = (patch) => {
    const next = { ...sale, value: saleValue, ...patch };
    // 促销价没填完整(空或半截数字)时先不写进属性
    if (next.value.trim() !== '' && !(Number(next.value) > 0)) return;
    setEdited((current) => setSalePrice(current, next, { locale, currency: price.currency }));
  };
  const bullets = edited ? textValues(edited, 'bullet_point') : [];
  const textField = (key, label, { rows = 2 } = {}) => {
    const value = textValues(edited, key).join(key === 'generic_keyword' ? ' ' : '\n');
    return (
      <label className={`field${changes[key] !== undefined ? ' changed' : ''}`}>
        <span>{label} <em className="hint">{value.length}{TEXT_LIMITS[key] ? ` / ${TEXT_LIMITS[key]}` : ''}</em></span>
        <textarea
          className="inp" rows={rows} value={value}
          onChange={(e) => setEdited((current) => setTextValues(current, key, [e.target.value], locale))}
        />
      </label>
    );
  };

  return (
    <div className="listings-drawer-mask" onClick={onClose}>
      <aside className="listings-drawer animate-in" onClick={(e) => e.stopPropagation()}>
        <header className="listings-drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="mono">{sku}</div>
            <div className="hint">
              {summary.asin ?? ''}{summary.productType ? ` · ${summary.productType}` : ''}
              {data?.row?.fetchedAt ? ` · ${formatTime(data.row.fetchedAt)} 拉取` : ''}
            </div>
          </div>
          <div className="spacer" />
          {summary.asin && (
            <a className="btn sm ghost" href={`https://www.amazon.${{ UK: 'co.uk', US: 'com', CA: 'ca', AU: 'com.au', AE: 'ae', BE: 'com.be' }[store.country] ?? store.country.toLowerCase()}/dp/${summary.asin}`} target="_blank" rel="noreferrer">前台</a>
          )}
          <button className="btn sm" onClick={() => load(true)} disabled={!!busy}>{busy === 'refresh' ? '刷新中…' : '从亚马逊刷新'}</button>
          <button className="btn sm ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {message && <div className={`note ${message.kind}`}>{message.text}</div>}
        {!edited ? <div className="empty">{busy ? '读取中…' : ''}</div> : (
          <div className="listings-drawer-body stack">
            {issues.length > 0 && (
              <section className="stack">
                <h3>亚马逊提示的问题</h3>
                {issues.map((issue, index) => (
                  <div key={index} className="listings-issue">
                    <span className={`tag ${SEVERITY[issue.severity]?.cls ?? 'gray'}`}>{SEVERITY[issue.severity]?.label ?? issue.severity}</span>
                    <span>{issue.message}</span>
                    {issue.attributeNames?.length > 0 && <span className="hint mono">{issue.attributeNames.join(', ')}</span>}
                  </div>
                ))}
              </section>
            )}

            <section className="stack">
              <h3>文案</h3>
              {textField('item_name', '标题', { rows: 2 })}
              <div className={`field${changes.bullet_point !== undefined ? ' changed' : ''}`}>
                <span>五点描述</span>
                {[...bullets, ...Array(Math.max(5, bullets.length + 1) - bullets.length).fill('')].map((text, index) => (
                  <textarea
                    key={index} className="inp" rows={2} value={text}
                    placeholder={`第 ${index + 1} 点`}
                    onChange={(e) => {
                      const next = [...bullets];
                      next[index] = e.target.value;
                      setEdited((current) => setTextValues(current, 'bullet_point', next, locale));
                    }}
                  />
                ))}
              </div>
              {textField('product_description', '商品描述', { rows: 5 })}
              {textField('generic_keyword', '后台搜索词', { rows: 2 })}
            </section>

            <section className="stack">
              <h3>价格</h3>
              <div className="listings-grid">
                <label className="field">
                  <span>您的价格（{price.currency || '站点货币'}）</span>
                  <input
                    className="inp" type="number" step="0.01" min="0" value={priceDraft ?? price.value}
                    onChange={(e) => {
                      const text = e.target.value;
                      setPriceDraft(text);
                      if (Number(text) > 0) setEdited((current) => setPrice(current, text, { locale, currency: price.currency }));
                    }}
                  />
                </label>
                <label className="field">
                  <span title="清空就是取消促销">销售价格（促销价）</span>
                  <input
                    className="inp" type="number" step="0.01" min="0" value={saleValue}
                    onChange={(e) => { setSaleDraft(e.target.value); updateSale({ value: e.target.value }); }}
                  />
                </label>
                <label className="field">
                  <span>销售开始日期</span>
                  <input className="inp" type="date" value={sale.start} disabled={!saleValue} onChange={(e) => updateSale({ start: e.target.value })} />
                </label>
                <label className="field">
                  <span>销售截止日期</span>
                  <input className="inp" type="date" value={sale.end} disabled={!saleValue} onChange={(e) => updateSale({ end: e.target.value })} />
                </label>
              </div>
              {changes.purchasable_offer !== undefined && saleValue && (!sale.start || !sale.end) && (
                <div className="note warn">促销价要同时填开始和截止日期，亚马逊才会接受。</div>
              )}
            </section>

            <section className="stack">
              <h3>规格</h3>
              <div className="listings-grid">
                <label className={`field${changes.page_yield !== undefined ? ' changed' : ''}`}>
                  <span>打印页数（page_yield）</span>
                  <input
                    className="inp" type="number" min="0" step="1" value={pageYieldOf(edited)}
                    onChange={(e) => setEdited((current) => setPageYield(current, e.target.value, locale))}
                  />
                </label>
              </div>
            </section>
          </div>
        )}

        <footer className="listings-drawer-foot">
          {result && (
            <div className={`note ${result.status === 'INVALID' || result.blocked ? 'err' : 'ok'}`}>
              {result.blocked
                ? '校验没通过，没有提交到亚马逊，改完下面的问题再提交'
                : result.mode === 'preview'
                ? (result.status === 'VALID' ? '校验通过（没有改线上 Listing）' : `校验结果：${result.status}`)
                : (result.status === 'ACCEPTED' ? '亚马逊已接收，一般几分钟到几小时生效，之后点「从亚马逊刷新」确认' : `提交结果：${result.status}`)}
              {result.issues.map((issue, index) => (
                <div key={index}>· [{SEVERITY[issue.severity]?.label ?? issue.severity}] {issue.message}{issue.attributeNames?.length ? `（${issue.attributeNames.join(', ')}）` : ''}</div>
              ))}
            </div>
          )}
          <div className="row">
            <span className="stat">改了 <b>{changedKeys.length}</b> 项{changedKeys.length ? `：${changedKeys.join('、')}` : ''}</span>
            <div className="spacer" />
            <button className="btn" disabled={!changedKeys.length || !!busy} onClick={() => { setEdited(original); setPriceDraft(null); setSaleDraft(null); }}>撤销改动</button>
            <button className="btn" disabled={!changedKeys.length || !!busy} onClick={() => submit(false)}>{busy === 'preview' ? '校验中…' : '校验（不改线上）'}</button>
            <button
              className="btn primary" disabled={!liveSubmit || !changedKeys.length || !!busy} onClick={() => submit(true)}
              title={liveSubmit ? '先自动校验，没有错误才改线上' : '服务器关闭了正式提交'}
            >{busy === 'live' ? '提交中…' : '提交到亚马逊'}</button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
