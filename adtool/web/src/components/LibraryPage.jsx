import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import './LibraryPage.css';

const CAT_TONE = { model: 'blue', brand: 'amber', irrel: 'gray', asin: 'green' };

export default function LibraryPage({ market }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [activeCat, setActiveCat] = useState('model');
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [checked, setChecked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  async function load() {
    setError('');
    try {
      const d = await api.library(market);
      setData(d);
      setChecked(new Set());
    } catch (e) {
      setError(e.message);
      setData(null);
    }
  }

  useEffect(() => { load(); }, [market]);

  const cats = data?.cats ?? [];
  const cat = cats.find((c) => c.id === activeCat) ?? cats[0];
  const configMap = useMemo(() => {
    const m = {};
    for (const c of data?.config ?? []) m[c.cat] = c;
    return m;
  }, [data]);

  const terms = useMemo(
    () => (data?.terms ?? []).filter((t) => t.cat === activeCat),
    [data, activeCat]
  );
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? terms.filter((t) => t.term.toLowerCase().includes(f)) : terms;
  }, [terms, filter]);

  const canEdit = !!data?.canEdit;
  const cfg = configMap[activeCat] ?? {};

  async function act(fn, okMsg) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      await load();
      setMsg({ kind: 'ok', text: typeof okMsg === 'function' ? okMsg(r) : okMsg });
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  function addTerms() {
    if (!draft.trim()) return;
    act(
      () => api.addTerms(market, activeCat, draft),
      (r) => {
        setDraft('');
        const parts = [`新增 ${r.added} 个`];
        if (r.duplicated) parts.push(`${r.duplicated} 个已存在跳过`);
        if (r.errorCount) parts.push(`${r.errorCount} 个格式不对:${r.errors[0]}`);
        return parts.join(' · ');
      }
    );
  }

  function removeChecked() {
    const ids = [...checked];
    if (!ids.length) return;
    if (!confirm(`确定删除选中的 ${ids.length} 个词?删了就没了。`)) return;
    act(() => api.deleteTerms(ids), (r) => `已删除 ${r.deleted} 个词`);
  }

  function toggle(id) {
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function exportXlsx() {
    const rows = [['站点', '类型', '否定词', '匹配方式', '否定层级', '添加人', '添加时间']];
    for (const c of cats) {
      const cc = configMap[c.id] ?? {};
      for (const t of (data?.terms ?? []).filter((x) => x.cat === c.id)) {
        rows.push([
          market, c.name, t.term,
          c.kw ? cc.match_type ?? '' : '',
          c.kw ? (cc.level === 'group' ? '广告组级' : '广告活动级') : '',
          t.created_by_name ?? '', t.created_at ?? '',
        ]);
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [8, 10, 30, 14, 14, 12, 20].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ws, '否定词库');
    XLSX.writeFile(wb, `否定词库_${market}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function importXlsx(file) {
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      // 找到「否定词」那一列;没有表头就当第一列是词
      const head = rows[0]?.map((x) => String(x).trim());
      const termCol = head?.findIndex((h) => /否定词|词|term/i.test(h));
      const col = termCol >= 0 ? termCol : 0;
      const words = rows
        .slice(termCol >= 0 ? 1 : 0)
        .map((r) => String(r[col] ?? '').trim())
        .filter(Boolean);
      if (!words.length) return setMsg({ kind: 'err', text: '这份文件里没读到词' });
      act(
        () => api.addTerms(market, activeCat, words.join('\n')),
        (r) => `导入到「${cat.name}」:新增 ${r.added} 个,${r.duplicated} 个已存在`
      );
    } catch (e) {
      setMsg({ kind: 'err', text: '读取失败:' + e.message });
    }
  }

  if (error) return <div className="lib"><div className="note err">{error}</div></div>;
  if (!data) return <div className="lib"><div className="empty">加载中…</div></div>;

  return (
    <div className="lib">
      <div className="lib-head">
        <div>
          <h1>{market} 站否定词库</h1>
          <p className="hint">
            {canEdit
              ? '这里的词会自动否定进本站点生成的每一条广告活动。改动对所有人立即生效。'
              : '你的账号对这个词库是只读的。需要增删改,找本国管理员。'}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={exportXlsx}>导出 Excel</button>
        {canEdit && (
          <label className="btn" style={{ cursor: 'pointer' }}>
            导入 Excel
            <input
              type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
              onChange={(e) => { importXlsx(e.target.files[0]); e.target.value = ''; }}
            />
          </label>
        )}
      </div>

      <div className="lib-tabs">
        {cats.map((c) => {
          const n = (data.terms ?? []).filter((t) => t.cat === c.id).length;
          const off = configMap[c.id]?.enabled === 0;
          return (
            <button
              key={c.id}
              className={`lib-tab${activeCat === c.id ? ' on' : ''}${off ? ' off' : ''}`}
              onClick={() => { setActiveCat(c.id); setChecked(new Set()); setFilter(''); }}
            >
              <span>{c.name}</span>
              <span className={`tag ${CAT_TONE[c.id]}`}>{n}</span>
              {off && <span className="lib-tab-off">停用</span>}
            </button>
          );
        })}
      </div>

      <div className="lib-body">
        <div className="lib-side stack">
          <div className="card">
            <div className="card-title">分类设置</div>
            <p className="hint" style={{ marginBottom: 12 }}>{cat.desc}</p>

            <label className="row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox" disabled={!canEdit}
                checked={cfg.enabled !== 0}
                onChange={(e) =>
                  act(() => api.setCatConfig(market, { cat: activeCat, enabled: e.target.checked }), '已保存')
                }
              />
              <span style={{ fontSize: 12.5 }}>生成广告时套用这一类</span>
            </label>

            {cat.kw && (
              <div className="stack" style={{ gap: 10 }}>
                <label className="field">
                  <span>匹配方式</span>
                  <select
                    className="inp" disabled={!canEdit} value={cfg.match_type ?? '否定词组'}
                    onChange={(e) =>
                      act(() => api.setCatConfig(market, { cat: activeCat, matchType: e.target.value }), '已保存')
                    }
                  >
                    <option value="否定词组">否定词组</option>
                    <option value="否定精准匹配">否定精准匹配</option>
                  </select>
                </label>
                <label className="field">
                  <span>否定层级</span>
                  <select
                    className="inp" disabled={!canEdit} value={cfg.level ?? 'camp'}
                    onChange={(e) =>
                      act(() => api.setCatConfig(market, { cat: activeCat, level: e.target.value }), '已保存')
                    }
                  >
                    <option value="camp">广告活动级</option>
                    <option value="group">广告组级</option>
                  </select>
                </label>
              </div>
            )}
          </div>

          {canEdit && (
            <div className="card">
              <div className="card-title">批量添加</div>
              <textarea
                className="inp" rows={8} value={draft}
                placeholder={cat.id === 'asin' ? 'B08T1HR5CS\nB087DH9GT3' : '一行一个词\nepson\nbrother'}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row" style={{ marginTop: 9 }}>
                <span className="hint">
                  {draft.split('\n').filter((s) => s.trim()).length} 行待添加
                </span>
                <div className="spacer" />
                <button className="btn primary" disabled={busy || !draft.trim()} onClick={addTerms}>
                  添加到「{cat.name}」
                </button>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                自动去重、去空行。已经在库里的词会被跳过,不会重复。
              </p>
            </div>
          )}
        </div>

        <div className="card lib-main">
          <div className="row wrap" style={{ marginBottom: 11 }}>
            <input
              className="inp" style={{ width: 200 }} placeholder="搜索词…"
              value={filter} onChange={(e) => setFilter(e.target.value)}
            />
            <span className="stat">
              <b>{shown.length}</b> / {terms.length} 个
            </span>
            <div className="spacer" />
            {canEdit && checked.size > 0 && (
              <button className="btn danger sm" disabled={busy} onClick={removeChecked}>
                删除选中 {checked.size}
              </button>
            )}
          </div>

          {msg && <div className={`note ${msg.kind}`} style={{ marginBottom: 11 }}>{msg.text}</div>}

          <div className="scroll">
            <table className="tbl">
              <thead>
                <tr>
                  {canEdit && (
                    <th style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={shown.length > 0 && shown.every((t) => checked.has(t.id))}
                        onChange={(e) =>
                          setChecked(e.target.checked ? new Set(shown.map((t) => t.id)) : new Set())
                        }
                      />
                    </th>
                  )}
                  <th>词</th>
                  <th style={{ width: 90 }}>添加人</th>
                  <th style={{ width: 130 }}>添加时间</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id}>
                    {canEdit && (
                      <td>
                        <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
                      </td>
                    )}
                    <td className="mono">{t.term}</td>
                    <td style={{ color: 'var(--text-faint)' }}>{t.created_by_name ?? '—'}</td>
                    <td style={{ color: 'var(--text-faint)' }}>{t.created_at ?? '—'}</td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={canEdit ? 4 : 3} className="empty">
                      {terms.length ? '没有匹配的词' : `「${cat.name}」还是空的`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
