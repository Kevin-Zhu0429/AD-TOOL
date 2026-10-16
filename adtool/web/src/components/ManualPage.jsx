import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { draftKey, dropDraft, isPristine, restoreTasks, writeDraft } from '../draft.js';
import Icon from './Icon.jsx';
import ManualForm from './ManualForm.jsx';
import { buildNegatives, todayStamp } from '../adEngine.js';
import {
  buildManualPlan, DEFAULT_COEFS, MATCH_TYPES, TARGET_TYPES,
} from '../manualEngine.js';
import './BuilderPage.css';
import './ManualPage.css';

let seq = 1;

/** 关键词 / 商品投放两组粘贴框的初始状态 */
const emptyKw = () => Object.fromEntries(
  MATCH_TYPES.map((mt, i) => [mt.id, { on: i === 0, bid: '', text: '' }])
);
/** 三合一默认三种匹配全开 */
const tripleKw = () => Object.fromEntries(
  MATCH_TYPES.map((mt) => [mt.id, { on: true, bid: '', text: '' }])
);
const emptyTgt = () => Object.fromEntries(
  TARGET_TYPES.map((tt, i) => [tt.id, { on: i === 0, bid: '', text: '' }])
);

function newManualTask(overrides = {}) {
  return {
    id: `m${seq++}`,
    camp: '',
    group: '',
    portfolio: '',
    portfolioMode: 'auto',
    date: todayStamp(),
    budget: 1.2,
    defBid: 0.3,
    strategy: 'down',
    places: { TOS: '', ROS: '', PP: '' },
    // 出价:bid = 自己填出价;cpc = 填目标 CPC,按溢价和系数反推出价(和自动广告页一个口径)
    bidMode: 'bid',
    baseBid: 0.36,
    rounding: 'round',
    coefs: { ...DEFAULT_COEFS },
    skus: '',
    mode: 'kw',                // kw = 关键词投放;tgt = 商品投放(ASIN / 品类)
    splitGroup: false,
    kw: emptyKw(),
    kwTriple: false,           // 三合一:精准 / 词组 / 广泛共用一个粘贴框
    kwShared: '',
    tgt: emptyTgt(),
    // 下面这几个字段和自动广告页共用一套否定逻辑(adEngine.buildNegatives)
    extraNeg: { negExact: '', negPhrase: '', cnegExact: '', cnegPhrase: '', negAsin: '' },
    libUse: { A: true, B: true, C: true, D: true, E: false },
    adType: 'mixed',
    seriesModels: [],
    seriesScope: 'both',
    ...overrides,
  };
}

/**
 * SP 手动广告的活动列表。嵌在「开设广告」页里:词库、SKU 库、广告组合库由外层读好传进来,
 * 生成按钮也在外层,这里只把每条活动的计划报上去(onReport)。
 */
