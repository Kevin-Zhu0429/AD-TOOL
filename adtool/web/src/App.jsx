import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useTheme } from './theme.js';
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
  }

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
      <HomePage user={user} market={market} onNav={setPage} theme={theme} />
    );

  return (
    <AppShell
      user={user}
      page={page}
      onNav={setPage}
      market={market}
      onMarket={setMarket}
      onLoggedOut={() => { setUser(null); setPage('home'); }}
      theme={theme}
      onToggleTheme={toggleTheme}
    >
      {body}
    </AppShell>
  );
}
