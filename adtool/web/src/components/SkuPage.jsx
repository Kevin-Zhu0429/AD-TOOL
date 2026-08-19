import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import './LibraryPage.css';
import './SkuPage.css';

/* 列名兜底:Excel 表头和列标题对不上时,再按这些关键词猜一次 */
const ALIAS = {
  country: /国家|站点|market|country/i,
  brand: /品牌|brand/i,
  model: /型号|机型|model/i,
  setGroup: /套组|套装|组合|颜色|set|pack/i,
  sku: /^sku$|卖家sku|商品sku|seller ?sku/i,
  stock: /在库|可售|库存|on ?hand|stock/i,
  transit: /在途|补货|transit|inbound/i,
};

/** 把 Excel 第一行表头映射成列 key,映射不上就按列序来 */
function mapHeader(cols, head) {
  const used = new Set();
  const idx = {};
  const norm = head.map((h) => String(h ?? '').trim());

  for (const col of cols) {
    const i = norm.findIndex((h, j) => !used.has(j) && h && h === col.label);
    if (i >= 0) { idx[col.key] = i; used.add(i); }
  }
  for (const col of cols) {
    if (idx[col.key] !== undefined) continue;
    const i = norm.findIndex((h, j) => !used.has(j) && h && ALIAS[col.key]?.test(h));
    if (i >= 0) { idx[col.key] = i; used.add(i); }
  }
  return Object.keys(idx).length ? idx : null;
}

const val = (it, key) => (it[key] === null || it[key] === undefined || it[key] === '' ? '' : it[key]);

