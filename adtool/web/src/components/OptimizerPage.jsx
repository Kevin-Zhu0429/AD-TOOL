import { isPet } from '../profile.js';
import { useEffect, useRef } from 'react';
import { api } from '../api.js';
import { mountOptimizer } from '../optApp.js';
import css from './optimizer.css?inline';
import './OptimizerPage.css';

/**
 * 广告优化工作台。
 * 里面那一整套是从单文件版移植来的原生 JS,这里只负责挂载 / 卸载:
 * 用 Shadow DOM 装起来,它的样式和站内样式互不干扰,主题变量照样继承进去。
 * 站点否定词库和账号 SKU 库在这一层拉,批量否定与跑偏机型检测共用。
 */
export default function OptimizerPage({ theme, market }) {
  const hostRef = useRef(null);
  const appRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);

    const mount = document.createElement('div');
    shadow.append(mount);
    appRef.current = mountOptimizer(mount, host, {
      pet: isPet,
      onAudit: (action, detail) => api.recordActivity(
        'optimizer', action, detail?.marketplace, detail,
      ).catch(() => {}),
    });
    return () => {
      appRef.current?.unmount();
      appRef.current = null;
      mount.remove();
      style.remove();
    };
  }, []);

  // 切站点要换一份词库;工作台是常驻的,不重挂载,只把新词库送进去
  useEffect(() => {
    let alive = true;
    let requestId = 0;
    const refreshLinkedData = (showLoading = false) => {
      const currentRequest = ++requestId;
      if (showLoading) appRef.current?.setLibrary(market, null, '');
      Promise.all([api.library(market), api.skus({ marketplace: market })])
        .then(([library, skus]) => {
          if (alive && currentRequest === requestId) {
            appRef.current?.setLibrary(market, library, '', skus.items ?? []);
          }
        })
        .catch((e) => {
          if (alive && currentRequest === requestId) appRef.current?.setLibrary(market, null, e.message);
        });
    };
    const onInventoryUpdated = () => refreshLinkedData();

    refreshLinkedData(true);
    window.addEventListener('adtool:sku-inventory-updated', onInventoryUpdated);
    return () => {
      alive = false;
      window.removeEventListener('adtool:sku-inventory-updated', onInventoryUpdated);
    };
  }, [market]);

  // 主题切换要传进 Shadow 里,深色条的底色跟着换
  useEffect(() => {
    hostRef.current?.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }, [theme]);

  return <div className="opt-shell"><div className="opt-host" ref={hostRef} /></div>;
}
