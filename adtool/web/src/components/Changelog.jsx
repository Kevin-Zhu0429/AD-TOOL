import { useEffect } from 'react';
import Icon from './Icon.jsx';
import { isNewer, visibleChangelog, visibleVersion } from '../changelog.js';
import './SkuPicker.css';
import './Changelog.css';

/**
 * 右下角的版本号。有没看过的更新时带个点,点一下打开更新日志。
 * 广告优化那一页底部有它自己的操作条,那里不显示(见 App.jsx)。
 */
export function VersionBadge({ version, unseen, onClick }) {
  return (
    <button
      className={`verbadge${unseen ? ' unseen' : ''}`}
      onClick={onClick}
      title={unseen ? '有新更新,点开看看' : '更新日志'}
    >
      {unseen && <span className="verdot" aria-hidden="true" />}
      <span className="mono">v{version}</span>
    </button>
  );
}

/**
 * 更新日志弹窗。
 * seenVersion 是打开这一刻「看过的版本」—— 比它新的条目打上「新」标,
 * 关掉的时候由外面记成已看过,所以同一版只会自动弹一次。
 */
export default function Changelog({ user, seenVersion, auto, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const releases = visibleChangelog(user);
  const version = visibleVersion(user);
  const fresh = releases.filter((r) => isNewer(r.version, seenVersion)).length;

  return (
    <div className="pickmask" onClick={onClose}>
      <div className="pickbox logbox" onClick={(e) => e.stopPropagation()}>
        <header className="pickhead">
          <b>更新日志</b>
          <span className="tag blue mono">v{version}</span>
          <div className="spacer" />
          <button className="btn sm ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>

        <p className="hint">
          {auto && fresh > 0
            ? `上次看过之后有 ${fresh} 个版本的更新。关掉之后不会再自动弹,右下角的版本号可以随时点开。`
            : '每次发新版都会记在这里,右下角的版本号可以随时点开。'}
        </p>

        <div className="scroll loglist">
          {releases.map((rel) => {
            const isNew = isNewer(rel.version, seenVersion);
            return (
              <section key={rel.version} className={`logrel${isNew ? ' new' : ''}`}>
                <div className="logmeta">
                  <b className="mono logver">v{rel.version}</b>
                  <span className="logdate">{rel.date}</span>
                  {isNew && <span className="tag green">新</span>}
                </div>
                <h3 className="logtitle">{rel.title}</h3>
                <ul className="logitems">
                  {rel.items.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="pickfoot">
          <span className="hint">有想加的功能,直接找 Kevin</span>
          <div className="spacer" />
          <button className="btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
