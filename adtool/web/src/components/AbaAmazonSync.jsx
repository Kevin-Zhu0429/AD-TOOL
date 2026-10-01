import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const when = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

const STAGES = {
  starting: '准备中',
  creating: '向亚马逊申请报告',
  processing: '亚马逊正在生成报告，一般要 1～5 分钟',
  downloading: '下载报告',
  saving: '写入数据',
};

/** 后台同步进度:第几份报告、哪一周、现在在等什么 */
function SyncProgress({ progress, now }) {
  const { total, done, week, batch, batches, stage, retryAt } = progress;
  const percent = total ? Math.round((done / total) * 100) : 0;
  const wait = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000)) : 0;
  const step = stage === 'throttled'
    ? `亚马逊接口限流，${wait ? `${wait} 秒后` : '马上'}自动重试`
    : STAGES[stage] ?? '同步中';
  return <div className="aba-sync-progress" role="status">
    <div className="aba-sync-progress-head">
      <strong>{total ? `第 ${Math.min(done + 1, total)} / ${total} 份报告` : '准备中'}</strong>
      <span>{percent}%</span>
    </div>
    <div className="aba-sync-progress-bar" role="progressbar" aria-label="ABA 同步进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <p className={`hint${stage === 'throttled' ? ' warn' : ''}`}>
      {week ? `${week} 这周${batches > 1 ? `（第 ${batch}/${batches} 批 ASIN）` : ''} · ` : ''}{step}
    </p>
  </div>;
}

/** 宠物版 ASIN 视图:从亚马逊品牌分析按周拉取搜索查询表现 */
export default function AbaAmazonSync({ market, onSynced }) {
  const [status, setStatus] = useState(null);
  const [weeks, setWeeks] = useState(4);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [now, setNow] = useState(Date.now());
  const wasRunning = useRef(false);

  async function refresh() {
    try {
      const next = await api.abaAmazonStatus(market);
      if (wasRunning.current && !next.running) {
        const done = next.lastSuccess;
        if (next.lastError && (!done || next.lastError.at > done.completedAt)) setMsg({ kind: 'err', text: next.lastError.message });
        else {
          const changed = (done?.added ?? 0) + (done?.updated ?? 0);
          setMsg({ kind: 'ok', text: `已同步：新增 ${done?.added ?? 0} 份、更新 ${done?.updated ?? 0} 份 ASIN 周报`
            + (done?.notReady?.length ? `；${done.notReady.join('、')} 那周亚马逊还没出数据，之后会自动补` : '') });
          if (changed) onSynced(done.weeks.map((week) => week.week_end));
        }
      }
      wasRunning.current = next.running;
      setStatus(next);
    } catch (e) {
      setStatus({ configured: false, issues: [e.message] });
    }
  }
  useEffect(() => { refresh(); }, [market]);
  useEffect(() => {
    if (!status?.running) return undefined;
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [status?.running]);
  // 限流等待时每秒刷新倒计时
  const throttled = status?.running && status.progress?.stage === 'throttled';
  useEffect(() => {
    if (!throttled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [throttled]);

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      await api.syncAbaAmazon(market, weeks);
      wasRunning.current = true;
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const last = status?.lastSuccess;
  return <section className="aba-upload aba-amazon-sync" aria-label="从亚马逊同步 ABA">
    <div className="aba-upload-top">
      <div>
        <strong>从亚马逊同步</strong>
        <p className="hint">按 SKU 库里的 ASIN 读取亚马逊品牌分析「搜索查询表现」周报，只补还没有的 ASIN 和周。每天自动补最近 4 周。{status?.configured
          ? (last ? ` 上次同步：${when(last.completedAt)}。` : ' 还没有同步过。')
          : ` ${status?.issues?.[0] ?? '服务器尚未配置宠物店铺的亚马逊 SP-API 凭证。'}`}</p>
      </div>
      <div className="row">
        <label>最近<select className="inp" aria-label="同步周数" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[1, 4, 8, 12].map((n) => <option key={n} value={n}>{n} 周</option>)}</select></label>
        <button className="btn primary" disabled={busy || !status?.configured || status?.running} onClick={sync}>
          {status?.running ? '后台同步中…' : busy ? '正在开始…' : '从亚马逊同步'}
        </button>
      </div>
    </div>
    {status?.running && status.progress && <SyncProgress progress={status.progress} now={now} />}
    {msg && <div className={`note ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
  </section>;
}
