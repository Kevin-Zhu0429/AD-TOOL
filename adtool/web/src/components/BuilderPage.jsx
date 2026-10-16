import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { draftKey, dropDraft, isPristine, restoreTasks, writeDraft } from '../draft.js';
import Icon from './Icon.jsx';
import TaskForm from './TaskForm.jsx';
import {
  AUTO_TYPES, STRATEGIES, NAME_TOKENS, buildNegatives, buildTaskPlan, todayStamp,
} from '../adEngine.js';
import './BuilderPage.css';

let seq = 1;

export function newTask(overrides = {}) {
  return {
    id: `t${seq++}`,
    title: '',
    skus: '',
    mode: 'wf',
    places: ['TOS', 'ROS'],
    tiers: '20,35,50,80,100,200,300,500,800,900',
    combos: '',
    autoTypes: ['Close'],
    strategies: ['down_zh'],
    prefix: '全店铺_SP_Auto',
    sep: '_',
    autoLang: 'en',
    tokens: NAME_TOKENS.map((t) => ({ ...t, on: t.id !== 'bid' })),
    portfolio: '',
    portfolioMode: 'auto',
    date: todayStamp(),
    budget: 1.2,
    defBid: 0.02,
    idleBid: 0.02,
    baseBid: 0.36,
    rounding: 'round',
    coefs: { TOS: 2, ROS: 1.5, PP: 1.5 },
    extraNeg: { negExact: '', negPhrase: '', cnegExact: '', cnegPhrase: '', negAsin: '' },
    // 每一类词库这个任务要不要套用;E 类数据格式还没定,默认不带
    libUse: { A: true, B: true, C: true, D: true, E: false },
    adType: 'mixed',        // mixed = 混合广告;series = 系列广告,D 类联动否定其它型号
    seriesModels: [],       // 系列广告投的是哪几个墨盒型号
    seriesScope: 'both',    // 联动否定的范围:both / models 只否墨盒 / printers 只否打印机
    ...overrides,
  };
}

/**
 * 草稿里的命名字段和当前版本对齐:顺序和勾选按草稿走,
 * 后来加的字段补到末尾,已经删掉的丢掉 —— 免得以后改 NAME_TOKENS 把老草稿弄坏。
 */
