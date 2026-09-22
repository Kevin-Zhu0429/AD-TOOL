import { isPet, profile } from './profile.js';
import PetProductPage from './components/PetProductPage.jsx';
import PriceStrategyPage from './components/PriceStrategyPage.jsx';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { useTheme } from './theme.js';
import { hasUnseen, visibleVersion } from './changelog.js';
import Changelog, { VersionBadge } from './components/Changelog.jsx';
import LoginPage from './components/LoginPage.jsx';
import AppShell from './components/AppShell.jsx';
import HomePage from './components/HomePage.jsx';
import BuilderPage from './components/BuilderPage.jsx';
import ManualPage from './components/ManualPage.jsx';
import OptimizerPage from './components/OptimizerPage.jsx';
import LibraryPage from './components/LibraryPage.jsx';
import SkuPage from './components/SkuPage.jsx';
import PortfolioPage from './components/PortfolioPage.jsx';
import AdminPage from './components/AdminPage.jsx';
import ProfilePage from './components/ProfilePage.jsx';
import ProductPage from './components/ProductPage.jsx';
import ToolsPage from './components/ToolsPage.jsx';
import AbaPage from './components/AbaPage.jsx';

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [user, setUser] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('home');
  // 广告优化工作台首次打开后保持挂载，避免切到其他页面时原生工作台被卸载、改动丢失。
  const [optimizerOpened, setOptimizerOpened] = useState(false);
  const [market, setMarket] = useState(profile.defaultMarket);
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

  useEffect(() => {
    const labels = {
      home: '首页', builder: '自动广告', manual: '手动广告', optimizer: '广告优化',
      library: '否定词库', skus: 'SKU 库', portfolios: '广告组合库', aba: 'ABA 报告',
      products: '产品情报', priceStrategy: '价格策略表', tools: '小工具', admin: '账号管理', profile: '个人资料',
    };
    document.title = `${labels[page] ?? '首页'} — 广告工作台`;
  }, [page]);

  function onLoggedIn(u) {
    setUser(u);
    setMarket(u.markets[0]);
    setPage('home');
    autoShown.current = false;   // 换个人登录,该弹的还要再弹
  }

  function navigate(nextPage) {
    if (nextPage === 'optimizer') setOptimizerOpened(true);
    if (nextPage !== page) {
      api.recordActivity(nextPage, 'open', market).catch(() => {});
    }
    setPage(nextPage);
  }

  function openLog(auto = false) {
    setLogSeen(user?.seenVersion ?? '');
    setLogAuto(auto);
    setLogOpen(true);
  }

  /** 关掉就算看过了 —— 记在账号上,换台电脑登录也不会再弹同一版 */
  function closeLog() {
    setLogOpen(false);
    if (!user || !hasUnseen(user.seenVersion, user)) return;
    const version = visibleVersion(user);
    setUser((u) => (u ? { ...u, seenVersion: version } : u));
    api.seenVersion(version).then((r) => r.user && setUser(r.user)).catch(() => {});
  }

  // 有没看过的更新就自动弹,一次会话只自动弹一次
  useEffect(() => {
    if (isPet || !user || autoShown.current || !hasUnseen(user.seenVersion, user)) return;
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
      null
    ) : page === 'skus' ? (
      <SkuPage key={market} market={market} />
    ) : page === 'portfolios' ? (
      <PortfolioPage key={market} market={market} />
    ) : page === 'aba' ? (
      <AbaPage key={`${user.id}:${market}`} market={market} userId={user.id} />
    ) : page === 'library' && !isPet ? (
      <LibraryPage key={market} market={market} />
    ) : page === 'products' && user.productIntel ? (
      isPet ? <PetProductPage key={market} market={market} /> : <ProductPage key={market} market={market} />
    ) : page === 'priceStrategy' && isPet ? (
      <PriceStrategyPage />
    ) : page === 'tools' ? (
      <ToolsPage />
    ) : page === 'admin' && user.role === 'owner' ? (
      <AdminPage user={user} markets={markets} />
    ) : page === 'profile' ? (
      <ProfilePage user={user} onUserChange={setUser} onDone={() => navigate('home')} />
    ) : (
      <HomePage
        user={user} market={market} onNav={navigate} theme={theme}
        onOpenChangelog={() => openLog(false)}
      />
    );

  return (
    <>
      <AppShell
        user={user}
        page={page}
        onNav={navigate}
        market={market}
        onMarket={setMarket}
        onLoggedOut={() => {
          setUser(null);
          setPage('home');
          setOptimizerOpened(false);
          autoShown.current = false;
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
      >
        {/*
          工作台里载入的批量表和所有编辑状态都保存在其原生应用实例中。
          首次进入后只隐藏、不卸载，回到其他页面再切回来仍是原来的实例。
        */}
        {optimizerOpened && user.adOpt && (
          <div style={{ display: page === 'optimizer' ? 'block' : 'none' }}>
            <OptimizerPage theme={theme} market={market} />
          </div>
        )}
        {(!user.adOpt || page !== 'optimizer') && body}
      </AppShell>

      {/* 广告优化那一页底部有它自己的操作条,右下角就不占位了 */}
      {!isPet && page !== 'optimizer' && (
        <VersionBadge
          version={visibleVersion(user)}
          unseen={hasUnseen(user.seenVersion, user)}
          onClick={() => openLog(false)}
        />
      )}
      {logOpen && <Changelog user={user} seenVersion={logSeen} auto={logAuto} onClose={closeLog} />}
    </>
  );
}
