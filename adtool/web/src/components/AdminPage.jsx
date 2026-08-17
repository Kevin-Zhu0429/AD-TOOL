import { useEffect, useState } from 'react';
import { api } from '../api.js';
import './AdminPage.css';

const ROLES = [
  { id: 'operator', label: '运营', desc: '负责站点的词库可编辑 · 可开广告' },
  { id: 'admin', label: '国家管理员', desc: '负责站点的词库可编辑 · 可开广告' },
  { id: 'owner', label: '超级管理员', desc: '所有站点 + 账号管理' },
];

/** 站点多选:创建表单和账号列表共用 */
function MarketChips({ markets, value, onChange }) {
  return (
    <div className="chips">
      {markets.map((m) => {
        const on = value.includes(m);
        return (
          <label key={m} className={`chip${on ? ' on' : ''}`}>
            <input
              type="checkbox" checked={on}
              onChange={() => onChange(on ? value.filter((x) => x !== m) : [...value, m])}
            />
            {m}
          </label>
        );
      })}
    </div>
  );
}

export default function AdminPage({ user, markets }) {
  const [users, setUsers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('users');
  const [form, setForm] = useState({
    username: '', displayName: '', password: '', role: 'operator', markets: [markets[0] ?? 'ES'],
  });
  // 正在改站点的那一行:{id, markets}
  const [mkEdit, setMkEdit] = useState(null);

  async function load() {
    try {
      const [u, a] = await Promise.all([api.listUsers(), api.audit()]);
      setUsers(u.users);
      setLogs(a.logs);
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  }
  useEffect(() => { load(); }, []);

  async function act(fn, okText) {
    setMsg(null);
    try {
      await fn();
      await load();
      setMsg({ kind: 'ok', text: okText });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  }

  function create() {
    if (!form.username.trim() || !form.displayName.trim() || form.password.length < 6) {
      return setMsg({ kind: 'err', text: '用户名、姓名要填,密码至少 6 位' });
    }
    if (form.role !== 'owner' && !form.markets.length) {
      return setMsg({ kind: 'err', text: '至少选一个负责站点' });
    }
    act(
      () => api.createUser(form),
      `账号 ${form.username} 已创建`
    ).then(() =>
      setForm({
        username: '', displayName: '', password: '', role: 'operator',
        markets: [markets[0] ?? 'ES'],
      })
    );
  }

  function resetPwd(u) {
    const p = prompt(`给 ${u.display_name} 设置新密码(至少 6 位)`);
    if (!p) return;
    act(() => api.resetPassword(u.id, p), `${u.display_name} 的密码已重置`);
  }

  return (
    <div className="admin">
      <div className="admin-head">
        <h1>账号管理</h1>
        <p className="hint">只有超级管理员能看到这一页。</p>
      </div>

      <div className="lib-tabs">
        <button className={`lib-tab${tab === 'users' ? ' on' : ''}`} onClick={() => setTab('users')}>
          账号 <span className="tag gray">{users.length}</span>
        </button>
        <button className={`lib-tab${tab === 'audit' ? ' on' : ''}`} onClick={() => setTab('audit')}>
          操作留痕
        </button>
      </div>

      {msg && <div className={`note ${msg.kind}`} style={{ marginBottom: 13 }}>{msg.text}</div>}

      {tab === 'users' && (
        <div className="admin-body">
          <div className="card admin-new">
            <div className="card-title">新建账号</div>
            <div className="stack" style={{ gap: 10 }}>
              <label className="field">
                <span>登录用户名</span>
                <input className="inp" value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </label>
              <label className="field">
                <span>显示姓名</span>
                <input className="inp" value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
              </label>
              <label className="field">
                <span>初始密码(至少 6 位)</span>
                <input className="inp" value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </label>
              <label className="field">
                <span>角色</span>
                <select className="inp" value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              </label>
              <p className="hint" style={{ marginTop: -4 }}>
                {ROLES.find((r) => r.id === form.role)?.desc}
              </p>
              {form.role !== 'owner' && (
                <div className="field">
                  <span>负责站点(可多选)</span>
                  <MarketChips
                    markets={markets} value={form.markets}
                    onChange={(v) => setForm({ ...form, markets: v })}
                  />
                </div>
              )}
              <button className="btn primary" onClick={create}>创建账号</button>
            </div>
          </div>

          <div className="card">
            <div className="scroll" style={{ maxHeight: '62vh' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>姓名</th><th>用户名</th><th>角色</th><th>站点</th><th>状态</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                      <td>{u.display_name}</td>
                      <td className="mono" style={{ color: 'var(--text-dim)' }}>{u.username}</td>
                      <td>
                        <select
                          className="inp sel-inline" value={u.role}
                          disabled={u.id === user.id}
                          onChange={(e) =>
                            act(() => api.updateUser(u.id, { role: e.target.value }), '角色已更新')
                          }
                        >
                          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="tag blue">全部</span>
                        ) : mkEdit?.id === u.id ? (
                          <div className="mkedit">
                            <MarketChips
                              markets={markets} value={mkEdit.markets}
                              onChange={(v) => setMkEdit({ id: u.id, markets: v })}
                            />
                            <div className="row" style={{ gap: 5 }}>
                              <button
                                className="btn sm primary"
                                disabled={!mkEdit.markets.length}
                                onClick={() => {
                                  const next = mkEdit.markets;
                                  setMkEdit(null);
                                  act(
                                    () => api.updateUser(u.id, { markets: next }),
                                    `${u.display_name} 的站点已改成 ${next.join(' / ')}`
                                  );
                                }}
                              >保存</button>
                              <button className="btn sm" onClick={() => setMkEdit(null)}>取消</button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="mkcell"
                            title="点一下改负责站点"
                            onClick={() => setMkEdit({ id: u.id, markets: u.markets ?? [] })}
                          >
                            {(u.markets ?? []).length
                              ? u.markets.map((m) => <span key={m} className="tag gray">{m}</span>)
                              : <span className="tag amber">未分配</span>}
                          </button>
                        )}
                      </td>
                      <td>
                        <span className={`tag ${u.is_active ? 'green' : 'gray'}`}>
                          {u.is_active ? '正常' : '已停用'}
                        </span>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 5 }}>
                          <button className="btn sm" onClick={() => resetPwd(u)}>重置密码</button>
                          {u.id !== user.id && (
                            <button
                              className={`btn sm${u.is_active ? ' danger' : ''}`}
                              onClick={() =>
                                act(
                                  () => api.updateUser(u.id, { isActive: !u.is_active }),
                                  u.is_active ? '已停用' : '已启用'
                                )
                              }
                            >
                              {u.is_active ? '停用' : '启用'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <p className="hint" style={{ marginBottom: 11 }}>最近 200 条操作,谁改了词库、谁登录过都在这。</p>
          <div className="scroll" style={{ maxHeight: '66vh' }}>
            <table className="tbl">
              <thead>
                <tr><th>时间</th><th>人</th><th>站点</th><th>动作</th><th>对象</th><th>详情</th></tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td style={{ color: 'var(--text-faint)' }}>{l.created_at}</td>
                    <td>{l.who ?? '—'}</td>
                    <td>{l.marketplace ?? '—'}</td>
                    <td><span className="tag gray">{l.action}</span></td>
                    <td style={{ color: 'var(--text-dim)' }}>{l.entity}</td>
                    <td className="mono" style={{ color: 'var(--text-faint)', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {l.detail ?? ''}
                    </td>
                  </tr>
                ))}
                {!logs.length && <tr><td colSpan={6} className="empty">还没有记录</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