export default function SkuPage({ market }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('mine');
  const [draft, setDraft] = useState('');
  const [replace, setReplace] = useState(false);
  const [filter, setFilter] = useState('');
  const [facet, setFacet] = useState({ country: '', brand: '' });
  const [checked, setChecked] = useState(() => new Set());
  const [edit, setEdit] = useState(null);          // 正在编辑的那一行:{id, ...列}

  async function load(next = scope) {
    setError('');
    try {
      const d = await api.skus(next === 'all' ? { scope: 'all' } : {});
      setData(d);
      setChecked(new Set());
    } catch (e) {
      setError(e.message);
      setData(null);
    }
  }
  useEffect(() => { load('mine'); }, []);

  const cols = useMemo(() => data?.cols ?? [], [data]);
  const items = useMemo(() => data?.items ?? [], [data]);

  const facetValues = useMemo(() => {
    const countries = new Set();
    const brands = new Set();
    for (const it of items) {
      if (it.country) countries.add(it.country);
      if (it.brand) brands.add(it.brand);
    }
    return { countries: [...countries].sort(), brands: [...brands].sort() };
  }, [items]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return items.filter((it) => {
      if (facet.country && it.country !== facet.country) return false;
      if (facet.brand && it.brand !== facet.brand) return false;
      if (!f) return true;
      return cols.some((c) => String(it[c.key] ?? '').toLowerCase().includes(f));
    });
  }, [items, filter, facet, cols]);

  const mine = scope !== 'all';

  async function act(fn, okMsg) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      await load();
      const out = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      setMsg(typeof out === 'string' ? { kind: 'ok', text: out } : out);
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  function resultText(r) {
    const parts = [];
    if (r.removed) parts.push(`清掉旧的 ${r.removed} 行`);
    if (r.added) parts.push(`新增 ${r.added} 行`);
    if (r.updated) parts.push(`更新 ${r.updated} 行`);
    if (!r.added && !r.updated) parts.push('没有写入新行');
    if (r.errorCount) parts.push(`${r.errorCount} 行没通过:${r.errors[0]}`);
    return { kind: r.errorCount ? 'warn' : 'ok', text: parts.join(' · ') };
  }

  function addDraft() {
    if (!draft.trim()) return;
    const rep = replace;
    act(() => api.addSkuText(draft, rep), (r) => {
      setDraft('');
      setReplace(false);
      return resultText(r);
    });
  }

  function removeChecked() {
    const ids = [...checked];
    if (!ids.length) return;
    if (!confirm(`确定删除选中的 ${ids.length} 行?删了就没了。`)) return;
    act(() => api.deleteSkus(ids), (r) => `已删除 ${r.deleted} 行`);
  }

  function saveEdit() {
    const body = {};
    for (const c of cols) body[c.key] = String(edit[c.key] ?? '');
    const id = edit.id;
    setEdit(null);
    act(() => api.updateSku(id, body), '已保存');
  }

  function downloadTemplate() {
    const rows = [
      cols.map((c) => c.label),
      ['ES', 'HP', '301', '1黑1彩', 'CY-ES-HP301XL-BKCL', 120, 300],
      ['ES', 'HP', '302', '2黑', 'CY-ES-HP302XL-2BK', 0, 500],
      ['DE', 'Canon', 'PG-545', '1黑', 'CY-DE-CA545XL-BK', 80, ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = cols.map((c) => ({ wch: c.width ?? 14 }));
    const guide = [['列', '必填', '说明'], ...cols.map((c) => [c.label, c.required ? '必填' : '选填', c.hint ?? ''])];
    const wg = XLSX.utils.aoa_to_sheet(guide);
    wg['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 52 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SKU导入');
    XLSX.utils.book_append_sheet(wb, wg, '填写说明');
    XLSX.writeFile(wb, 'SKU库导入模板.xlsx');
  }

  function exportXlsx() {
    const head = [...cols.map((c) => c.label), '更新时间', ...(mine ? [] : ['上传人'])];
    const rows = [head];
    for (const it of shown) {
      rows.push([
        ...cols.map((c) => val(it, c.key)),
        it.updated_at ?? '', ...(mine ? [] : [it.owner_name ?? '']),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = head.map((_, i) => ({ wch: cols[i]?.width ?? 16 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'SKU库');
    XLSX.writeFile(wb, `SKU库_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function importXlsx(file, asReplace) {
    if (!file) return;
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
      if (!sheet.length) return setMsg({ kind: 'err', text: '这份文件是空的' });

      const idx = mapHeader(cols, sheet[0] ?? []);
      const body = idx ? sheet.slice(1) : sheet;
      const rows = [];
      for (const r of body) {
        const row = {};
        cols.forEach((c, i) => {
          const at = idx ? idx[c.key] : i;
          row[c.key] = at === undefined ? '' : r[at] ?? '';
        });
        if (cols.some((c) => String(row[c.key] ?? '').trim())) rows.push(row);
      }
      if (!rows.length) return setMsg({ kind: 'err', text: '这份文件里没读到数据行' });

      const countries = [...new Set(rows.map((r) => String(r.country ?? '').trim().toUpperCase()))]
        .filter(Boolean);
      if (asReplace && !confirm(
        `整表替换:你自己库里 ${countries.join(' / ')} 的 SKU 会先清空,再写入文件里的 ${rows.length} 行。` +
        '别的国家和别人的库不受影响。继续?'
      )) return;

      act(() => api.addSkuRows(rows, asReplace), resultText);
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
          <h1>我的 SKU 库</h1>
          <p className="hint">
            每个账号一份自己的库,别人看不到,大家只传自己负责的品牌。
            开广告时在「投放 SKU」那里点「从 SKU 库选」,按站点和型号挑好直接填进去。
          </p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={downloadTemplate}>下载模板</button>
        <button className="btn" onClick={exportXlsx}>导出 Excel</button>
        {mine && (
          <>
            <label className="btn" style={{ cursor: 'pointer' }}>
              导入 Excel
              <input
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => { importXlsx(e.target.files[0], false); e.target.value = ''; }}
              />
            </label>
            <label className="btn" style={{ cursor: 'pointer' }} title="先清空文件里出现的那几个国家,再导入">
              整表替换
              <input
                type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                onChange={(e) => { importXlsx(e.target.files[0], true); e.target.value = ''; }}
              />
            </label>
          </>
        )}
      </div>

      {data.canViewAll && (
        <div className="lib-tabs">
          {[['mine', '我上传的'], ['all', '全部账号(只读)']].map(([id, label]) => (
            <button
              key={id}
              className={`lib-tab${scope === id ? ' on' : ''}`}
              onClick={() => { setScope(id); setEdit(null); load(id); }}
            >{label}</button>
          ))}
        </div>
      )}

      <div className="lib-body">
        <div className="stack">
          {mine && (
          <div className="card">
            <div className="card-title">批量添加</div>
            <textarea
              className="inp" rows={8} value={draft}
              placeholder={`从 Excel 直接复制粘贴,一行一个 SKU\n列的顺序:${cols.map((c) => c.label).join(' → ')}\n\nES\tHP\t301\t1黑1彩\tCY-ES-HP301XL-BKCL\t120\t300`}
              onChange={(e) => setDraft(e.target.value)}
            />
            <label className="row" style={{ marginTop: 9 }}>
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span className="hint">先清空这批数据里出现的国家再写(月度整表更新用)</span>
            </label>
            <div className="row" style={{ marginTop: 9 }}>
              <span className="hint">{draft.split('\n').filter((s) => s.trim()).length} 行待添加</span>
              <div className="spacer" />
              <button className="btn primary" disabled={busy || !draft.trim()} onClick={addDraft}>
                写入我的库
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              列之间用 Tab 分隔(Excel 复制出来就是),也认 <span className="mono">~</span> 和{' '}
              <span className="mono">|</span>;SKU 和型号自带 <span className="mono">-</span>,所以不拿它当分隔符。
              同一个国家里同一个 SKU 再传一次是更新库存,不会重复。
            </p>
          </div>
          )}

          <div className="card">
            <div className="card-title">模板列</div>
            <div className="libmeta">
              {cols.map((c) => (
                <div key={c.key}>
                  <span>{c.label}</span>
                  <b>{c.required ? '必填 · ' : ''}{c.hint}</b>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card lib-main">
          <div className="row wrap" style={{ marginBottom: 11 }}>
            <input
              className="inp" style={{ width: 190 }} placeholder="搜索(所有列)…"
              value={filter} onChange={(e) => setFilter(e.target.value)}
            />
            {facetValues.countries.length > 1 && (
              <select
                className="inp" style={{ width: 110 }} value={facet.country}
                onChange={(e) => setFacet({ ...facet, country: e.target.value })}
              >
                <option value="">全部国家</option>
                {facetValues.countries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {facetValues.brands.length > 1 && (
              <select
                className="inp" style={{ width: 130 }} value={facet.brand}
                onChange={(e) => setFacet({ ...facet, brand: e.target.value })}
              >
                <option value="">全部品牌</option>
                {facetValues.brands.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            )}
            <span className="stat"><b>{shown.length}</b> / {items.length} 行</span>
            <div className="spacer" />
            {mine && checked.size > 0 && (
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
                  {mine && (
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
                  {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                  {!mine && <th style={{ width: 90 }}>上传人</th>}
                  <th style={{ width: 128 }}>更新时间</th>
                  {mine && <th style={{ width: 92 }} />}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 2000).map((it) => {
                  const editing = edit?.id === it.id;
                  const dead = !Number(it.stock) && !Number(it.transit);
                  return (
                    <tr key={it.id}>
                      {mine && (
                        <td>
                          <input
                            type="checkbox" checked={checked.has(it.id)}
                            onChange={() => setChecked((prev) => {
                              const n = new Set(prev);
                              if (n.has(it.id)) n.delete(it.id);
                              else n.add(it.id);
                              return n;
                            })}
                          />
                        </td>
                      )}
                      {cols.map((c) => (
                        <td key={c.key} className="mono">
                          {editing ? (
                            <input
                              className="inp cellinp" type={c.num ? 'number' : 'text'}
                              value={edit[c.key] ?? ''}
                              onChange={(e) => setEdit({ ...edit, [c.key]: e.target.value })}
                            />
                          ) : (
                            <>
                              {val(it, c.key) === '' ? '—' : val(it, c.key)}
                              {c.key === 'transit' && dead && (
                                <span className="tag amber" style={{ marginLeft: 6 }}>缺货</span>
                              )}
                            </>
                          )}
                        </td>
                      ))}
                      {!mine && (
                        <td style={{ color: 'var(--text-faint)' }}>{it.owner_name ?? '—'}</td>
                      )}
                      <td style={{ color: 'var(--text-faint)' }}>{it.updated_at ?? '—'}</td>
                      {mine && (
                        <td>
                          {editing ? (
                            <div className="row" style={{ gap: 5 }}>
                              <button className="btn sm primary" disabled={busy} onClick={saveEdit}>保存</button>
                              <button className="btn sm" onClick={() => setEdit(null)}>取消</button>
                            </div>
                          ) : (
                            <button
                              className="btn sm ghost"
                              onClick={() => setEdit({
                                id: it.id,
                                ...Object.fromEntries(cols.map((c) => [c.key, val(it, c.key)])),
                              })}
                            >编辑</button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
                {!shown.length && (
                  <tr>
                    <td colSpan={cols.length + 3} className="empty">
                      {items.length
                        ? '没有匹配的行'
                        : mine
                          ? `库还是空的 —— 下载模板填好再导入,或者直接从 Excel 复制粘贴到左边(当前站点 ${market})`
                          : '还没有人传过 SKU'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {shown.length > 2000 && (
              <p className="hint" style={{ padding: '8px 2px' }}>
                只显示前 2000 行,用上面的搜索和筛选缩小范围(导出的是筛选后的全部 {shown.length} 行)。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
