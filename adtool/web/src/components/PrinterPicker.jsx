import { useEffect, useMemo, useState } from 'react';
import {
  printerLib, printerFacets, printerSeriesMap, printerTerm, modelTerms,
  searchPrinters, targetedModels, isTargeted, pickedTerms, appendTerms,
} from '../printerLib.js';
import './SkuPicker.css';
import './PrinterPicker.css';

/**
 * 从 D 类打印机库挑否定词 —— 自动广告页和手动广告页共用。
 * 用法:搜墨盒型号或打印机机型 → 勾中要否的行 → 选加到哪个否定词框 → 一键写进去。
 * 系列广告正在投的那些型号会标出来并且默认不勾,免得把自己在投的机型给否了。
 */

/* 列表一次最多渲染这么多行,再多就让用户搜细一点 —— 欧洲 D 库有一千多行 */
const SHOW_MAX = 400;
/* 筛出来不超过这个数就默认全勾上,和 SKU 库挑选一个习惯 */
const AUTO_PICK_MAX = 200;

const PICKS = [
  ['printer', '打印机型号'],
  ['model', '墨盒型号'],
  ['both', '两个都要'],
];

const TARGETS = [
  ['cnegPhrase', '活动级 · 否定词组'],
  ['cnegExact', '活动级 · 否定精准'],
  ['negPhrase', '广告组级 · 否定词组'],
  ['negExact', '广告组级 · 否定精准'],
];

