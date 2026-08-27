import { useEffect, useMemo, useState } from 'react';
import { buildSeriesNegatives } from '../adEngine.js';
import { copyText } from '../clipboard.js';
import {
  printerLib, printerFacets, printerSeriesMap, printerTerm, modelTerms,
  searchPrinters, queryReport, pickedTerms, rowsModels, joinTerms,
  SEARCH_FIELDS, TERM_SEPS,
} from '../printerLib.js';
import './SkuPicker.css';
import './PrinterPicker.css';
import './NegHelper.css';

/**
 * 后台否定助手 —— D 类词库当型号库单独用。
 *
 * 不生成批量表,只解决一件事:同事在亚马逊后台手动开广告 / 手动否定时,
 * 一次搜多个墨盒型号,勾中要否的行,把墨盒型号或打印机型号一键复制走,
 * 直接粘进后台的否定词框。
 *
 * 两种算法都在这里:
 *  · 否定搜到的  —— 勾谁否谁,和「从打印机库选」同一套(printerLib)
 *  · 只投这些型号 —— 整库反推,其余墨盒和打印机全否,和系列广告联动否定同一套
 *    (adEngine.buildSeriesNegatives),所以后台开的系列广告和工具生成的口径一致
 */

const SHOW_MAX = 400;

const MODES = [
  ['pick', '否定勾中的', '勾哪几行就否哪几行'],
  ['series', '只投这些型号,否掉其余', '按勾中的墨盒型号整库反推,和系列广告一个口径'],
];

const PICKS = [
  ['printer', '打印机型号'],
  ['model', '墨盒型号'],
  ['both', '两个都要'],
];

const SCOPES = [
  ['both', '墨盒 + 打印机'],
  ['models', '只否墨盒型号'],
  ['printers', '只否打印机型号'],
];

/** 搜索框按搜哪一列换提示语 —— 大部分时候是拿一串墨盒型号来搜 */
const PLACEHOLDER = {
  model: '一次搜多个墨盒型号:305, 304, 951XL\n(逗号 / 换行分开 = 或;从 Excel 整列粘进来也认)',
  printer: '一次搜多个打印机机型:2540, DeskJet 3750\n(逗号 / 换行分开 = 或;系列名和机型号都能搜)',
  all: '型号 / 机型 / 品牌 / 系列都搜:305, DeskJet 2540\n(逗号 / 换行分开 = 或,空格分开 = 两个词都要命中)',
};

