import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import NegHelper from './NegHelper.jsx';
import './LibraryPage.css';

const TONE = { A: 'gray', B: 'amber', C: 'blue', D: 'green', E: 'violet' };

/** 列名兜底:Excel 表头和列标题对不上时,再按这些关键词猜一次 */
const ALIAS = {
  term: /型号|否定词|品牌|关键词|term|model/i,
  brand: /品牌|brand/i,
  series: /系列|series/i,
  printer: /打印机|printer/i,
  asin: /asin/i,
};

/** 把 Excel 第一行表头映射成列 key,映射不上就按列序来 */
function mapHeader(lib, head) {
  const used = new Set();
  const idx = {};
  const norm = head.map((h) => String(h ?? '').trim());

  for (const col of lib.cols) {
    const i = norm.findIndex(
      (h, j) => !used.has(j) && h && (h.includes(col.label) || col.label.includes(h))
    );
    if (i >= 0) {
      idx[col.key] = i;
      used.add(i);
    }
  }
  for (const col of lib.cols) {
    if (idx[col.key] !== undefined) continue;
    const i = norm.findIndex((h, j) => !used.has(j) && h && ALIAS[col.key]?.test(h));
    if (i >= 0) {
      idx[col.key] = i;
      used.add(i);
    }
  }
  return Object.keys(idx).length ? idx : null;
}

