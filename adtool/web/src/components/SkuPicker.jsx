import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { searchSkus, isOutOfStock, mergeSkuText } from '../skuMatch.js';
import './SkuPicker.css';

/**
 * 从 SKU 库挑 SKU 填进「投放 SKU」框 —— 自动广告页和手动广告页共用。
 * 和桌面版一个用法:输型号(301 能查到 301XL)→ 勾选 → 追加 / 覆盖填入。
 * 只读当前站点的 SKU,库是各账号自己的。
 */
export default function SkuPicker({ market, current, onApply, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [picked, setPicked] = useState(() => new Set());

  useEffect(() => {
    api.skus({ marketplace: market })
      .then((d) => setItems(d.items ?? []))
      .catch((e) => setError(e.message));
  }, [market]);

  const brands = useMemo(
    () => [...new Set((items ?? []).map((it) => it.brand).filter(Boolean))].sort(),
    [items]
  );

  const hits = useMemo(() => {
    let list = searchSkus(items ?? [], query);
    if (brand) list = list.filter((it) => it.brand === brand);
    if (inStockOnly) list = list.filter((it) => !isOutOfStock(it));
    return list;
  }, [items, query, brand, inStockOnly]);

  // 每次筛选结果变了就默认全选 —— 和桌面版一样,查出来的默认都要投
  useEffect(() => { setPicked(new Set(hits.map((it) => it.id))); }, [hits]);

  function toggle(id) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function apply(mode) {
    const skus = hits.filter((it) => picked.has(it.id)).map((it) => it.sku);
    if (!skus.length) return;
    const { text, addedCount } = mergeSkuText(current, skus, mode);
    onApply(text, mode === 'replace'
      ? `已填入 ${skus.length} 个 SKU(覆盖)`
      : `已追加 ${addedCount} 个 SKU${addedCount < skus.length ? `,${skus.length - addedCount} 个本来就在框里` : ''}`);
    onClose();
  }

  const total = items?.length ?? 0;

  return (
    <div className="pickmask" onClick={onClose}>
      <div className="pickbox" onClick={(e) => e.stopPropagation()}>
        <header className="pickhead">
          <b>从 SKU 库选</b>
          <span className="tag blue">{market} 站</span>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {error ? (
          <div className="note err">{error}</div>
        ) : items === null ? (
          <div className="empty">加载中…</div>
        ) : !total ? (
          <div className="note info">
            你的 SKU 库里还没有 {market} 站的 SKU。先去「SKU 库」页导入,或者直接在左边手填。
          </div>
        ) : (
          <>
            <div className="row wrap pickbar">
              <input
                className="inp" style={{ flex: 1, minWidth: 150 }} autoFocus
                placeholder="型号 / 品牌 / SKU…(输 301 会把 301XL 一起查出来)"
                value={query} onChange={(e) => setQuery(e.target.value)}
              />
              {brands.length > 1 && (
                <select className="inp" style={{ width: 120 }} value={brand}
                  onChange={(e) => setBrand(e.target.value)}>
                  <option value="">全部品牌</option>
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              <label className="row" style={{ gap: 5 }}>
                <input type="checkbox" checked={inStockOnly}
                  onChange={(e) => setInStockOnly(e.target.checked)} />
                <span className="hint">只看有货</span>
              </label>
            </div>

            <div className="scroll picklist">
              {hits.map((it) => (
                <label key={it.id} className={`pickrow${picked.has(it.id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={picked.has(it.id)} onChange={() => toggle(it.id)} />
                  <span className="mono picksku">{it.sku}</span>
                  <span className="pickmeta">
                    {[it.brand, it.model, it.setGroup].filter(Boolean).join(' · ')}
                  </span>
                  <div className="spacer" />
                  {isOutOfStock(it)
                    ? <span className="tag amber">缺货</span>
                    : (
                      <span className="hint">
                        {Number(it.stock) ? `在库 ${it.stock}` : ''}
                        {Number(it.stock) && Number(it.transit) ? ' · ' : ''}
                        {Number(it.transit) ? `在途 ${it.transit}` : ''}
                      </span>
                    )}
                </label>
              ))}
              {!hits.length && (
                <div className="empty">
                  没找到 —— 换个型号试试,或者去「SKU 库」把这些 SKU 先导进来
                </div>
              )}
            </div>

            <footer className="pickfoot">
              <button className="btn sm" onClick={() => setPicked(new Set(hits.map((it) => it.id)))}>全选</button>
              <button className="btn sm" onClick={() => setPicked(new Set())}>全不选</button>
              <span className="stat">已选 <b>{picked.size}</b> / {hits.length}</span>
              <div className="spacer" />
              <button className="btn sm" onClick={onClose}>取消</button>
              <button className="btn sm" disabled={!picked.size} onClick={() => apply('replace')}>覆盖填入</button>
              <button className="btn sm primary" disabled={!picked.size} onClick={() => apply('append')}>追加填入</button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
