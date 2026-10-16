import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useReducedMotion } from '../useReducedMotion.js';
import { hasUnseen, visibleChangelog, visibleVersion } from '../changelog.js';
import Icon from './Icon.jsx';
import CloudShader from './CloudShader.jsx';
import CircularCarousel from './CircularCarousel.jsx';
import CardAmbientBackground from './CardAmbientBackground.jsx';
import './HomePage.css';

function homeEntries(user, market) {
  return [
    { id: "aba", tone: "blue", icon: "chart", title: "ABA 报告", desc: "上传品牌搜索查询周报，按搜索词、墨盒系列和对应机型筛选，查看每周查询量、曝光、点击和购买表现。", meta: "品牌视图 · 数据仅自己可见 · 服务器保存" },
    { id: "builder", tone: "blue", icon: "layers", title: "开设广告", desc: user.manualAds ? "SP 自动、SP 手动、SB 品牌三种广告在一页里切换着填，一次生成可直接上传的总表。自动广告保留瀑布流；SB 支持集合、视频两种格式，也能按溢价档位开瀑布流。词库里的否定词三种广告都能套用。" : "按任务批量配置自动广告（瀑布流 / 组合），一次生成可直接上传的总表。词库里的否定词会自动带进每一条活动；开系列广告时还会按 D 类反推，把其它墨盒和打印机型号一起否掉。", meta: user.manualAds ? "SP + SB · 生成 xlsx 批量表" : "生成 xlsx 批量表" },
    { id: "optimizer", tone: "blue", icon: "chart", title: "广告优化", desc: "把后台下载的批量表拖进来,逐条活动看广告位 / SKU / 投放 / 搜索词的表现,改竞价、调溢价、批量否定,最后导出能直接回传的批量表。批量否定可以直接勾本站词库的 A–E 类,D 类还能按在投的墨盒型号反推该否掉的其它型号。", meta: "试用中 · 数据只在本机浏览器里解析", visible: user.adOpt },
    { id: "library", tone: "green", icon: "book", title: `${market} 站否定词库`, desc: "A 无名词 · B 非售品牌 · C 非售流量干扰墨盒 · D 在售墨盒和打印机 · E 原装竞品 ASIN。改动立即生效。D 类还能当型号库单独用:后台否定助手里一次搜多个墨盒型号,把墨盒或打印机型号复制走,直接粘进后台否定。", meta: user.goodsAdmin ? 'A–E 都可编辑' : 'A 类可编辑,B–E 只读' },
    { id: "skus", tone: "amber", icon: "file", title: "我的 SKU 库", desc: "按国家 / 品牌 / 型号 / 套组存自己负责的 SKU 和库存。每个账号一份自己的,开广告时在「投放 SKU」那里一键挑进去。", meta: "模板导入 · 只有自己看得到" },
    { id: "portfolios", tone: "violet", icon: "layers", title: `${market} 站广告组合库`, desc: "导入广告组合编号和名称。开自动或手动广告时，会按投放 SKU 的型号自动选择对应 Series；多个系列自动选择混投，也可手动覆盖。", meta: "两列模板 · 每个账号独立" },
    { id: "products", tone: "amber", icon: "chart", title: `${market} 站产品情报`, desc: "维护分市场产品库,按品牌、型号和具体色组筛选,查看 ABCD 价格档位、价格阶梯和机会竞品。", meta: "产品库 · 竞品对比", visible: user.productIntel },
    { id: "tools", tone: "green", icon: "box", title: "小工具", desc: "合并多个 Excel 表格，快速得到一份完整总表。", meta: "所有账号可用 · 表格合并" },
    { id: "agedFees", tone: "blue", icon: "box", title: "FBA 超龄仓储费", desc: "导入库存表，按品牌和市场查看费用；修正日销后即时重算，并导出当前筛选结果。", meta: "所有账号共享 · 支持 ZIP 与 Excel" },
    { id: "admin", tone: "violet", icon: "users", title: "账号管理", desc: "新建账号、分配国家和角色、重置密码、停用离职人员,以及查看全部操作留痕。", meta: "仅超级管理员可见", visible: user.role === 'owner' },
  ].filter((entry) => !Object.hasOwn(entry, 'visible') || entry.visible);
}

