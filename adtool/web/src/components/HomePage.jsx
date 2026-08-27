import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { CHANGELOG, VERSION, hasUnseen } from '../changelog.js';
import Icon from './Icon.jsx';
import CloudShader from './CloudShader.jsx';
import './HomePage.css';

function EntryCard({ tone, icon, title, desc, meta, onClick }) {
  return (
    <button className={`entry ${tone}`} onClick={onClick}>
      <span className="entry-glow" aria-hidden="true" />
      <span className="entry-icon"><Icon name={icon} size={19} /></span>
      <span className="entry-title">{title}</span>
      <span className="entry-desc">{desc}</span>
      <span className="entry-foot">
        {meta}
        <Icon name="down" className="ico-sm entry-arrow" />
      </span>
    </button>
  );
}

export default function HomePage({ user, market, onNav, theme, onOpenChangelog }) {
  const [libCount, setLibCount] = useState(null);
  const [noWebgl, setNoWebgl] = useState(false);

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

  const latest = CHANGELOG[0];
  const unseen = hasUnseen(user.seenVersion);

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

      <div className="home-grid">
        <EntryCard
          tone="blue" icon="layers" title="自动广告"
          desc="按任务批量配置自动广告,一次生成可直接上传的总表。词库里的否定词会自动带进每一条活动;开系列广告时还会按 D 类反推,把其它墨盒和打印机型号一起否掉。"
          meta="生成 xlsx 批量表"
          onClick={() => onNav('builder')}
        />
        {user.manualAds && (
          <EntryCard
            tone="violet" icon="sliders" title="手动广告"
            desc="关键词投放和商品投放(ASIN / 品类定向)。关键词和 ASIN 自己粘贴,不接词表库;否定词照样联动本站词库,精准 / 词组 / 广泛可以分别给出价、也可以各自拆广告组。出价可以自己填,也可以填目标 CPC 按溢价和系数反推。"
            meta="试用中 · 生成 xlsx 批量表"
            onClick={() => onNav('manual')}
          />
        )}
        {user.adOpt && (
          <EntryCard
            tone="blue" icon="chart" title="广告优化"
            desc="把后台下载的批量表拖进来,逐条活动看广告位 / SKU / 投放 / 搜索词的表现,改竞价、调溢价、批量否定,最后导出能直接回传的批量表。批量否定可以直接勾本站词库的 A–E 类,D 类还能按在投的墨盒型号反推该否掉的其它型号。"
            meta="试用中 · 数据只在本机浏览器里解析"
            onClick={() => onNav('optimizer')}
          />
        )}
        <EntryCard
          tone="green" icon="book" title={`${market} 站否定词库`}
          desc="A 无名词 · B 非售品牌 · C 非售流量干扰墨盒 · D 在售墨盒和打印机 · E 原装竞品 ASIN。改动立即生效。D 类还能当型号库单独用:后台否定助手里一次搜多个墨盒型号,把墨盒或打印机型号复制走,直接粘进后台否定。"
          meta={user.goodsAdmin ? 'A–E 都可编辑' : 'A 类可编辑,B–E 只读'}
          onClick={() => onNav('library')}
        />
        <EntryCard
          tone="amber" icon="file" title="我的 SKU 库"
          desc="按国家 / 品牌 / 型号 / 套组存自己负责的 SKU 和库存。每个账号一份自己的,开广告时在「投放 SKU」那里一键挑进去。"
          meta="模板导入 · 只有自己看得到"
          onClick={() => onNav('skus')}
        />
        {user.role === 'owner' && (
          <EntryCard
            tone="violet" icon="users" title="账号管理"
            desc="新建账号、分配国家和角色、重置密码、停用离职人员,以及查看全部操作留痕。"
            meta="仅超级管理员可见"
            onClick={() => onNav('admin')}
          />
        )}
      </div>

      <section className={`home-log${unseen ? ' unseen' : ''}`}>
        <div className="home-log-head">
          <span className="home-log-label">更新日志</span>
          <span className="tag gray mono">v{VERSION}</span>
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
