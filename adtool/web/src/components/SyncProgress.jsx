import { useEffect, useState } from 'react';
import './SyncProgress.css';

const STAGES = {
  starting: '准备中',
  working: '处理中',
  creating: '向亚马逊申请报告',
  processing: '亚马逊正在生成报告，一般要 1～5 分钟',
  downloading: '下载报告',
  saving: '写入数据',
};

/**
 * 亚马逊后台同步的进度条(和 ABA 同步同一个样式)。
 * progress: { total, done, step, stage, retryAt },来自 /price-strategy/status
 */
export default function SyncProgress({ progress, label = '亚马逊同步进度' }) {
  const [now, setNow] = useState(Date.now());
  const throttled = progress?.stage === 'throttled';
  // 限流等待时每秒刷新倒计时
  useEffect(() => {
    if (!throttled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [throttled]);
  if (!progress) return null;
  const { total, done, step, stage, retryAt } = progress;
  const percent = total ? Math.min(99, Math.round((done / total) * 100)) : 0;
  const wait = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000)) : 0;
  const detail = throttled ? `亚马逊接口限流，${wait ? `${wait} 秒后` : '马上'}自动重试` : STAGES[stage] ?? '同步中';
  return <div className="sync-progress" role="status">
    <div className="sync-progress-head">
      <strong>{total ? `第 ${Math.min(done + 1, total)} / ${total} 步` : '准备中'}</strong>
      <span>{percent}%</span>
    </div>
    <div className="sync-progress-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <p className={`hint${throttled ? ' warn' : ''}`}>{step ? `${step} · ` : ''}{detail}</p>
  </div>;
}
