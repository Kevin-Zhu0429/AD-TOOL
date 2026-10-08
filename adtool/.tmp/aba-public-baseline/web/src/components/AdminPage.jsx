import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import CaptainAdmin from './CaptainAdmin.jsx';
import './AdminPage.css';

const ROLES = [
  { id: 'operator', label: '运营', desc: '负责站点的词库可编辑 · 可开自动广告' },
  { id: 'admin', label: '国家管理员', desc: '负责站点的词库可编辑 · 可开自动广告' },
  { id: 'owner', label: '超级管理员', desc: '所有站点 + 账号管理 + 全部试用功能' },
];

const ROLE_LABELS = Object.fromEntries(ROLES.map((role) => [role.id, role.label]));
const ACTION_LABELS = {
  login: '登录', logout: '退出登录', open: '打开板块', create: '新建', update: '更新',
  delete: '删除', import: '导入', replace: '覆盖导入', import_local: '本机读取', export: '导出',
  sync: '同步', sync_partial: '部分同步', enable: '启用', disable: '停用', clear_local: '本机清空',
};
const ENTITY_LABELS = {
  user: '账号', lib_items: '否定词库', neg_cat_config: '词库设置', sku_items: 'SKU 库',
  portfolio_items: '广告组合库', products: '产品库', product: '产品', product_month: '产品月份',
  product_settings: '产品设置', aba_reports: 'ABA 品牌报告', aba_asin_reports: 'ABA ASIN 报告', aba_public_reports: 'ABA报告（公共）',
  captain_inventory: '库存同步', captain_channel: '库存店铺', captain_channel_group: '库存店铺组',
  module_home: '首页', module_builder: '自动广告', module_manual: '手动广告',
  module_optimizer: '广告优化', module_library: '否定词库', module_skus: 'SKU 库',
  module_portfolios: '广告组合库', module_aba: 'ABA 报告', module_abaPublic: 'ABA报告（公共）', module_products: '产品情报',
  module_tools: '小工具', module_admin: '账号管理', module_profile: '个人资料',
};
const DETAIL_LABELS = {
  added: '新增', updated: '更新', removed: '移除', count: '数量', reports: '报告',
  campaigns: '活动', tasks: '任务', rows: '行数', targets: '关键词/定向', files: '文件',
  sheets: '工作表', groups: '分类', field: '字段', role: '角色', markets: '站点',
};

const AUDIT_PERIODS = [
  { id: '7', label: '近 7 天' }, { id: '30', label: '近 30 天' },
  { id: 'all', label: '全部明细' }, { id: 'custom', label: '自定义' },
];

/** 本地日期 YYYY-MM-DD(日志时间是服务器本地时间,自定义范围按天算) */
function localDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 自定义范围两头都填了且起始不晚于结束,才去请求 */
function auditRangeReady(filter) {
  return filter.days !== 'custom' || (filter.from && filter.to && filter.from <= filter.to);
}

/** 下拉选项:已知的代码按中文名列出,当前选中但不在表里的也保留 */
function auditOptions(labels, current) {
  const keys = Object.keys(labels);
  if (current !== 'all' && !keys.includes(current)) keys.push(current);
  return keys.map((key) => ({ key, label: labels[key] ?? key }));
}

/** 汇总里的一组计数,点一下就按这一项筛(再点取消) */
function SummaryGroup({ title, items, labelOf, active, onPick }) {
  if (!items?.length) return null;
  const total = items.reduce((sum, item) => sum + item.n, 0);
  return (
    <div className="audit-sum-group">
      <h3>{title}</h3>
      <ul>
        {items.slice(0, 8).map((item) => {
          const key = String(item.key ?? '');
          const on = active === key;
          return (
            <li key={key || 'none'}>
              <button
                type="button"
                className={`audit-sum-item${on ? ' on' : ''}`}
                aria-pressed={on}
                disabled={!onPick || item.key == null}
                onClick={() => onPick(on ? 'all' : key)}
              >
                <span className="audit-sum-label">{labelOf(item)}</span>
                <span className="audit-sum-bar"><i style={{ width: `${Math.max(3, (item.n / total) * 100)}%` }} /></span>
                <b>{item.n}</b>
              </button>
            </li>
          );
        })}
        {items.length > 8 && <li className="audit-sum-rest">另有 {items.length - 8} 项，共 {items.slice(8).reduce((sum, item) => sum + item.n, 0)} 条</li>}
      </ul>
    </div>
  );
}

