import { useState } from 'react';
import {
  AUTO_TYPES, STRATEGIES, PLACEMENTS, AUTO_ZH,
  parseLines, campName, strategyOf,
} from '../adEngine.js';

function Chips({ items, value, onChange }) {
  return (
    <div className="chips">
      {items.map(({ id, label }) => {
        const on = value.includes(id);
        return (
          <label key={id} className={`chip${on ? ' on' : ''}`}>
            <input
              type="checkbox" checked={on}
              onChange={() => onChange(on ? value.filter((v) => v !== id) : [...value, id])}
            />
            {label}
          </label>
        );
      })}
    </div>
  );
}

const TABS = [
  { id: 'basic', label: 'SKU 与组合' },
  { id: 'name', label: '命名规则' },
  { id: 'params', label: '参数与出价' },
  { id: 'neg', label: '否定投放' },
  { id: 'preview', label: '预览' },
];

export default function TaskEditor({ task, plan, index, libCount, libTerms, onChange }) {
  const [tab, setTab] = useState('basic');
  const set = (patch) => onChange(patch);
  const setNeg = (patch) => onChange({ extraNeg: { ...task.extraNeg, ...patch } });

  const skuCount = parseLines(task.skus).length;
  const demo = plan?.campaigns?.[0];

  return (
    <div className="editor">
      <div className="editor-head">
        <input
          className="inp editor-title"
          placeholder={`任务 ${index + 1} 名称(选填,只用于自己分辨)`}
          value={task.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </div>

      <div className="editor-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`editor-tab${tab === t.id ? ' on' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'preview' && plan?.campaigns?.length ? (
              <span className="tag gray" style={{ marginLeft: 6 }}>{plan.campaigns.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      {plan?.problems?.length > 0 && (
        <div className="note warn editor-problems">
          {plan.problems.map((p, i) => <div key={i}>· {p}</div>)}
        </div>
      )}

      <div className="editor-body">
        {/* ---------------- SKU 与组合 ---------------- */}
        {tab === 'basic' && (
          <div className="g2 editor-grid">
            <div className="card">
              <div className="card-title"><span className="num">1</span>SKU · 每行一个</div>
              <textarea
                className="inp" rows={13} placeholder="填这个任务要投的 SKU"
                value={task.skus} onChange={(e) => set({ skus: e.target.value })}
              />
              <div className="row" style={{ marginTop: 9 }}>
                <span className="stat">已填 <b>{skuCount}</b> 个</span>
                <div className="spacer" />
                <button className="btn sm" onClick={() => set({ skus: '' })}>清空</button>
              </div>
              <p className="hint" style={{ marginTop: 7 }}>自动去重、去空行、压缩多余空格。</p>
            </div>

            <div className="stack">
              <div className="card">
                <div className="card-title"><span className="num">2</span>生成组合</div>

                <label className="lbl">自动广告类型</label>
                <div style={{ margin: '5px 0 12px' }}>
                  <Chips
                    items={AUTO_TYPES.map(([id]) => ({ id, label: `${id} · ${AUTO_ZH[id]}` }))}
                    value={task.autoTypes}
                    onChange={(v) => set({ autoTypes: v })}
                  />
                </div>

                <label className="lbl">竞价方案</label>
                <div style={{ margin: '5px 0 12px' }}>
                  <Chips
                    items={STRATEGIES.map((s) => ({ id: s.id, label: s.label }))}
                    value={task.strategies}
                    onChange={(v) => set({ strategies: v })}
                  />
                </div>

                <label className="field" style={{ marginBottom: 11 }}>
                  <span>溢价方式</span>
                  <select className="inp" value={task.mode} onChange={(e) => set({ mode: e.target.value })}>
                    <option value="wf">瀑布流 · 一条活动一个广告位 × 溢价档位</option>
                    <option value="combo">组合 · 一条活动多个广告位,各给各的溢价</option>
                  </select>
                </label>

                {task.mode === 'wf' ? (
                  <>
                    <label className="lbl">
                      溢价位置 <span style={{ color: 'var(--text-faint)' }}>(一个都不选 = 不加溢价)</span>
                    </label>
                    <div style={{ margin: '5px 0 9px' }}>
                      <Chips
                        items={PLACEMENTS.map(([id]) => ({ id, label: id }))}
                        value={task.places}
                        onChange={(v) => set({ places: v })}
                      />
                    </div>
                    <div className="row wrap" style={{ marginBottom: 11 }}>
                      <button className="btn sm" onClick={() => set({ places: [] })}>不加溢价</button>
                      <button className="btn sm" onClick={() => set({ places: ['TOS', 'ROS'] })}>TOS+ROS</button>
                    </div>
                    <label className="field">
                      <span>溢价档位(%,逗号分隔)</span>
                      <input
                        className="inp" disabled={!task.places.length}
                        value={task.tiers} onChange={(e) => set({ tiers: e.target.value })}
                      />
                    </label>
                    <p className="hint" style={{ marginTop: 7 }}>
                      {task.places.length
                        ? '每个广告位 × 每个档位各出一条活动。'
                        : '不加溢价:三行竞价调整全写 0,命名里也不带位置和溢价。'}
                    </p>
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
                        onClick={() => {
                          const t = task.tiers.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
                          set({ combos: t.map((v) => `TOS:${v} ROS:${v}`).join('\n') });
                        }}
                      >档位→TOS=ROS</button>
                      <button
                        className="btn sm"
                        onClick={() => {
                          const t = task.tiers.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
                          set({ combos: t.map((v) => `TOS:${v} ROS:${Math.round(v / 2)}`).join('\n') });
                        }}
                      >档位→ROS减半</button>
                      <button className="btn sm" onClick={() => set({ combos: '' })}>清空</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ---------------- 命名 ---------------- */}
        {tab === 'name' && (
          <div className="card" style={{ maxWidth: 620 }}>
            <div className="card-title"><span className="num">3</span>命名规则</div>
            <div className="g2">
              <label className="field">
                <span>前缀(自己写)</span>
                <input className="inp" value={task.prefix} onChange={(e) => set({ prefix: e.target.value })} />
              </label>
              <label className="field">
                <span>分隔符</span>
                <input className="inp" value={task.sep} onChange={(e) => set({ sep: e.target.value })} />
              </label>
            </div>

            <label className="lbl" style={{ display: 'block', margin: '13px 0 6px' }}>
              后缀字段 · 勾选启用,↑↓ 调顺序
            </label>
            <div className="stack" style={{ gap: 6 }}>
              {task.tokens.map((t, i) => (
                <div key={t.id} className={`tokrow${t.on ? '' : ' off'}`}>
                  <input
                    type="checkbox" checked={t.on}
                    onChange={() => {
                      const next = task.tokens.map((x, j) => (j === i ? { ...x, on: !x.on } : x));
                      set({ tokens: next });
                    }}
                  />
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
                <>命名示例 <b className="mono">{demo.name}</b></>
              ) : (
                '先勾选自动投放方式和竞价方案'
              )}
            </div>
          </div>
        )}

        {/* ---------------- 参数 ---------------- */}
        {tab === 'params' && (
          <div className="g2 editor-grid">
            <div className="card">
              <div className="card-title"><span className="num">4</span>活动参数</div>
              <div className="g2">
                <label className="field">
                  <span>广告组合编号</span>
                  <input className="inp" value={task.portfolio} onChange={(e) => set({ portfolio: e.target.value })} />
                </label>
                <label className="field">
                  <span>开始日期</span>
                  <input className="inp" value={task.date} onChange={(e) => set({ date: e.target.value })} />
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
            </div>

            <div className="card">
              <div className="card-title"><span className="num">5</span>出价折算</div>
              <div className="g2">
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
                <div className="coefbox-title">提高和降低 · 广告位系数</div>
                <div className="g3">
                  {PLACEMENTS.map(([key]) => (
                    <label className="field" key={key}>
                      <span>{key}</span>
                      <input
                        className="inp" type="number" step="0.1"
                        value={task.coefs[key]}
                        onChange={(e) => set({ coefs: { ...task.coefs, [key]: e.target.value } })}
                      />
                    </label>
                  ))}
                </div>
                <p className="hint" style={{ marginTop: 9 }}>
                  出价 = CPC ÷ ((1+溢价) × 系数)。固定竞价和仅降低一律 ×1。<br />
                  例:TOS·100%·提降 → {task.baseBid} ÷ ((1+100%)×{task.coefs.TOS}) ={' '}
                  <b>{(Number(task.baseBid) / ((1 + 1) * Number(task.coefs.TOS) || 1)).toFixed(2)}</b><br />
                  不加位置溢价时 → 出价 = CPC 基数 <b>{task.baseBid}</b>(不打系数)
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- 否定 ---------------- */}
        {tab === 'neg' && (
          <div className="g2 editor-grid">
            <div className="card">
              <div className="card-title"><span className="num">6</span>站点词库</div>
              <label className="row" style={{ marginBottom: 10 }}>
                <input
                  type="checkbox" checked={task.useLib}
                  onChange={(e) => set({ useLib: e.target.checked })}
                />
                <span style={{ fontSize: 12.5 }}>本任务套用站点否定词库({libCount} 条)</span>
              </label>
              <p className="hint" style={{ marginBottom: 11 }}>
                词库在「否定词库」页面维护,这里只决定这个任务带不带。带上后会写进本任务生成的每一条活动。
              </p>
              <div className="scroll" style={{ maxHeight: 260 }}>
                <table className="tbl">
                  <thead><tr><th>类型</th><th>词</th></tr></thead>
                  <tbody>
                    {libTerms.slice(0, 300).map((t) => (
                      <tr key={t.id}>
                        <td style={{ color: 'var(--text-faint)' }}>{t.cat}</td>
                        <td className="mono">{t.term}</td>
                      </tr>
                    ))}
                    {!libTerms.length && <tr><td colSpan={2} className="empty">词库还是空的</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card-title"><span className="num">7</span>本任务额外否定</div>
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

              <div className="negsec">否定关键词 · 广告活动级(一般在这否定)</div>
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
                value={task.extraNeg.negAsin} onChange={(e) => setNeg({ negAsin: e.target.value })}
              />
              <p className="hint" style={{ marginTop: 7 }}>
                填纯 ASIN 即可,自动补成 <span className="mono">asin="B0…"</span> 格式。
              </p>

              <div className="row" style={{ marginTop: 11 }}>
                <span className="stat">
                  合计否定词 <b>{plan?.negs?.length ?? 0}</b> · ASIN <b>{plan?.asins?.length ?? 0}</b>
                  {' '}· 每条活动 +<b>{(plan?.negs?.length ?? 0) + (plan?.asins?.length ?? 0)}</b> 行
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ---------------- 预览 ---------------- */}
        {tab === 'preview' && (
          <div className="card">
            <div className="row" style={{ marginBottom: 11 }}>
              <span className="stat">本任务 <b>{plan?.campaigns?.length ?? 0}</b> 条活动</span>
              <span className="stat">每块 <b>{plan?.blockRows ?? 0}</b> 行</span>
              <span className="stat">
                小计 <b>{(plan?.campaigns?.length ?? 0) * ((plan?.blockRows ?? 0) + 1)}</b> 行
              </span>
            </div>
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>#</th><th>广告活动名称</th><th>广告位</th><th>溢价</th><th>折算</th><th>出价</th>
                  </tr>
                </thead>
                <tbody>
                  {(plan?.campaigns ?? []).map((p, i) => (
                    <tr key={p.name}>
                      <td style={{ color: 'var(--text-faint)' }}>{i + 1}</td>
                      <td className="mono">{p.name}</td>
                      <td>{p.active.length ? p.active.join('+') : '无溢价'}</td>
                      <td>{p.active.length ? p.active.map((k) => `${p.prem[k]}%`).join(' / ') : '—'}</td>
                      <td className="mono">
                        {p.factor === 1 ? '—' : `÷${p.factor}${p.driver ? ` (${p.driver})` : ''}`}
                      </td>
                      <td className="mono"><b>{p.bid}</b></td>
                    </tr>
                  ))}
                  {!plan?.campaigns?.length && (
                    <tr><td colSpan={6} className="empty">当前组合没有可生成的广告活动</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
