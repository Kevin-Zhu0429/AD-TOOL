import { useEffect, useMemo, useRef } from 'react';
import { resolvePortfolio } from '../portfolioMatch.js';

export default function PortfolioField({ task, skuItems, portfolios, loading, error, onChange }) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const mode = task.portfolioMode || (task.portfolio ? 'manual' : 'auto');
  const result = useMemo(
    () => resolvePortfolio(task.skus, skuItems ?? [], portfolios ?? []),
    [task.skus, skuItems, portfolios]
  );

  useEffect(() => {
    if (mode !== 'auto' || loading || error) return;
    const next = result.status === 'matched' ? result.portfolioId : '';
    if (task.portfolio !== next || task.portfolioMode !== 'auto') {
      onChangeRef.current({ portfolio: next, portfolioMode: 'auto' });
    }
  }, [mode, loading, error, result.status, result.portfolioId, task.portfolio, task.portfolioMode]);

  const known = (portfolios ?? []).some((item) => item.portfolioId === task.portfolio);
  const selectValue = mode === 'auto' ? 'auto' : known ? `portfolio:${task.portfolio}` : 'custom';
  const message = loading
    ? '正在读取广告组合库…'
    : error
      ? error
      : mode === 'manual'
        ? `已手动选择${known ? '库内广告组合' : '自定义编号'}。${result.status !== 'matched' && result.status !== 'empty' ? ` 自动识别提示：${result.message}` : ''}`
        : result.message;
  const tone = error || (!loading && !['matched', 'empty'].includes(result.status)) ? 'warn' : result.status === 'matched' ? 'ok' : 'info';

  return (
    <div className="portfolio-field">
      <label className="field">
        <span>广告组合</span>
        <select
          className="inp"
          value={selectValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'auto') onChange({ portfolioMode: 'auto', portfolio: '' });
            else if (value === 'custom') onChange({ portfolioMode: 'manual', portfolio: '' });
            else onChange({ portfolioMode: 'manual', portfolio: value.slice('portfolio:'.length) });
          }}
          aria-describedby="portfolio-match-status"
        >
          <option value="auto">自动识别投放 SKU</option>
          {(portfolios ?? []).map((item) => (
            <option key={item.id ?? item.portfolioId} value={`portfolio:${item.portfolioId}`}>
              {item.name} · {item.portfolioId}
            </option>
          ))}
          <option value="custom">手动填写其他编号</option>
        </select>
      </label>
      {selectValue === 'custom' && (
        <label className="field portfolio-custom">
          <span>广告组合编号</span>
          <input
            className="inp mono"
            inputMode="numeric"
            value={task.portfolio}
            onChange={(event) => onChange({ portfolioMode: 'manual', portfolio: event.target.value })}
          />
        </label>
      )}
      <p id="portfolio-match-status" className={`portfolio-status ${tone}`} role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
