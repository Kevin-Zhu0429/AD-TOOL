import { useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

const ROLE = { owner: '超级管理员', admin: '国家管理员', operator: '运营' };

export default function ProfilePage({ user, onUserChange, onDone }) {
  const [name, setName] = useState(user.displayName);
  const [nameMsg, setNameMsg] = useState(null);
  const [savingName, setSavingName] = useState(false);

  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwMsg, setPwMsg] = useState(null);
  const [savingPw, setSavingPw] = useState(false);

  const nameDirty = name.trim() !== user.displayName && name.trim() !== '';

  async function saveName(e) {
    e.preventDefault();
    setNameMsg(null);
    setSavingName(true);
    try {
      const { user: next } = await api.updateProfile(name.trim());
      onUserChange(next);
      setNameMsg({ kind: 'ok', text: '姓名已更新' });
    } catch (err) {
      setNameMsg({ kind: 'err', text: err.message });
    } finally {
      setSavingName(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setPwMsg(null);
    if (newPassword.length < 6) return setPwMsg({ kind: 'err', text: '新密码至少 6 位' });
    if (newPassword !== confirm) return setPwMsg({ kind: 'err', text: '两次输入的新密码不一样' });
    if (newPassword === oldPassword) return setPwMsg({ kind: 'err', text: '新密码和原密码一样' });
    setSavingPw(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setPwMsg({ kind: 'ok', text: '密码已修改,下次登录用新密码' });
      setOld(''); setNew(''); setConfirm('');
    } catch (err) {
      setPwMsg({ kind: 'err', text: err.message });
    } finally {
      setSavingPw(false);
    }
  }

  return (
    <div className="profile animate-in">
      <div className="page-head">
        <h1>个人资料</h1>
        <p className="hint">姓名和密码可以自己改。角色和负责站点由超级管理员分配。</p>
      </div>

      <div className="profile-id card">
        <span className="avatar lg" style={{ width: 44, height: 44, fontSize: 17 }}>
          {user.displayName.slice(0, 1)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{user.displayName}</div>
          <div className="hint mono">{user.username}</div>
        </div>
        <div className="spacer" />
        <div className="row" style={{ gap: 5 }}>
          <span className="tag blue">{ROLE[user.role] ?? user.role}</span>
          <span className="tag gray">
            {user.role === 'owner' ? '全部站点' : `${user.markets.join(' / ')} 站`}
          </span>
        </div>
      </div>

      <form className="card" onSubmit={saveName}>
        <div className="card-title"><Icon name="user" className="ico-sm" />显示姓名</div>
        <p className="hint" style={{ marginBottom: 12 }}>
          这个名字会出现在词库的「添加人」和操作记录里。
        </p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
          <label className="field" style={{ flex: 1 }}>
            <span>姓名</span>
            <input
              className="inp" value={name} maxLength={20}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="btn primary" type="submit" disabled={!nameDirty || savingName}>
            {savingName ? '保存中…' : '保存'}
          </button>
        </div>
        {nameMsg && <div className={`note ${nameMsg.kind}`} style={{ marginTop: 11 }}>{nameMsg.text}</div>}
      </form>

      <form className="card" onSubmit={savePassword}>
        <div className="card-title"><Icon name="lock" className="ico-sm" />修改密码</div>
        <p className="hint" style={{ marginBottom: 12 }}>
          忘了密码就找超级管理员重置。
        </p>
        <div className="stack" style={{ gap: 11 }}>
          <label className="field">
            <span>原密码</span>
            <input className="inp" type="password" autoComplete="current-password"
              value={oldPassword} onChange={(e) => setOld(e.target.value)} />
          </label>
          <div className="g2">
            <label className="field">
              <span>新密码(至少 6 位)</span>
              <input className="inp" type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => setNew(e.target.value)} />
            </label>
            <label className="field">
              <span>再输一次</span>
              <input className="inp" type="password" autoComplete="new-password"
                value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </div>

          {pwMsg && <div className={`note ${pwMsg.kind}`}>{pwMsg.text}</div>}

          <div className="row">
            <button className="btn primary" type="submit"
              disabled={savingPw || !oldPassword || !newPassword}>
              {savingPw ? '保存中…' : '修改密码'}
            </button>
            <button className="btn" type="button" onClick={onDone}>返回首页</button>
          </div>
        </div>
      </form>
    </div>
  );
}
