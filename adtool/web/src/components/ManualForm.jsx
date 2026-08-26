import { useState } from 'react';
import { ORDER, PLACEMENTS, parseLines } from '../adEngine.js';
import {
  MANUAL_STRATEGIES, MATCH_TYPES, TARGET_TYPES, DEFAULT_COEFS,
  parseKeywordLines, formatKeyword, bidFromCpc, strategyOf,
} from '../manualEngine.js';
import { Sec } from './FormBits.jsx';
import { LibraryNegatives, ExtraNegatives } from './NegPanels.jsx';
import SkuPicker from './SkuPicker.jsx';

/* 一条手动广告活动 = 一整页表单,和自动广告页一样所有区块同时可见 */

/* 界面上按 TOS → ROS → PP 排,和下面「最终 CPC」那张表一个顺序(写表还是按 PLACE_ROWS) */
const PLACE_UI = ORDER.map((k) => PLACEMENTS.find(([key]) => key === k));

/** 一种匹配类型 / 一种定向类型:开关 + 出价 + 粘贴框 */
function Unit({ on, label, hint, bid, text, count, placeholder, bidPlaceholder, bidNote, onChange }) {
  return (
    <div className={`unitbox${on ? ' on' : ''}`}>
      <div className="unitbox-head">
        <label className="unitbox-name">
          <input type="checkbox" checked={on} onChange={() => onChange({ on: !on })} />
          <b>{label}</b>
        </label>
        <span className="hint">{hint}</span>
        <div className="spacer" />
        <span className="stat"><b>{count}</b> 条</span>
        <input
          className="inp bidmini" type="number" step="0.01" placeholder={bidPlaceholder}
          value={bid} onChange={(e) => onChange({ bid: e.target.value })}
        />
      </div>
      {bidNote && <p className="hint unitbox-bid">{bidNote}</p>}
      <textarea
        className="inp" rows={6} placeholder={placeholder}
        value={text} onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}

export default function ManualForm({ task, plan, libCount, lib, market, onChange }) {
  const set = (patch) => onChange(patch);
  const [pick, setPick] = useState(false);
  const [pickNote, setPickNote] = useState('');
  const setUnit = (bucket, key, patch) =>
    onChange({ [bucket]: { ...task[bucket], [key]: { ...task[bucket][key], ...patch } } });

  const skuCount = parseLines(task.skus).length;
  const negCount = (plan?.campNegs?.length ?? 0) + (plan?.groupNegs?.length ?? 0);
  const asinCount = plan?.asins?.length ?? 0;
  const rows = [];
  for (const g of plan?.groups ?? []) {
    for (const u of g.units) {
      for (const it of u.items) rows.push({ group: g.name, label: u.label, text: it.text, bid: u.bid });
    }
  }

  /* ---- 出价 / 最终 CPC ---- */
  const cpcMode = task.bidMode === 'cpc';
  const factor = plan?.factor ?? 1;
  const driver = plan?.driver ?? null;
  const defBid = plan?.defBid ?? 0;
  const landing = plan?.landing ?? [];
  const withCoef = strategyOf(task.strategy).factor;   // 只有「提高和降低」才打系数

  /** 某个粘贴框实际会写进表里的出价:留空 = 广告组默认竞价;CPC 模式下填的是目标 CPC */
  function unitBid(cfg) {
    const raw = String(cfg?.bid ?? '').trim();
    const v = Number(raw);
    if (raw === '' || !isFinite(v)) return defBid;
    return cpcMode ? bidFromCpc(v, factor, task.rounding) : v;
  }
  function unitNote(cfg) {
    const b = unitBid(cfg);
    const raw = String(cfg?.bid ?? '').trim();
    const top = landing.find((r) => r.key === (driver ?? 'TOS'));
    const landed = top ? Math.round(b * top.factor * 1000) / 1000 : b;
    if (cpcMode) {
      return raw === ''
        ? `留空 = 用上面的目标 CPC,出价 ${b}`
        : `目标 CPC ${raw} ÷ ${factor} → 出价 ${b}`;
    }
    return driver ? `出价 ${b} · ${driver} 落地 CPC ${landed}` : `出价 ${b}`;
  }

  return (
    <div className="onepage mform">
      {/* ==================== 左列 ==================== */}
      <div className="col">
        <Sec n="1" title="广告活动参数">
          <label className="field">
            <span>广告活动名称 *</span>
            <input
              className="inp task-name" style={{ marginBottom: 0 }}
              placeholder="例:ES_SP_KW_301_精准"
              value={task.camp} onChange={(e) => set({ camp: e.target.value })}
            />
          </label>
          <div className="g2" style={{ marginTop: 11 }}>
            <label className="field">
              <span>广告组名称</span>
              <input
                className="inp" placeholder="留空则同活动名"
                value={task.group} onChange={(e) => set({ group: e.target.value })}
              />
            </label>
            <label className="field">
              <span>广告组合编号</span>
              <input className="inp mono" value={task.portfolio}
                onChange={(e) => set({ portfolio: e.target.value })} />
            </label>
          </div>
          <div className="g3" style={{ marginTop: 11 }}>
            <label className="field">
              <span>开始日期</span>
              <input className="inp mono" value={task.date}
                onChange={(e) => set({ date: e.target.value })} />
            </label>
            <label className="field">
              <span>每日预算</span>
              <input className="inp" type="number" step="0.1" value={task.budget}
                onChange={(e) => set({ budget: e.target.value })} />
            </label>
            <label className="field">
              <span>竞价方案</span>
              <select className="inp" value={task.strategy}
                onChange={(e) => set({ strategy: e.target.value })}>
                {MANUAL_STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="lbl block" style={{ margin: '13px 0 6px' }}>广告位溢价(%)</label>
          <div className="g3">
            {PLACE_UI.map(([key, label]) => (
              <label className="field" key={key}>
                <span title={label}>{key}</span>
                <input
                  className="inp" type="number" step="1" placeholder="0"
                  value={task.places[key]}
                  onChange={(e) => set({ places: { ...task.places, [key]: e.target.value } })}
                />
              </label>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            三个广告位都会写进表里,不加溢价的留空或填 0。
          </p>

          {/* ---- 出价:自己填 or 按目标 CPC 反推 ---- */}
          <label className="lbl block" style={{ margin: '15px 0 6px' }}>出价怎么定</label>
          <div className="seg" style={{ marginBottom: 10 }}>
            {[
              ['bid', '直接填出价', '出价就是写进表里的数,溢价另算'],
              ['cpc', '按目标 CPC 反推', '填想要的落地 CPC,按溢价和系数自动折算出价'],
            ].map(([id, label, desc]) => (
              <button
                key={id}
                className={`seg-item${(task.bidMode ?? 'bid') === id ? ' on' : ''}`}
                onClick={() => set({ bidMode: id })}
              >
                <b>{label}</b>
                <span>{desc}</span>
              </button>
            ))}
          </div>

          {cpcMode ? (
            <>
              <div className="g2">
                <label className="field">
                  <span>目标 CPC(落地价)</span>
                  <input className="inp" type="number" step="0.01" value={task.baseBid}
                    onChange={(e) => set({ baseBid: e.target.value })} />
                </label>
                <label className="field">
                  <span>小数处理</span>
                  <select className="inp" value={task.rounding}
                    onChange={(e) => set({ rounding: e.target.value })}>
                    <option value="round">四舍五入 2 位</option>
                    <option value="trunc">截断 2 位</option>
                  </select>
                </label>
              </div>
              <div className="coefbox">
                <div className="coefbox-title">
                  <span>提高和降低 · 广告位系数</span>
                  <span className="hint">
                    {withCoef ? '按最贵的那个广告位折算' : '当前竞价方案一律 ×1,改成「提高和降低」才用得上'}
                  </span>
                </div>
                <div className="g3">
                  {PLACE_UI.map(([key]) => (
                    <label className="field" key={key}>
                      <span>{key}</span>
                      <input
                        className="inp" type="number" step="0.1" disabled={!withCoef}
                        value={task.coefs?.[key] ?? DEFAULT_COEFS[key]}
                        onChange={(e) => set({ coefs: { ...task.coefs, [key]: e.target.value } })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <label className="field">
              <span>广告组默认竞价</span>
              <input className="inp" type="number" step="0.01" value={task.defBid}
                onChange={(e) => set({ defBid: e.target.value })} />
            </label>
          )}

          {/* ---- 最终 CPC ---- */}
          <div className="cpcbox">
            <div className="coefbox-title">
              <span>最终 CPC</span>
              <span className="hint">落地 CPC = 出价 × (1+溢价) × 系数,溢价 0 的位置不打系数</span>
              <div className="spacer" />
              <span className="stat">广告组默认竞价 <b>{defBid}</b></span>
            </div>
            <table className="tbl cpctbl">
              <thead>
                <tr><th>广告位</th><th>溢价</th><th>系数</th><th>倍数</th><th>落地 CPC</th></tr>
              </thead>
              <tbody>
                {landing.map((r) => (
                  <tr key={r.key} className={r.key === driver ? 'drv' : ''}>
                    <td>{r.key}{r.key === driver && <span className="tag amber" style={{ marginLeft: 6 }}>最贵</span>}</td>
                    <td className="mono">{r.pct}%</td>
                    <td className="mono">×{r.coef}</td>
                    <td className="mono c-dim">×{r.factor}</td>
                    <td><span className="bidpill">{r.cpc}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 8 }}>
              {cpcMode
                ? <>目标 CPC {task.baseBid} ÷ {factor}{driver ? `(${driver} 最贵)` : ''} = 出价{' '}
                  <b className="c-text">{defBid}</b>,这样任何广告位的落地 CPC 都不会超过目标。</>
                : <>出价 {defBid} 写进表里,上面是各广告位实际会被扣到的价。
                  想反过来按落地 CPC 定价,就切到「按目标 CPC 反推」。</>}
            </p>
          </div>
        </Sec>

        <Sec
          n="2" title="投放 SKU · 每行一个"
          meta={<span className="stat"><b>{skuCount}</b> 个</span>}
        >
          <textarea
            className="inp" rows={10} placeholder="这条活动要投的 SKU"
            value={task.skus} onChange={(e) => set({ skus: e.target.value })}
          />
          <div className="row wrap" style={{ marginTop: 9 }}>
            <button className="btn sm" onClick={() => setPick(true)}>从 SKU 库选</button>
            <button className="btn sm" onClick={() => { set({ skus: '' }); setPickNote(''); }}>清空</button>
            <div className="spacer" />
            <p className="hint">自动去重、去空行、压缩多余空格。</p>
          </div>
          {pickNote && <p className="hint c-ok" style={{ marginTop: 6 }}>{pickNote}</p>}
          {pick && (
            <SkuPicker
              market={market}
              current={task.skus}
              onApply={(text, note) => { set({ skus: text }); setPickNote(note); }}
              onClose={() => setPick(false)}
            />
          )}
        </Sec>

        <Sec
          n="3" title="否定词库" tone="green"
          meta={<span className="stat"><b>{libCount}</b> 条</span>}
        >
          <LibraryNegatives task={task} lib={lib} plan={plan} onChange={onChange} />
        </Sec>
      </div>

      {/* ==================== 中列 ==================== */}
      <div className="col">
        <Sec
          n="4" title="投放方式" tone="violet"
          meta={<span className="stat"><b>{plan?.targets ?? 0}</b> 条</span>}
        >
          <div className="seg">
            {[
              ['kw', '关键词投放', '自己粘贴关键词,按精准 / 词组 / 广泛分别给出价'],
              ['tgt', '商品投放', '自己粘贴 ASIN 或品类 ID,写成商品定向行'],
            ].map(([id, label, desc]) => (
              <button
                key={id}
                className={`seg-item${task.mode === id ? ' on' : ''}`}
                onClick={() => set({ mode: id })}
              >
                <b>{label}</b>
                <span>{desc}</span>
              </button>
            ))}
          </div>

          <p className="hint" style={{ margin: '10px 0 11px' }}>
            一个广告组要么打关键词、要么打商品定向,亚马逊不允许混投,所以这里二选一。
            {cpcMode
              ? '出价框里填的是这一类的目标 CPC,留空就用上面那个;写进表里的是折算后的出价。'
              : '出价留空就用上面的广告组默认竞价。'}
          </p>

          {task.mode === 'kw'
            ? MATCH_TYPES.map((mt) => {
              const cfg = task.kw[mt.id];
              return (
                <Unit
                  key={mt.id}
                  on={cfg.on} label={`${mt.label}匹配`} hint={mt.hint}
                  bid={cfg.bid} text={cfg.text}
                  count={parseKeywordLines(cfg.text).length}
                  placeholder={'从表格里直接粘贴,每行一个词'}
                  bidPlaceholder={cpcMode ? '目标CPC' : '出价'}
                  bidNote={cfg.on ? unitNote(cfg) : ''}
                  onChange={(patch) => setUnit('kw', mt.id, patch)}
                />
              );
            })
            : TARGET_TYPES.map((tt) => {
              const cfg = task.tgt[tt.id];
              return (
                <Unit
                  key={tt.id}
                  on={cfg.on} label={tt.label} hint={tt.hint}
                  bid={cfg.bid} text={cfg.text}
                  count={parseLines(cfg.text).length}
                  placeholder={tt.id === 'category' ? '34285014031' : 'B08T1HR5CS'}
                  bidPlaceholder={cpcMode ? '目标CPC' : '出价'}
                  bidNote={cfg.on ? unitNote(cfg) : ''}
                  onChange={(patch) => setUnit('tgt', tt.id, patch)}
                />
              );
            })}

          <label className="switchrow" style={{ marginTop: 11 }}>
            <input
              type="checkbox" checked={task.splitGroup}
              onChange={() => set({ splitGroup: !task.splitGroup })}
            />
            <span className="switchrow-main">
              <b>每种{task.mode === 'kw' ? '匹配' : '定向'}类型单独一个广告组</b>
              <span className="hint">
                广告组名后面接类型后缀,SKU 和否定词每个组都写一遍;
                不勾就全部塞进同一个广告组。
              </span>
            </span>
          </label>

          {task.mode === 'kw' && (
            <p className="hint" style={{ marginTop: 10 }}>
              精准写成 <span className="mono">[词]</span>、词组写成{' '}
              <span className="mono">&quot;词&quot;</span>、广泛不加标记,粘进来时自带的引号或方括号会先去掉再统一加。
              示例:<span className="mono">{formatKeyword('hp 301 ink', '精准')}</span>
            </p>
          )}
          {task.mode === 'tgt' && (
            <p className="hint" style={{ marginTop: 10 }}>
              填纯 ASIN 即可,自动写成 <span className="mono">asin=&quot;B0…&quot;</span> /{' '}
              <span className="mono">asin-expanded=&quot;B0…&quot;</span>;
              已经写好的表达式原样保留。
            </p>
          )}
        </Sec>

        <Sec
          n="5" title="本任务额外否定" tone="amber"
          meta={<span className="stat">+<b>{negCount + asinCount}</b> 行/条</span>}
        >
          <ExtraNegatives
            task={task} negCount={negCount} asinCount={asinCount}
            lib={lib} market={market} onChange={onChange}
          />
        </Sec>
      </div>

      {/* ==================== 右列 · 预览 ==================== */}
      <div className="col col-preview">
        <Sec
          n="6" title="本条活动预览" tone="green"
          meta={
            plan?.problems?.length
              ? <span className="tag amber">{plan.problems.length} 项待处理</span>
              : <span className="tag green">就绪</span>
          }
        >
          <div className="minigrid">
            <div className="mini"><span>广告组</span><b>{plan?.groups?.length ?? 0}</b></div>
            <div className="mini">
              <span>{task.mode === 'kw' ? '关键词' : '商品定向'}</span><b>{plan?.targets ?? 0}</b>
            </div>
            <div className="mini"><span>总行数</span><b>{plan?.rows ?? 0}</b></div>
          </div>

          {plan?.problems?.length > 0 && (
            <div className="note err probs">
              <div>{plan.problems.map((p, i) => <div key={i}>· {p}</div>)}</div>
            </div>
          )}
          {plan?.warnings?.length > 0 && (
            <div className="note warn probs">
              <div>{plan.warnings.map((p, i) => <div key={i}>· {p}</div>)}</div>
            </div>
          )}

          <p className="hint" style={{ marginBottom: 9 }}>
            结构:1 广告活动 + {PLACEMENTS.length} 竞价调整
            {plan?.campNegs?.length ? ` + ${plan.campNegs.length} 活动级否定` : ''}
            ,每个广告组 1 + {skuCount} SKU + 投放
            {plan?.groupNegs?.length ? ` + ${plan.groupNegs.length} 否定词` : ''}
            {plan?.asins?.length ? ` + ${plan.asins.length} 否定 ASIN` : ''}。
          </p>

          <div className="scroll previewbox">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>广告组</th><th>类型</th><th>写入文本</th><th>出价</th></tr>
              </thead>
              <tbody>
                {rows.slice(0, 400).map((r, i) => (
                  <tr key={`${r.group}|${r.text}`}>
                    <td className="c-faint">{i + 1}</td>
                    <td className="mono namecell">{r.group}</td>
                    <td>{r.label}</td>
                    <td className="mono namecell">{r.text}</td>
                    <td><span className="bidpill">{r.bid}</span></td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr><td colSpan={5} className="empty">还没有可写入的关键词 / 商品定向</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {rows.length > 400 && (
            <p className="hint" style={{ marginTop: 8 }}>只列出前 400 条,生成的表里是全部 {rows.length} 条。</p>
          )}
        </Sec>
      </div>
    </div>
  );
}
