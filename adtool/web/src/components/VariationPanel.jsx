import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { themeAttributes } from '../listingEdit.js';

const SEVERITY = { ERROR: '错误', WARNING: '警告', INFO: '提示' };

const matches = (item, needle) => !needle
  || [item.sku, item.asin, item.itemName].some((value) => String(value ?? '').toLowerCase().includes(needle));

export default function VariationPanel({ store, items, liveSubmit, onChanged }) {
  const [parentQuery, setParentQuery] = useState('');
  const [parentSku, setParentSku] = useState('');
  const [theme, setTheme] = useState('');
  const [childQuery, setChildQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [results, setResults] = useState(null);
  // 现有子体的变体属性值:{ sku: { color: 'Black' } },用来查新子体有没有撞值
  const [familyValues, setFamilyValues] = useState({});

  const bySku = useMemo(() => new Map(items.map((item) => [item.sku, item])), [items]);
  const parents = useMemo(() => {
    const needle = parentQuery.trim().toLowerCase();
    return items.filter((item) => (item.parentage === 'parent' || item.childCount > 0) && matches(item, needle));
  }, [items, parentQuery]);
  const parent = bySku.get(parentSku) ?? null;
  const attributes = themeAttributes(theme, parent?.themeAttributes ?? []);
  const family = useMemo(() => {
    if (!parent) return [];
    const skus = new Set([...(parent.childSkus ?? []), ...items.filter((item) => item.parent === parent.sku).map((item) => item.sku)]);
    return [...skus].map((sku) => bySku.get(sku) ?? { sku });
  }, [parent, items, bySku]);
  useEffect(() => {
    setFamilyValues({});
    if (!parent) return undefined;
    let cancelled = false;
    (async () => {
      for (const row of family.filter((r) => r.itemName)) {
        try {
          const { item } = await api.listingItem(store, row.sku);
          if (cancelled) return;
          setFamilyValues((current) => ({ ...current, [row.sku]: item.attributes ?? {} }));
        } catch { /* 读不到就不参与查重,亚马逊校验还会再查 */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentSku, store]);

  const candidates = useMemo(() => {
    const needle = childQuery.trim().toLowerCase();
    if (!parent || !needle) return [];
    const taken = new Set([parent.sku, ...family.map((row) => row.sku), ...picked.map((row) => row.sku)]);
    return items.filter((item) => !taken.has(item.sku) && item.parentage !== 'parent' && matches(item, needle)).slice(0, 30);
  }, [items, childQuery, parent, family, picked]);

  function chooseParent(sku) {
    const next = bySku.get(sku);
    setParentSku(sku);
    setTheme(next?.variationTheme ?? '');
    setPicked([]);
    setResults(null);
    setMessage(null);
  }

  /** 加一个子体:读它现在的属性,把变体属性的现值填进输入框 */
  async function addChild(item) {
    setChildQuery('');
    setResults(null);
    const row = { sku: item.sku, item, values: {}, loading: true };
    setPicked((current) => [...current, row]);
    try {
      const { item: full } = await api.listingItem(store, item.sku);
      const values = Object.fromEntries(attributes.map((name) => [name, String(full.attributes?.[name]?.[0]?.value ?? '')]));
      setPicked((current) => current.map((r) => (r.sku === item.sku ? { ...r, values, loading: false } : r)));
    } catch (error) {
      setPicked((current) => current.map((r) => (r.sku === item.sku ? { ...r, loading: false } : r)));
      setMessage({ kind: 'err', text: `${item.sku}：${error.message}` });
    }
  }

  const setValue = (sku, name, value) => setPicked((current) => current.map((r) => (
    r.sku === sku ? { ...r, values: { ...r.values, [name]: value } } : r
  )));

  // 同一家族里变体属性组合不能重复(和已有子体比,也和这次加的比);值 → 撞上的 SKU
  const duplicates = useMemo(() => {
    const keyOf = (values) => attributes.map((name) => String(values?.[name] ?? '').trim().toLowerCase()).join('|');
    const owners = new Map();
    const add = (key, sku) => owners.set(key, [...(owners.get(key) ?? []), sku]);
    for (const [sku, attrs] of Object.entries(familyValues)) {
      add(keyOf(Object.fromEntries(attributes.map((name) => [name, attrs[name]?.[0]?.value]))), sku);
    }
    for (const row of picked) add(keyOf(row.values), row.sku);
    const clash = new Map();
    for (const row of picked) {
      const key = keyOf(row.values);
      const others = (owners.get(key) ?? []).filter((sku) => sku !== row.sku);
      if (key.replace(/\|/g, '') && others.length) clash.set(row.sku, others);
    }
    return clash;
  }, [picked, attributes, familyValues]);
  const missing = picked.some((row) => attributes.some((name) => !String(row.values[name] ?? '').trim()));
  const ready = parent && theme.trim() && picked.length && !missing && !duplicates.size && !picked.some((row) => row.loading);

  async function merge(live) {
    if (live && !window.confirm(
      `确定把 ${picked.length} 个 SKU 合并到父体 ${parent.sku} 下面？\n${picked.map((row) => row.sku).join('、')}\n`
      + '会先全部校验，全部通过才改线上变体关系。',
    )) return;
    setBusy(live ? 'live' : 'preview');
    setMessage(null);
    try {
      const res = await api.mergeVariation({
        ...store, parentSku: parent.sku, theme: theme.trim(), live,
        children: picked.map((row) => ({ sku: row.sku, values: row.values })),
      });
      setResults(res);
      if (res.mode === 'live') {
        setPicked([]);
        onChanged();
      }
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function detach(sku) {
    if (!window.confirm(`把 ${sku} 移出父体 ${parent.sku}？会先校验，通过后它变回独立 Listing，不再共享这个家族的评论。`)) return;
    setBusy(`detach:${sku}`);
    setMessage(null);
    try {
      const res = await api.detachVariation({ ...store, sku, live: true });
      if (res.blocked) {
        setMessage({ kind: 'err', text: `${sku} 校验没通过，没有移出：${res.issues.map((i) => i.message).join('；')}` });
      } else {
        setMessage({ kind: 'ok', text: `${sku} 移出请求亚马逊已接收（${res.status}），生效后点「从亚马逊拉取」确认` });
        onChanged();
      }
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="card stack variation-panel">
      <p className="hint">
        选一个已有评论的父体，再把要借评的 SKU 加进来做子体。合并只在当前站点、同一个卖家账号里生效，子体和父体要是同一个商品类型，
        每个子体的变体属性值（比如颜色）不能重复。提交前会先全部校验。
      </p>

      <div className="row wrap">
        <input className="inp" placeholder="搜父体 SKU / ASIN / 标题" value={parentQuery} onChange={(e) => setParentQuery(e.target.value)} />
        <select className="inp" value={parentSku} onChange={(e) => chooseParent(e.target.value)}>
          <option value="">选择父体（{parents.length} 个）</option>
          {parents.map((item) => (
            <option key={item.sku} value={item.sku}>{item.sku} · {item.childCount} 个子体 · {(item.itemName ?? '').slice(0, 40)}</option>
          ))}
        </select>
      </div>

      {!parents.length && <div className="note info">这个站点的本地数据里没有父体。先在「商品列表」拉取，或者确认这个站点已经有变体家族。</div>}

      {parent && (
        <>
          <div className="row wrap">
            <label className="field">
              <span>变体主题（variation_theme）</span>
              <input className="inp mono" value={theme} onChange={(e) => setTheme(e.target.value.toUpperCase())} placeholder="如 COLOR、SIZE_NAME/COLOR_NAME" />
            </label>
            <span className="stat">子体要带的属性：<b className="mono">{attributes.join('、') || '—'}</b></span>
          </div>

          <div>
            <h3>现有子体（{family.length}）</h3>
            <table className="tbl">
              <tbody>
                {family.map((row) => (
                  <tr key={row.sku}>
                    <td className="mono">{row.sku}</td>
                    <td className="mono">{row.asin ?? ''}</td>
                    <td>{attributes.map((name) => familyValues[row.sku]?.[name]?.[0]?.value).filter(Boolean).join(' / ')}</td>
                    <td>{row.itemName ?? <span className="hint">本地没有这个 SKU</span>}</td>
                    <td>
                      <button className="btn sm danger" disabled={!liveSubmit || !!busy || !row.itemName} onClick={() => detach(row.sku)}>
                        {busy === `detach:${row.sku}` ? '移出中…' : '移出'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="stack">
            <h3>加入子体</h3>
            <input className="inp" placeholder="搜要合并进来的 SKU / ASIN / 标题" value={childQuery} onChange={(e) => setChildQuery(e.target.value)} />
            {candidates.length > 0 && (
              <div className="variation-candidates">
                {candidates.map((item) => (
                  <button key={item.sku} className="variation-candidate" onClick={() => addChild(item)}>
                    <span className="mono">{item.sku}</span>
                    <span className="hint">{item.asin} · {item.productType}{item.parent ? ` · 现在属于 ${item.parent}` : ''}</span>
                    <span className="variation-candidate-title">{item.itemName}</span>
                  </button>
                ))}
              </div>
            )}

            {picked.length > 0 && (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>商品类型</th>
                    {attributes.map((name) => <th key={name} className="mono">{name}</th>)}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {picked.map((row) => {
                    const typeMismatch = row.item.productType && parent.productType && row.item.productType !== parent.productType;
                    return (
                      <tr key={row.sku}>
                        <td className="mono">
                          {row.sku}
                          {row.item.parent && <div className="hint">会从 {row.item.parent} 移到这里</div>}
                          {duplicates.has(row.sku) && <div className="tag red">和 {duplicates.get(row.sku).join('、')} 的属性值重复</div>}
                        </td>
                        <td>{row.item.productType}{typeMismatch && <div className="tag red">和父体 {parent.productType} 不一样</div>}</td>
                        {attributes.map((name) => (
                          <td key={name}>
                            <input
                              className="inp" value={row.values[name] ?? ''} disabled={row.loading}
                              placeholder={row.loading ? '读取中…' : '必填'}
                              onChange={(e) => setValue(row.sku, name, e.target.value)}
                            />
                          </td>
                        ))}
                        <td>
                          <button className="btn sm ghost" onClick={() => setPicked((current) => current.filter((r) => r.sku !== row.sku))}>去掉</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {message && <div className={`note ${message.kind}`}>{message.text}</div>}
          {results && (
            <div className={`note ${results.blocked || results.results.some((r) => r.status === 'INVALID') ? 'err' : 'ok'}`}>
              {results.blocked
                ? '有子体校验没通过，整批都没有提交'
                : results.mode === 'live' ? '亚马逊已接收合并请求，一般几分钟到几小时生效，之后重新拉取确认' : '校验结果（没有改线上）'}
              {results.results.map((r) => (
                <div key={r.sku}>
                  · <span className="mono">{r.sku}</span>：{r.status}
                  {r.issues.map((issue, index) => (
                    <span key={index}>；[{SEVERITY[issue.severity] ?? issue.severity}] {issue.message}{issue.attributeNames?.length ? `（${issue.attributeNames.join(', ')}）` : ''}</span>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <span className="stat">
              {picked.length ? <>准备合并 <b>{picked.length}</b> 个 SKU 到 <span className="mono">{parent.sku}</span></> : '还没有选子体'}
              {missing && picked.length > 0 ? '，有变体属性没填' : ''}
            </span>
            <div className="spacer" />
            <button className="btn" disabled={!ready || !!busy} onClick={() => merge(false)}>{busy === 'preview' ? '校验中…' : '校验（不改线上）'}</button>
            <button className="btn primary" disabled={!ready || !liveSubmit || !!busy} onClick={() => merge(true)}>
              {busy === 'live' ? '提交中…' : '提交合并'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
