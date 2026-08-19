import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';
import './AppShell.css';

const ROLE = {
  owner: { label: '超级管理员', cls: 'blue' },
  admin: { label: '国家管理员', cls: 'green' },
  operator: { label: '运营', cls: 'gray' },
};

export default function AppShell({
  user, page, onNav, market, onMarket, onLoggedOut, theme, onToggleTheme, children,
}) {
  const [menu, setMenu] = useState(false);
  const popRef = useRef(null);
  const role = ROLE[user.role] ?? { label: user.role, cls: 'gray' };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const nav = [
    { id: 'home', label: '首页', icon: 'home' },
    { id: 'builder', label: '自动广告', icon: 'layers' },
    ...(user.manualAds ? [{ id: 'manual', label: '手动广告', icon: 'sliders' }] : []),
    { id: 'library', label: '否定词库', icon: 'book' },
    { id: 'skus', label: 'SKU 库', icon: 'file' },
    ...(user.role === 'owner' ? [{ id: 'admin', label: '账号管理', icon: 'users' }] : []),
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <button className="topbar-brand" onClick={() => onNav('home')}>
          <span className="topbar-glyph">PH</span>
          <span className="topbar-name">广告工作台</span>
        </button>

        <nav className="topnav">
          {nav.map((it) => (
            <button
              key={it.id}
              className={`topnav-item${page === it.id ? ' on' : ''}`}
              onClick={() => onNav(it.id)}
            >
              <Icon name={it.icon} className="ico-sm" />
              <span>{it.label}</span>
            </button>
          ))}
        </nav>

        <div className="spacer" />

        {user.markets.length > 1 ? (
          <div className="market-wrap">
            <select
              className="inp market-pick"
              value={market}
              onChange={(e) => onMarket(e.target.value)}
              aria-label="切换站点"
            >
              {user.markets.map((m) => (
                <option key={m} value={m}>{m} 站</option>
              ))}
            </select>
          </div>
        ) : (
          <span className="market-fixed">{market} 站</span>
        )}

        <button
          className="btn ghost icon theme-btn"
          onClick={onToggleTheme}
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          aria-label="切换主题"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>

        <div className="usermenu" ref={popRef}>
          <button className={`usermenu-btn${menu ? ' on' : ''}`} onClick={() => setMenu((v) => !v)}>
            <span className="avatar">{user.displayName.slice(0, 1)}</span>
            <span className="uname">{user.displayName}</span>
            <Icon name="down" className="ico-sm caret" />
          </button>

          {menu && (
            <>
              <div className="usermenu-mask" onClick={() => setMenu(false)} />
              <div className="usermenu-pop animate-in">
                <div className="usermenu-head">
                  <span className="avatar lg">{user.displayName.slice(0, 1)}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="usermenu-name">{user.displayName}</div>
                    <div className="usermenu-sub mono">{user.username}</div>
                  </div>
                </div>
                <div className="usermenu-badges">
                  <span className={`tag ${role.cls}`}>{role.label}</span>
                  <span className="tag gray">
                    {user.role === 'owner' ? '全部站点' : `${user.markets.join(' / ')} 站`}
                  </span>
                </div>

                <div className="usermenu-sep" />

                <button className="usermenu-item" onClick={() => { setMenu(false); onNav('profile'); }}>
                  <Icon name="user" className="ico-sm" />个人资料
                </button>
                <button className="usermenu-item" onClick={() => { setMenu(false); onToggleTheme(); }}>
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="ico-sm" />
                  {theme === 'dark' ? '浅色主题' : '深色主题'}
                </button>

                <div className="usermenu-sep" />

                <button
                  className="usermenu-item danger"
                  onClick={async () => { await api.logout(); onLoggedOut(); }}
                >
                  <Icon name="logout" className="ico-sm" />退出登录
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="shell-main">{children}</main>
    </div>
  );
}
