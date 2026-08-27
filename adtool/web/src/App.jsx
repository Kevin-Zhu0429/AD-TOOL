import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useTheme } from './theme.js';
import { VERSION, hasUnseen } from './changelog.js';
import Changelog, { VersionBadge } from './components/Changelog.jsx';
import LoginPage from './components/LoginPage.jsx';
import AppShell from './components/AppShell.jsx';
import HomePage from './components/HomePage.jsx';
import BuilderPage from './components/BuilderPage.jsx';
import ManualPage from './components/ManualPage.jsx';
import OptimizerPage from './components/OptimizerPage.jsx';
import LibraryPage from './components/LibraryPage.jsx';
import SkuPage from './components/SkuPage.jsx';
import AdminPage from './components/AdminPage.jsx';
import ProfilePage from './components/ProfilePage.jsx';

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [user, setUser] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('home');
  const [market, setMarket] = useState('ES');
  // 更新日志:有没看过的版本就登录后自动弹一次,关掉记成看过
  const [logOpen, setLogOpen] = useState(false);
  const [logAuto, setLogAuto] = useState(false);
  // 打开那一刻「看过的版本」,弹窗开着的时候不变,免得「新」标在眼前消失
  const [logSeen, setLogSeen] = useState('');
  const autoShown = useRef(false);

  useEffect(() => {
    api
      .me()
      .then((res) => {
        setMarkets(res.marketplaces ?? []);
        if (res.user) {
          setUser(res.user);
          setMarket(res.user.markets[0]);
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  function onLoggedIn(u) {
    setUser(u);
    setMarket(u.markets[0]);
    setPage('home');
    autoShown.current = false;   // 换个人登录,该弹的还要再弹
  }

  function openLog(auto = false) {
    setLogSeen(user?.seenVersion ?? '');
    setLogAuto(auto);
    setLogOpen(true);
  }

  /** 关掉就算看过了 —— 记在账号上,换台电脑登录也不会再弹同一版 */
  function closeLog() {
    setLogOpen(false);
    if (!user || !hasUnseen(user.seenVersion)) return;
    setUser((u) => (u ? { ...u, seenVersion: VERSION } : u));
    api.seenVersion(VERSION).then((r) => r.user && setUser(r.user)).catch(() => {});
  }

  // 有没看过的更新就自动弹,一次会话只自动弹一次
  useEffect(() => {
    if (!user || autoShown.current || !hasUnseen(user.seenVersion)) return;
    autoShown.current = true;
    setLogSeen(user.seenVersion ?? '');
    setLogAuto(true);
    setLogOpen(true);
  }, [user]);

  if (checking) return null;

  if (!user) {
    return <LoginPage onLoggedIn={onLoggedIn} theme={theme} onToggleTheme={toggleTheme} />;
  }

  // 切站点要重新拉词库,用 market 做 key 强制重挂载
  const body =
    page === 'builder' ? (
      <BuilderPage key={market} market={market} />
    ) : page === 'manual' && user.manualAds ? (
      <ManualPage key={market} market={market} />
    ) : page === 'optimizer' && user.adOpt ? (
      // 工作台里载的批量表跟站点无关,切站点不重挂载(改动会丢),只换一份词库
      <OptimizerPage theme={theme} market={market} />
    ) : page === 'skus' ? (
      <SkuPage key={market} market={market} />
    ) : page === 'library' ? (
      <LibraryPage key={market} market={market} />
    ) : page === 'admin' && user.role === 'owner' ? (
      <AdminPage user={user} markets={markets} />
    ) : page === 'profile' ? (
      <ProfilePage user={user} onUserChange={setUser} onDone={() => setPage('home')} />
    ) : (
      <HomePage
        user={user} market={market} onNav={setPage} theme={theme}
        onOpenChangelog={() => openLog(false)}
      />
    );

  return (
    <>
      <AppShell
        user={user}
        page={page}
        onNav={setPage}
        market={market}
        onMarket={setMarket}
        onLoggedOut={() => { setUser(null); setPage('home'); autoShown.current = false; }}
        theme={theme}
        onToggleTheme={toggleTheme}
      >
        {body}
      </AppShell>

      {/* 广告优化那一页底部有它自己的操作条,右下角就不占位了 */}
      {page !== 'optimizer' && (
        <VersionBadge unseen={hasUnseen(user.seenVersion)} onClick={() => openLog(false)} />
      )}
      {logOpen && <Changelog seenVersion={logSeen} auto={logAuto} onClose={closeLog} />}
    </>
  );
}
