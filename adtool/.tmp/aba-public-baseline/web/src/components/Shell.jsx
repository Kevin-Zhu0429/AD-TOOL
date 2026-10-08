import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './Shell.css';

const ROLE_LABEL = {
  admin: '管理员',
  operator: '运营',
  viewer: '只读',
};

export default function Shell({ user, onLoggedOut }) {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  async function handleLogout() {
    await api.logout();
    onLoggedOut();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="topbar-dot" />
          词库系统
        </div>
        <div className="topbar-user">
          <span className="topbar-role">{ROLE_LABEL[user.role] || user.role}</span>
          <span>{user.displayName}</span>
          <button className="topbar-logout" onClick={handleLogout}>
            退出
          </button>
        </div>
      </header>

      <main className="shell-main">
        <div className="welcome-card">
          <h1>欢迎,{user.displayName}</h1>
          <p>登录链路已经打通。词库的增删改查会接在这个框架里。</p>

          <div className="status-row">
            <span className={`status-dot ${health ? 'ok' : 'bad'}`} />
            {health ? `服务连接正常 · ${health.time}` : '服务连接异常'}
          </div>
        </div>
      </main>
    </div>
  );
}
