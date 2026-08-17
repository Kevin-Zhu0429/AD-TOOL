import { useState } from 'react';
import { api } from '../api.js';

export default function PasswordPage({ onDone }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setMsg(null);
    if (newPassword.length < 6) return setMsg({ kind: 'err', text: '新密码至少 6 位' });
    if (newPassword !== confirm) return setMsg({ kind: 'err', text: '两次输入的新密码不一样' });
    setBusy(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      setMsg({ kind: 'ok', text: '密码已修改,下次登录用新密码' });
      setOld(''); setNew(''); setConfirm('');
    } catch (err) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', padding: '44px 20px' }}>
      <h1 style={{ fontSize: 19, marginBottom: 4 }}>修改密码</h1>
      <p className="hint" style={{ marginBottom: 18 }}>忘了原密码的话,找超级管理员重置。</p>

      <form className="card" onSubmit={submit}>
        <div className="stack" style={{ gap: 11 }}>
          <label className="field">
            <span>原密码</span>
            <input className="inp" type="password" value={oldPassword}
              onChange={(e) => setOld(e.target.value)} autoComplete="current-password" />
          </label>
          <label className="field">
            <span>新密码</span>
            <input className="inp" type="password" value={newPassword}
              onChange={(e) => setNew(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="field">
            <span>再输一次新密码</span>
            <input className="inp" type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>

          {msg && <div className={`note ${msg.kind}`}>{msg.text}</div>}

          <div className="row" style={{ marginTop: 2 }}>
            <button className="btn primary" type="submit" disabled={busy}>保存</button>
            <button className="btn" type="button" onClick={onDone}>返回</button>
          </div>
        </div>
      </form>
    </div>
  );
}
