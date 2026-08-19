import { useEffect, useRef } from 'react';
import { mountOptimizer } from '../optApp.js';
import css from './optimizer.css?inline';
import './OptimizerPage.css';

/**
 * 广告优化工作台。
 * 里面那一整套是从单文件版移植来的原生 JS,这里只负责挂载 / 卸载:
 * 用 Shadow DOM 装起来,它的样式和站内样式互不干扰,主题变量照样继承进去。
 */
export default function OptimizerPage({ theme }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);

    const mount = document.createElement('div');
    shadow.append(mount);
    const unmount = mountOptimizer(mount, host);
    return () => {
      unmount();
      mount.remove();
      style.remove();
    };
  }, []);

  // 主题切换要传进 Shadow 里,深色条的底色跟着换
  useEffect(() => {
    hostRef.current?.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
  }, [theme]);

  return <div className="opt-shell"><div className="opt-host" ref={hostRef} /></div>;
}
