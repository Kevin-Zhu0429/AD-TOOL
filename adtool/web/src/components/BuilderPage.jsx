import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import TaskEditor from './TaskEditor.jsx';
import {
  AUTO_TYPES, STRATEGIES, NAME_TOKENS, parseLines,
  buildNegatives, buildTaskPlan, buildWorkbookData, downloadWorkbook, todayStamp,
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
    date: todayStamp(),
    budget: 1.2,
    defBid: 0.02,
    idleBid: 0.02,
    baseBid: 0.36,
    rounding: 'round',
    coefs: { TOS: 2, ROS: 1.5, PP: 1.5 },
    extraNeg: { negExact: '', negPhrase: '', cnegExact: '', cnegPhrase: '', negAsin: '' },
    useLib: true,
    ...overrides,
  };
}

function autoTitle(task, index) {
  if (task.title.trim()) return task.title.trim();
  const autos = task.autoTypes.join('+') || '未选投放方式';
  const strats = task.strategies
    .map((s) => STRATEGIES.find((x) => x.id === s)?.label ?? s)
    .join('+');
  return `任务 ${index + 1} · ${autos} · ${strats || '未选竞价'}`;
}

export default function BuilderPage({ market }) {
  const [lib, setLib] = useState(null);
  const [libError, setLibError] = useState('');
  const [tasks, setTasks] = useState(() => [newTask()]);
  const [activeId, setActiveId] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setResult(null);
    api.library(market).then(setLib).catch((e) => setLibError(e.message));
  }, [market]);

  useEffect(() => {
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [tasks, activeId]);

  const libConfig = useMemo(() => {
    const m = {};
    for (const c of lib?.config ?? []) {
      m[c.cat] = { enabled: c.enabled !== 0, matchType: c.match_type, level: c.level };
    }
    return m;
  }, [lib]);

  /** 每个任务各自算一遍计划,词库按任务开关决定带不带 */
  const plans = useMemo(() => {
    return tasks.map((task) => {
      const negData = buildNegatives(
        task.useLib ? lib?.terms ?? [] : [],
        libConfig,
        task.extraNeg
      );
      return { task, plan: buildTaskPlan(task, negData) };
    });
  }, [tasks, lib, libConfig]);

  const totals = useMemo(() => {
    const campaigns = plans.reduce((a, x) => a + x.plan.campaigns.length, 0);
    const problems = plans.filter((x) => x.plan.problems.length).length;
    const rows = plans.reduce(
      (a, x) => a + x.plan.campaigns.length * (x.plan.blockRows + 1), 0
    );
    return { campaigns, problems, rows };
  }, [plans]);

  const blocked = totals.problems > 0 || totals.campaigns === 0;

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setResult(null);
  }

  function addTask() {
    // 新任务沿用上一个任务的参数,只清空 SKU —— 连开几个系列时省事
    const last = tasks[tasks.length - 1];
    const t = last
      ? newTask({ ...last, id: `t${seq++}`, title: '', skus: last.skus })
      : newTask();
    setTasks((prev) => [...prev, t]);
    setActiveId(t.id);
    setResult(null);
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
    setResult(null);
  }

  function removeTask(id) {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : [newTask()];
    });
    setActiveId(null);
    setResult(null);
  }

  function moveTask(id, dir) {
    setTasks((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setResult(null);
  }

  function generate() {
    try {
      const wb = buildWorkbookData(plans);
      if (wb.bad.length) {
        setResult({
          kind: 'err',
          text: `自检未通过(${wb.bad.length} 项):${wb.bad.slice(0, 5).join('；')}`,
        });
        return;
      }
      const file = `CYES-批量开广告-${market}-${todayStamp()}.xlsx`;
      downloadWorkbook(wb.aoa, file);
      setResult({
        kind: 'ok',
        text: `已生成 ${wb.placed.length} 条广告活动,来自 ${tasks.length} 个任务,共 ${wb.aoa.length} 行,三道自检全部通过。文件:${file}`,
      });
    } catch (e) {
      setResult({ kind: 'err', text: e.message });
    }
  }

  const active = tasks.find((t) => t.id === activeId) ?? tasks[0];
  const activePlan = plans.find((p) => p.task.id === active?.id)?.plan;
  const libCount = lib?.terms?.length ?? 0;

  return (
    <div className="builder">
      <div className="builder-head">
        <div>
          <h1>开设广告 · {market} 站</h1>
          <p className="hint">
            一个任务 = 一组 SKU + 一套组合。加几个任务分别配置,最后一次生成合并成总表。
            {libError
              ? ` 词库读取失败:${libError}`
              : ` 本站点词库共 ${libCount} 条,可在每个任务里选择是否套用。`}
          </p>
        </div>
      </div>

      <div className="builder-body">
        {/* ---------- 任务列表 ---------- */}
        <aside className="tasklist">
          <div className="tasklist-head">
            <span className="card-title" style={{ margin: 0 }}>任务列表</span>
            <div className="spacer" />
            <button className="btn sm" onClick={addTask}>+ 新任务</button>
          </div>

          <div className="tasklist-items">
            {plans.map(({ task, plan }, i) => (
              <button
                key={task.id}
                className={`taskitem${task.id === active?.id ? ' on' : ''}${plan.problems.length ? ' bad' : ''}`}
                onClick={() => setActiveId(task.id)}
              >
                <div className="taskitem-top">
                  <span className="taskitem-idx">{i + 1}</span>
                  <span className="taskitem-name">{autoTitle(task, i)}</span>
                </div>
                <div className="taskitem-meta">
                  {plan.problems.length ? (
                    <span className="tag amber">{plan.problems.length} 项待处理</span>
                  ) : (
                    <span className="tag green">{plan.campaigns.length} 条活动</span>
                  )}
                  <span>{parseLines(task.skus).length} SKU</span>
                  <span>{plan.blockRows} 行/条</span>
                </div>
                <div className="taskitem-tools">
                  <span onClick={(e) => { e.stopPropagation(); moveTask(task.id, -1); }} title="上移">↑</span>
                  <span onClick={(e) => { e.stopPropagation(); moveTask(task.id, 1); }} title="下移">↓</span>
                  <span onClick={(e) => { e.stopPropagation(); duplicateTask(task.id); }} title="复制">⧉</span>
                  <span
                    className="del"
                    onClick={(e) => { e.stopPropagation(); removeTask(task.id); }}
                    title="删除"
                  >✕</span>
                </div>
              </button>
            ))}
          </div>

          <div className="tasklist-foot">
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="stat"><b>{totals.campaigns}</b> 条活动</span>
              <div className="spacer" />
              <span className="stat"><b>{totals.rows}</b> 行</span>
            </div>
            {totals.problems > 0 && (
              <div className="note warn" style={{ marginBottom: 8 }}>
                {totals.problems} 个任务还有问题,处理完才能生成
              </div>
            )}
            <button className="btn primary" style={{ width: '100%' }} disabled={blocked} onClick={generate}>
              生成总表并下载
            </button>
            {result && (
              <div className={`note ${result.kind}`} style={{ marginTop: 9 }}>{result.text}</div>
            )}
          </div>
        </aside>

        {/* ---------- 任务编辑器 ---------- */}
        <section className="taskpane">
          {active && (
            <TaskEditor
              key={active.id}
              task={active}
              plan={activePlan}
              index={tasks.findIndex((t) => t.id === active.id)}
              libCount={libCount}
              libTerms={lib?.terms ?? []}
              onChange={(patch) => updateTask(active.id, patch)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

export { AUTO_TYPES, STRATEGIES };
