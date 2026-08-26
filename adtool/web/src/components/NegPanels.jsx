import { useMemo, useState } from 'react';
import { seriesGroups } from '../adEngine.js';
import { modelKey } from '../skuMatch.js';
import { parseQuery, printerLib } from '../printerLib.js';
import PrinterPicker from './PrinterPicker.jsx';

/**
 * 否定相关的两块面板 —— 自动广告页和手动广告页共用。
 * 两边的任务对象都带着同一批字段(libUse / adType / seriesModels / seriesScope / extraNeg),
 * 所以否定逻辑只有 adEngine.buildNegatives 这一份实现。
 */

/** 词库联动:混合 / 系列广告 + D 类型号选择 + 本任务套用哪几类库 */
export function LibraryNegatives({ task, lib, plan, onChange }) {
  const set = (patch) => onChange(patch);
  const [modelFilter, setModelFilter] = useState('');

  // D 类:本区在售的墨盒型号组,「575, 576」这种一起卖的算一组
  const dSpec = (lib?.libs ?? []).find((l) => l.special === 'series');
  const groups = useMemo(
    () => seriesGroups(dSpec ? lib?.items?.[dSpec.id] ?? [] : []),
    [lib, dSpec]
  );
  const picked = task.seriesModels ?? [];
  const pickedSet = new Set(picked.map((m) => m.toLowerCase()));
  // 搜索框认逗号 / 换行分开的多个型号,「305, 304」一次筛出两个系列
  const shownGroups = useMemo(() => {
    const terms = parseQuery(modelFilter).map((g) => g.join(' '));
    if (!terms.length) return groups;
    return groups.filter((g) => terms.some((t) =>
      g.label.toLowerCase().includes(t) || g.models.some((m) => modelKey(m) === modelKey(t))));
  }, [groups, modelFilter]);
  const filtering = shownGroups.length !== groups.length;

  /** 把筛出来的型号一次全勾上 —— 一个系列广告投好几个型号时省得一个个点 */
  function pickShown() {
    const add = [];
    for (const g of shownGroups) {
      for (const m of g.models) if (!pickedSet.has(m.toLowerCase())) add.push(m);
    }
    if (add.length) set({ seriesModels: [...picked, ...add] });
  }

  function toggleGroup(g) {
    const on = g.models.some((m) => pickedSet.has(m.toLowerCase()));
    const drop = new Set(g.models.map((m) => m.toLowerCase()));
    const next = on
      ? picked.filter((m) => !drop.has(m.toLowerCase()))
      : [...picked, ...g.models.filter((m) => !pickedSet.has(m.toLowerCase()))];
    set({ seriesModels: next });
  }

  return (
    <>
      <label className="lbl">这个任务开的是哪种广告</label>
      <div className="seg mt5">
        {[
          ['mixed', '混合广告', '一条活动里什么型号都投,D 类不做联动否定'],
          ['series', '系列广告', '只投选中的墨盒系列,其它型号和打印机自动否掉'],
        ].map(([id, label, desc]) => (
          <button
            key={id}
            className={`seg-item${task.adType === id ? ' on' : ''}`}
            onClick={() => set({ adType: id })}
          >
            <b>{label}</b>
            <span>{desc}</span>
          </button>
        ))}
      </div>

      {task.adType === 'series' && (
        <div className="serieskit">
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <input
              className="inp" style={{ flex: 1, minWidth: 120 }}
              placeholder="搜墨盒型号…(逗号分开一次搜多个,例 305, 304)"
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
            />
            {filtering && shownGroups.length > 0 && (
              <button className="btn sm" onClick={pickShown}>全选搜到的 {shownGroups.length}</button>
            )}
            {picked.length > 0 && (
              <button className="btn sm" onClick={() => set({ seriesModels: [] })}>清空</button>
            )}
          </div>

          <div className="scroll modelbox">
            <div className="chips">
              {shownGroups.map((g) => {
                const on = g.models.some((m) => pickedSet.has(m.toLowerCase()));
                return (
                  <label key={g.label} className={`chip${on ? ' on' : ''}`} title={`${g.count} 台打印机`}>
                    <input type="checkbox" checked={on} onChange={() => toggleGroup(g)} />
                    {g.label}
                    <span className="chip-sub">{g.count}</span>
                  </label>
                );
              })}
              {!shownGroups.length && (
                <span className="hint">
                  {groups.length ? '没有匹配的型号' : 'D 类词库这个区域还没有数据,先让商品部上传'}
                </span>
              )}
            </div>
          </div>

          <div className="row wrap" style={{ marginBottom: 8 }}>
            <span className="hint">联动否定</span>
            {[
              ['both', '墨盒 + 打印机'],
              ['models', '只否墨盒型号'],
              ['printers', '只否打印机型号'],
            ].map(([id, label]) => (
              <button
                key={id}
                className={`btn sm${(task.seriesScope ?? 'both') === id ? ' primary' : ''}`}
                onClick={() => set({ seriesScope: id })}
              >{label}</button>
            ))}
          </div>

          {plan?.series ? (
            <div className="seriesout">
              <div className="minigrid">
                <div className="mini"><span>投放型号</span><b>{picked.length}</b></div>
                <div className="mini"><span>否掉墨盒</span><b>{plan.series.models.length}</b></div>
                <div className="mini"><span>否掉打印机</span><b>{plan.series.printers.length}</b></div>
              </div>
              {plan.series.qualified.length > 0 && (
                <p className="hint" style={{ marginTop: 8 }}>
                  其中 {plan.series.qualified.length} 个打印机数字在别的系列里也有,
                  已自动带上系列名再否,例如 <span className="mono">{plan.series.qualified[0]}</span>。
                </p>
              )}
            </div>
          ) : (
            <p className="hint" style={{ marginTop: 8 }}>
              选中要投的墨盒型号后,这里会显示自动否掉多少个型号。
            </p>
          )}
        </div>
      )}

      <label className="lbl block" style={{ margin: '13px 0 6px' }}>本任务套用哪几类词库</label>
      <div className="stack" style={{ gap: 6 }}>
        {(lib?.libs ?? []).map((l) => {
          const items = lib?.items?.[l.id] ?? [];
          const scope = lib?.scopes?.[l.id];
          const off = lib?.config?.[l.id]?.enabled === false;
          const on = !!task.libUse?.[l.id];
          return (
            <div key={l.id} className={`tokrow${on && !off && scope ? '' : ' off'}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={!scope}
                onChange={() => set({ libUse: { ...task.libUse, [l.id]: !on } })}
              />
              <span className="tokrow-i">{l.id}</span>
              <span style={{ flex: 1 }}>
                {l.name}
                {l.special === 'series' && (
                  <span className="chip-sub"> 只在系列广告里生效</span>
                )}
              </span>
              <span className="stat">
                <b>{items.length}</b> {scope ? scope.scope : '本站没有'}
              </span>
              {off && <span className="tag gray">站点已停用</span>}
            </div>
          );
        })}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        词库在「否定词库」页维护。勾上的会合并去重后写进这个任务生成的每一条活动;
        「站点已停用」的那几类在词库页里被关掉了,勾了也不会带。
      </p>
    </>
  );
}

/** 本任务临时否定:两级否定关键词 + 否定商品定向,可以从 D 类打印机库直接挑词进来 */
export function ExtraNegatives({ task, negCount, asinCount, lib, market, onChange }) {
  const setNeg = (patch) => onChange({ extraNeg: { ...task.extraNeg, ...patch } });
  const [pick, setPick] = useState(false);
  const [pickNote, setPickNote] = useState('');
  const printerCount = useMemo(() => printerLib(lib).items.length, [lib]);

  return (
    <>
      <div className="row wrap" style={{ marginBottom: 9 }}>
        <button className="btn sm" onClick={() => setPick(true)}>从打印机库选</button>
        <span className="hint">
          在 D 类库里搜墨盒型号或打印机机型,勾中的一键写进下面的否定词框
          {printerCount ? `(本区 ${printerCount} 行)` : ''}
        </span>
      </div>
      {pickNote && <p className="hint c-ok" style={{ marginBottom: 9 }}>{pickNote}</p>}
      {pick && (
        <PrinterPicker
          market={market}
          lib={lib}
          task={task}
          onApply={(patch, note) => { setNeg(patch); setPickNote(note); }}
          onClose={() => setPick(false)}
        />
      )}

      <p className="hint" style={{ marginBottom: 11 }}>
        只对这个任务生效,和词库合并后一起写进每条活动,重复的自动去掉。
      </p>

      <div className="negsec">否定关键词 · 广告组级</div>
      <div className="g2">
        <label className="field">
          <span>否定精准匹配</span>
          <textarea className="inp" rows={3} value={task.extraNeg.negExact}
            onChange={(e) => setNeg({ negExact: e.target.value })} />
        </label>
        <label className="field">
          <span>否定词组</span>
          <textarea className="inp" rows={3} value={task.extraNeg.negPhrase}
            onChange={(e) => setNeg({ negPhrase: e.target.value })} />
        </label>
      </div>

      <div className="negsec">否定关键词 · 广告活动级<span>一般在这否定</span></div>
      <div className="g2">
        <label className="field">
          <span>否定精准匹配</span>
          <textarea className="inp" rows={3} value={task.extraNeg.cnegExact}
            onChange={(e) => setNeg({ cnegExact: e.target.value })} />
        </label>
        <label className="field">
          <span>否定词组</span>
          <textarea className="inp" rows={3} value={task.extraNeg.cnegPhrase}
            onChange={(e) => setNeg({ cnegPhrase: e.target.value })} />
        </label>
      </div>

      <div className="negsec">否定商品定向(ASIN)</div>
      <textarea
        className="inp" rows={3} placeholder={'B08T1HR5CS\nB087DH9GT3'}
        value={task.extraNeg.negAsin}
        onChange={(e) => setNeg({ negAsin: e.target.value })}
      />
      <div className="row wrap" style={{ marginTop: 9 }}>
        <span className="stat">否定词 <b>{negCount}</b></span>
        <span className="stat">ASIN <b>{asinCount}</b></span>
        <div className="spacer" />
        <span className="hint">纯 ASIN 即可,自动补成 asin=&quot;B0…&quot;</span>
      </div>
    </>
  );
}
