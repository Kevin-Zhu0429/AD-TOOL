import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import './CaptainAdmin.css';

const formatTime = (value) => value
  ? new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false })
  : '尚未同步';
const brandKey = (value) => String(value ?? '').trim().toLowerCase();
const inferredBrand = (group) => {
  const name = String(group.groupName ?? '').trim();
  const withoutEurope = name.replace(/[_-]EU(?:[_-]UK)?$/i, '');
  const withoutCountry = withoutEurope.replace(new RegExp(`[_-]${group.scope}$`, 'i'), '');
  return withoutCountry && withoutCountry !== name ? withoutCountry : '';
};

function syncText(result) {
  return `已处理 ${result.users} 个账号，更新 ${Number(result.updated || 0)} 行`
    + (result.unmatched ? `，${result.unmatched} 个 SKU 未匹配` : '')
    + (result.failed ? `，${result.failed} 个库存来源失败` : '');
}

export default function CaptainAdmin({ users }) {
  const [settings, setSettings] = useState(null);
  const [channelGroups, setChannelGroups] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);

  async function load() {
    try {
      setSettings(await api.captainAdmin());
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    }
  }

  useEffect(() => { load(); }, []);

  const activeUsers = useMemo(() => users.filter((user) => user.is_active), [users]);
  const bindingByChannel = useMemo(() => new Map(
    (settings?.bindings ?? []).map((binding) => [binding.open_channel_id, binding])
  ), [settings]);
  const assignmentsByGroup = useMemo(() => {
    const map = new Map();
    for (const assignment of settings?.assignments ?? []) {
      const rows = map.get(assignment.group_key) ?? [];
      rows.push(assignment);
      map.set(assignment.group_key, rows);
    }
    return map;
  }, [settings]);
  const coverage = settings?.skuCoverage ?? [];

  function eligibleUsers(country, brand) {
    const key = brandKey(brand);
    const ids = new Set(coverage
      .filter((row) => row.country === country && brandKey(row.brand) === key)
      .map((row) => String(row.userId)));
    return activeUsers.filter((user) => ids.has(String(user.id)));
  }

  function availableBrands(group) {
    const byKey = new Map();
    const inferred = inferredBrand(group);
    if (inferred) byKey.set(brandKey(inferred), inferred);
    for (const row of coverage) {
      if (group.countries.includes(row.country) && !byKey.has(brandKey(row.brand))) {
        byKey.set(brandKey(row.brand), row.brand);
      }
    }
    return [...byKey.values()].sort((a, b) => (
      brandKey(a) === brandKey(inferred) ? -1
        : brandKey(b) === brandKey(inferred) ? 1 : a.localeCompare(b, 'zh-CN')
    ));
  }

  function assignmentDefaults(group, brand) {
    const current = assignmentsByGroup.get(group.groupKey) ?? [];
    return Object.fromEntries(group.countries.map((country) => {
      const saved = current.find((row) => row.country === country && brandKey(row.brand) === brandKey(brand));
      const legacy = group.channels
        .filter((channel) => channel.country === country)
        .map((channel) => bindingByChannel.get(channel.openChannelId))
        .find((binding) => binding && brandKey(binding.brand) === brandKey(brand));
      const eligible = eligibleUsers(country, brand);
      const preferred = saved?.user_id ?? legacy?.user_id;
      const validPreferred = eligible.some((user) => String(user.id) === String(preferred));
      return [country, validPreferred ? String(preferred) : eligible.length === 1 ? String(eligible[0].id) : ''];
    }));
  }

  async function discover() {
    setBusy('discover');
    setMessage(null);
    try {
      const result = await api.discoverCaptainChannels();
      const groups = result.groups ?? [];
      setChannelGroups(groups);
      setDrafts(Object.fromEntries(groups.map((group) => {
        const current = assignmentsByGroup.get(group.groupKey) ?? [];
        const legacyBindings = group.channels
          .map((channel) => bindingByChannel.get(channel.openChannelId)).filter(Boolean);
        const brands = availableBrands(group);
        const savedBrands = [...new Set(current.map((row) => row.brand))];
        const legacyBrands = [...new Set(legacyBindings.map((row) => row.brand))];
        const preferred = savedBrands.length === 1 ? savedBrands[0]
          : legacyBrands.length === 1 ? legacyBrands[0] : inferredBrand(group);
        const brand = brands.find((item) => brandKey(item) === brandKey(preferred))
          ?? (brands.length === 1 ? brands[0] : '');
        return [group.groupKey, { brand, assignees: brand ? assignmentDefaults(group, brand) : {} }];
      })));
      const channelCount = groups.reduce((sum, group) => sum + group.channels.length, 0);
      setMessage({
        kind: groups.length ? 'ok' : 'warn',
        text: groups.length
          ? `已读取 ${groups.length} 个库存店铺，包含 ${channelCount} 个真实站点`
          : '船长账号下没有可用店铺',
      });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  function changeBrand(group, brand) {
    const previous = drafts[group.groupKey]?.assignees ?? {};
    const assignees = Object.fromEntries(group.countries.map((country) => {
      const eligible = eligibleUsers(country, brand);
      const kept = eligible.some((user) => String(user.id) === String(previous[country]));
      return [country, kept ? previous[country] : eligible.length === 1 ? String(eligible[0].id) : ''];
    }));
    setDrafts((current) => ({ ...current, [group.groupKey]: { brand, assignees } }));
  }

  async function save(group) {
    const draft = drafts[group.groupKey] ?? { brand: '', assignees: {} };
    const selectedCountries = group.countries.filter((country) => draft.assignees?.[country]);
    if (!draft.brand || !selectedCountries.length) {
      return setMessage({
        kind: 'err',
        text: `请为 ${group.groupName} 选择品牌，并至少选择一个国家负责人`,
      });
    }
    setBusy(`save:${group.groupKey}`);
    setMessage(null);
    try {
      await api.saveCaptainBinding({
        groupKey: group.groupKey,
        groupName: group.groupName,
        scope: group.scope,
        brand: draft.brand,
        channels: group.channels,
        assignments: selectedCountries.map((country) => ({
          country, userId: Number(draft.assignees[country]),
        })),
      });
      await load();
      setMessage({
        kind: 'ok',
        text: `${group.groupName} 已绑定 ${selectedCountries.join(' / ')}；其他国家可等负责人上传 SKU 后再补充`,
      });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function toggle(row) {
    setBusy(`toggle:${row.id}`);
    setMessage(null);
    try {
      if (row.legacy) await api.toggleCaptainBinding(row.id, !row.enabled);
      else await api.toggleCaptainAssignment(row.id, !row.enabled);
      await load();
      setMessage({ kind: 'ok', text: `${row.group_name || row.channel_name} · ${row.country} 已${row.enabled ? '停用' : '启用'}` });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function syncAll() {
    setBusy('sync');
    setMessage(null);
    try {
      const result = await api.syncAllCaptainInventory();
      await load();
      setMessage({ kind: result.failed ? 'warn' : 'ok', text: syncText(result) });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  if (!settings) return <div className="card captain-admin-loading">正在读取船长库存设置…</div>;
  const currentRows = [...(settings.assignments ?? []), ...(settings.legacyBindings ?? [])];
  const hasEnabled = currentRows.some((row) => row.enabled);

  return (
    <div className="captain-admin stack">
      {!settings.configured && (
        <div className="note warn" role="status">
          服务器尚未配置船长 APPID 和密钥。请先填写 .env，再重新构建并启动服务。
        </div>
      )}
      {message && <div className={`note ${message.kind}`} role={message.kind === 'err' ? 'alert' : 'status'}>{message.text}</div>}

      <div className="card captain-intro">
        <div>
          <div className="card-title">店铺读取与同步</div>
          <p className="hint">
            一个库存店铺组先选择 SKU 品牌，再按需要选择一个或多个国家负责人；未上传 SKU 的国家可以留空，
            不会阻塞已选择的国家。欧洲组使用同一份共享库存，UK 仍单独分配。
          </p>
        </div>
        <div className="row wrap captain-actions">
          <button className="btn" disabled={!settings.configured || !!busy} onClick={discover}>
            {busy === 'discover' ? '正在读取…' : '读取船长店铺'}
          </button>
          <button className="btn primary" disabled={!settings.configured || !!busy || !hasEnabled} onClick={syncAll}>
            {busy === 'sync' ? '正在同步…' : '同步全部库存'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">绑定库存店铺</div>
        <div className="scroll captain-table-scroll">
          <table className="tbl">
            <thead>
              <tr><th>船长库存店铺</th><th>范围</th><th>SKU 库品牌</th><th>各国家负责人</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {channelGroups.map((group) => {
                const draft = drafts[group.groupKey] ?? { brand: '', assignees: {} };
                const brands = availableBrands(group);
                const saved = assignmentsByGroup.get(group.groupKey) ?? [];
                const complete = group.countries.every((country) => saved.some((row) => row.country === country));
                return (
                  <tr key={group.groupKey}>
                    <td>
                      <div>{group.groupName}</div>
                      <div className="captain-store-meta">{group.channels.length} 个真实站点</div>
                    </td>
                    <td><span className="tag gray">{group.scope === 'EU' ? '欧洲共享' : group.countries.join(' / ')}</span></td>
                    <td>
                      <select
                        className="inp captain-field"
                        aria-label={`${group.groupName} 对应的 SKU 库品牌`}
                        value={draft.brand}
                        onChange={(event) => changeBrand(group, event.target.value)}
                      >
                        <option value="">请选择品牌</option>
                        {brands.map((brand) => <option key={brandKey(brand)} value={brand}>{brand}</option>)}
                      </select>
                    </td>
                    <td>
                      <div className="captain-assignees">
                        {group.countries.map((country) => {
                          const eligible = draft.brand ? eligibleUsers(country, draft.brand) : [];
                          return (
                            <label className="captain-assignee" key={country}>
                              <span className="tag gray">{country}</span>
                              <select
                                className="inp captain-field"
                                aria-label={`${group.groupName} ${country} 负责人`}
                                value={draft.assignees?.[country] ?? ''}
                                disabled={!draft.brand}
                                onChange={(event) => setDrafts((current) => ({
                                  ...current,
                                  [group.groupKey]: {
                                    ...draft,
                                    assignees: { ...draft.assignees, [country]: event.target.value },
                                  },
                                }))}
                              >
                                <option value="">{draft.brand && !eligible.length ? '该国家暂无账号有此品牌 SKU' : '请选择负责人'}</option>
                                {eligible.map((user) => <option key={user.id} value={user.id}>{user.display_name}</option>)}
                              </select>
                            </label>
                          );
                        })}
                      </div>
                    </td>
                    <td>
                      <span className={`tag ${complete && saved.every((row) => row.enabled) ? 'green' : 'gray'}`}>
                        {complete ? '已按国家绑定' : saved.length ? `部分绑定 ${saved.length}/${group.countries.length}` : '可绑定'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn sm"
                        disabled={!!busy || !draft.brand || !group.countries.some((country) => draft.assignees?.[country])}
                        onClick={() => save(group)}
                      >
                        {busy === `save:${group.groupKey}` ? '保存中…' : saved.length ? '更新分配' : '保存分配'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!channelGroups.length && (
                <tr><td colSpan={6} className="empty">点击“读取船长店铺”后在这里按国家分配负责人</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">当前分配</div>
        <div className="scroll captain-table-scroll">
          <table className="tbl">
            <thead>
              <tr><th>账号</th><th>品牌</th><th>国家</th><th>库存店铺组</th><th>最后同步</th><th>结果</th><th /></tr>
            </thead>
            <tbody>
              {currentRows.map((row) => (
                <tr key={`${row.legacy ? 'legacy' : 'assignment'}-${row.id}`} style={{ opacity: row.enabled ? 1 : 0.55 }}>
                  <td>{row.owner_name}</td>
                  <td>{row.brand}</td>
                  <td><span className="tag gray">{row.country}</span></td>
                  <td>{row.group_name || row.channel_name}{row.legacy ? '（旧绑定）' : ''}</td>
                  <td>{formatTime(row.last_sync_at)}</td>
                  <td>
                    <div className="captain-result">
                      <span className={`tag ${row.last_sync_status === 'error' ? 'red' : row.last_sync_status === 'ok' ? 'green' : 'gray'}`}>
                        {row.last_sync_status === 'error' ? '失败' : row.last_sync_status === 'ok' ? '成功' : '等待'}
                      </span>
                      <span title={row.last_sync_detail || ''}>{row.last_sync_detail || '等待首次同步'}</span>
                    </div>
                  </td>
                  <td>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => toggle(row)}>
                      {busy === `toggle:${row.id}` ? '处理中…' : row.enabled ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
              {!currentRows.length && <tr><td colSpan={7} className="empty">还没有分配库存国家</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