export default function PrinterPicker({ market, lib, task, onApply, onClose }) {
  const { spec, items, scope } = useMemo(() => printerLib(lib), [lib]);
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState({ brand: '', series: '' });
  const [pick, setPick] = useState('printer');
  const [target, setTarget] = useState('cnegPhrase');
  const [picked, setPicked] = useState(() => new Set());

  const facets = useMemo(() => printerFacets(items), [items]);
  const seriesMap = useMemo(() => printerSeriesMap(items), [items]);
  const adType = task?.adType;
  const seriesModels = task?.seriesModels;
  const targeted = useMemo(
    () => (adType === 'series' ? targetedModels(seriesModels) : new Set()),
    [adType, seriesModels]
  );

  const filtered = !!(query.trim() || facet.brand || facet.series);
  const hits = useMemo(
    () => searchPrinters(items, query, facet),
    [items, query, facet]
  );
  const shown = hits.slice(0, SHOW_MAX);

  // 筛选结果一变就重挑一次:筛过并且条数不多就默认全勾(在投的除外),否则一个都不勾
  useEffect(() => {
    if (!filtered || hits.length > AUTO_PICK_MAX) {
      setPicked(new Set());
      return;
    }
    setPicked(new Set(hits.filter((r) => !isTargeted(r, targeted)).map((r) => r.id)));
  }, [hits, filtered, targeted]);

  const terms = useMemo(
    () => pickedTerms(hits.filter((r) => picked.has(r.id)), pick, seriesMap),
    [hits, picked, pick, seriesMap]
  );
  const targetLabel = TARGETS.find(([id]) => id === target)?.[1] ?? '';
  const hitTargeted = hits.some((r) => picked.has(r.id) && isTargeted(r, targeted));

  function toggle(id) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function apply() {
    if (!terms.length) return;
    const { text, added, dup } = appendTerms(task?.extraNeg?.[target], terms);
    onApply(
      { [target]: text },
      `已加 ${added} 个否定词到「${targetLabel}」${dup ? `,${dup} 个本来就在框里` : ''}`
    );
    onClose();
  }

  return (
    <div className="pickmask" onClick={onClose}>
      <div className="pickbox printbox" onClick={(e) => e.stopPropagation()}>
        <header className="pickhead">
          <b>从打印机库选否定词</b>
          {scope && <span className="tag blue">{spec?.id} 类 · {scope.scope} 库</span>}
          <span className="hint">{market} 站</span>
          <div className="spacer" />
          <button className="btn sm ghost" onClick={onClose} aria-label="关闭">✕</button>
        </header>

        {!scope ? (
          <div className="note info">
            {market} 站这个区域还没开 {spec?.id ?? 'D'} 类打印机库。
          </div>
        ) : !items.length ? (
          <div className="note info">
            这个区域的打印机库还没有数据,先让商品部在「否定词库」页把 {spec?.id ?? 'D'} 类传上来。
          </div>
        ) : (
          <>
            <div className="row wrap pickbar">
              <input
                className="inp" style={{ flex: 1, minWidth: 160 }} autoFocus
                placeholder="搜墨盒型号或打印机机型…(空格分开可以搜多个词)"
                value={query} onChange={(e) => setQuery(e.target.value)}
              />
              {facets.brands.length > 1 && (
                <select className="inp" style={{ width: 110 }} value={facet.brand}
                  onChange={(e) => setFacet({ ...facet, brand: e.target.value })}>
                  <option value="">全部品牌</option>
                  {facets.brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
              {facets.series.length > 1 && (
                <select className="inp" style={{ width: 130 }} value={facet.series}
                  onChange={(e) => setFacet({ ...facet, series: e.target.value })}>
                  <option value="">全部系列</option>
                  {facets.series.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
            </div>

            <div className="row wrap">
              <span className="hint">加哪一列</span>
              {PICKS.map(([id, label]) => (
                <button
                  key={id}
                  className={`btn sm${pick === id ? ' primary' : ''}`}
                  onClick={() => setPick(id)}
                >{label}</button>
              ))}
            </div>

            <div className="scroll picklist">
              <div className="printhead">
                <span />
                <span>墨盒型号</span>
                <span>品牌</span>
                <span>打印机系列</span>
                <span>打印机型号</span>
                <span />
              </div>
              {shown.map((r) => {
                const on = picked.has(r.id);
                const busy = isTargeted(r, targeted);
                const pt = printerTerm(r, seriesMap);
                return (
                  <label key={r.id} className={`printrow${on ? ' on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(r.id)} />
                    <span className="mono printmodel">{modelTerms(r).join(' / ') || '—'}</span>
                    <span className="printdim">{r.brand || '—'}</span>
                    <span className="printdim">{r.series || '—'}</span>
                    <span className="mono" title={pt !== r.printer ? `否定时写成 ${pt}` : undefined}>
                      {r.printer || '—'}
                      {pt !== r.printer && <span className="printqual"> → {pt}</span>}
                    </span>
                    {busy ? <span className="tag amber">在投</span> : <span />}
                  </label>
                );
              })}
              {!hits.length && (
                <div className="empty">
                  没找到 —— 换个型号或机型试试,库里没有的先让商品部补进 {spec?.id ?? 'D'} 类
                </div>
              )}
              {hits.length > shown.length && (
                <div className="hint printmore">
                  还有 {hits.length - shown.length} 行没显示,搜细一点再挑
                </div>
              )}
            </div>

            <div className="row wrap">
              <span className="hint">加到</span>
              {TARGETS.map(([id, label]) => (
                <button
                  key={id}
                  className={`btn sm${target === id ? ' primary' : ''}`}
                  onClick={() => setTarget(id)}
                >{label}</button>
              ))}
            </div>

            {hitTargeted && (
              <p className="hint printwarn">
                勾中的行里有正在投的墨盒型号,加进去等于把自己在投的机型否掉了,确认一下。
              </p>
            )}

            <footer className="pickfoot">
              <button
                className="btn sm"
                onClick={() => setPicked(new Set(shown.map((r) => r.id)))}
              >全选本页</button>
              <button className="btn sm" onClick={() => setPicked(new Set())}>全不选</button>
              <span className="stat">已选 <b>{picked.size}</b> / {hits.length}</span>
              <span className="stat">写入 <b>{terms.length}</b> 个词</span>
              <div className="spacer" />
              <button className="btn sm" onClick={onClose}>取消</button>
              <button className="btn sm primary" disabled={!terms.length} onClick={apply}>
                添加到否定词
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
