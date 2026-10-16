import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import BuilderPage from './BuilderPage.jsx';
import ManualPage from './ManualPage.jsx';
import SbPage from './SbPage.jsx';
import { C, SHEET, buildWorkbookData, downloadSheets, todayStamp } from '../adEngine.js';
import { buildManualWorkbookData } from '../manualEngine.js';
import { SB_SHEET, buildSbWorkbookData } from '../sbEngine.js';
import { normLibData } from '../negLib.js';
import './BuilderPage.css';
import './AdsPage.css';

/*
 * 开设广告:SP 自动(瀑布流 / 组合)、SP 手动、SB 品牌三种放在一页,顶部切换。
 * 三种任务各管各的列表和草稿,最后一键生成一个 xlsx:
 * SP 自动 + SP 手动写进「商品推广活动」一页,SB 写进「品牌推广多个广告组广告活动」一页。
 */

const TABS = [
  { id: 'auto', label: 'SP 自动', sub: '瀑布流 / 组合,批量开自动广告' },
  { id: 'manual', label: 'SP 手动', sub: '关键词 / 商品投放', perm: 'manualAds' },
  { id: 'sb', label: 'SB 品牌', sub: '集合 / 视频,支持瀑布流', perm: 'manualAds' },
];
const TAB_KEY = 'adtool.ads.tab';

function readTab() {
  try { return localStorage.getItem(TAB_KEY) || ''; } catch { return ''; }
}
function saveTab(id) {
  try { localStorage.setItem(TAB_KEY, id); } catch { /* 存不了就算了 */ }
}

/** 某一类任务的统计:活动数、待处理任务数 */
function summarize(kind, report) {
  if (!report) return { campaigns: 0, problems: 0, used: false };
  const { plans, used } = report;
  const problems = plans.filter((x) => x.plan.problems.length).length;
  const campaigns = kind === 'manual'
    ? plans.filter((x) => x.plan.ok).length
    : plans.reduce((a, x) => a + (x.plan.problems.length ? 0 : x.plan.campaigns.length), 0);
  return { campaigns, problems, used };
}