function CarouselEntry({ entry, slice, light }) {
  return (
    <div className={`home-ring-card ${entry.tone}`}>
      <CardAmbientBackground id={entry.id} slice={slice} light={light} />
      <span className="home-ring-mark"><Icon name={entry.icon} size={66} /></span>
      <div className="home-ring-copy">
        <span className="home-ring-title">{entry.title}</span>
        <span className="home-ring-desc">{entry.desc}</span>
      </div>
      <span className="home-ring-foot">{entry.meta}<Icon name="external" size={15} /></span>
    </div>
  );
}

export default function HomePage({ user, market, onNav, theme, onOpenChangelog }) {
  const [libCount, setLibCount] = useState(null);
  const [noWebgl, setNoWebgl] = useState(false);
  const [activeId, setActiveId] = useState('aba');
  const [paused, setPaused] = useState(false);
  const reducedMotion = useReducedMotion();
  const [selection, setSelection] = useState({ index: undefined, revision: 0 });
  const entries = useMemo(() => homeEntries(user, market), [user, market]);
  const activeIndex = Math.max(0, entries.findIndex((entry) => entry.id === activeId));
  const activeEntry = entries[activeIndex];
  const selectEntry = (index) => {
    setPaused(true);
    setSelection((previous) => ({ index: (index + entries.length) % entries.length, revision: previous.revision + 1 }));
  };

  useEffect(() => {
    let alive = true;
    setLibCount(null);
    api.library(market)
      .then((d) => alive && setLibCount(
        Object.values(d.items ?? {}).reduce((a, x) => a + x.length, 0)
      ))
      .catch(() => alive && setLibCount(0));
    return () => { alive = false; };
  }, [market]);

  const releases = visibleChangelog(user);
  const latest = releases[0];
  const version = visibleVersion(user);
  const unseen = hasUnseen(user.seenVersion, user);

  const hour = new Date().getHours();
  const greet = hour < 6 ? '这么晚还在忙' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';

  // 云层只在浅色主题下铺;显卡不支持时页头退回原来的纯文字样式
  const sky = theme === 'light' && !noWebgl;

  return (
    <div className={`home animate-in${sky ? ' has-sky' : ''}`}>
      <div className="home-hero">
        {sky && (
          <CloudShader
            className="home-hero-sky"
            speed={0.7}
            count={5}
            skyTopColor="#3f7fe4"
            skyBottomColor="#b7dcf6"
            cloudColor="#fdfbf6"
            onUnsupported={() => setNoWebgl(true)}
          />
        )}
        <div className="home-head">
          <h1>{greet},{user.displayName}</h1>
          <p className="hint">
            当前站点 <b className="home-mk">{market}</b>
            {user.markets.length > 1
              ? ' · 右上角可以切换到你负责的其他站点'
              : ' · 你的账号负责这个站点'}
            {libCount !== null && ` · 词库 ${libCount} 条`}
          </p>
        </div>
      </div>

      <section className="home-showcase" aria-label="功能入口" data-effects-paused={paused || reducedMotion ? '' : undefined}>
        <div className="home-showcase-head">
          <div>
            <h2>选择你的工作入口</h2>
            <p id="home-carousel-help">左右拖动切换，点击两侧卡片移到正中，点击正中卡片进入。也可用方向键切换、回车进入。</p>
          </div>
          <button className="btn sm home-carousel-play" disabled={reducedMotion} aria-pressed={reducedMotion || paused} onClick={() => setPaused((value) => !value)}>
            {reducedMotion ? '动态效果已关闭' : paused ? '继续动效' : '暂停动效'}
          </button>
        </div>
        <div className="home-carousel-stage">
          <CircularCarousel
            key={entries.map((entry) => entry.id).join('|')}
            items={entries}
            preset="cylinder"
            intro="rise"
            cardWidth={290}
            aspectRatio={0.88}
            gap={28}
            curve={1}
            tilt={-6}
            perspective={2500}
            autoplay={paused ? 'off' : 'drift'}
            speed={8}
            depthFade={0.62}
            fadeColor="var(--bg)"
            innerShade={0.45}
            cornerRadius={18}
            parallax={0.12}
            stretch={0.2}
            renderItem={(entry, _index, slice) => <CarouselEntry entry={entry} slice={slice} light={theme === 'light'} />}
            selectedIndex={selection.index}
            selectionVersion={selection.revision}
            ariaLabel="工作台功能轮播"
            ariaDescribedBy="home-carousel-help"
            onChange={(index) => setActiveId(entries[index].id)}
            onItemClick={(entry) => onNav(entry.id)}
          />
        </div>
        <div className="home-carousel-controls">
          <button className="btn icon" aria-label="上一个功能" onClick={() => selectEntry(activeIndex - 1)}>
            <Icon name="down" className="home-carousel-prev" />
          </button>
          <span className="home-carousel-position" aria-label={`第 ${activeIndex + 1} 个功能，共 ${entries.length} 个`}>
            <b>{String(activeIndex + 1).padStart(2, '0')}</b><span>/</span>{String(entries.length).padStart(2, '0')}
          </span>
          <button className="btn icon" aria-label="下一个功能" onClick={() => selectEntry(activeIndex + 1)}>
            <Icon name="down" className="home-carousel-next" />
          </button>
        </div>
        <div className="home-carousel-detail">
          <div className="home-carousel-detail-copy">
            <div className="home-carousel-detail-text">
              <h3>{activeEntry.title}</h3>
              <p>{activeEntry.desc}</p>
              <span>{activeEntry.meta}</span>
            </div>
            {entries.map((entry) => (
              <div key={entry.id} className="home-carousel-detail-text home-carousel-detail-measure" aria-hidden="true">
                <div className="home-carousel-detail-title">{entry.title}</div>
                <p>{entry.desc}</p>
                <span>{entry.meta}</span>
              </div>
            ))}
          </div>
          <button className="btn primary" onClick={() => onNav(activeEntry.id)}>
            进入{activeEntry.title}<Icon name="external" size={15} />
          </button>
        </div>
        <div className="home-carousel-shortcuts" role="group" aria-label="选择功能">
          {entries.map((entry, index) => (
            <button key={entry.id} className={`home-shortcut${index === activeIndex ? ' on' : ''}`}
              aria-label={`查看${entry.title}`} aria-pressed={index === activeIndex} onClick={() => selectEntry(index)}>
              <Icon name={entry.icon} size={14} /><span>{entry.title}</span>
            </button>
          ))}
        </div>
      </section>

      <section className={`home-log${unseen ? ' unseen' : ''}`}>
        <div className="home-log-head">
          <span className="home-log-label">更新日志</span>
          <span className="tag gray mono">v{version}</span>
          {unseen && <span className="tag blue">有新更新</span>}
          <span className="hint">{latest.date}</span>
          <div className="spacer" />
          <button className="btn sm" onClick={onOpenChangelog}>查看全部</button>
        </div>
        <h2 className="home-log-title">{latest.title}</h2>
        <ul className="home-log-items">
          {latest.items.slice(0, 3).map((t, i) => <li key={i}>{t}</li>)}
        </ul>
        {latest.items.length > 3 && (
          <button className="home-log-more" onClick={onOpenChangelog}>
            还有 {latest.items.length - 3} 条,以及更早的版本
            <Icon name="down" className="ico-sm" />
          </button>
        )}
      </section>
    </div>
  );
}
