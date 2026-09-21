import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { configureProfile } from './profile.js';

function Bootstrap() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch('/api/config', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('无法读取网站配置，请确认后端已更新并启动。');
      const config = await response.json();
      if (!controller.signal.aborted) { configureProfile(config.id); setReady(true); }
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [retry]);
  if (ready) return <App />;
  return <main className="lib"><div className="note" role={error ? 'alert' : 'status'}>{error || '正在载入工作台…'}{error && <button className="btn" onClick={() => setRetry((n) => n + 1)}>重试</button>}</div></main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><Bootstrap /></StrictMode>);