function fixTokens(list) {
  const known = new Map(NAME_TOKENS.map((t) => [t.id, t]));
  const out = [];
  const seen = new Set();
  for (const t of list ?? []) {
    const base = known.get(t?.id);
    if (!base || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({ ...base, on: !!t.on });
  }
  for (const t of NAME_TOKENS) if (!seen.has(t.id)) out.push({ ...t, on: t.id !== 'bid' });
  return out;
}

function autoTitle(task, index) {
  if (task.title.trim()) return task.title.trim();
  const autos = task.autoTypes.join('+') || '未选投放方式';
  const strats = task.strategies
    .map((s) => STRATEGIES.find((x) => x.id === s)?.label ?? s)
    .join('+');
  return `任务 ${index + 1} · ${autos} · ${strats || '未选竞价'}`;
}

/**
 * SP 自动广告的任务列表(瀑布流 / 组合)。嵌在「开设广告」页里:
 * 词库、SKU 库、广告组合库由外层统一读好传进来,生成按钮也在外层,
 * 这里只把每个任务的计划报上去(onReport)。
 */
export default function BuilderPage({ market, data, onReport }) {
  const key = draftKey('builder', market);
  // 填到一半切去别的页面(或者手滑刷新)不该白填一遍 —— 进来先把草稿捞回来
  const [restored] = useState(() => {
    const r = restoreTasks(key, newTask, 't');
    if (!r) return null;
    seq = Math.max(seq, r.seq);
    return { ...r, tasks: r.tasks.map((t) => ({ ...t, tokens: fixTokens(t.tokens) })) };
  });
  const { lib, libData, skuItems, portfolios, portfolioError } = data;
  const [tasks, setTasks] = useState(() => restored?.tasks ?? [newTask()]);
  const [activeId, setActiveId] = useState(() => restored?.activeId ?? null);
  const [fromDraft, setFromDraft] = useState(!!restored);

  useEffect(() => {
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [tasks, activeId]);

  // 改一下存一次(慢半拍,免得每敲一个字都写一遍 localStorage)
  useEffect(() => {
    const t = setTimeout(() => {
      if (isPristine(tasks, newTask)) dropDraft(key);   // 空表单不留草稿
      else writeDraft(key, { tasks, activeId });
    }, 400);
    return () => clearTimeout(t);
  }, [key, tasks, activeId]);

  /** 每个任务各自算一遍计划,词库按任务开关决定带不带 */
  const plans = useMemo(() => {
    return tasks.map((task) => {
      const negData = buildNegatives(libData, task);
      return { task, plan: buildTaskPlan(task, negData) };
    });
  }, [tasks, libData]);

  const used = !isPristine(tasks, newTask);
  useEffect(() => {
    onReport?.({ plans, used, tasks: tasks.length });
  }, [plans, used, tasks.length, onReport]);

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addTask() {
    // 新任务沿用上一个任务的参数,只清空标题 —— 连开几个系列时省事
    const last = tasks[tasks.length - 1];
    const t = last
      ? newTask({ ...last, id: `t${seq++}`, title: '', skus: last.skus })
      : newTask();
    setTasks((prev) => [...prev, t]);
    setActiveId(t.id);
  }

  function duplicateTask(id) {
    const src = tasks.find((t) => t.id === id);
    if (!src) return;
    const t = { ...src, id: `t${seq++}`, title: `${autoTitle(src, 0)} 副本` };
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      return [...prev.slice(0, i + 1), t, ...prev.slice(i + 1)];
    });
    setActiveId(t.id);
  }

  function removeTask(id) {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : [newTask()];
    });
    setActiveId(null);
  }

  /** 清空这个站点的全部任务,连本地草稿一起删 */
  function resetAll() {
    if (!confirm('清空这个站点的全部任务?浏览器里存的草稿也会一起删掉。')) return;
    api.recordActivity('builder', 'clear_local', market, { tasks: tasks.length }).catch(() => {});
    dropDraft(key);
    const t = newTask();
    setTasks([t]);
    setActiveId(t.id);
    setFromDraft(false);
  }

  const active = tasks.find((t) => t.id === activeId) ?? tasks[0];
  const activePlan = plans.find((p) => p.task.id === active?.id)?.plan;
  const libCount = Object.values(lib?.items ?? {}).reduce((a, x) => a + x.length, 0);
  const multi = tasks.length > 1;

  return (
    <div className="builder">
      {/* ---------- 吸顶操作条 ---------- */}
      <div className="bbar">
        <div className="tabstrip">
          {plans.map(({ task, plan }, i) => (
            <div
              key={task.id}
              className={`taskpill${task.id === active?.id ? ' on' : ''}${plan.problems.length ? ' bad' : ''}`}
            >
              <button
                className="taskpill-main"
                onClick={() => setActiveId(task.id)}
                title={autoTitle(task, i)}
              >
                <span className="taskpill-i">{i + 1}</span>
                <span className="taskpill-name">{autoTitle(task, i)}</span>
                <span className="taskpill-n">
                  {plan.problems.length ? `${plan.problems.length} 待处理` : `${plan.campaigns.length} 条`}
                </span>
              </button>
              {multi && (
                <button
                  className="taskpill-x"
                  title="删除任务"
                  aria-label="删除任务"
                  onClick={() => removeTask(task.id)}
                >✕</button>
              )}
            </div>
          ))}
          <button className="btn sm addtask" onClick={addTask}>
            <Icon name="plus" className="ico-sm" />新任务
          </button>
          {active && (
            <button className="btn sm ghost" onClick={() => duplicateTask(active.id)} title="复制当前任务">
              <Icon name="copy" className="ico-sm" />复制
            </button>
          )}
        </div>

        <div className="spacer" />

        {fromDraft && (
          <span className="tag gray" title="上次填的内容存在这台电脑的浏览器里,已经帮你恢复">
            草稿已恢复
          </span>
        )}
        <button className="btn sm ghost" onClick={resetAll} title="清空这个站点的全部任务">
          清空重来
        </button>
      </div>

      {/* ---------- 一页式表单 ---------- */}
      {active && (
        <TaskForm
          key={active.id}
          task={active}
          plan={activePlan}
          index={tasks.findIndex((t) => t.id === active.id)}
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

export { AUTO_TYPES, STRATEGIES };