function detailText(raw) {
  if (!raw) return '—';
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return String(raw);
    return Object.entries(value).slice(0, 6).map(([key, item]) => {
      const shown = Array.isArray(item) ? `${item.length} 项` : typeof item === 'object' ? '详情已记录' : String(item);
      return `${DETAIL_LABELS[key] ?? key}：${shown}`;
    }).join(' · ');
  } catch { return String(raw); }
}

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
  const [auditStats, setAuditStats] = useState([]);
  const [auditTotals, setAuditTotals] = useState({ sevenDay: 0, thirtyDay: 0 });
  const [logFilter, setLogFilter] = useState({
    userId: 'all', action: 'all', entity: 'all', days: '30', from: localDate(-6), to: localDate(),
  });
  const [logSummary, setLogSummary] = useState(null);
  const [logNext, setLogNext] = useState(null);
  const [logBusy, setLogBusy] = useState(false);
  const logRequest = useRef(0);
  const [resetUser, setResetUser] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetShown, setResetShown] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const resetDialogRef = useRef(null);
  const [deleteUser, setDeleteUser] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteDialogRef = useRef(null);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('users');
  const [form, setForm] = useState({
    username: '', displayName: '', password: '', role: 'operator',
    markets: [markets[0] ?? 'ES'], goodsAdmin: false, manualAds: false, adOpt: false,
    productIntel: false,
  });
  // 正在改站点的那一行:{id, markets}
  const [mkEdit, setMkEdit] = useState(null);

  async function load() {
    try {
      const request = ++logRequest.current;
      const [u, a] = await Promise.all([api.listUsers(), api.audit(auditRangeReady(logFilter) ? logFilter : { ...logFilter, days: '30' })]);
      setUsers(u.users);
      if (request === logRequest.current) {
        setLogs(a.logs);
        setLogNext(a.nextBefore ?? null);
        setLogSummary(a.summary ?? null);
      }
      setAuditStats(a.stats ?? []);
      setAuditTotals(a.totals ?? { sevenDay: 0, thirtyDay: 0 });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (resetUser && !resetDialogRef.current?.open) resetDialogRef.current?.showModal();
  }, [resetUser]);
  useEffect(() => {
    if (deleteUser && !deleteDialogRef.current?.open) deleteDialogRef.current?.showModal();
  }, [deleteUser]);

  // 筛选都在服务端做;切换条件时重新取第一页(连汇总),「加载更多」接着上一页往后取
  async function loadLogs(filters, before) {
    const request = ++logRequest.current;
    setLogBusy(true);
    try {
      const page = await api.auditLogs(filters, before);
      if (request !== logRequest.current) return;   // 条件已经又变了,丢掉旧结果
      setLogs((old) => (before ? [...old, ...page.logs] : page.logs));
      setLogNext(page.nextBefore ?? null);
      if (!before) setLogSummary(page.summary ?? null);
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      if (request === logRequest.current) setLogBusy(false);
    }
  }
  function changeLogFilter(patch) {
    const next = { ...logFilter, ...patch };
    setLogFilter(next);
    if (auditRangeReady(next)) { loadLogs(next); return; }
    // 日期还没选完整:作废在途请求,别让上一个条件的结果留在表里
    logRequest.current += 1;
    setLogBusy(false);
    setLogs([]);
    setLogNext(null);
    setLogSummary(null);
  }
  const logRangeError = auditRangeReady(logFilter) ? '' : '请选择起止日期，且开始日期不能晚于结束日期';
  const logFiltered = logFilter.userId !== 'all' || logFilter.action !== 'all' || logFilter.entity !== 'all';

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
    if (form.role !== 'owner' && !form.markets.length && !form.goodsAdmin) {
      return setMsg({ kind: 'err', text: '至少选一个负责站点' });
    }
    act(
      () => api.createUser(form),
      `账号 ${form.username} 已创建`
    ).then(() =>
      setForm({
        username: '', displayName: '', password: '', role: 'operator',
        markets: [markets[0] ?? 'ES'], goodsAdmin: false, manualAds: false, adOpt: false,
        productIntel: false,
      })
    );
  }

  function openReset(u) {
    setResetUser(u);
    setResetPassword('');
    setResetShown(false);
    setResetError('');
  }

  function closeReset() {
    if (resetBusy) return;
    setResetUser(null);
    setResetPassword('');
    setResetShown(false);
    setResetError('');
  }

  async function submitReset(event) {
    event.preventDefault();
    if (resetPassword.length < 6) return setResetError('新密码至少 6 位');
    setResetBusy(true); setResetError('');
    try {
      await api.resetPassword(resetUser.id, resetPassword);
      const name = resetUser.display_name;
      resetDialogRef.current?.close();
      setResetUser(null); setResetPassword('');
      await load();
      setMsg({ kind: 'ok', text: `${name} 的密码已重置` });
    } catch (error) {
      setResetError(error.message);
    } finally {
      setResetBusy(false);
    }
  }

  function openDelete(u) {
    setDeleteUser(u);
    setDeleteError('');
  }

  function closeDelete() {
    if (deleteBusy) return;
    setDeleteUser(null);
    setDeleteError('');
  }

  async function submitDelete(event) {
    event.preventDefault();
    setDeleteBusy(true); setDeleteError('');
    try {
      const name = deleteUser.display_name;
      await api.deleteUser(deleteUser.id);
      deleteDialogRef.current?.close();
      setDeleteUser(null);
      if (mkEdit?.id === deleteUser.id) setMkEdit(null);
      await load();
      setMsg({ kind: 'ok', text: `${name} 的账号已永久删除` });
    } catch (error) {
      setDeleteError(error.message);
    } finally {
      setDeleteBusy(false);
    }
  }

  function changeRole(u, nextRole) {
    if (nextRole === u.role) {
      if (mkEdit?.id === u.id) setMkEdit(null);
      return;
    }
    if (u.role === 'owner' && nextRole !== 'owner') {
      setMkEdit((current) => ({
        id: u.id,
        markets: current?.id === u.id ? current.markets : [],
        role: nextRole,
      }));
      setMsg({ kind: 'info', text: `请为 ${u.display_name} 选择负责站点，再一起保存角色变更` });
      return;
    }
    setMkEdit((current) => current?.id === u.id ? null : current);
    act(() => api.updateUser(u.id, { role: nextRole }), '角色已更新');
  }

  return (
    <div className="admin">
      <div className="admin-head">
        <h1>账号管理</h1>
        <p className="hint">
          只有超级管理员能看到这一页。手动广告、广告优化、产品情报都按账号开通,
          未勾选的人看不到对应页面和更新日志。
        </p>
      </div>

      <div className="lib-tabs">
        <button className={`lib-tab${tab === 'users' ? ' on' : ''}`} onClick={() => setTab('users')}>
          账号 <span className="tag gray">{users.length}</span>
        </button>
        <button className={`lib-tab${tab === 'audit' ? ' on' : ''}`} onClick={() => setTab('audit')}>
          操作日志
        </button>
        <button className={`lib-tab${tab === 'captain' ? ' on' : ''}`} onClick={() => setTab('captain')}>
          亚马逊库存
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
                <>
                  <label className="row">
                    <input
                      type="checkbox" checked={form.goodsAdmin}
                      onChange={(e) => setForm({ ...form, goodsAdmin: e.target.checked })}
                    />
                    <span style={{ fontSize: 12.5 }}>商品部维护权(B/C/D/E 四类词库)</span>
                  </label>
                  <p className="hint" style={{ marginTop: -4 }}>
                    勾上以后可以改所有区域的非售品牌、干扰墨盒、在售墨盒和竞品 ASIN,
                    并且能看到全部站点;纯商品部账号可以不选负责站点。
                  </p>
                  <label className="row">
                    <input
                      type="checkbox" checked={form.manualAds}
                      onChange={(e) => setForm({ ...form, manualAds: e.target.checked })}
                    />
                    <span style={{ fontSize: 12.5 }}>手动广告使用权(试用中)</span>
                  </label>
                  <p className="hint" style={{ marginTop: -4 }}>
                    不勾的人看不到「手动广告」这一页,只能用自动广告。
                  </p>
                  <label className="row">
                    <input
                      type="checkbox" checked={form.adOpt}
                      onChange={(e) => setForm({ ...form, adOpt: e.target.checked })}
                    />
                    <span style={{ fontSize: 12.5 }}>广告优化使用权(试用中)</span>
                  </label>
                  <p className="hint" style={{ marginTop: -4 }}>
                    不勾的人看不到「广告优化」这一页,也就用不了批量表分析和优化。
                  </p>
                  <label className="row">
                    <input
                      type="checkbox" checked={form.productIntel}
                      onChange={(e) => setForm({ ...form, productIntel: e.target.checked })}
                    />
                    <span style={{ fontSize: 12.5 }}>产品库与竞品分析使用权</span>
                  </label>
                  <p className="hint" style={{ marginTop: -4 }}>
                    不勾的人看不到「产品情报」页面,也看不到这项功能对应的更新日志。
                  </p>
                  <div className="field">
                    <span>负责站点(可多选,决定 A 类无名词改哪个站)</span>
                    <MarketChips
                      markets={markets} value={form.markets}
                      onChange={(v) => setForm({ ...form, markets: v })}
                    />
                  </div>
                </>
              )}
              <button className="btn primary" onClick={create}>创建账号</button>
            </div>
          </div>

          <div className="card">
            <div className="scroll" style={{ maxHeight: '62vh' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>姓名</th><th>用户名</th><th>角色</th><th>商品部</th><th>产品情报</th><th>手动广告</th><th>广告优化</th>
                    <th>站点</th><th>状态</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.5 }}>
                      <td>{u.display_name}</td>
                      <td className="mono" style={{ color: 'var(--text-dim)' }}>{u.username}</td>
                      <td>
                        <select
                          className="inp sel-inline" value={mkEdit?.id === u.id && mkEdit.role ? mkEdit.role : u.role}
                          disabled={u.id === user.id}
                          onChange={(e) => changeRole(u, e.target.value)}
                        >
                          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="tag blue">天然有</span>
                        ) : (
                          <label className="row" title="B/C/D/E 四类词库的维护权">
                            <input
                              type="checkbox" checked={!!u.goodsAdmin}
                              onChange={(e) =>
                                act(
                                  () => api.updateUser(u.id, { goodsAdmin: e.target.checked }),
                                  e.target.checked
                                    ? `${u.display_name} 现在能维护 B/C/D/E 词库`
                                    : `${u.display_name} 的商品部维护权已取消`
                                )
                              }
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="tag blue">天然有</span>
                        ) : (
                          <label className="row" title="能不能看到产品库、竞品分析及对应更新日志">
                            <input
                              type="checkbox" checked={!!u.productIntel}
                              onChange={(e) =>
                                act(
                                  () => api.updateUser(u.id, { productIntel: e.target.checked }),
                                  e.target.checked
                                    ? `${u.display_name} 现在能用产品情报`
                                    : `${u.display_name} 的产品情报权限已收回`
                                )
                              }
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="tag blue">天然有</span>
                        ) : (
                          <label className="row" title="能不能看到「手动广告」这一页">
                            <input
                              type="checkbox" checked={!!u.manualAds}
                              onChange={(e) =>
                                act(
                                  () => api.updateUser(u.id, { manualAds: e.target.checked }),
                                  e.target.checked
                                    ? `${u.display_name} 现在能用手动广告`
                                    : `${u.display_name} 的手动广告权限已收回`
                                )
                              }
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        {u.role === 'owner' ? (
                          <span className="tag blue">天然有</span>
                        ) : (
                          <label className="row" title="能不能看到「广告优化」这一页">
                            <input
                              type="checkbox" checked={!!u.adOpt}
                              onChange={(e) =>
                                act(
                                  () => api.updateUser(u.id, { adOpt: e.target.checked }),
                                  e.target.checked
                                    ? `${u.display_name} 现在能用广告优化`
                                    : `${u.display_name} 的广告优化权限已收回`
                                )
                              }
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        {mkEdit?.id === u.id ? (
                          <div className="mkedit">
                            {mkEdit.role && (
                              <span className="mkedit-hint">
                                改为{ROLE_LABELS[mkEdit.role]}后负责哪些站点？
                              </span>
                            )}
                            <MarketChips
                              markets={markets} value={mkEdit.markets}
                              onChange={(v) => setMkEdit({ ...mkEdit, markets: v })}
                            />
                            <div className="row" style={{ gap: 5 }}>
                              <button
                                className="btn sm primary"
                                disabled={!mkEdit.markets.length && (!u.goodsAdmin || !!mkEdit.role)}
                                onClick={() => {
                                  const next = mkEdit.markets;
                                  const nextRole = mkEdit.role;
                                  setMkEdit(null);
                                  act(
                                    () => api.updateUser(u.id, {
                                      markets: next,
                                      ...(nextRole ? { role: nextRole } : {}),
                                    }),
                                    nextRole
                                      ? `${u.display_name} 已改为${ROLE_LABELS[nextRole]}，负责 ${next.join(' / ')} 站`
                                      : `${u.display_name} 的站点已改成 ${next.join(' / ')}`
                                  );
                                }}
                              >保存</button>
                              <button className="btn sm" onClick={() => setMkEdit(null)}>取消</button>
                            </div>
                          </div>
                        ) : u.role === 'owner' ? (
                          <span className="tag blue">全部</span>
                        ) : (
                          <button
                            className="mkcell"
                            title="点一下改负责站点"
                            onClick={() => setMkEdit({ id: u.id, markets: u.ownMarkets ?? [] })}
                          >
                            {(u.ownMarkets ?? []).length
                              ? u.ownMarkets.map((m) => <span key={m} className="tag gray">{m}</span>)
                              : <span className="tag amber">{u.goodsAdmin ? '全部(商品部)' : '未分配'}</span>}
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
                          <button className="btn sm" onClick={() => openReset(u)}>重置密码</button>
                          {u.id !== user.id && (
                            <>
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
                              <button className="btn sm danger" onClick={() => openDelete(u)}>删除</button>
                            </>
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
        <div className="audit-page">
          <section className="audit-overview" aria-labelledby="audit-heading">
            <div>
              <h2 id="audit-heading">账号操作统计</h2>
              <p className="hint">仅超级管理员可见。统计登录、数据维护、同步，以及本机生成和导出。</p>
            </div>
            <div className="audit-totals" aria-label="操作总数">
              <div><b>{auditTotals.sevenDay}</b><span>近 7 天</span></div>
              <div><b>{auditTotals.thirtyDay}</b><span>近 30 天</span></div>
            </div>
          </section>

          <div className="card audit-stats-card">
            <div className="scroll audit-stats-scroll">
              <table className="tbl audit-stats-table">
                <thead><tr><th>账号</th><th>角色</th><th>近 7 天</th><th>近 30 天</th><th>最近操作</th></tr></thead>
                <tbody>
                  {auditStats.map((item) => (
                    <tr key={item.id}>
                      <td><b>{item.display_name}</b><small className="audit-username mono">{item.username}</small></td>
                      <td><span className={`tag ${item.is_active ? 'gray' : 'red'}`}>{item.is_active ? ROLE_LABELS[item.role] : '已停用'}</span></td>
                      <td><strong className="audit-count seven">{item.seven_day}</strong></td>
                      <td><strong className="audit-count thirty">{item.thirty_day}</strong></td>
                      <td className="audit-time">{item.last_action_at ?? '暂无操作'}</td>
                    </tr>
                  ))}
                  {!auditStats.length && <tr><td colSpan={5} className="empty">还没有账号统计</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card audit-log-card">
            <div className="audit-log-head">
              <div><h2>操作明细</h2><p className="hint">按账号、动作、对象和时间筛选，每次加载 100 条。</p></div>
              <div className="audit-filters">
                <label>账号<select className="inp" value={logFilter.userId} onChange={(event) => changeLogFilter({ userId: event.target.value })}><option value="all">全部账号</option>{auditStats.map((item) => <option key={item.id} value={item.id}>{item.display_name}</option>)}</select></label>
                <label>动作<select className="inp" value={logFilter.action} onChange={(event) => changeLogFilter({ action: event.target.value })}><option value="all">全部动作</option>{auditOptions(ACTION_LABELS, logFilter.action).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
                <label>对象<select className="inp" value={logFilter.entity} onChange={(event) => changeLogFilter({ entity: event.target.value })}><option value="all">全部对象</option>{auditOptions(ENTITY_LABELS, logFilter.entity).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
                <label>时间<select className="inp" value={logFilter.days} onChange={(event) => changeLogFilter({ days: event.target.value })}>{AUDIT_PERIODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                {logFilter.days === 'custom' && (
                  <>
                    <label>开始<input className="inp" type="date" value={logFilter.from} max={logFilter.to || undefined} aria-invalid={!!logRangeError} onChange={(event) => changeLogFilter({ from: event.target.value })} /></label>
                    <label>结束<input className="inp" type="date" value={logFilter.to} min={logFilter.from || undefined} aria-invalid={!!logRangeError} onChange={(event) => changeLogFilter({ to: event.target.value })} /></label>
                  </>
                )}
                {logFiltered && <button className="btn sm audit-reset" type="button" onClick={() => changeLogFilter({ userId: 'all', action: 'all', entity: 'all' })}>清除筛选</button>}
              </div>
            </div>
            {logRangeError && <div className="note err audit-range-error" role="alert">{logRangeError}</div>}
            {logSummary && !logRangeError && (
              <section className="audit-summary" aria-label="筛选结果汇总">
                <div className="audit-sum-totals">
                  <div><b>{logSummary.total}</b><span>条操作</span></div>
                  <div><b>{logSummary.users}</b><span>个账号</span></div>
                  <div><b>{logSummary.byAction.length}</b><span>种动作</span></div>
                  <div><b>{logSummary.byEntity.length}</b><span>类对象</span></div>
                  {logSummary.firstAt && (
                    <p className="audit-sum-span">
                      <span className="mono">{logSummary.firstAt}</span> 至 <span className="mono">{logSummary.lastAt}</span>
                    </p>
                  )}
                </div>
                {logSummary.total > 0 && (
                  <div className="audit-sum-groups">
                    <SummaryGroup title="按动作" items={logSummary.byAction} active={logFilter.action} labelOf={(item) => ACTION_LABELS[item.key] ?? item.key} onPick={(action) => changeLogFilter({ action })} />
                    <SummaryGroup title="按对象" items={logSummary.byEntity} active={logFilter.entity} labelOf={(item) => ENTITY_LABELS[item.key] ?? item.key} onPick={(entity) => changeLogFilter({ entity })} />
                    <SummaryGroup title="按账号" items={logSummary.byUser} active={logFilter.userId} labelOf={(item) => item.who ?? '已删除账号'} onPick={(userId) => changeLogFilter({ userId })} />
                    <SummaryGroup title="按站点" items={logSummary.byMarket} labelOf={(item) => item.key ?? '无站点'} />
                  </div>
                )}
              </section>
            )}
            <div className="scroll audit-log-scroll">
            <table className="tbl">
              <thead>
                <tr><th>时间</th><th>人</th><th>站点</th><th>动作</th><th>对象</th><th>详情</th></tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="audit-time">{l.created_at}</td>
                    <td><b>{l.who ?? '已删除账号'}</b><small className="audit-username mono">{l.username ?? ''}</small></td>
                    <td>{l.marketplace ?? '—'}</td>
                    <td><span className="tag gray">{ACTION_LABELS[l.action] ?? l.action}</span></td>
                    <td className="audit-entity">{ENTITY_LABELS[l.entity] ?? l.entity}</td>
                    <td className="audit-detail">{detailText(l.detail)}</td>
                  </tr>
                ))}
                {!logs.length && !logBusy && <tr><td colSpan={6} className="empty">这个条件下还没有操作</td></tr>}
              </tbody>
            </table>
          </div>
            {logNext && (
              <div className="audit-more">
                <button className="btn sm" type="button" disabled={logBusy} aria-busy={logBusy} onClick={() => loadLogs(logFilter, logNext)}>
                  {logBusy ? '正在加载…' : '加载更多'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'captain' && <CaptainAdmin users={users} />}

      {resetUser && (
        <dialog ref={resetDialogRef} className="admin-dialog" onClose={closeReset}>
          <form noValidate onSubmit={submitReset}>
            <header><div><h2>重置密码</h2><p className="hint">为 {resetUser.display_name} 设置至少 6 位的新密码。</p></div></header>
            <div className="admin-dialog-body">
              <label className="field"><span>新密码</span><span className="admin-password-field"><input className="inp" type={resetShown ? 'text' : 'password'} autoComplete="new-password" autoFocus value={resetPassword} aria-invalid={!!resetError} aria-describedby={resetError ? 'reset-password-error' : undefined} onChange={(event) => { setResetPassword(event.target.value); setResetError(''); }} /><button type="button" className="btn sm" aria-pressed={resetShown} aria-label={resetShown ? '隐藏新密码' : '显示新密码'} onClick={() => setResetShown((shown) => !shown)}>{resetShown ? '隐藏' : '显示'}</button></span></label>
              {resetError && <div id="reset-password-error" className="note err" role="alert">{resetError}</div>}
            </div>
            <footer><button className="btn" type="button" disabled={resetBusy} onClick={() => resetDialogRef.current?.close()}>取消</button><button className="btn primary" type="submit" disabled={resetBusy} aria-busy={resetBusy}>{resetBusy ? '正在重置…' : '重置密码'}</button></footer>
          </form>
        </dialog>
      )}

      {deleteUser && (
        <dialog
          ref={deleteDialogRef}
          className="admin-dialog"
          aria-labelledby="delete-account-title"
          onClose={closeDelete}
          onCancel={(event) => { if (deleteBusy) event.preventDefault(); }}
        >
          <form noValidate onSubmit={submitDelete}>
            <header>
              <div>
                <h2 id="delete-account-title">永久删除账号</h2>
                <p className="hint">删除后无法恢复，请确认账号和数据范围。</p>
              </div>
            </header>
            <div className="admin-dialog-body">
              <div className="admin-delete-account">
                <strong>{deleteUser.display_name}</strong>
                <span className="mono">{deleteUser.username}</span>
              </div>
              <div className="note warn">
                该账号将不能再登录；它的 SKU、ABA 报告、广告组合和店铺分配会永久删除。操作日志与共享词库、产品数据会保留，但不再关联此账号。
              </div>
              {deleteError && <div className="note err" role="alert">{deleteError}</div>}
            </div>
            <footer>
              <button className="btn" type="button" disabled={deleteBusy} onClick={() => deleteDialogRef.current?.close()}>取消</button>
              <button className="btn danger admin-delete-confirm" type="submit" disabled={deleteBusy} aria-busy={deleteBusy}>
                {deleteBusy ? '正在删除…' : '永久删除账号'}
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </div>
  );
}
