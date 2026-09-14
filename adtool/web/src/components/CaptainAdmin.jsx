import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import './CaptainAdmin.css';

const formatTime = (value) => value
  ? new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false })
  : '尚未同步';

function syncText(result) {
  const rows = result.results ?? [];
  const updated = rows.reduce((sum, row) => sum + Number(row.updated || 0), 0);
  const failed = rows.reduce((sum, row) => sum + Number(row.failed || 0) + (row.error ? 1 : 0), 0);
  return `已处理 ${result.users} 个账号，更新 ${updated} 行${failed ? `，${failed} 个店铺失败` : ''}`;
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

  const bindingByChannel = useMemo(() => new Map(
    (settings?.bindings ?? []).map((binding) => [binding.open_channel_id, binding])
  ), [settings]);
  const brandOptionsByUser = useMemo(() => new Map(
    (settings?.brandOptions ?? []).map((row) => [String(row.userId), row.brands])
  ), [settings]);

  async function discover() {
    setBusy('discover');
    setMessage(null);
    try {
      const result = await api.discoverCaptainChannels();
      const groups = result.groups ?? [];
      const defaultUser = users.find((user) => (
        user.is_active && (brandOptionsByUser.get(String(user.id)) ?? []).length
      )) ?? users.find((user) => user.is_active);
      setChannelGroups(groups);
      setDrafts(Object.fromEntries(groups.map((group) => {
        const bindings = group.channels.map((channel) => bindingByChannel.get(channel.openChannelId)).filter(Boolean);
        const userIds = [...new Set(bindings.map((binding) => String(binding.user_id)))];
        const userId = userIds.length === 1 ? userIds[0] : String(defaultUser?.id ?? '');
        const availableBrands = brandOptionsByUser.get(userId) ?? [];
        const boundBrands = [...new Set(bindings.map((binding) => binding.brand))];
        const boundBrand = boundBrands.length === 1 && availableBrands.includes(boundBrands[0]) ? boundBrands[0] : '';
        return [group.groupKey, {
          userId,
          brand: boundBrand || (availableBrands.length === 1 ? availableBrands[0] : ''),
        }];
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

  async function save(group) {
    const draft = drafts[group.groupKey] ?? {};
    if (!draft.userId || !draft.brand?.trim()) {
      return setMessage({ kind: 'err', text: `请为 ${group.groupName} 选择网站账号和 SKU 库品牌` });
    }
    setBusy(`save:${group.groupKey}`);
    setMessage(null);
    try {
      await api.saveCaptainBinding({
        userId: Number(draft.userId),
        brand: draft.brand.trim(),
        channels: group.channels,
      });
      await load();
      setMessage({
        kind: 'ok',
        text: `${group.groupName} 的 ${group.channels.length} 个站点已绑定到品牌 ${draft.brand.trim()}`,
      });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function toggle(binding) {
    setBusy(`toggle:${binding.id}`);
    setMessage(null);
    try {
      await api.toggleCaptainBinding(binding.id, !binding.enabled);
      await load();
      setMessage({ kind: 'ok', text: `${binding.channel_name} 已${binding.enabled ? '停用' : '启用'}` });
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
      setMessage({ kind: result.results.some((row) => row.error || row.failed) ? 'warn' : 'ok', text: syncText(result) });
    } catch (error) {
      setMessage({ kind: 'err', text: error.message });
    } finally {
      setBusy('');
    }
  }

  if (!settings) return <div className="card captain-admin-loading">正在读取船长库存设置…</div>;

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
            读取后按船长库存页面的店铺组展示，再绑定“网站账号 + SKU 库品牌”。每个真实站点仍分别调用
            inventory_list；欧洲同品牌库存合计后同步到 ES / DE / FR / IT / UK 的同名 SKU。
          </p>
        </div>
        <div className="row wrap captain-actions">
          <button className="btn" disabled={!settings.configured || !!busy} onClick={discover}>
            {busy === 'discover' ? '正在读取…' : '读取船长店铺'}
          </button>
          <button
            className="btn primary"
            disabled={!settings.configured || !!busy || !settings.bindings.some((binding) => binding.enabled)}
            onClick={syncAll}
          >
            {busy === 'sync' ? '正在同步…' : '同步全部库存'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">绑定库存店铺</div>
        <div className="scroll captain-table-scroll">
          <table className="tbl">
            <thead>
              <tr><th>船长库存店铺</th><th>范围</th><th>网站账号</th><th>SKU 库品牌</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {channelGroups.map((group) => {
                const draft = drafts[group.groupKey] ?? { userId: '', brand: '' };
                const bindings = group.channels.map((channel) => bindingByChannel.get(channel.openChannelId)).filter(Boolean);
                const brandOptions = brandOptionsByUser.get(draft.userId) ?? [];
                const allBound = bindings.length === group.channels.length;
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
                        aria-label={`${group.groupName} 对应的网站账号`}
                        value={draft.userId}
                        onChange={(event) => {
                          const userId = event.target.value;
                          const nextBrands = brandOptionsByUser.get(userId) ?? [];
                          setDrafts({
                            ...drafts,
                            [group.groupKey]: {
                              userId,
                              brand: nextBrands.length === 1 ? nextBrands[0] : '',
                            },
                          });
                        }}
                      >
                        <option value="">请选择</option>
                        {users.filter((user) => user.is_active).map((user) => (
                          <option key={user.id} value={user.id}>{user.display_name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        className="inp captain-field"
                        aria-label={`${group.groupName} 对应的 SKU 库品牌`}
                        value={draft.brand}
                        onChange={(event) => setDrafts({
                          ...drafts,
                          [group.groupKey]: { ...draft, brand: event.target.value },
                        })}
                      >
                        <option value="">{brandOptions.length ? '请选择品牌' : '该账号暂无 SKU 品牌'}</option>
                        {brandOptions.map((brand) => <option key={brand} value={brand}>{brand}</option>)}
                      </select>
                    </td>
                    <td>
                      <span className={`tag ${allBound && bindings.every((binding) => binding.enabled) ? 'green' : 'gray'}`}>
                        {allBound ? '已绑定' : bindings.length ? `部分绑定 ${bindings.length}/${group.channels.length}` : '可绑定'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn sm"
                        disabled={!!busy || !draft.userId || !draft.brand}
                        onClick={() => save(group)}
                      >
                        {busy === `save:${group.groupKey}` ? '保存中…' : bindings.length ? '更新绑定' : '保存绑定'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!channelGroups.length && (
                <tr><td colSpan={6} className="empty">点击“读取船长店铺”后在这里完成绑定</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-title">当前绑定</div>
        <div className="scroll captain-table-scroll">
          <table className="tbl">
            <thead>
              <tr><th>账号</th><th>品牌</th><th>国家</th><th>店铺</th><th>最后同步</th><th>结果</th><th /></tr>
            </thead>
            <tbody>
              {settings.bindings.map((binding) => (
                <tr key={binding.id} style={{ opacity: binding.enabled ? 1 : 0.55 }}>
                  <td>{binding.owner_name}</td>
                  <td>{binding.brand}</td>
                  <td><span className="tag gray">{binding.country}</span></td>
                  <td>{binding.channel_name}</td>
                  <td>{formatTime(binding.last_sync_at)}</td>
                  <td>
                    <div className="captain-result">
                      <span className={`tag ${binding.last_sync_status === 'error' ? 'red' : binding.last_sync_status === 'ok' ? 'green' : 'gray'}`}>
                        {binding.last_sync_status === 'error' ? '失败' : binding.last_sync_status === 'ok' ? '成功' : '等待'}
                      </span>
                      <span title={binding.last_sync_detail || ''}>{binding.last_sync_detail || '等待首次同步'}</span>
                    </div>
                  </td>
                  <td>
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => toggle(binding)}>
                      {busy === `toggle:${binding.id}` ? '处理中…' : binding.enabled ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
              {!settings.bindings.length && <tr><td colSpan={7} className="empty">还没有绑定店铺</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