export default function ManualPage({ market, data, onReport }) {
  const key = draftKey('manual', market);
  // 和自动广告页一样:填到一半切页面 / 刷新都不丢,进来先把草稿捞回来
  const [restored] = useState(() => {
    const r = restoreTasks(key, newManualTask, 'm');
    if (r) seq = Math.max(seq, r.seq);
    return r;
  });
  const { lib, libData, skuItems, portfolios, portfolioError } = data;
  const [tasks, setTasks] = useState(() => restored?.tasks ?? [newManualTask()]);
  const [activeId, setActiveId] = useState(() => restored?.activeId ?? null);
  const [fromDraft, setFromDraft] = useState(!!restored);
  const taskStrip = useRef(null);
  useEffect(() => {
    taskStrip.current?.querySelector('.taskpill.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  useEffect(() => {
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [tasks, activeId]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (isPristine(tasks, newManualTask)) dropDraft(key);   // 空表单不留草稿
      else writeDraft(key, { tasks, activeId });
    }, 400);
    return () => clearTimeout(t);
  }, [key, tasks, activeId]);

  const plans = useMemo(
    () => tasks.map((task) => ({ task, plan: buildManualPlan(task, buildNegatives(libData, task)) })),
    [tasks, libData]
  );

  const used = !isPristine(tasks, newManualTask);
  useEffect(() => {
    onReport?.({ plans, used, tasks: tasks.length });
  }, [plans, used, tasks.length, onReport]);

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addTask() {
    // 沿用上一条活动的参数,只清空名称和关键词 —— 连开几条时省事
    const last = tasks[tasks.length - 1];
    const t = last
      ? newManualTask({
        ...last, id: `m${seq++}`, camp: '', group: '',
        kw: last.kwTriple ? tripleKw() : emptyKw(), kwShared: '', tgt: emptyTgt(),
      })
      : newManualTask();
    setTasks((prev) => [...prev, t]);
    setActiveId(t.id);
  }

  function duplicateTask(id) {
    const src = tasks.find((t) => t.id === id);
    if (!src) return;
    const t = {
      ...src, id: `m${seq++}`,
      camp: src.camp ? `${src.camp}_副本` : '',
      kw: JSON.parse(JSON.stringify(src.kw)),
      tgt: JSON.parse(JSON.stringify(src.tgt)),
    };
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      return [...prev.slice(0, i + 1), t, ...prev.slice(i + 1)];
    });
    setActiveId(t.id);
  }

  function removeTask(id) {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : [newManualTask()];
    });
    setActiveId(null);
  }

  /** 清空这个站点的全部活动,连本地草稿一起删 */
  function resetAll() {
    if (!confirm('清空这个站点的全部活动?浏览器里存的草稿也会一起删掉。')) return;
    api.recordActivity('builder', 'clear_local', market, { manual: tasks.length }).catch(() => {});
    dropDraft(key);
    const t = newManualTask();
    setTasks([t]);
    setActiveId(t.id);
    setFromDraft(false);
  }

  const active = tasks.find((t) => t.id === activeId) ?? tasks[0];
  const activePlan = plans.find((p) => p.task.id === active?.id)?.plan;
  const libCount = Object.values(lib?.items ?? {}).reduce((a, x) => a + x.length, 0);
  const multi = tasks.length > 1;

  return (
    <div className="builder manual-builder">
      <div className="bbar">
        <div className="manual-task-navigation">
        <div className="tabstrip" ref={taskStrip} tabIndex={0} role="region" aria-label="广告活动列表，可横向滚动">
          {plans.map(({ task, plan }, i) => (
            <div
              key={task.id}
              className={`taskpill${task.id === active?.id ? ' on' : ''}${plan.problems.length ? ' bad' : ''}`}
            >
              <button
                className="taskpill-main"
                onClick={() => setActiveId(task.id)}
                title={task.camp || `活动 ${i + 1}`}
              >
                <span className="taskpill-i">{i + 1}</span>
                <span className="taskpill-name">{task.camp || `未命名活动 ${i + 1}`}</span>
                <span className="taskpill-n">
                  {plan.problems.length ? `${plan.problems.length} 待处理` : `${plan.rows} 行`}
                </span>
              </button>
              {multi && (
                <button
                  className="taskpill-x"
                  title="删除活动"
                  aria-label="删除活动"
                  onClick={() => removeTask(task.id)}
                >✕</button>
              )}
            </div>
          ))}
        </div>
        <div className="manual-task-actions">
          <button className="btn sm addtask" onClick={addTask}>
            <Icon name="plus" className="ico-sm" />新活动
          </button>
          {active && (
            <button className="btn sm ghost" onClick={() => duplicateTask(active.id)} title="复制当前活动">
              <Icon name="copy" className="ico-sm" />复制
            </button>
          )}
        </div>
        </div>

        <div className="spacer" />

        {fromDraft && (
          <span className="tag gray" title="上次填的内容存在这台电脑的浏览器里,已经帮你恢复">
            草稿已恢复
          </span>
        )}
        <button className="btn sm ghost" onClick={resetAll} title="清空这个站点的全部活动">
          清空重来
        </button>
      </div>

      {active && (
        <ManualForm
          key={active.id}
          task={active}
          plan={activePlan}
          libCount={libCount}
          lib={libData}
          market={market}
          skuItems={skuItems}
          portfolios={portfolios}
          portfolioError={portfolioError}
          onChange={(patch) => updateTask(active.id, patch)}
        />
      )}
    </div>
  );
}
