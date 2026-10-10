import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { INK_THEMES, parentCategoryField, themeAttributes } from '../listingEdit.js';

const SEVERITY = { ERROR: '错误', WARNING: '警告', INFO: '提示' };

const EU_SITES = ['ES', 'DE', 'FR', 'IT', 'UK'];
/** 亚马逊常要的几个必填项,只写进还没有这个属性的父体 / 子体;值是接口枚举 */
const FILL_FIELDS = [
  { name: 'gdpr_risk', label: 'GDPR 风险', euOnly: true, options: [
    ['no_electronic_information_stored', '没有存储电子信息'], ['user_setting_information_storage', '存储用户设置'],
    ['manufacturer_website_registration', '需在厂商网站注册'], ['cloud_account_connectivity', '连接云账号'],
    ['physical_or_cloud_data_storage', '本地或云端存数据'], ['pin_or_biometric_recognition_lock', '密码或生物识别锁'],
  ] },
  { name: 'supplier_declared_dg_hz_regulation', label: '危险品规管', options: [
    ['not_applicable', '不适用'], ['ghs', 'GHS'], ['storage', '储存'], ['transportation', '运输'], ['disposal', '处置'], ['other', '其他'], ['unknown', '不清楚'],
  ] },
  { name: 'batteries_required', label: '需要电池吗', options: [['false', '否'], ['true', '是']] },
  { name: 'country_of_origin', label: '原产国（两位代码，如 CN）', text: true },
];
const defaultFill = (country) => ({
  ...(EU_SITES.includes(country) ? { gdpr_risk: 'no_electronic_information_stored' } : {}),
  supplier_declared_dg_hz_regulation: 'not_applicable', batteries_required: 'false', country_of_origin: '',
});

const newParentDraft = (country) => ({ sku: '', itemName: '', brand: '', category: parentCategoryField(country).fallback });

const matches = (item, needle) => !needle
  || [item.sku, item.asin, item.itemName].some((value) => String(value ?? '').toLowerCase().includes(needle));

