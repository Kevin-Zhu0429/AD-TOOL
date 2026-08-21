import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import ManualForm from './ManualForm.jsx';
import { parseLines, buildNegatives, downloadWorkbook, todayStamp } from '../adEngine.js';
import { buildManualPlan, buildManualWorkbookData, MATCH_TYPES, TARGET_TYPES } from '../manualEngine.js';
import './BuilderPage.css';
import './ManualPage.css';

let seq = 1;

/** 关键词 / 商品投放两组粘贴框的初始状态 */
const emptyKw = () => Object.fromEntries(
  MATCH_TYPES.map((mt, i) => [mt.id, { on: i === 0, bid: '', text: '' }])
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
    date: todayStamp(),
    budget: 1.2,
    defBid: 0.3,
    strategy: 'down',
    places: { TOS: '', ROS: '', PP: '' },
    skus: '',
    mode: 'kw',                // kw = 关键词投放;tgt = 商品投放(ASIN / 品类)
    splitGroup: false,
    kw: emptyKw(),
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

export default function ManualPage({ market }) {
  const [lib, setLib] = useState(null);
  const [libError, setLibError] = useState('');
  const [tasks, setTasks] = useState(() => [newManualTask()]);
  const [activeId, setActiveId] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    setResult(null);
    api.library(market).then(setLib).catch((e) => setLibError(e.message));
  }, [market]);

  useEffect(() => {
    if (!activeId && tasks.length) setActiveId(tasks[0].id);
  }, [tasks, activeId]);

  const libData = useMemo(() => {
    const config = {};
    for (const c of lib?.config ?? []) {
      config[c.lib] = { enabled: c.enabled !== 0, matchType: c.match_type, level: c.level };
    }
    return { libs: lib?.libs ?? [], items: lib?.items ?? {}, config, scopes: lib?.scopes ?? {} };
  }, [lib]);

  const plans = useMemo(
    () => tasks.map((task) => ({ task, plan: buildManualPlan(task, buildNegatives(libData, task)) })),
    [tasks, libData]
  );

  const totals = useMemo(() => {
    const ok = plans.filter((x) => x.plan.ok).length;
    const problems = plans.filter((x) => x.plan.problems.length).length;
    const rows = plans.reduce((a, x) => a + (x.plan.ok ? x.plan.rows + 1 : 0), 0);
    const targets = plans.reduce((a, x) => a + x.plan.targets, 0);
    const skus = plans.reduce((a, x) => a + parseLines(x.task.skus).length, 0);
    return { ok, problems, rows, targets, skus };
  }, [plans]);

  const blocked = totals.problems > 0 || totals.ok === 0;

  function updateTask(id, patch) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setResult(null);
  }

  function addTask() {
    // 沿用上一条活动的参数,只清空名称和关键词 —— 连开几条时省事
    const last = tasks[tasks.length - 1];
    const t = last
      ? newManualTask({
        ...last, id: `m${seq++}`, camp: '', group: '',
        kw: emptyKw(), tgt: emptyTgt(),
      })
      : newManualTask();
    setTasks((prev) => [...prev, t]);
    setActiveId(t.id);
    setResult(null);
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
    setResult(null);
  }

  function removeTask(id) {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      return next.length ? next : [newManualTask()];
    });
    setActiveId(null);
    setResult(null);
  }

  function generate() {
    try {
      const wb = buildManualWorkbookData(plans);
      if (wb.bad.length) {
        setResult({
          kind: 'err',
          text: `自检未通过(${wb.bad.length} 项):${wb.bad.slice(0, 5).join('；')}`,
        });
        return;
      }
      const file = `手动广告-${market}-${todayStamp()}.xlsx`;
      downloadWorkbook(wb.aoa, file);
      const kw = wb.placed.reduce((a, x) => a + x.plan.targets, 0);
      setResult({
        kind: 'ok',
        text: `已生成 ${wb.placed.length} 条广告活动、${kw} 条关键词/商品定向,共 ${wb.aoa.length} 行,自检全部通过。文件:${file}`,
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
      <header className="bhero">
        <div className="bhero-glow" />
        <div className="bhero-text">
          <h1>
            手动广告
            <span className="bhero-mk">{market} 站</span>
          </h1>
          <p className="hint">
            关键词投放和商品投放(ASIN 定向)。关键词和 ASIN 自己粘贴,不接任何词表库;
            {libError ? ` 词库读取失败:${libError}` : ` 否定词仍然联动本站词库(共 ${libCount} 条)。`}
          </p>
        </div>
        <div className="bhero-stats">
          {[
            ['广告活动', totals.ok, 'accent'],
            ['总行数', totals.rows, ''],
            ['关键词/定向', totals.targets, ''],
            ['SKU', totals.skus, ''],
          ].map(([label, value, tone]) => (
            <div className={`kpi${tone ? ` ${tone}` : ''}`} key={label}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </header>

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
          <button className="btn sm addtask" onClick={addTask}>
            <Icon name="plus" className="ico-sm" />新活动
          </button>
          {active && (
            <button className="btn sm ghost" onClick={() => duplicateTask(active.id)} title="复制当前活动">
              <Icon name="copy" className="ico-sm" />复制
            </button>
          )}
        </div>

        <div className="spacer" />

        {totals.problems > 0 && (
          <span className="tag amber">{totals.problems} 条活动待处理</span>
        )}
        <button className="btn primary" disabled={blocked} onClick={generate}>
          <Icon name="download" className="ico-sm" />
          生成总表并下载
        </button>
      </div>

      {result && <div className={`note ${result.kind} bresult animate-in`}>{result.text}</div>}

      {active && (
        <ManualForm
          key={active.id}
          task={active}
          plan={activePlan}
          libCount={libCount}
          lib={libData}
          market={market}
          onChange={(patch) => updateTask(active.id, patch)}
        />
      )}
    </div>
  );
}
