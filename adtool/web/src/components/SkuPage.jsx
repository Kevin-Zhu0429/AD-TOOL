import { isPet } from '../profile.js';
import { PET_SKU_FIELDS } from '../../../shared/profile.js';
import { useConfirm } from './AppDialog.jsx';
import { AbaPagination } from './AbaTable.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { isOutOfStock, isZeroStock } from '../skuMatch.js';
import './LibraryPage.css';
import './SkuPage.css';

/* 列名兜底:Excel 表头和列标题对不上时,再按这些关键词猜一次 */
const ALIAS = {
  style: /款式|style/i, size: /尺码|size/i, color: /^颜色$|^colou?r$/i, fabric: /面料|外观|fabric|material/i,
  country: /国家|站点|market|country/i,
  brand: /品牌|brand/i,
  model: /型号|机型|model/i,
  setGroup: /套组|套装|组合|颜色|set|pack/i,
  sku: /^sku$|卖家sku|商品sku|seller ?sku/i,
  stock: /在库|可售|库存|on ?hand|stock/i,
  transit: /在途|补货|transit|inbound/i,
  asin: /^asin$|子asin|商品asin/i,
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
  const [confirmAction, confirmation] = useConfirm();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('mine');
  const [draft, setDraft] = useState('');
  const [replace, setReplace] = useState(false);
  const [filter, setFilter] = useState('');
  const [facet, setFacet] = useState({ country: '', brand: '', style: '', size: '', color: '', fabric: '' });
  const [checked, setChecked] = useState(() => new Set());
  const [edit, setEdit] = useState(null);          // 正在编辑的那一行:{id, ...列}
  const [captain, setCaptain] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const filterRef = useRef(null);

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
  async function loadCaptain() {
    try {
      setCaptain(await api.captainStatus());
    } catch (e) {
      setCaptain({ configured: false, bindings: [], error: e.message });
    }
  }
  useEffect(() => { load('mine'); loadCaptain(); }, []);

  const cols = useMemo(() => data?.cols ?? [], [data]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const zeroStockItems = useMemo(() => items.filter(isZeroStock), [items]);

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
      if (isPet && ['style', 'size', 'color', 'fabric'].some((key) => facet[key] && it[key] !== facet[key])) return false;
      if (!f) return true;
      return cols.some((c) => String(it[c.key] ?? '').toLowerCase().includes(f));
    });
  }, [items, filter, facet, cols]);

  useEffect(() => setPage(1), [items, filter, facet]);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(shown.length / pageSize)));
  const pageRows = shown.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const mine = scope !== 'all';

  async function act(fn, okMsg) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      await load();
      window.dispatchEvent(new CustomEvent('adtool:sku-inventory-updated'));
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

  async function addDraft() {
    if (!draft.trim()) return;
    const rep = replace;
    if (rep && !await confirmAction('整表替换将清空本次站点中的 SKU（宠物版为店铺共享库），再写入粘贴内容。此操作无法撤销。', '确认替换')) return;
    act(() => api.addSkuText(draft, rep), (r) => {
      if (!r.errorCount) { setDraft(''); setReplace(false); }
      return resultText(r);
    });
  }

  async function removeChecked() {
    const ids = [...checked];
    if (!ids.length) return;
    if (!await confirmAction(`确定删除选中的 ${ids.length} 行？此操作无法撤销。`, '删除 SKU')) return;
    act(() => api.deleteSkus(ids), (r) => `已删除 ${r.deleted} 行`);
  }

  function saveEdit() {
    if (busy) return;
    const body = {};
    for (const c of cols) body[c.key] = String(edit[c.key] ?? '');
    const id = edit.id;
    act(async () => {
      const result = await api.updateSku(id, body);
      setEdit(null);
      return result;
    }, '已保存');
  }

  async function syncCaptain() {
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const result = await api.syncCaptainInventory();
      await Promise.all([load(scope), loadCaptain()]);
      window.dispatchEvent(new CustomEvent('adtool:sku-inventory-updated'));
      const text = `已更新 ${result.updated} 行，读取 ${result.fetched} 个库存 SKU` +
        (result.unmatched ? `，${result.unmatched} 个 SKU 在网站库里未匹配` : '') +
        (result.failed ? `，${result.failed} 家店铺失败` : '');
      setSyncMsg({ kind: result.failed ? 'warn' : 'ok', text });
    } catch (e) {
      setSyncMsg({ kind: 'err', text: e.message });
    } finally {
      setSyncBusy(false);
    }
  }

  function downloadTemplate() {
    const rows = [
      cols.map((c) => c.label),
      ...(isPet ? [['PET-RAIN-YELLOW-L', '雨衣 A 款', 'L', '黄色', '防水涂层 / 纯色', 120, 80, '示例品牌', 'B000000001'], ['PET-RAIN-YELLOW-XL', '雨衣 A 款', 'XL', '黄色', '防水涂层 / 纯色', 0, 60, '示例品牌', 'B000000002']] : [
      ['ES', 'HP', '301', 'BKC', 'CY-ES-HP301XL-BKCL', 120, 300, ''],
      ['ES', 'HP', '302', '2BK', 'CY-ES-HP302XL-2BK', 0, 500, ''],
      ['DE', 'Canon', 'PG-545', 'BK', 'CY-DE-CA545XL-BK', 80, '', '']]),
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
          if (c.key === 'asin' && (at === undefined || at >= r.length)) return;
          row[c.key] = at === undefined ? '' : r[at] ?? '';
        });
        if (isPet && idx) {
          const countryAt = (sheet[0] ?? []).findIndex((h) => /^(国家|站点|country|marketplace)$/i.test(String(h).trim()));
          if (countryAt >= 0 && r[countryAt] && !/^(US|美国|美国站)$/i.test(String(r[countryAt]).trim())) throw new Error('宠物版仅支持美国站 US');
        }
        if (cols.some((c) => String(row[c.key] ?? '').trim())) rows.push(row);
      }
      if (!rows.length) return setMsg({ kind: 'err', text: '这份文件里没读到数据行' });

      if (isPet) rows.forEach((row) => { row.country = 'US'; });
      const countries = [...new Set(rows.map((r) => String(r.country ?? '').trim().toUpperCase()))]
        .filter(Boolean);
      if (asReplace && !await confirmAction(
        `整表替换:当前库里 ${countries.join(' / ')} 的 SKU 会先清空,再写入文件里的 ${rows.length} 行。` +
        '别的国家和别人的库不受影响。继续?'
      )) return;

      act(() => api.addSkuRows(rows, asReplace), resultText);
    } catch (e) {
      setMsg({ kind: 'err', text: '读取失败:' + e.message });
    }
  }

  if (error) return <div className="lib"><div className="note err" role="alert">{error} <button className="btn" onClick={() => load()}>重新加载</button></div></div>;
  if (!data) return <div className="lib"><div className="empty">加载中…</div></div>;

  return (
    <div className="lib">
      {confirmation}
      <div className="lib-head">
        <div>
          <h1>我的 SKU 库</h1>
          <p className="hint">
            {isPet ? '美国站 SKU 库。按款式、尺码、颜色和面料外观筛选，开广告时一键选择。所有账号共享并可维护这份 SKU 库，填写 ASIN 后关联共享 ABA 报告。' : '每个账号一份自己的库，开广告时按站点和型号挑选。填写 ASIN 后，ABA ASIN 视图会关联该 SKU 的型号、品牌和套组。'}
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
            <div className="card captain-sync-card">
              <div className="card-title">船长库存</div>
              <p className="hint">
                {isPet ? '同步已绑定美国店铺的库存，只更新已有 SKU 的在库、在途库存，保留人工填写的宠物属性。' : '欧洲库存按品牌合并；这里只更新分配给你的国家，其他国家由各自负责人同步。'}
              </p>
              {captain?.bindings?.length ? (
                <div className="captain-binding-list">
                  {captain.bindings.map((binding) => (
                    <div key={binding.id}>
                      <span>{binding.brand} · {binding.country}</span>
                      <b className={`tag ${binding.enabled ? 'green' : 'gray'}`}>
                        {binding.enabled ? '已绑定' : '已停用'}
                      </b>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint captain-sync-empty">
                  {captain?.configured ? '还没有绑定店铺，请联系超级管理员。' : '服务器尚未配置船长 API。'}
                </p>
              )}
              <button
                className="btn primary captain-sync-button"
                disabled={syncBusy || !captain?.configured || !captain?.bindings?.some((binding) => binding.enabled)}
                onClick={syncCaptain}
              >
                {syncBusy ? '正在同步…' : '同步船长库存'}
              </button>
              {syncMsg && <div className={`note ${syncMsg.kind}`} role={syncMsg.kind === 'err' ? 'alert' : 'status'}>{syncMsg.text}</div>}
            </div>
          )}
          {mine && (
          <div className="card">
            <div className="card-title">批量添加</div>
            <textarea
              className="inp resize-none" rows={8} value={draft}
              aria-label="批量添加 SKU"
              placeholder={isPet ? `从 Excel 复制粘贴，一行一个 SKU\n列顺序：${cols.map((c) => c.label).join(' → ')}\n\nPET-RAIN-L\t雨衣 A 款\tL\t黄色\t纯色\t120\t80` : `从 Excel 直接复制粘贴,一行一个 SKU\n列的顺序:${cols.map((c) => c.label).join(' → ')}\n\nES\tHP\t301\tBKC\tCY-ES-HP301XL-BKCL\t120\t300`}
              onChange={(e) => setDraft(e.target.value)}
            />
            <label className="row" style={{ marginTop: 9 }}>
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              <span className="hint">{isPet ? '先清空店铺共享的美国站 SKU 再写入' : '先清空这批数据里出现的国家再写(月度整表更新用)'}</span>
            </label>
            <div className="row" style={{ marginTop: 9 }}>
              <span className="hint">{draft.split('\n').filter((s) => s.trim()).length} 行待添加</span>
              <div className="spacer" />
              <button className="btn primary" disabled={busy || !draft.trim()} onClick={addDraft}>
                写入我的库
              </button>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              列之间用 Tab 分隔;
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
          {isPet && <div className="pet-filters">{PET_SKU_FIELDS.filter((c) => ['style', 'size', 'color', 'fabric'].includes(c.key)).map((c) => <label key={c.key}>{c.label}<select className="inp" aria-label={c.label} value={facet[c.key]} onChange={(e) => setFacet({ ...facet, [c.key]: e.target.value })}><option value="">全部{c.label}</option>{[...new Set(items.map((it) => it[c.key]).filter(Boolean))].sort().map((v) => <option key={v}>{v}</option>)}</select></label>)}</div>}
          <div className="row wrap" style={{ marginBottom: 11 }}>
            <div className="sku-search">
              <input
                ref={filterRef}
                className="inp" placeholder="搜索(所有列)…"
                value={filter} onChange={(e) => setFilter(e.target.value)}
              />
              {filter && (
                <button
                  className="btn ghost icon sku-search-clear"
                  aria-label="清空 SKU 搜索"
                  onClick={() => { setFilter(''); filterRef.current?.focus(); }}
                >×</button>
              )}
            </div>
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

            {msg && <div id="sku-feedback" className={`note ${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'} style={{ marginBottom: 11 }}>{msg.text}</div>}
            {zeroStockItems.length > 0 && (
              <div className="note err sku-zero-summary" role="status">
                <b>{zeroStockItems.length} 个 SKU 在库为 0</b>
                <span>
                  {mine
                    ? '这些 SKU 会同步到广告优化的 SKU 矩阵并高亮；有在途库存也会继续提醒。'
                    : '这是全部账号的只读汇总；各账号会在自己的广告优化 SKU 矩阵中收到提醒。'}
                </span>
              </div>
            )}

          <div className="scroll">
            <table className="tbl">
              <thead>
                <tr>
                  {mine && (
                    <th style={{ width: 30 }}>
                      <input
                        type="checkbox"
                        checked={shown.length > 0 && pageRows.every((t) => checked.has(t.id))}
                        onChange={(e) =>
                          setChecked(e.target.checked ? new Set(pageRows.map((t) => t.id)) : new Set())
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
                {pageRows.map((it) => {
                  const editing = edit?.id === it.id;
                  const zeroStock = isZeroStock(it);
                  const outOfStock = isOutOfStock(it);
                  return (
                    <tr key={it.id} className={zeroStock ? 'sku-zero-row' : undefined}>
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
                              aria-label={`${c.label} ${it.sku}`}
                              aria-invalid={c.key === 'asin' && !!edit.asin && !/^[A-Z0-9]{10}$/i.test(edit.asin.trim())}
                              aria-describedby={msg?.kind === 'err' ? 'sku-feedback' : undefined}
                              value={edit[c.key] ?? ''}
                              onChange={(e) => setEdit({ ...edit, [c.key]: e.target.value })}
                            />
                          ) : (
                            <>
                              {val(it, c.key) === '' ? '—' : val(it, c.key)}
                              {c.key === 'stock' && zeroStock && (
                                <span className="tag red sku-zero-tag">
                                  {outOfStock ? '已断货' : '在库 0'}
                                </span>
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
          </div>
          <AbaPagination data={{ total: shown.length, page: currentPage, pageSize, pageCount: Math.max(1, Math.ceil(shown.length / pageSize)) }} onChange={(patch) => { if (patch.pageSize) setPageSize(patch.pageSize); setPage(patch.page ?? 1); }} />
        </div>
      </div>
    </div>
  );
}
