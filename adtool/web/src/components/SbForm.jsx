import { useRef, useState } from 'react';
import { api } from '../api.js';
import { parseLines } from '../adEngine.js';
import { MATCH_TYPES, parseKeywordLines } from '../manualEngine.js';
import {
  SB_FORMATS, SB_PLACEMENTS, SB_TARGET_TYPES, parseSbAssets, tiersOf,
} from '../sbEngine.js';
import { Sec } from './FormBits.jsx';
import { LibraryNegatives, ExtraNegatives } from './NegPanels.jsx';
import { Unit, TripleUnit } from './ManualForm.jsx';
import SkuPicker from './SkuPicker.jsx';
import PortfolioField from './PortfolioField.jsx';

/* 一条品牌推广(SB)任务 = 一整页表单,布局和手动广告一样三列 */

/** 品牌素材:上传一次后台下载的 SB 批量表,同站点所有人共用 */
function AssetBox({ market, assets, onAssets }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      const data = parseSbAssets(await file.arrayBuffer());
      const res = await api.saveSbAssets(market, data, file.name);
      onAssets({ data: res.data, fileName: file.name, updatedAt: '刚刚' });
      setNote({ kind: 'ok', text: `已读到 ${res.data.brands.length} 个品牌、${res.data.logos.length} 个徽标、${res.data.videos.length} 条视频,${market} 站所有人都能用。` });
    } catch (e) {
      setNote({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const d = assets?.data;
  return (
    <div className="sb-assets">
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="hint" style={{ flex: 1, minWidth: 200 }}>
          {d
            ? <>当前素材:{d.brands.map((b) => b.name || b.entityId).join('、')} · 徽标 {d.logos.length} · 视频 {d.videos.length}
              {assets.updatedAt ? ` · ${assets.uploadedBy ? `${assets.uploadedBy} ` : ''}${assets.updatedAt} 更新` : ''}</>
            : `${market} 站还没有品牌素材。去后台「批量操作」下载一份勾了品牌推广的批量表,传上来就行。`}
        </span>
        <button className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '读取中…' : d ? '重新上传 SB 批量表' : '上传 SB 批量表'}
        </button>
        <input
          ref={input} type="file" accept=".xlsx,.xls" hidden
          onChange={(e) => upload(e.target.files?.[0])}
        />
      </div>
      {note && <p className={`hint ${note.kind === 'ok' ? 'c-ok' : 'c-err'}`} style={{ marginTop: 6 }}>{note.text}</p>}
    </div>
  );
}

export default function SbForm({
  task, plan, libCount, lib, market, skuItems, portfolios, portfolioError, assets, onAssets, onChange,
}) {
  const set = (patch) => onChange(patch);
  const [pick, setPick] = useState(false);
  const [pickNote, setPickNote] = useState('');
  const setUnit = (bucket, key, patch) =>
    onChange({ [bucket]: { ...task[bucket], [key]: { ...task[bucket][key], ...patch } } });

  const triple = task.mode === 'kw' && !!task.kwTriple;
  function pickMode(id) {
    if (id === 'tgt') return set({ mode: 'tgt' });
    if (id === 'kw') return set({ mode: 'kw', kwTriple: false });
    const seed = task.kwShared || MATCH_TYPES.map((mt) => task.kw[mt.id]?.text).find(Boolean) || '';
    set({
      mode: 'kw', kwTriple: true, kwShared: seed,
      kw: task.kwTriple ? task.kw : Object.fromEntries(MATCH_TYPES.map(({ id: k }) => [k, { ...task.kw[k], on: true }])),
    });
  }
  const modeId = task.mode === 'tgt' ? 'tgt' : triple ? 'kw3' : 'kw';

  const data = assets?.data;
  const brands = data?.brands ?? [];
  const logos = (data?.logos ?? []).filter((l) => !l.entityId || !task.brandEntity || l.entityId === task.brandEntity);
  const videos = data?.videos ?? [];

  /** 选品牌时顺手把品牌名带上,只有一个徽标的话也直接选上 */
  function pickBrand(entityId) {
    const b = brands.find((x) => x.entityId === entityId);
    const patch = { brandEntity: entityId, brandName: b?.name || task.brandName };
    const own = (data?.logos ?? []).filter((l) => !l.entityId || l.entityId === entityId);
    if (own.length === 1) Object.assign(patch, { logoId: own[0].assetId, logoCrop: own[0].crop ?? '' });
    set(patch);
  }

  const cpcMode = task.bidMode === 'cpc';
  const fmt = SB_FORMATS.find((f) => f.id === task.format) ?? SB_FORMATS[0];
  const asinCount = plan?.asins?.length ?? 0;
  const negCount = plan?.negs?.length ?? 0;
  const campaigns = plan?.campaigns ?? [];
  const preview = [];
  for (const c of campaigns.slice(0, 50)) {
    for (const u of plan.units) preview.push({ camp: c.name, label: u.label, n: u.items.length, bid: c.bids[u.key] });
  }

  return (
    <div className="onepage mform">
      {/* ==================== 左列 ==================== */}
      <div className="col">
        <Sec n="1" title="品牌和广告格式" tone="violet">
          <AssetBox market={market} assets={assets} onAssets={onAssets} />

          <label className="lbl block" style={{ margin: '13px 0 6px' }}>广告格式</label>
          <div className="seg seg3">
            {SB_FORMATS.map((f) => (
              <button
                key={f.id} type="button" aria-pressed={task.format === f.id}
                className={`seg-item${task.format === f.id ? ' on' : ''}`}
                onClick={() => set({ format: f.id })}
              >
                <b>{f.label}</b>
                <span>{f.desc}</span>
              </button>
            ))}
          </div>

          <div className="g2" style={{ marginTop: 11 }}>
            <label className="field">
              <span>品牌</span>
              <select className="inp" value={task.brandEntity} onChange={(e) => pickBrand(e.target.value)}>
                <option value="">{brands.length ? '选一个品牌' : '先上传 SB 批量表'}</option>
                {brands.map((b) => <option key={b.entityId} value={b.entityId}>{b.name || b.entityId}</option>)}
              </select>
            </label>
            {fmt.id !== 'video' && (
              <label className="field">
                <span>品牌名称(广告上显示)</span>
                <input className="inp" value={task.brandName} onChange={(e) => set({ brandName: e.target.value })} />
              </label>
            )}
          </div>

          {fmt.id !== 'video' ? (
            <div className="field" style={{ marginTop: 11 }}>
              <span>品牌徽标</span>
              <div className="sb-pick">
                {logos.map((l) => (
                  <button
                    key={l.assetId} type="button" title={l.name}
                    className={`sb-pick-item${task.logoId === l.assetId ? ' on' : ''}`}
                    onClick={() => set({ logoId: l.assetId, logoCrop: l.crop ?? '' })}
                  >
                    {l.url ? <img src={l.url} alt={l.name} loading="lazy" /> : <span>{l.name}</span>}
                  </button>
                ))}
                {!logos.length && <span className="hint">素材里没有徽标</span>}
              </div>
            </div>
          ) : (
            <label className="field" style={{ marginTop: 11 }}>
              <span>视频素材</span>
              <select className="inp" value={task.videoId} onChange={(e) => set({ videoId: e.target.value })}>
                <option value="">{videos.length ? '选一条视频' : '素材里没有视频'}</option>
                {videos.map((v) => <option key={v.assetId} value={v.assetId}>{v.name || v.assetId}</option>)}
              </select>
            </label>
          )}
        </Sec>

        <Sec n="2" title="广告活动参数">
          <label className="field">
            <span>广告活动名称 *</span>
            <input
              className="inp task-name" style={{ marginBottom: 0 }}
              placeholder="例:SBC-CPC-302-Series-ASIN-通用芯片BK"
              value={task.camp} onChange={(e) => set({ camp: e.target.value })}
            />
          </label>
          <p className="hint" style={{ marginTop: 6 }}>广告组和广告的名称都跟活动名一样。</p>
          <div style={{ marginTop: 11 }}>
            <PortfolioField
              task={task} skuItems={skuItems} portfolios={portfolios}
              loading={skuItems === null || portfolios === null} error={portfolioError} onChange={set}
            />
          </div>
          <div className="g2" style={{ marginTop: 11 }}>
            <label className="field">
              <span>开始日期</span>
              <input className="inp mono" value={task.date} onChange={(e) => set({ date: e.target.value })} />
            </label>
            <label className="field">
              <span>每日预算</span>
              <input className="inp" type="number" step="0.1" value={task.budget}
                onChange={(e) => set({ budget: e.target.value })} />
            </label>
          </div>

          <label className="switchrow" style={{ marginTop: 11 }}>
            <input type="checkbox" checked={!!task.autoBid} onChange={() => set({ autoBid: !task.autoBid })} />
            <span className="switchrow-main">
              <b>让亚马逊自动调整竞价</b>
              <span className="hint">后台叫「竞价优化」。勾上就不能自己调广告位,瀑布流也用不了。一般不勾。</span>
            </span>
          </label>

          {!task.autoBid && (
            <>
              <label className="lbl block" style={{ margin: '13px 0 6px' }}>
                按广告位调整竞价(%) <span className="c-faint">留空 = 0,可以填负数</span>
              </label>
              <div className="g2">
                {SB_PLACEMENTS.map(([key, label]) => (
                  <label className="field" key={key}>
                    <span>{label}</span>
                    <input
                      className="inp" type="number" step="1" placeholder="0"
                      disabled={task.wf?.on && task.wf?.place === key}
                      value={task.wf?.on && task.wf?.place === key ? '' : task.places[key]}
                      onChange={(e) => set({ places: { ...task.places, [key]: e.target.value } })}
                    />
                  </label>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                后台新建页面上的「搜索结果顶部」就是这里的「搜索结果首页首位」。四个广告位都会写进表里。
              </p>

              <label className="switchrow" style={{ marginTop: 11 }}>
                <input
                  type="checkbox" checked={!!task.wf?.on}
                  onChange={() => set({ wf: { ...task.wf, on: !task.wf?.on } })}
                />
                <span className="switchrow-main">
                  <b>瀑布流:一个溢价档位开一条活动</b>
                  <span className="hint">和 SP 自动广告一样,活动名后面接档位,例如 -Tos20、-Tos50。</span>
                </span>
              </label>
              {task.wf?.on && (
                <div className="g2" style={{ marginTop: 9 }}>
                  <label className="field">
                    <span>按哪个广告位分档</span>
                    <select className="inp" value={task.wf.place}
                      onChange={(e) => set({ wf: { ...task.wf, place: e.target.value } })}>
                      {SB_PLACEMENTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>溢价档位(%,逗号分隔) · {tiersOf(task.wf.tiers).length} 档</span>
                    <input className="inp mono" value={task.wf.tiers}
                      onChange={(e) => set({ wf: { ...task.wf, tiers: e.target.value } })} />
                  </label>
                </div>
              )}
            </>
          )}

          <label className="lbl block" style={{ margin: '15px 0 6px' }}>出价怎么定</label>
          <div className="seg" style={{ marginBottom: 10 }}>
            {[
              ['bid', '直接填出价', '写进表里就是这个数'],
              ['cpc', '按目标 CPC 反推', '出价 = 目标 CPC ÷ (1+最高溢价),瀑布流每档各算各的'],
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
          <div className="g2">
            <label className="field">
              <span>{cpcMode ? '目标 CPC' : '默认出价'}(下面各类出价留空就用它)</span>
              <input className="inp" type="number" step="0.01" value={task.baseBid}
                onChange={(e) => set({ baseBid: e.target.value })} />
            </label>
            {cpcMode && (
              <label className="field">
                <span>小数处理</span>
                <select className="inp" value={task.rounding} onChange={(e) => set({ rounding: e.target.value })}>
                  <option value="round">四舍五入 2 位</option>
                  <option value="trunc">截断 2 位</option>
                </select>
              </label>
            )}
          </div>
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
        {fmt.id !== 'collAuto' && (
          <Sec
            n="4" title={fmt.id === 'video' ? '推广商品 · 1 个' : '推广商品 · 3–10 个'}
            meta={<span className="stat"><b>{asinCount}</b> 个 ASIN</span>}
          >
            <textarea
              className="inp resize-none" rows={5}
              placeholder={'每行一个,填 SKU 或 ASIN 都行\nSKU 会去 SKU 库里找它的 ASIN'}
              value={task.skus} onChange={(e) => set({ skus: e.target.value })}
            />
            <div className="row wrap" style={{ marginTop: 9 }}>
              <button className="btn sm" onClick={() => setPick(true)}>从 SKU 库选</button>
              <button className="btn sm" onClick={() => { set({ skus: '' }); setPickNote(''); }}>清空</button>
              <div className="spacer" />
              {plan?.asins?.length > 0 && <span className="hint mono">{plan.asins.join(' ')}</span>}
            </div>
            {pickNote && <p className="hint c-ok" style={{ marginTop: 6 }}>{pickNote}</p>}
            {pick && (
              <SkuPicker
                market={market} current={task.skus}
                onApply={(text, note) => { set({ skus: text }); setPickNote(note); }}
                onClose={() => setPick(false)}
              />
            )}
          </Sec>
        )}
        {fmt.id === 'collAuto' && (
          <Sec n="4" title="推广商品">
            <p className="hint">
              自动商品集不用选商品,亚马逊按关键词从你的品牌商品里自己挑。
              下面这个框只用来自动匹配广告组合,可以不填。
            </p>
            <textarea
              className="inp resize-none" rows={3} style={{ marginTop: 8 }} placeholder="SKU(选填)"
              value={task.skus} onChange={(e) => set({ skus: e.target.value })}
            />
          </Sec>
        )}

        <Sec
          n="5" title="投放方式" tone="violet"
          meta={<span className="stat"><b>{plan?.targets ?? 0}</b> 条</span>}
        >
          <div className="seg seg3">
            {[
              ['kw', '关键词投放', '三种匹配各粘各的词'],
              ['kw3', '关键词三合一', '只粘一次词,三种匹配同时开'],
              ['tgt', '商品投放', '粘 ASIN 或品类 ID'],
            ].map(([id, label, desc]) => (
              <button
                key={id} type="button" aria-pressed={modeId === id}
                className={`seg-item${modeId === id ? ' on' : ''}`}
                onClick={() => pickMode(id)}
              >
                <b>{label}</b>
                <span>{desc}</span>
              </button>
            ))}
          </div>
          <p className="hint" style={{ margin: '10px 0 11px' }}>
            {cpcMode ? '出价框里填的是这一类的目标 CPC,留空就用上面那个。' : '出价留空就用上面的默认出价。'}
          </p>

          {triple && (
            <TripleUnit
              kw={task.kw} text={task.kwShared ?? ''}
              count={parseKeywordLines(task.kwShared).length}
              bidPlaceholder={cpcMode ? '目标CPC' : '出价'}
              noteOf={(cfg) => (String(cfg.bid ?? '').trim() ? '' : '留空 = 用默认')}
              onUnit={(id, patch) => setUnit('kw', id, patch)}
              onText={(text) => set({ kwShared: text })}
            />
          )}
          {triple ? null : task.mode === 'kw'
            ? MATCH_TYPES.map((mt) => {
              const cfg = task.kw[mt.id];
              return (
                <Unit
                  key={mt.id} on={cfg.on} label={`${mt.label}匹配`} hint={mt.hint}
                  bid={cfg.bid} text={cfg.text} count={parseKeywordLines(cfg.text).length}
                  placeholder="从表格里直接粘贴,每行一个词"
                  bidPlaceholder={cpcMode ? '目标CPC' : '出价'}
                  onChange={(patch) => setUnit('kw', mt.id, patch)}
                />
              );
            })
            : SB_TARGET_TYPES.map((tt) => {
              const cfg = task.tgt[tt.id];
              return (
                <Unit
                  key={tt.id} on={cfg.on} label={tt.label} hint={tt.hint}
                  bid={cfg.bid} text={cfg.text} count={parseLines(cfg.text).length}
                  placeholder={tt.id === 'category' ? '34285014031' : 'B08T1HR5CS'}
                  bidPlaceholder={cpcMode ? '目标CPC' : '出价'}
                  onChange={(patch) => setUnit('tgt', tt.id, patch)}
                />
              );
            })}
        </Sec>

        <Sec
          n="6" title="本任务额外否定" tone="amber"
          meta={<span className="stat">+<b>{negCount}</b> 条</span>}
        >
          <ExtraNegatives
            task={task} negCount={negCount} asinCount={0} noAsin
            lib={lib} market={market} onChange={onChange}
          />
          <p className="hint" style={{ marginTop: 8 }}>
            SB 只有广告组级否定,活动级的否定词也会写到广告组上。词库 E 类的否定 ASIN 暂时不写进 SB。
          </p>
        </Sec>
      </div>

      {/* ==================== 右列 · 预览 ==================== */}
      <div className="col col-preview">
        <Sec
          n="7" title="本任务预览" tone="green"
          meta={
            plan?.problems?.length
              ? <span className="tag amber">{plan.problems.length} 项待处理</span>
              : <span className="tag green">就绪</span>
          }
        >
          <div className="minigrid">
            <div className="mini"><span>广告活动</span><b>{campaigns.length}</b></div>
            <div className="mini"><span>{task.mode === 'kw' ? '关键词' : '商品定向'}</span><b>{plan?.targets ?? 0}</b></div>
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
            每条活动:1 广告活动{task.autoBid ? '' : ` + ${SB_PLACEMENTS.length} 广告位调整`} + 1 广告组 + 1 {fmt.label}广告
            + 投放{negCount ? ` + ${negCount} 否定词` : ''}。
          </p>

          <div className="scroll previewbox">
            <table className="tbl">
              <thead>
                <tr><th>#</th><th>广告活动名称</th><th>类型</th><th>条数</th><th>出价</th></tr>
              </thead>
              <tbody>
                {preview.map((r, i) => (
                  <tr key={`${r.camp}|${r.label}`}>
                    <td className="c-faint">{i + 1}</td>
                    <td className="mono namecell">{r.camp}</td>
                    <td>{r.label}</td>
                    <td className="mono">{r.n}</td>
                    <td><span className="bidpill">{r.bid}</span></td>
                  </tr>
                ))}
                {!preview.length && (
                  <tr><td colSpan={5} className="empty">还没有可写入的投放</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Sec>
      </div>
    </div>
  );
}