export default function LibraryPage({ market }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [activeId, setActiveId] = useState('A');
  const [draft, setDraft] = useState('');
  const [replace, setReplace] = useState(false);
  const [filter, setFilter] = useState('');
  const [facet, setFacet] = useState({ brand: '', series: '' });
  const [checked, setChecked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [helper, setHelper] = useState(false);

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

  const libs = data?.libs ?? [];
  const lib = libs.find((l) => l.id === activeId) ?? libs[0];
  const scope = lib ? data?.scopes?.[lib.id] : null;
  const canEdit = lib ? !!data?.perms?.[lib.id] : false;
  // 套用设置是「本站点怎么用词库」,归站点负责人管 —— A 类的写权限刚好就是这个口径
  const canConfig = !!data?.perms?.A;

  const configMap = useMemo(() => {
    const m = {};
    for (const c of data?.config ?? []) m[c.lib] = c;
    return m;
  }, [data]);
  const cfg = (lib && configMap[lib.id]) ?? {};

  const items = useMemo(() => (lib ? data?.items?.[lib.id] ?? [] : []), [data, lib]);

  const facetValues = useMemo(() => {
    const brands = new Set();
    const series = new Set();
    for (const it of items) {
      if (it.brand) brands.add(it.brand);
      if (it.series) series.add(it.series);
    }
    return { brands: [...brands].sort(), series: [...series].sort() };
  }, [items]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return items.filter((it) => {
      if (facet.brand && it.brand !== facet.brand) return false;
      if (facet.series && it.series !== facet.series) return false;
      if (!f) return true;
      return (lib?.cols ?? []).some((c) => String(it[c.key] ?? '').toLowerCase().includes(f));
    });
  }, [items, filter, facet, lib]);

  function switchLib(id) {
    setActiveId(id);
    setChecked(new Set());
    setFilter('');
    setFacet({ brand: '', series: '' });
    setDraft('');
    setReplace(false);
    setMsg(null);
  }

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

  function resultText(r) {
    const parts = [];
    if (r.removed) parts.push(`清掉旧的 ${r.removed} 行`);
    parts.push(`新增 ${r.added} 行`);
    if (r.duplicated) parts.push(`${r.duplicated} 行已存在跳过`);
    if (r.errorCount) parts.push(`${r.errorCount} 行没通过:${r.errors[0]}`);
    return parts.join(' · ');
  }

  function addDraft() {
    if (!draft.trim()) return;
    const rep = replace;
    act(() => api.addText(market, lib.id, draft, rep), (r) => {
      setDraft('');
      setReplace(false);
      return resultText(r);
    });
  }

  function removeChecked() {
    const ids = [...checked];
    if (!ids.length) return;
    if (!confirm(`确定删除选中的 ${ids.length} 行?删了就没了。`)) return;
    act(() => api.deleteRows(ids), (r) => `已删除 ${r.deleted} 行`);
  }

  function toggle(id) {
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function exportXlsx() {
    const head = [...lib.cols.map((c) => c.label), '备注', '添加人', '添加时间'];
    const rows = [head];
    for (const it of shown) {
      rows.push([
        ...lib.cols.map((c) => it[c.key] ?? ''),
        it.note ?? '', it.created_by_name ?? '', it.created_at ?? '',
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = head.map((_, i) => ({ wch: i < lib.cols.length ? 18 : 14 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${lib.id}类`);
    const tag = scope?.scope ?? market;
    XLSX.writeFile(wb, `${lib.id}类_${lib.name}_${tag}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function importXlsx(file, asReplace) {
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      if (!sheet.length) return setMsg({ kind: 'err', text: '这份文件是空的' });

      const idx = mapHeader(lib, sheet[0] ?? []);
      // 认出表头就跳过第一行,认不出就当整张表都是数据、按列序对上去
      const body = idx ? sheet.slice(1) : sheet;
      const rows = [];
      for (const r of body) {
        const row = {};
        lib.cols.forEach((c, i) => {
          const at = idx ? idx[c.key] : i;
          row[c.key] = at === undefined ? '' : r[at] ?? '';
        });
        if (lib.cols.some((c) => String(row[c.key] ?? '').trim())) rows.push(row);
      }
      if (!rows.length) return setMsg({ kind: 'err', text: '这份文件里没读到数据行' });
      if (asReplace && !confirm(`整表替换:${scope?.scope} 的「${lib.name}」现有 ${items.length} 行会被清空,换成文件里的 ${rows.length} 行。继续?`)) {
        return;
      }
      act(() => api.addRows(market, lib.id, rows, asReplace), resultText);
    } catch (e) {
      setMsg({ kind: 'err', text: '读取失败:' + e.message });
    }
  }

  if (error) return <div className="lib"><div className="note err">{error}</div></div>;
  if (!data || !lib) return <div className="lib"><div className="empty">加载中…</div></div>;

  const syncText =
    lib.scope === 'region'
      ? `${data.region?.name ?? scope?.scope} 区共用一份 · 传一次同步给 ${scope?.markets?.join(' / ')}`
      : `${market} 站单独一份,不影响别的站点`;

  return (
    <div className="lib">
      <div className="lib-head">
        <div>
          <h1>{market} 站否定词库</h1>
          <p className="hint">
            A 类由运营和国家管理员按站点维护;B/C/D/E 由商品部维护,欧洲传德国、美洲传美国,同区自动同步。
          </p>
        </div>
        <div className="spacer" />
        {lib.special === 'series' && scope && (
          <button className="btn primary" onClick={() => setHelper(true)}>
            后台否定助手
          </button>
        )}
        <button className="btn" onClick={exportXlsx}>导出 Excel</button>
        {canEdit && (
          <>
            <label className="btn" style={{ cursor: 'pointer' }}>
              导入 Excel
              <input
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => { importXlsx(e.target.files[0], false); e.target.value = ''; }}
              />
            </label>
            <label className="btn" style={{ cursor: 'pointer' }} title="先清空这一类,再导入文件里的内容">
              整表替换
              <input
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => { importXlsx(e.target.files[0], true); e.target.value = ''; }}
              />
            </label>
          </>
        )}
      </div>

      <div className="lib-tabs">
        {libs.map((l) => {
          const n = (data.items?.[l.id] ?? []).length;
          const off = configMap[l.id]?.enabled === 0;
          const none = !data.scopes?.[l.id];
          return (
            <button
              key={l.id}
              className={`lib-tab${l.id === lib.id ? ' on' : ''}${off || none ? ' off' : ''}`}
              onClick={() => switchLib(l.id)}
            >
              <span className="lib-tab-id">{l.id}</span>
              <span>{l.name}</span>
              <span className={`tag ${TONE[l.id]}`}>{n}</span>
              {none && <span className="lib-tab-off">本站没有</span>}
              {!none && off && <span className="lib-tab-off">不套用</span>}
            </button>
          );
        })}
      </div>

      {helper && (
        <NegHelper market={market} lib={data} onClose={() => setHelper(false)} />
      )}

      <div className="lib-body">
        <div className="lib-side stack">
          <div className="card">
            <div className="card-title">{lib.id} 类 · {lib.name}</div>
            <p className="hint" style={{ marginBottom: 10 }}>{lib.desc}</p>
            <div className="libmeta">
              <div><span>维护方</span><b>{lib.ownerName}</b></div>
              <div><span>更新节奏</span><b>{lib.cadence}</b></div>
              <div><span>范围</span><b>{scope ? syncText : '本站点没有这一类'}</b></div>
            </div>
            {lib.special === 'series' && scope && (
              <p className="hint" style={{ marginTop: 10 }}>
                这一类也能当型号库单独用:点右上角<b>后台否定助手</b>,一次搜多个墨盒型号,
                把墨盒型号或打印机型号复制走,直接粘进亚马逊后台的否定词框。
              </p>
            )}
            {lib.draft && (
              <p className="note warn" style={{ marginTop: 10 }}>
                数据格式还没定,先按 ASIN + 品牌 + 对应墨盒型号存着,定了再调整。
              </p>
            )}
            {!canEdit && scope && (
              <p className="hint" style={{ marginTop: 10 }}>
                你这边是只读的,要增删改找{lib.ownerName}。
              </p>
            )}
          </div>

          <div className="card">
            <div className="card-title">开广告时怎么用</div>
            <label className="row" style={{ marginBottom: 10 }}>
              <input
                type="checkbox" disabled={!canConfig}
                checked={cfg.enabled !== 0}
                onChange={(e) =>
                  act(() => api.setLibConfig(market, { lib: lib.id, enabled: e.target.checked }), '已保存')
                }
              />
              <span style={{ fontSize: 12.5 }}>
                {lib.special === 'series'
                  ? '开系列广告时联动否定其它型号'
                  : '生成广告时套用这一类'}
              </span>
            </label>

            {lib.feed?.kw?.length || lib.special === 'series' ? (
              <div className="stack" style={{ gap: 10 }}>
                <label className="field">
                  <span>匹配方式</span>
                  <select
                    className="inp" disabled={!canConfig} value={cfg.match_type || '否定词组'}
                    onChange={(e) =>
                      act(() => api.setLibConfig(market, { lib: lib.id, matchType: e.target.value }), '已保存')
                    }
                  >
                    <option value="否定词组">否定词组</option>
                    <option value="否定精准匹配">否定精准匹配</option>
                  </select>
                </label>
                <label className="field">
                  <span>否定层级</span>
                  <select
                    className="inp" disabled={!canConfig} value={cfg.level || 'camp'}
                    onChange={(e) =>
                      act(() => api.setLibConfig(market, { lib: lib.id, level: e.target.value }), '已保存')
                    }
                  >
                    <option value="camp">广告活动级</option>
                    <option value="group">广告组级</option>
                  </select>
                </label>
              </div>
            ) : (
              <p className="hint">这一类只出否定商品定向(ASIN),没有匹配方式。</p>
            )}
            <p className="hint" style={{ marginTop: 9 }}>
              这里只管 {market} 站怎么用词库,不影响别的站点,也不改词库内容。
            </p>
          </div>

          {canEdit && scope && (
            <div className="card">
              <div className="card-title">批量添加</div>
              <textarea
                className="inp" rows={7} value={draft}
                placeholder={
                  lib.cols.length === 1
                    ? `一行一个\n${lib.id === 'B' ? 'epson\nbrother' : 'pad\ncord'}`
                    : `从 Excel 直接复制粘贴,一行一条\n列的顺序:${lib.cols.map((c) => c.label).join(' → ')}`
                }
                onChange={(e) => setDraft(e.target.value)}
              />
              <label className="row" style={{ marginTop: 9 }}>
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                <span className="hint">先清空这一类再写(月度整表更新用)</span>
              </label>
              <div className="row" style={{ marginTop: 9 }}>
                <span className="hint">{draft.split('\n').filter((s) => s.trim()).length} 行待添加</span>
                <div className="spacer" />
                <button className="btn primary" disabled={busy || !draft.trim()} onClick={addDraft}>
                  写入 {lib.id} 类
                </button>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                自动去重、去空行。{lib.cols.length > 1 && '列之间用 Tab 分隔,和 Excel 复制出来的格式一致。'}
              </p>
            </div>
          )}
        </div>

        <div className="card lib-main">
          <div className="row wrap" style={{ marginBottom: 11 }}>
            <input
              className="inp" style={{ width: 190 }} placeholder="搜索(所有列)…"
              value={filter} onChange={(e) => setFilter(e.target.value)}
            />
            {facetValues.brands.length > 1 && (
              <select
                className="inp" style={{ width: 130 }} value={facet.brand}
                onChange={(e) => setFacet({ ...facet, brand: e.target.value })}
              >
                <option value="">全部品牌</option>
                {facetValues.brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            {facetValues.series.length > 1 && (
              <select
                className="inp" style={{ width: 150 }} value={facet.series}
                onChange={(e) => setFacet({ ...facet, series: e.target.value })}
              >
                <option value="">全部打印机系列</option>
                {facetValues.series.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            <span className="stat"><b>{shown.length}</b> / {items.length} 行</span>
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
                  {lib.cols.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th style={{ width: 90 }}>添加人</th>
                  <th style={{ width: 130 }}>添加时间</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 2000).map((it) => (
                  <tr key={it.id}>
                    {canEdit && (
                      <td>
                        <input type="checkbox" checked={checked.has(it.id)} onChange={() => toggle(it.id)} />
                      </td>
                    )}
                    {lib.cols.map((c) => (
                      <td key={c.key} className="mono">{it[c.key] ?? '—'}</td>
                    ))}
                    <td style={{ color: 'var(--text-faint)' }}>{it.created_by_name ?? '—'}</td>
                    <td style={{ color: 'var(--text-faint)' }}>{it.created_at ?? '—'}</td>
                  </tr>
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={lib.cols.length + (canEdit ? 3 : 2)} className="empty">
                      {!scope
                        ? `${market} 站不在「${lib.name}」的覆盖范围里`
                        : items.length ? '没有匹配的行' : `「${lib.name}」还是空的`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {shown.length > 2000 && (
              <p className="hint" style={{ padding: '8px 2px' }}>
                行数太多,只显示前 2000 行,用上面的搜索和筛选缩小范围(导出的是筛选后的全部 {shown.length} 行)。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
