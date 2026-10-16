import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { draftKey, dropDraft, isPristine, restoreTasks, writeDraft } from '../draft.js';
import Icon from './Icon.jsx';
import SbForm from './SbForm.jsx';
import { buildNegatives, todayStamp } from '../adEngine.js';
import { MATCH_TYPES } from '../manualEngine.js';
import { SB_TARGET_TYPES, buildSbPlan } from '../sbEngine.js';
import './ManualPage.css';
import './SbPage.css';

let seq = 1;

const emptyKw = () => Object.fromEntries(MATCH_TYPES.map((mt, i) => [mt.id, { on: i === 0, bid: '', text: '' }]));
const emptyTgt = () => Object.fromEntries(SB_TARGET_TYPES.map((tt, i) => [tt.id, { on: i === 0, bid: '', text: '' }]));

function newSbTask(overrides = {}) {
  return {
    id: `s${seq++}`,
    camp: '',
    portfolio: '',
    portfolioMode: 'auto',
    date: todayStamp(),
    budget: 2,
    format: 'collManual',
    brandEntity: '',
    brandName: '',
    logoId: '',
    logoCrop: '',
    videoId: '',
    skus: '',
    autoBid: false,
    places: { TOS: '', ROS: '', HOME: '', PP: '' },
    wf: { on: false, place: 'TOS', tiers: '20,50,100,200' },
    bidMode: 'bid',
    baseBid: 0.5,
    rounding: 'round',
    mode: 'kw',
    kw: emptyKw(),
    kwTriple: false,
    kwShared: '',
    tgt: emptyTgt(),
    // 和 SP 两个页面共用一套否定逻辑(adEngine.buildNegatives)
    extraNeg: { negExact: '', negPhrase: '', cnegExact: '', cnegPhrase: '', negAsin: '' },
    libUse: { A: true, B: true, C: true, D: true, E: false },
    adType: 'mixed',
    seriesModels: [],
    seriesScope: 'both',
    ...overrides,
  };
}

/** 新任务默认带上这个站点唯一的品牌和徽标,省得每次都选 */
function withBrand(task, assets) {
  const d = assets?.data;
  if (!d || task.brandEntity || d.brands.length !== 1) return task;
  const b = d.brands[0];
  const logos = d.logos.filter((l) => !l.entityId || l.entityId === b.entityId);
  return {
    ...task, brandEntity: b.entityId, brandName: task.brandName || b.name,
    ...(logos.length === 1 && !task.logoId ? { logoId: logos[0].assetId, logoCrop: logos[0].crop ?? '' } : {}),
  };
}

/**
 * 品牌推广(SB)任务列表。嵌在「开设广告」页里,生成按钮在外面那一层,
 * 这里只把每个任务的计划报上去(onReport)。
 */