export default function NegHelper({ market, lib, onClose }) {
  const { spec, items, scope } = useMemo(() => printerLib(lib), [lib]);
  const [query, setQuery] = useState('');
  // 搜哪一列:默认只搜墨盒型号 —— 搜 305 时不该把「墨盒 302、机型 3050」那种行也捞出来
  const [field, setField] = useState('model');
  const [facet, setFacet] = useState({ brand: '', series: '' });
  const [picked, setPicked] = useState(() => new Set());
  const [mode, setMode] = useState('pick');
  const [pick, setPick] = useState('printer');
  const [negScope, setNegScope] = useState('both');
  const [sep, setSep] = useState('line');
  const [copied, setCopied] = useState('');

  const facets = useMemo(() => printerFacets(items), [items]);
  const seriesMap = useMemo(() => printerSeriesMap(items), [items]);
  const hits = useMemo(
    () => searchPrinters(items, query, facet, field),
    [items, query, facet, field]
  );
  const report = useMemo(
    () => queryReport(items, query, facet, field),
    [items, query, facet, field]
  );
  const misses = report.filter((r) => !r.count);
  const shown = hits.slice(0, SHOW_MAX);

  // 搜索条件一变就把勾选重置成「本次搜到的全勾上」—— 搜多个型号时正好一次性拿走;
  // 什么都没搜就是整个库,这时候一个都不勾,免得手一抖复制走一千多个词
  const filtered = !!(query.trim() || facet.brand || facet.series);
  useEffect(() => {
    setPicked(filtered ? new Set(hits.map((r) => r.id)) : new Set());
  }, [hits, filtered]);

  useEffect(() => { setCopied(''); }, [query, field, facet, picked, mode, pick, negScope, sep]);

  const pickedRows = useMemo(() => hits.filter((r) => picked.has(r.id)), [hits, picked]);
  const models = useMemo(() => rowsModels(pickedRows), [pickedRows]);

  // 「只投这些」是整库反推,所以用的是全部行 items,不是搜索结果
  const series = useMemo(
    () => (mode === 'series' && models.length ? buildSeriesNegatives(items, models) : null),
    [mode, models, items]
  );

  const terms = useMemo(() => {
    if (mode !== 'series') return pickedTerms(pickedRows, pick, seriesMap);
    if (!series) return [];
    return [
      ...(negScope === 'printers' ? [] : series.models),
      ...(negScope === 'models' ? [] : series.printers),
    ];
  }, [mode, pickedRows, pick, seriesMap, series, negScope]);

  const text = joinTerms(terms, sep);

  async function copy() {
    const ok = await copyText(text);
    setCopied(ok ? `已复制 ${terms.length} 个词,直接粘到后台的否定词框` : '复制失败,手动全选下面的框再 Ctrl+C');
  }

  function toggle(id) {
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  return (
    <div className="pickmask" onClick={onClose}>
      <div className="pickbox neghelp" onClick={(e) => e.stopPropagation()}>
        <header className="pickhead">
          <b>后台否定助手</b>
          {scope && <span className="tag blue">{spec?.id} 类 · {scope.scope} 库 · {items.length} 行</span>}
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
            这个区域的打印机库还没有数据,先让商品部把 {spec?.id ?? 'D'} 类传上来。
          </div>
        ) : (
          <>
            <p className="hint">
              在后台手动开广告 / 手动否定时用:一次搜多个墨盒型号 → 勾中要否的行 → 复制 → 粘进后台的否定词框。
              不生成批量表,也不改词库。搜之前先选<b>搜哪一列</b> —— 305 这种数字在别的系列里可能是机型号,
              只想要 305 墨盒的行就搜墨盒型号那一列。
            </p>

            <div className="neghelp-body">
              {/* ---------- 左:搜 + 勾 ---------- */}
              <div className="neghelp-pane">
                <div className="row wrap neghelp-field">
                  <span className="hint">搜哪一列</span>
                  {SEARCH_FIELDS.map(([id, label]) => (
                    <button
                      key={id}
                      className={`btn sm${field === id ? ' primary' : ''}`}
                      onClick={() => setField(id)}
                    >{label}</button>
                  ))}
                </div>
                <textarea
                  className="inp neghelp-q" rows={2} autoFocus
                  placeholder={PLACEHOLDER[field]}
                  value={query} onChange={(e) => setQuery(e.target.value)}
                />
                <div className="row wrap pickbar">
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
                  <button className="btn sm" onClick={() => { setQuery(''); setFacet({ brand: '', series: '' }); }}>
                    清空条件
                  </button>
                  <div className="spacer" />
                  <span className="stat">搜到 <b>{hits.length}</b> 行</span>
                </div>

                {report.length > 1 && (
                  <div className="chips neghelp-terms">
                    {report.map((r) => (
                      <span key={r.label} className={`chip${r.count ? '' : ' miss'}`}>
                        {r.label}<span className="chip-sub">{r.count}</span>
                      </span>
                    ))}
                  </div>
                )}
                {misses.length > 0 && (
                  <p className="hint printwarn">
                    这 {misses.length} 个在 {spec?.id ?? 'D'} 类库的
                    {SEARCH_FIELDS.find(([id]) => id === field)?.[1]}里没找到:
                    {misses.map((m) => m.label).join('、')} —— 确认有没有写错、是不是该换一列搜,
                    或者让商品部补进库里。
                  </p>
                )}

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
                        <span />
                      </label>
                    );
                  })}
                  {!hits.length && (
                    <div className="empty">没找到 —— 换个型号或机型试试</div>
                  )}
                  {hits.length > shown.length && (
                    <div className="hint printmore">
                      还有 {hits.length - shown.length} 行没显示(勾选和复制算的是全部 {hits.length} 行)
                    </div>
                  )}
                </div>

                <div className="row wrap">
                  <button className="btn sm" onClick={() => setPicked(new Set(hits.map((r) => r.id)))}>
                    全选搜到的
                  </button>
                  <button className="btn sm" onClick={() => setPicked(new Set())}>全不选</button>
                  <span className="stat">已勾 <b>{pickedRows.length}</b> 行 · {models.length} 个墨盒型号</span>
                </div>
              </div>

              {/* ---------- 右:出词 + 复制 ---------- */}
              <div className="neghelp-pane">
                <div className="seg neghelp-seg">
                  {MODES.map(([id, label, desc]) => (
                    <button
                      key={id}
                      className={`seg-item${mode === id ? ' on' : ''}`}
                      onClick={() => setMode(id)}
                    >
                      <b>{label}</b>
                      <span>{desc}</span>
                    </button>
                  ))}
                </div>

                <div className="row wrap">
                  <span className="hint">{mode === 'series' ? '否什么' : '要哪一列'}</span>
                  {(mode === 'series' ? SCOPES : PICKS).map(([id, label]) => (
                    <button
                      key={id}
                      className={`btn sm${(mode === 'series' ? negScope : pick) === id ? ' primary' : ''}`}
                      onClick={() => (mode === 'series' ? setNegScope(id) : setPick(id))}
                    >{label}</button>
                  ))}
                </div>

                <div className="row wrap">
                  <span className="hint">分隔符</span>
                  {TERM_SEPS.map(([id, label]) => (
                    <button
                      key={id}
                      className={`btn sm${sep === id ? ' primary' : ''}`}
                      onClick={() => setSep(id)}
                    >{label}</button>
                  ))}
                </div>

                {mode === 'series' && (
                  series ? (
                    <div className="minigrid neghelp-mini">
                      <div className="mini"><span>投放型号</span><b>{models.length}</b></div>
                      <div className="mini"><span>否掉墨盒</span><b>{series.models.length}</b></div>
                      <div className="mini"><span>否掉打印机</span><b>{series.printers.length}</b></div>
                    </div>
                  ) : (
                    <p className="hint">先在左边勾出要投的墨盒型号,这里才算得出该否掉哪些。</p>
                  )
                )}
                {mode === 'series' && series?.qualified?.length > 0 && (
                  <p className="hint">
                    其中 {series.qualified.length} 个打印机数字在别的系列里也有,已自动带上系列名再否,
                    例如 <span className="mono">{series.qualified[0]}</span>。
                  </p>
                )}

                <textarea
                  className="inp neghelp-out" readOnly value={text}
                  placeholder="勾中左边的行,这里出词"
                  onFocus={(e) => e.target.select()}
                />

                <div className="row wrap">
                  <span className="stat">共 <b>{terms.length}</b> 个词</span>
                  <div className="spacer" />
                  <button className="btn sm primary" disabled={!terms.length} onClick={copy}>
                    复制全部
                  </button>
                </div>
                {copied && <p className="hint c-ok">{copied}</p>}
                <p className="hint">
                  后台粘贴口径:否定词组 / 否定精准都行,一般用否定词组。
                  打印机数字在别的系列里也出现过时,这里给的是带系列名的写法(例 DeskJet 2540),
                  免得把在投的机型也否掉。
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
