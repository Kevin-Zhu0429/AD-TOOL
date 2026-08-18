import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import TaskForm from './TaskForm.jsx';
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
    // 每一类词库这个任务要不要套用;E 类数据格式还没定,默认不带
    libUse: { A: true, B: true, C: true, D: true, E: false },
    adType: 'mixed',        // mixed = 混合广告;series = 系列广告,D 类联动否定其它型号
    seriesModels: [],       // 系列广告投的是哪几个墨盒型号
    seriesScope: 'both',    // 联动否定的范围:both / models 只否墨盒 / printers 只否打印机
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

  /** 词库数据整理成引擎要的形状:定义 + 各类行 + 本站点的套用设置 */
  const libData = useMemo(() => {
    const config = {};
    for (const c of lib?.config ?? []) {
      config[c.lib] = { enabled: c.enabled !== 0, matchType: c.match_type, level: c.level };
    }
    return { libs: lib?.libs ?? [], items: lib?.items ?? {}, config, scopes: lib?.scopes ?? {} };
  }, [lib]);

  /** 每个任务各自算一遍计划,词库按任务开关决定带不带 */
  const plans = useMemo(() => {
    return tasks.map((task) => {
      const negData = buildNegatives(libData, task);
      return { task, plan: buildTaskPlan(task, negData) };
    });
  }, [tasks, libData]);

  const totals = useMemo(() => {
    const campaigns = plans.reduce((a, x) => a + x.plan.campaigns.length, 0);
    const problems = plans.filter((x) => x.plan.problems.length).length;
    const rows = plans.reduce(
      (a, x) => a + x.plan.campaigns.length * (x.plan.blockRows + 1), 0
    );
    const skus = plans.reduce((a, x) => a + parseLines(x.task.skus).length, 0);
    return { campaigns, problems, rows, skus };
  }, [plans]);

  const blocked = totals.problems > 0 || totals.campaigns === 0;

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setResult(null);
  }

  function addTask() {
    // 新任务沿用上一个任务的参数,只清空标题 —— 连开几个系列时省事
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
  const libCount = Object.values(lib?.items ?? {}).reduce((a, x) => a + x.length, 0);
  const multi = tasks.length > 1;

  return (
    <div className="builder">
      {/* ---------- 页头 ---------- */}
      <header className="bhero">
        <div className="bhero-glow" />
        <div className="bhero-text">
          <h1>
            开设广告
            <span className="bhero-mk">{market} 站</span>
          </h1>
          <p className="hint">
            一页填完:SKU、组合、命名、参数、否定,右边实时预览。
            {libError ? ` 词库读取失败:${libError}` : ` 本站点词库共 ${libCount} 条,可在每个任务里选择是否套用。`}
          </p>
        </div>
        <div className="bhero-stats">
          {[
            ['广告活动', totals.campaigns, 'accent'],
            ['总行数', totals.rows, ''],
            ['SKU', totals.skus, ''],
            ['任务', tasks.length, ''],
          ].map(([label, value, tone]) => (
            <div className={`kpi${tone ? ` ${tone}` : ''}`} key={label}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </header>

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

        {totals.problems > 0 && (
          <span className="tag amber">{totals.problems} 个任务待处理</span>
        )}
        <button className="btn primary" disabled={blocked} onClick={generate}>
          <Icon name="download" className="ico-sm" />
          生成总表并下载
        </button>
      </div>

      {result && <div className={`note ${result.kind} bresult animate-in`}>{result.text}</div>}

      {/* ---------- 一页式表单 ---------- */}
      {active && (
        <TaskForm
          key={active.id}
          task={active}
          plan={activePlan}
          index={tasks.findIndex((t) => t.id === active.id)}
          libCount={libCount}
          lib={libData}
          onChange={(patch) => updateTask(active.id, patch)}
        />
      )}
    </div>
  );
}

export { AUTO_TYPES, STRATEGIES };