export default function SbPage({ market, data, onReport }) {
  const key = draftKey('sb', market);
  const [restored] = useState(() => {
    const r = restoreTasks(key, newSbTask, 's');
    if (r) seq = Math.max(seq, r.seq);
    return r;
  });
  const [assets, setAssets] = useState(null);
  const [tasks, setTasks] = useState(() => restored?.tasks ?? [newSbTask()]);
  const [activeId, setActiveId] = useState(() => restored?.activeId ?? null);
  const [fromDraft, setFromDraft] = useState(!!restored);
  const taskStrip = useRef(null);
  const { lib, libData, skuItems, portfolios, portfolioError } = data;

  useEffect(() => {
    taskStrip.current?.querySelector('.taskpill.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    api.sbAssets(market).then(setAssets).catch((e) => setAssets({ data: null, error: e.message }));
  }, [market]);

  // 素材到了以后,还没选品牌的任务自动带上(站点只有一个品牌时)
  useEffect(() => {
    if (!assets?.data) return;
    setTasks((prev) => {
      const next = prev.map((t) => withBrand(t, assets));
      return next.some((t, i) => t !== prev[i]) ? next : prev;
    });
  }, [assets]);

  useEffect(() => {
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [tasks, activeId]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (isPristine(tasks, newSbTask) || isPristine(tasks, () => withBrand(newSbTask(), assets))) dropDraft(key);
      else writeDraft(key, { tasks, activeId });
    }, 400);
    return () => clearTimeout(t);
  }, [key, tasks, activeId, assets]);

  const plans = useMemo(
    () => tasks.map((task) => ({
      task, plan: buildSbPlan(task, buildNegatives(libData, task), { market, skuItems }),
    })),
    [tasks, libData, market, skuItems]
  );

  const used = !(isPristine(tasks, newSbTask) || isPristine(tasks, () => withBrand(newSbTask(), assets)));
  useEffect(() => {
    onReport?.({ plans, used, tasks: tasks.length });
  }, [plans, used, tasks.length, onReport]);

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addTask() {
    // 沿用上一条的品牌、素材和参数,只清空名称和投放
    const last = tasks[tasks.length - 1];
    const t = last
      ? newSbTask({ ...last, id: `s${seq++}`, camp: '', kw: emptyKw(), kwShared: '', tgt: emptyTgt() })
      : withBrand(newSbTask(), assets);
    setTasks((prev) => [...prev, t]);
    setActiveId(t.id);
  }

  function duplicateTask(id) {
    const src = tasks.find((t) => t.id === id);
    if (!src) return;
    const t = { ...JSON.parse(JSON.stringify(src)), id: `s${seq++}`, camp: src.camp ? `${src.camp}_副本` : '' };
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      return [...prev.slice(0, i + 1), t, ...prev.slice(i + 1)];
    });
    setActiveId(t.id);
  }

  function removeTask(id) {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : [withBrand(newSbTask(), assets)];
    });
    setActiveId(null);
  }

  function resetAll() {
    if (!confirm('清空这个站点的全部品牌广告任务?浏览器里存的草稿也会一起删掉。')) return;
    api.recordActivity('builder', 'clear_local', market, { sb: tasks.length }).catch(() => {});
    dropDraft(key);
    const t = withBrand(newSbTask(), assets);
    setTasks([t]);
    setActiveId(t.id);
    setFromDraft(false);
  }

  const active = tasks.find((t) => t.id === activeId) ?? tasks[0];
  const activePlan = plans.find((p) => p.task.id === active?.id)?.plan;
  const libCount = Object.values(lib?.items ?? {}).reduce((a, x) => a + x.length, 0);
  const multi = tasks.length > 1;

  return (
    <div className="manual-builder sb-builder">
      <div className="bbar">
        <div className="manual-task-navigation">
          <div className="tabstrip" ref={taskStrip} tabIndex={0} role="region" aria-label="品牌广告任务列表，可横向滚动">
            {plans.map(({ task, plan }, i) => (
              <div
                key={task.id}
                className={`taskpill${task.id === active?.id ? ' on' : ''}${plan.problems.length ? ' bad' : ''}`}
              >
                <button className="taskpill-main" onClick={() => setActiveId(task.id)} title={task.camp || `任务 ${i + 1}`}>
                  <span className="taskpill-i">{i + 1}</span>
                  <span className="taskpill-name">{task.camp || `未命名 SB ${i + 1}`}</span>
                  <span className="taskpill-n">
                    {plan.problems.length ? `${plan.problems.length} 待处理` : `${plan.campaigns.length} 条`}
                  </span>
                </button>
                {multi && (
                  <button className="taskpill-x" title="删除任务" aria-label="删除任务" onClick={() => removeTask(task.id)}>✕</button>
                )}
              </div>
            ))}
          </div>
          <div className="manual-task-actions">
            <button className="btn sm addtask" onClick={addTask}>
              <Icon name="plus" className="ico-sm" />新任务
            </button>
            {active && (
              <button className="btn sm ghost" onClick={() => duplicateTask(active.id)} title="复制当前任务">
                <Icon name="copy" className="ico-sm" />复制
              </button>
            )}
          </div>
        </div>
        <div className="spacer" />
        {fromDraft && <span className="tag gray" title="上次填的内容存在这台电脑的浏览器里,已经帮你恢复">草稿已恢复</span>}
        <button className="btn sm ghost" onClick={resetAll} title="清空这个站点的全部品牌广告任务">清空重来</button>
      </div>

      {assets?.error && <div className="note err bresult">品牌素材读取失败:{assets.error}</div>}

      {active && (
        <SbForm
          key={active.id}
          task={active}
          plan={activePlan}
          libCount={libCount}
          lib={libData}
          market={market}
          skuItems={skuItems}
          portfolios={portfolios}
          portfolioError={portfolioError}
          assets={assets}
          onAssets={setAssets}
          onChange={(patch) => updateTask(active.id, patch)}
        />
      )}
    </div>
  );
}
