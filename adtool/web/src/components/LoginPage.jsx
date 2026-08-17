import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import CloudShader from './CloudShader.jsx';
import './LoginPage.css';

export default function LoginPage({ onLoggedIn, theme, onToggleTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [noWebgl, setNoWebgl] = useState(false);

  // 云层只在浅色主题下铺;显卡不支持时退回原来的网格 + 光晕
  const sky = theme === 'light' && !noWebgl;

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) return setError('请填写用户名和密码');
    setLoading(true);
    try {
      const { user } = await api.login(username.trim(), password);
      onLoggedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`login${sky ? ' has-sky' : ''}`}>
      {sky ? (
        <CloudShader
          className="login-sky"
          speed={0.85}
          skyTopColor="#2f6fe0"
          skyBottomColor="#a8d2f2"
          cloudColor="#fdfbf6"
          onUnsupported={() => setNoWebgl(true)}
        />
      ) : (
        <>
          <div className="login-grid" aria-hidden="true" />
          <div className="login-halo" aria-hidden="true" />
        </>
      )}

      <form className="login-card animate-in" onSubmit={submit}>
        <button
          type="button"
          className="btn ghost icon login-theme"
          onClick={onToggleTheme}
          aria-label="切换主题"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>

        <div className="login-brand">
          <span className="login-glyph">PH</span>
          <div>
            <div className="login-name">广告工作台</div>
            <div className="login-tag">批量开发 · 否定词库</div>
          </div>
        </div>

        <div className="stack" style={{ gap: 13 }}>
          <label className="field">
            <span>用户名</span>
            <input
              className="inp" autoFocus autoComplete="username"
              value={username} onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              className="inp" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {error && (
            <div className="note err">
              <Icon name="alert" className="ico-sm" style={{ marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          <button className="btn primary" type="submit" disabled={loading} style={{ marginTop: 2 }}>
            {loading ? '登录中…' : '登录'}
          </button>
        </div>

        <div className="login-foot">仅限公司内网 · 账号由管理员开通</div>
      </form>
    </div>
  );
}