export default function AdsPage({ market, user, initialTab }) {
  const tabs = TABS.filter((t) => !t.perm || user[t.perm]);
  const [tab, setTab] = useState(() => {
    const want = initialTab || readTab();
    return tabs.some((t) => t.id === want) ? want : tabs[0].id;
  });
  const [lib, setLib] = useState(null);
  const [libError, setLibError] = useState('');
  const [skuItems, setSkuItems] = useState(null);
  const [portfolios, setPortfolios] = useState(null);
  const [portfolioError, setPortfolioError] = useState('');
  const [reports, setReports] = useState({});
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (initialTab && tabs.some((t) => t.id === initialTab)) setTab(initialTab);
  }, [initialTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // 三种广告共用一份词库 / SKU 库 / 广告组合库,只读一次
  useEffect(() => {
    setPortfolioError('');
    api.library(market).then(setLib).catch((e) => setLibError(e.message));
    api.skus({ marketplace: market }).then((r) => setSkuItems(r.items ?? [])).catch((e) => { setSkuItems([]); setPortfolioError((old) => [old, `SKU 库读取失败：${e.message}`].filter(Boolean).join('；')); });
    api.portfolios(market).then((r) => setPortfolios(r.items ?? [])).catch((e) => { setPortfolios([]); setPortfolioError((old) => [old, `广告组合库读取失败：${e.message}`].filter(Boolean).join('；')); });
  }, [market]);

  const libData = useMemo(() => normLibData(lib), [lib]);
  const data = useMemo(
    () => ({ lib, libData, skuItems, portfolios, portfolioError }),
    [lib, libData, skuItems, portfolios, portfolioError]
  );

  const reporters = useMemo(() => Object.fromEntries(['auto', 'manual', 'sb'].map((k) => [
    k, (r) => { setReports((prev) => ({ ...prev, [k]: r })); setResult(null); },
  ])), []);

  const stats = {
    auto: summarize('auto', reports.auto),
    manual: summarize('manual', reports.manual),
    sb: summarize('sb', reports.sb),
  };
  const enabled = tabs.map((t) => t.id);
  const inUse = enabled.filter((k) => stats[k].used);
  const totalCampaigns = inUse.reduce((a, k) => a + stats[k].campaigns, 0);
  const pending = inUse.filter((k) => stats[k].problems > 0);
  const loading = skuItems === null || portfolios === null;
  const blocked = loading || !inUse.length || pending.length > 0 || totalCampaigns === 0;
  const labelOf = (k) => TABS.find((t) => t.id === k)?.label ?? k;

  const generate = useCallback(() => {
    try {
      const bad = [];
      const sheets = [];
      let spAoa = null;
      const counts = {};
      if (inUse.includes('auto')) {
        const wb = buildWorkbookData(reports.auto.plans);
        bad.push(...wb.bad.map((x) => `SP 自动 · ${x}`));
        spAoa = wb.aoa;
        counts.auto = wb.placed.length;
      }
      if (inUse.includes('manual')) {
        const wb = buildManualWorkbookData(reports.manual.plans);
        bad.push(...wb.bad.map((x) => `SP 手动 · ${x}`));
        // 和自动广告同一套表头,接在后面,中间空一行
        spAoa = spAoa ? [...spAoa, new Array(wb.aoa[0].length).fill(null), ...wb.aoa.slice(1)] : wb.aoa;
        counts.manual = wb.placed.length;
      }
      if (spAoa) {
        const names = spAoa.filter((r) => r[C.ENTITY] === '广告活动').map((r) => r[C.CAMP]);
        const dup = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
        if (dup.length) bad.push(`SP 自动和手动里有同名活动:${dup.slice(0, 3).join('、')}`);
        sheets.push({ name: SHEET, aoa: spAoa });
      }
      if (inUse.includes('sb')) {
        const wb = buildSbWorkbookData(reports.sb.plans);
        bad.push(...wb.bad.map((x) => `SB 品牌 · ${x}`));
        sheets.push({ name: SB_SHEET, aoa: wb.aoa, widths: wb.aoa[0].map((h) => Math.max(10, Math.min(30, String(h).length * 2))) });
        counts.sb = wb.placed.length;
      }
      if (bad.length) {
        setResult({ kind: 'err', text: `自检未通过(${bad.length} 项):${bad.slice(0, 5).join('；')}` });
        return;
      }
      const file = `开设广告-${market}-${todayStamp()}.xlsx`;
      downloadSheets(sheets, file);
      const rows = sheets.reduce((a, s) => a + s.aoa.length, 0);
      api.recordActivity('builder', 'export', market, { ...counts, rows }).catch(() => {});
      const parts = [
        counts.auto ? `SP 自动 ${counts.auto} 条` : '',
        counts.manual ? `SP 手动 ${counts.manual} 条` : '',
        counts.sb ? `SB 品牌 ${counts.sb} 条` : '',
      ].filter(Boolean);
      setResult({ kind: 'ok', text: `已生成广告活动:${parts.join('、')},共 ${rows} 行(含表头),自检全部通过。文件:${file}` });
    } catch (e) {
      setResult({ kind: 'err', text: e.message });
    }
  }, [inUse, reports, market]);

  const libCount = Object.values(lib?.items ?? {}).reduce((a, x) => a + x.length, 0);

  return (
    <div className="builder ads-page">
      <header className="bhero">
        <div className="bhero-glow" />
        <div className="bhero-text">
          <h1>
            开设广告
            <span className="bhero-mk">{market} 站</span>
          </h1>
          <p className="hint">
            SP 自动、SP 手动、SB 品牌在这一页切换着填,最后一键生成一个总表(SP 一页、SB 一页)直接上传后台。
            填的内容会自动存在这台电脑上,切页面、刷新都还在。
            {libError ? ` 词库读取失败:${libError}` : ` 本站点否定词库共 ${libCount} 条,三种广告都能套用。`}
          </p>
        </div>
        <div className="bhero-stats">
          {[
            ['广告活动', totalCampaigns, 'accent'],
            ...tabs.map((t) => [t.label, stats[t.id].campaigns, '']),
          ].map(([label, value, tone]) => (
            <div className={`kpi${tone ? ` ${tone}` : ''}`} key={label}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </header>

      <div className="ads-switch">
        <div className="ads-tabs" role="tablist" aria-label="广告类型">
          {tabs.map((t) => {
            const s = stats[t.id];
            return (
              <button
                key={t.id} role="tab" aria-selected={tab === t.id}
                className={`ads-tab${tab === t.id ? ' on' : ''}`}
                onClick={() => { setTab(t.id); saveTab(t.id); }}
              >
                <b>{t.label}</b>
                <span>{t.sub}</span>
                {s.used && (
                  <em className={`tag ${s.problems ? 'amber' : 'green'}`}>
                    {s.problems ? `${s.problems} 待处理` : `${s.campaigns} 条`}
                  </em>
                )}
              </button>
            );
          })}
        </div>
        <div className="spacer" />
        {pending.length > 0 && (
          <span className="tag amber">{pending.map(labelOf).join('、')} 有任务待处理</span>
        )}
        <button className="btn primary" disabled={blocked} onClick={generate}>
          <Icon name="download" className="ico-sm" />
          生成总表并下载
        </button>
      </div>

      {result && <div className={`note ${result.kind} bresult animate-in`}>{result.text}</div>}

      {/* 三种都挂着,只是隐藏 —— 切来切去填的内容不丢,也能一起生成 */}
      {tabs.map((t) => (
        <div key={t.id} hidden={tab !== t.id}>
          {t.id === 'auto' && <BuilderPage market={market} data={data} onReport={reporters.auto} />}
          {t.id === 'manual' && <ManualPage market={market} data={data} onReport={reporters.manual} />}
          {t.id === 'sb' && <SbPage market={market} data={data} onReport={reporters.sb} />}
        </div>
      ))}
    </div>
  );
}
