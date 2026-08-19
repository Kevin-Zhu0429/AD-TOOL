import { useState } from 'react';
import {
  AUTO_TYPES, STRATEGIES, PLACEMENTS, AUTO_ZH, parseLines,
} from '../adEngine.js';
import { Chips, Sec } from './FormBits.jsx';
import { LibraryNegatives, ExtraNegatives } from './NegPanels.jsx';
import SkuPicker from './SkuPicker.jsx';

/* 一个任务 = 一整页表单,所有区块同时可见,不再分标签页 */

const tiersOf = (text) =>
  String(text ?? '').split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));

export default function TaskForm({ task, plan, index, libCount, lib, market, onChange }) {
  const set = (patch) => onChange(patch);
  const [pick, setPick] = useState(false);
  const [pickNote, setPickNote] = useState('');

  const skuCount = parseLines(task.skus).length;
  const negCount = plan?.negs?.length ?? 0;
  const asinCount = plan?.asins?.length ?? 0;
  const campaigns = plan?.campaigns ?? [];
  const demo = campaigns[0];

  return (
    <div className="onepage">
      {/* ==================== 左列 ==================== */}
      <div className="col">
        <Sec
          n="1"
          title="SKU · 每行一个"
          meta={<span className="stat"><b>{skuCount}</b> 个</span>}
        >
          <input
            className="inp task-name"
            placeholder={`任务 ${index + 1} 名称(选填,只用于自己分辨)`}
            value={task.title}
            onChange={(e) => set({ title: e.target.value })}
          />
          <textarea
            className="inp"
            rows={12}
            placeholder="填这个任务要投的 SKU"
            value={task.skus}
            onChange={(e) => set({ skus: e.target.value })}
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
          n="2"
          title="否定词库"
          tone="green"
          meta={<span className="stat"><b>{libCount}</b> 条</span>}
        >
          <LibraryNegatives task={task} lib={lib} plan={plan} onChange={onChange} />
        </Sec>

        <Sec
          n="3"
          title="本任务额外否定"
          tone="amber"
          meta={<span className="stat">+<b>{negCount + asinCount}</b> 行/条</span>}
        >
          <ExtraNegatives
            task={task} negCount={negCount} asinCount={asinCount} onChange={onChange}
          />
        </Sec>
      </div>

      {/* ==================== 中列 ==================== */}
      <div className="col">
        <Sec
          n="4"
          title="生成组合"
          meta={<span className="stat"><b>{campaigns.length}</b> 条活动</span>}
        >
          <label className="lbl">自动广告类型</label>
          <div className="mb12 mt5">
            <Chips
              items={AUTO_TYPES.map(([id]) => ({ id, label: id, sub: AUTO_ZH[id] }))}
              value={task.autoTypes}
              onChange={(v) => set({ autoTypes: v })}
            />
          </div>

          <label className="lbl">竞价方案</label>
          <div className="mb12 mt5">
            <Chips
              items={STRATEGIES.map((s) => ({ id: s.id, label: s.label }))}
              value={task.strategies}
              onChange={(v) => set({ strategies: v })}
            />
          </div>

          <div className="seg">
            {[
              ['wf', '瀑布流', '一条活动一个广告位 × 溢价档位'],
              ['combo', '组合', '一条活动多个广告位,各给各的溢价'],
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

          {task.mode === 'wf' ? (
            <>
              <label className="lbl">
                溢价位置 <span className="c-faint">(一个都不选 = 不加溢价)</span>
              </label>
              <div className="mt5 mb9">
                <Chips
                  items={PLACEMENTS.map(([id]) => ({ id, label: id }))}
                  value={task.places}
                  onChange={(v) => set({ places: v })}
                />
              </div>
              <div className="row wrap mb12">
                <button className="btn sm" onClick={() => set({ places: [] })}>不加溢价</button>
                <button className="btn sm" onClick={() => set({ places: ['TOS', 'ROS'] })}>TOS+ROS</button>
                <button className="btn sm" onClick={() => set({ places: ['TOS', 'ROS', 'PP'] })}>三个位置</button>
              </div>
              <label className="field">
                <span>溢价档位(%,逗号分隔)</span>
                <input
                  className="inp mono" disabled={!task.places.length}
                  value={task.tiers} onChange={(e) => set({ tiers: e.target.value })}
                />
              </label>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => set({ tiers: '20,35,50,80,100,200,300,500,800,900' })}
                >标准 10 档</button>
                <span className="hint">
                  {task.places.length
                    ? `${task.places.length} 个广告位 × ${tiersOf(task.tiers).length} 档 × 投放方式 × 竞价方案`
                    : '不加溢价:三行竞价调整全写 0,命名里也不带位置和溢价。'}
                </span>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>溢价组合(一行 = 一条活动)</span>
                <textarea
                  className="inp" rows={6} placeholder={'TOS:100 ROS:50\nTOS:200 ROS:100'}
                  value={task.combos} onChange={(e) => set({ combos: e.target.value })}
                />
              </label>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => set({ combos: tiersOf(task.tiers).map((v) => `TOS:${v} ROS:${v}`).join('\n') })}
                >档位→TOS=ROS</button>
                <button
                  className="btn sm"
                  onClick={() => set({ combos: tiersOf(task.tiers).map((v) => `TOS:${v} ROS:${Math.round(v / 2)}`).join('\n') })}
                >档位→ROS减半</button>
                <button className="btn sm" onClick={() => set({ combos: '' })}>清空</button>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                <span className="mono">TOS:100 ROS:50</span>、<span className="mono">TOS=100,ROS=50</span> 都认;
                没写到的广告位按 0 处理,也不进命名。
              </p>
            </>
          )}
        </Sec>

        <Sec n="5" title="命名规则" tone="violet">
          <div className="g2">
            <label className="field">
              <span>前缀(自己写)</span>
              <input className="inp" value={task.prefix} onChange={(e) => set({ prefix: e.target.value })} />
            </label>
            <label className="field">
              <span>分隔符</span>
              <input className="inp mono" value={task.sep} onChange={(e) => set({ sep: e.target.value })} />
            </label>
          </div>

          <label className="lbl block" style={{ margin: '13px 0 6px' }}>
            后缀字段 · 勾选启用,↑↓ 调顺序
          </label>
          <div className="stack" style={{ gap: 6 }}>
            {task.tokens.map((t, i) => (
              <div key={t.id} className={`tokrow${t.on ? '' : ' off'}`}>
                <input
                  type="checkbox" checked={t.on}
                  onChange={() => set({ tokens: task.tokens.map((x, j) => (j === i ? { ...x, on: !x.on } : x)) })}
                />
                <span className="tokrow-i">{i + 1}</span>
                <span style={{ flex: 1 }}>{t.label}</span>
                <button
                  className="btn sm ghost" disabled={i === 0}
                  onClick={() => {
                    const next = [...task.tokens];
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    set({ tokens: next });
                  }}
                >↑</button>
                <button
                  className="btn sm ghost" disabled={i === task.tokens.length - 1}
                  onClick={() => {
                    const next = [...task.tokens];
                    [next[i + 1], next[i]] = [next[i], next[i + 1]];
                    set({ tokens: next });
                  }}
                >↓</button>
              </div>
            ))}
          </div>

          <label className="field" style={{ marginTop: 13 }}>
            <span>自动投放方式写法</span>
            <select className="inp" value={task.autoLang} onChange={(e) => set({ autoLang: e.target.value })}>
              <option value="en">Close / Loose / Substitutes / Complements</option>
              <option value="zh">紧密 / 宽泛 / 同类 / 关联</option>
            </select>
          </label>

          <div className="namedemo">
            {demo ? (
              <><span className="namedemo-k">命名示例</span><b className="mono">{demo.name}</b></>
            ) : (
              <span className="c-faint">先勾选自动投放方式和竞价方案</span>
            )}
          </div>
        </Sec>

        <Sec n="6" title="参数与出价">
          <div className="g2">
            <label className="field">
              <span>广告组合编号</span>
              <input className="inp mono" value={task.portfolio}
                onChange={(e) => set({ portfolio: e.target.value })} />
            </label>
            <label className="field">
              <span>开始日期</span>
              <input className="inp mono" value={task.date}
                onChange={(e) => set({ date: e.target.value })} />
            </label>
          </div>
          <div className="g3" style={{ marginTop: 11 }}>
            <label className="field">
              <span>每日预算</span>
              <input className="inp" type="number" step="0.1" value={task.budget}
                onChange={(e) => set({ budget: e.target.value })} />
            </label>
            <label className="field">
              <span>默认竞价</span>
              <input className="inp" type="number" step="0.01" value={task.defBid}
                onChange={(e) => set({ defBid: e.target.value })} />
            </label>
            <label className="field">
              <span>暂停项出价</span>
              <input className="inp" type="number" step="0.01" value={task.idleBid}
                onChange={(e) => set({ idleBid: e.target.value })} />
            </label>
          </div>
          <div className="g2" style={{ marginTop: 11 }}>
            <label className="field">
              <span>出价基数 CPC</span>
              <input className="inp" type="number" step="0.01" value={task.baseBid}
                onChange={(e) => set({ baseBid: e.target.value })} />
            </label>
            <label className="field">
              <span>小数处理</span>
              <select className="inp" value={task.rounding} onChange={(e) => set({ rounding: e.target.value })}>
                <option value="round">四舍五入 2 位</option>
                <option value="trunc">截断 2 位</option>
              </select>
            </label>
          </div>

          <div className="coefbox">
            <div className="coefbox-title">
              <span>提高和降低 · 广告位系数</span>
              <span className="hint">固定竞价 / 仅降低一律 ×1</span>
            </div>
            <div className="g3">
              {PLACEMENTS.map(([key]) => (
                <label className="field" key={key}>
                  <span>{key}</span>
                  <input
                    className="inp" type="number" step="0.1" value={task.coefs[key]}
                    onChange={(e) => set({ coefs: { ...task.coefs, [key]: e.target.value } })}
                  />
                </label>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 10 }}>
              出价 = CPC ÷ ((1+溢价) × 系数)<br />
              例:TOS·100%·提降 → {task.baseBid} ÷ ((1+100%)×{task.coefs.TOS}) ={' '}
              <b className="c-text">
                {(Number(task.baseBid) / ((1 + 1) * Number(task.coefs.TOS) || 1)).toFixed(2)}
              </b><br />
              不加位置溢价时 → 出价 = CPC 基数 <b className="c-text">{task.baseBid}</b>(不打系数)
            </p>
          </div>
        </Sec>
      </div>

      {/* ==================== 右列 · 预览 ==================== */}
      <div className="col col-preview">
        <Sec
          n="7"
          title="本任务预览"
          tone="green"
          meta={
            plan?.problems?.length
              ? <span className="tag amber">{plan.problems.length} 项待处理</span>
              : <span className="tag green">就绪</span>
          }
        >
          <div className="minigrid">
            <div className="mini">
              <span>广告活动</span><b>{campaigns.length}</b>
            </div>
            <div className="mini">
              <span>每条行数</span><b>{plan?.blockRows ?? 0}</b>
            </div>
            <div className="mini">
              <span>本任务行数</span><b>{campaigns.length * ((plan?.blockRows ?? 0) + 1)}</b>
            </div>
          </div>

          {plan?.problems?.length > 0 && (
            <div className="note warn probs">
              <div>
                {plan.problems.map((p, i) => <div key={i}>· {p}</div>)}
              </div>
            </div>
          )}

          <div className="scroll previewbox">
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th><th>广告活动名称</th><th>广告位</th><th>溢价</th><th>折算</th><th>出价</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((p, i) => (
                  <tr key={p.name}>
                    <td className="c-faint">{i + 1}</td>
                    <td className="mono namecell">{p.name}</td>
                    <td>{p.active.length ? p.active.join('+') : <span className="c-faint">无溢价</span>}</td>
                    <td className="mono">{p.active.length ? p.active.map((k) => `${p.prem[k]}%`).join(' / ') : '—'}</td>
                    <td className="mono c-dim">
                      {p.factor === 1 ? '—' : `÷${p.factor}${p.driver ? ` ${p.driver}` : ''}`}
                    </td>
                    <td><span className="bidpill">{p.bid}</span></td>
                  </tr>
                ))}
                {!campaigns.length && (
                  <tr><td colSpan={6} className="empty">当前组合没有可生成的广告活动</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Sec>
      </div>
    </div>
  );
}
