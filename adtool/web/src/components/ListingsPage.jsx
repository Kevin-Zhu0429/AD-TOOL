import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  FORM_KEYS, IMAGE_KEYS, attributePreview, diffAttributes, imageUrl, localeOf, merchantQuantity, priceOf,
  setImageUrl, setMerchantQuantity, setPrice, setTextValues, textValues,
} from '../listingEdit.js';
import './ListingsPage.css';

const STATUS_LABEL = { BUYABLE: '可购买', DISCOVERABLE: '可搜索到' };
const SEVERITY = { ERROR: { label: '错误', cls: 'red' }, WARNING: { label: '警告', cls: 'amber' }, INFO: { label: '提示', cls: 'gray' } };
const IMAGE_LABEL = (key) => (key === 'main_product_image_locator' ? '主图'
  : key === 'swatch_product_image_locator' ? '颜色样图' : `副图 ${key.split('_').pop()}`);
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
            ? '服务器已开启正式提交，「提交到亚马逊」会直接改线上 Listing。'
            : '现在上传只让亚马逊校验，不会改线上 Listing。'}
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
  const [rawKey, setRawKey] = useState('');
  const [rawText, setRawText] = useState('');
  const [newAttr, setNewAttr] = useState('');
  // 价格输入框自己留一份文字,输到「17.」这种半截数字时不被改写
  const [priceDraft, setPriceDraft] = useState(null);

  async function load(refresh = false) {
    setBusy(refresh ? 'refresh' : 'load');
    setMessage(null);
    try {
      const next = await api.listingItem(store, sku, refresh);
      setData(next);
      setEdited(next.item.attributes ?? {});
      setPriceDraft(null);
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
    if (live && !window.confirm(`确定把 ${changedKeys.length} 项改动提交到亚马逊？这会直接修改 ${store.brand}-${store.country} 的线上 Listing（${sku}）。`)) return;
    setBusy(live ? 'live' : 'preview');
    setMessage(null);
    try {
      const res = await api.submitListing({ ...store, sku, changes, live });
      setResult(res);
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  function openRaw(key) {
    setRawKey(key);
    setRawText(JSON.stringify(edited[key] ?? [{ value: '', ...locale }], null, 2));
  }

  function saveRaw() {
    try {
      const value = rawText.trim() ? JSON.parse(rawText) : null;
      if (value !== null && !Array.isArray(value)) throw new Error('要是一个数组');
      setEdited((current) => {
        const next = { ...current };
        if (value === null || !value.length) delete next[rawKey];
        else next[rawKey] = value;
        return next;
      });
      setRawKey('');
    } catch (error) {
      setMessage({ kind: 'err', text: `${rawKey} 的 JSON 不对：${error.message}` });
    }
  }

  const summary = data?.item.summaries?.[0] ?? {};
  const issues = data?.item.issues ?? [];
  const otherKeys = Object.keys(edited ?? {}).filter((key) => !FORM_KEYS.has(key)).sort();
  const price = edited ? priceOf(edited) : { value: '', currency: '' };
  const quantity = edited ? merchantQuantity(edited) : null;
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
            <a className="btn sm ghost" href={`https://www.amazon.${{ UK: 'co.uk', US: 'com', CA: 'ca', AU: 'com.au', AE: 'ae' }[store.country] ?? store.country.toLowerCase()}/dp/${summary.asin}`} target="_blank" rel="noreferrer">前台</a>
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
                {[...bullets, ''].slice(0, Math.max(5, bullets.length + 1)).map((text, index) => (
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
              <h3>价格和库存</h3>
              <div className="row wrap">
                <label className={`field${changes.purchasable_offer !== undefined ? ' changed' : ''}`}>
                  <span>售价（{price.currency || '站点货币'}）</span>
                  <input
                    className="inp" type="number" step="0.01" min="0" value={priceDraft ?? price.value}
                    onChange={(e) => {
                      const text = e.target.value;
                      setPriceDraft(text);
                      if (Number(text) > 0) setEdited((current) => setPrice(current, text, { locale, currency: price.currency }));
                    }}
                  />
                </label>
                <label className={`field${changes.fulfillment_availability !== undefined ? ' changed' : ''}`}>
                  <span>自发货库存</span>
                  {quantity === null
                    ? <input className="inp" disabled value="FBA，由亚马逊仓库决定" readOnly />
                    : <input className="inp" type="number" min="0" step="1" value={quantity}
                        onChange={(e) => setEdited((current) => setMerchantQuantity(current, e.target.value))} />}
                </label>
              </div>
            </section>

            <section className="stack">
              <h3>图片 <span className="hint">填公网能打开的图片地址，亚马逊会自己去下载</span></h3>
              <div className="listings-images">
                {IMAGE_KEYS.map((key) => {
                  const url = imageUrl(edited, key);
                  return (
                    <label key={key} className={`listings-image${changes[key] !== undefined ? ' changed' : ''}`}>
                      {url ? <img src={url} alt="" loading="lazy" /> : <span className="listings-image-empty">{IMAGE_LABEL(key)}</span>}
                      <span className="hint">{IMAGE_LABEL(key)}</span>
                      <input className="inp" value={url} placeholder="https://…" onChange={(e) => setEdited((current) => setImageUrl(current, key, e.target.value, locale))} />
                    </label>
                  );
                })}
              </div>
            </section>

            <section className="stack">
              <h3>其他属性 <span className="hint">{otherKeys.length} 个，点「改」按亚马逊原格式编辑</span></h3>
              <table className="tbl listings-attrs">
                <tbody>
                  {otherKeys.map((key) => (
                    <tr key={key} className={changes[key] !== undefined ? 'changed' : ''}>
                      <td className="mono">{key}</td>
                      <td>{attributePreview(edited[key])}</td>
                      <td><button className="btn sm ghost" onClick={() => openRaw(key)}>改</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rawKey && (
                <div className="card stack">
                  <div className="row"><b className="mono">{rawKey}</b><div className="spacer" /><span className="hint">清空 = 删除这个属性</span></div>
                  <textarea className="inp mono" rows={10} value={rawText} onChange={(e) => setRawText(e.target.value)} />
                  <div className="row"><button className="btn sm primary" onClick={saveRaw}>确定</button><button className="btn sm" onClick={() => setRawKey('')}>取消</button></div>
                </div>
              )}
              <div className="row">
                <input className="inp mono" placeholder="新增属性名，如 special_feature" value={newAttr} onChange={(e) => setNewAttr(e.target.value)} />
                <button className="btn sm" disabled={!/^[a-z][a-z0-9_]*$/.test(newAttr.trim())} onClick={() => { openRaw(newAttr.trim()); setNewAttr(''); }}>添加</button>
              </div>
            </section>
          </div>
        )}

        <footer className="listings-drawer-foot">
          {result && (
            <div className={`note ${result.status === 'INVALID' ? 'err' : 'ok'}`}>
              {result.mode === 'preview'
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
            <button className="btn" disabled={!changedKeys.length || !!busy} onClick={() => { setEdited(original); setPriceDraft(null); }}>撤销改动</button>
            <button className="btn" disabled={!changedKeys.length || !!busy} onClick={() => submit(false)}>{busy === 'preview' ? '校验中…' : '校验（不改线上）'}</button>
            <button
              className="btn primary" disabled={!liveSubmit || !changedKeys.length || !!busy} onClick={() => submit(true)}
              title={liveSubmit ? '' : '服务器还没开启正式提交'}
            >{busy === 'live' ? '提交中…' : '提交到亚马逊'}</button>
          </div>
        </footer>
      </aside>
    </div>
  );
}