export default function VariationPanel({ store, items, liveSubmit, onChanged }) {
  // existing = 挂到已有父体;new = 新建父体(同事模板的做法:建一个只有标题和品牌的父体,主题 SET_NAME)
  const [mode, setMode] = useState('existing');
  const [draft, setDraft] = useState(() => newParentDraft(store.country));
  const categoryField = parentCategoryField(store.country);
  const [parentQuery, setParentQuery] = useState('');
  const [parentSku, setParentSku] = useState('');
  const [theme, setTheme] = useState('');
  const [childQuery, setChildQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [results, setResults] = useState(null);
  const [fill, setFill] = useState(() => defaultFill(store.country));
  // 现有子体的变体属性值:{ sku: { color: 'Black' } },用来查新子体有没有撞值
  const [familyValues, setFamilyValues] = useState({});

  const bySku = useMemo(() => new Map(items.map((item) => [item.sku, item])), [items]);
  const parents = useMemo(() => {
    const needle = parentQuery.trim().toLowerCase();
    return items.filter((item) => (item.parentage === 'parent' || item.childCount > 0) && matches(item, needle));
  }, [items, parentQuery]);
  const parent = mode === 'existing' ? bySku.get(parentSku) ?? null : null;
  const active = mode === 'new' || !!parent;
  const parentType = parent?.productType ?? picked[0]?.item.productType ?? null;
  const targetSku = mode === 'new' ? draft.sku.trim() : parent?.sku;
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
    if (!active || !needle) return [];
    const taken = new Set([targetSku, ...family.map((row) => row.sku), ...picked.map((row) => row.sku)]);
    return items.filter((item) => !taken.has(item.sku) && item.parentage !== 'parent' && matches(item, needle)).slice(0, 30);
  }, [items, childQuery, active, targetSku, family, picked]);

  function switchMode(next) {
    setMode(next);
    setParentSku('');
    setDraft(newParentDraft(store.country));
    setTheme(next === 'new' ? 'SET_NAME' : '');
    setPicked([]);
    setResults(null);
    setMessage(null);
  }

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
      // 新建父体时,品牌和标题先用第一个子体的,再自己改
      if (mode === 'new') {
        setDraft((current) => ({
          ...current,
          brand: current.brand || String(full.attributes?.brand?.[0]?.value ?? ''),
          itemName: current.itemName || String(full.attributes?.item_name?.[0]?.value ?? item.itemName ?? ''),
        }));
      }
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
  const draftOk = mode === 'existing' || (draft.sku.trim() && draft.itemName.trim() && draft.brand.trim() && !bySku.has(draft.sku.trim()));
  const ready = active && draftOk && theme.trim() && picked.length && !missing && !duplicates.size && !picked.some((row) => row.loading);

  async function merge(live) {
    if (live && !window.confirm(
      (mode === 'new' ? `确定新建父体 ${targetSku}，并把 ${picked.length} 个 SKU 挂到它下面？\n` : `确定把 ${picked.length} 个 SKU 合并到父体 ${targetSku} 下面？\n`)
      + `${picked.map((row) => row.sku).join('、')}\n会先校验，通过才改线上变体关系。`,
    )) return;
    setBusy(live ? 'live' : 'preview');
    setMessage(null);
    try {
      const res = await api.mergeVariation({
        ...store, theme: theme.trim(), live,
        ...(mode === 'new'
          ? { newParent: { ...draft, sku: draft.sku.trim(), itemName: draft.itemName.trim(), brand: draft.brand.trim(), category: draft.category.trim() } }
          : { parentSku: parent.sku }),
        children: picked.map((row) => ({ sku: row.sku, values: row.values })),
        fill,
      });
      setResults(res);
      if (res.mode === 'live' && !res.blocked) {
        setPicked([]);
        // 新父体建好以后切回「已有父体」并选中它,方便继续往里加
        if (mode === 'new') {
          setMode('existing');
          setParentSku(targetSku);
          setDraft(newParentDraft(store.country));
        }
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
        把要借评的 SKU 挂到一个父体下面做子体：可以挂到已有评论的父体，也可以像合评模板那样新建一个父体（主题 SET_NAME）。合并只在当前站点、同一个卖家账号里生效，子体和父体要是同一个商品类型，
        每个子体的变体属性值（比如颜色）不能重复。提交前会先全部校验。
      </p>

      <div className="chips">
        {[['existing', '挂到已有父体'], ['new', '新建父体']].map(([id, label]) => (
          <button key={id} className={`chip${mode === id ? ' on' : ''}`} onClick={() => switchMode(id)}>{label}</button>
        ))}
      </div>

      {mode === 'new' && (
        <div className="listings-grid variation-new-parent">
          <label className="field">
            <span>新父体 SKU</span>
            <input className="inp mono" value={draft.sku} placeholder="如 67XL0831" onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
            {bySku.has(draft.sku.trim()) && <em className="tag red">这个 SKU 已经存在</em>}
          </label>
          <label className="field variation-wide">
            <span>父体标题</span>
            <input className="inp" value={draft.itemName} placeholder="加入第一个子体后自动带出，可改" onChange={(e) => setDraft({ ...draft, itemName: e.target.value })} />
          </label>
          <label className="field">
            <span>品牌</span>
            <input className="inp" value={draft.brand} onChange={(e) => setDraft({ ...draft, brand: e.target.value })} />
          </label>
          <label className="field">
            <span>{categoryField.label}</span>
            <input className="inp mono" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          </label>
        </div>
      )}

      {mode === 'existing' && <div className="row wrap">
        <input className="inp" placeholder="搜父体 SKU / ASIN / 标题" value={parentQuery} onChange={(e) => setParentQuery(e.target.value)} />
        <select className="inp" value={parentSku} onChange={(e) => chooseParent(e.target.value)}>
          <option value="">选择父体（{parents.length} 个）</option>
          {parents.map((item) => (
            <option key={item.sku} value={item.sku}>{item.sku} · {item.childCount} 个子体 · {(item.itemName ?? '').slice(0, 40)}</option>
          ))}
        </select>
      </div>}

      {mode === 'existing' && !parents.length && <div className="note info">这个站点的本地数据里没有父体。先在「商品列表」拉取，或者确认这个站点已经有变体家族。</div>}

      {active && (
        <>
          <div className="row wrap">
            <label className="field">
              <span>变体主题（variation_theme）</span>
              <input className="inp mono" list="variation-themes" value={theme} onChange={(e) => setTheme(e.target.value.toUpperCase())} placeholder="如 SET_NAME、COLOR" />
              <datalist id="variation-themes">{INK_THEMES.map((name) => <option key={name} value={name} />)}</datalist>
            </label>
            <span className="stat">子体要带的属性：<b className="mono">{attributes.join('、') || '—'}</b></span>
          </div>

          {mode === 'existing' && <div>
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
          </div>}

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
                    const typeMismatch = row.item.productType && parentType && row.item.productType !== parentType;
                    return (
                      <tr key={row.sku}>
                        <td className="mono">
                          {row.sku}
                          {row.item.parent && <div className="hint">会从 {row.item.parent} 移到这里</div>}
                          {duplicates.has(row.sku) && <div className="tag red">和 {duplicates.get(row.sku).join('、')} 的属性值重复</div>}
                        </td>
                        <td>{row.item.productType}{typeMismatch && <div className="tag red">和{parent ? '父体' : '第一个子体'}的 {parentType} 不一样</div>}</td>
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

          <div className="stack">
            <h3>缺了才补的必填项 <span className="hint">已经填过的父体、子体不会被改；不想补的选空</span></h3>
            <div className="listings-grid">
              {FILL_FIELDS.filter((field) => !field.euOnly || EU_SITES.includes(store.country)).map((field) => (
                <label key={field.name} className="field">
                  <span>{field.label}</span>
                  {field.text
                    ? <input className="inp mono" value={fill[field.name] ?? ''} maxLength={2} onChange={(e) => setFill({ ...fill, [field.name]: e.target.value.toUpperCase() })} />
                    : (
                      <select className="inp" value={fill[field.name] ?? ''} onChange={(e) => setFill({ ...fill, [field.name]: e.target.value })}>
                        <option value="">不补</option>
                        {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    )}
                </label>
              ))}
            </div>
          </div>

          {message && <div className={`note ${message.kind}`}>{message.text}</div>}
          {results && (
            <div className={`note ${results.blocked || [results.parent, ...results.results].some((r) => r?.status === 'INVALID') ? 'err' : 'ok'}`}>
              {results.blocked
                ? (results.parent?.blocked || (results.parent && results.parent.status !== 'ACCEPTED' && results.parent.mode === 'live')
                  ? '新父体没有通过，什么都没有提交'
                  : `有子体校验没通过，子体都没有提交${results.parent?.status === 'ACCEPTED' ? '（新父体已经建好；如果报的是找不到父体，等几分钟亚马逊处理完，到「挂到已有父体」里选它再提交）' : ''}`)
                : results.mode === 'live' ? '亚马逊已接收合并请求，一般几分钟到几小时生效，之后重新拉取确认' : '校验结果（没有改线上）'}
              {!results.blocked && results.mode === 'preview' && results.parent && (
                <div className="hint">新父体还没建，子体校验里如果只报「找不到父体」可以忽略，提交时会先建父体再挂子体。</div>
              )}
              {[results.parent, ...results.results].filter(Boolean).map((r) => (
                <div key={r.sku}>
                  · <span className="mono">{r.sku}</span>{r.parent ? '（新父体）' : ''}：{r.status}
                  {r.issues.map((issue, index) => (
                    <span key={index}>；[{SEVERITY[issue.severity] ?? issue.severity}] {issue.message}{issue.attributeNames?.length ? `（${issue.attributeNames.join(', ')}）` : ''}</span>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <span className="stat">
              {picked.length ? <>准备合并 <b>{picked.length}</b> 个 SKU 到 <span className="mono">{targetSku || '新父体'}</span></> : '还没有选子体'}
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
