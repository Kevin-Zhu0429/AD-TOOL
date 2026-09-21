import { isPet } from '../profile.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { isMixedPortfolio, portfolioSeriesKey } from '../portfolioMatch.js';
import './LibraryPage.css';
import './SkuPage.css';
import './PortfolioPage.css';

const COLS = [
  { key: 'portfolioId', label: '广告组合编号', width: 22 },
  { key: 'name', label: '广告组合名称', width: 30 },
];

function mapRows(sheet) {
  if (!sheet.length) return [];
  const head = sheet[0].map((value) => String(value ?? '').trim());
  const idAt = head.findIndex((value) => /广告组合编号|portfolio\s*id/i.test(value));
  const nameAt = head.findIndex((value) => /广告组合名称|portfolio\s*name/i.test(value));
  const hasHeader = idAt >= 0 || nameAt >= 0;
  return (hasHeader ? sheet.slice(1) : sheet)
    .map((row) => ({
      portfolioId: String(row[idAt >= 0 ? idAt : 0] ?? '').trim(),
      name: String(row[nameAt >= 0 ? nameAt : 1] ?? '').trim(),
    }))
    .filter((row) => row.portfolioId || row.name);
}

function parsePasted(text) {
  const rows = String(text ?? '').replace(/\r/g, '\n').split('\n').map((line) => {
    const parts = line.includes('\t') ? line.split('\t') : line.split(/\s*[|~]\s*/);
    return { portfolioId: String(parts[0] ?? '').trim(), name: String(parts.slice(1).join(' ') ?? '').trim() };
  }).filter((row) => row.portfolioId || row.name);
  return rows[0] && /广告组合编号|portfolio\s*id/i.test(rows[0].portfolioId) ? rows.slice(1) : rows;
}

export default function PortfolioPage({ market }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [replace, setReplace] = useState(false);
  const [pendingRows, setPendingRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [deleteItem, setDeleteItem] = useState(null);
  const searchRef = useRef(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await api.portfolios(market)); }
    catch (loadError) { setError(loadError.message); setData(null); }
  }, [market]);

  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => `${item.portfolioId} ${item.name}`.toLowerCase().includes(query));
  }, [items, filter]);

  async function act(action, success) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      await load();
      setMessage({ kind: 'ok', text: typeof success === 'function' ? success(result) : success });
      return true;
    } catch (actionError) {
      setMessage({ kind: 'err', text: actionError.message });
      return false;
    } finally { setBusy(false); }
  }

  function queueRows(rows) {
    if (busy) return;
    if (!rows.length) return setMessage({ kind: 'err', text: '没有读到广告组合数据' });
    if (replace) setPendingRows(rows);
    else saveRows(rows, false);
  }

  function saveRows(rows, asReplace) {
    act(() => api.addPortfolioRows(market, rows, asReplace), (result) => {
      setDraft('');
      setReplace(false);
      setPendingRows(null);
      return [result.removed ? `清掉旧的 ${result.removed} 行` : '', result.added ? `新增 ${result.added} 行` : '', result.updated ? `更新 ${result.updated} 行` : '']
        .filter(Boolean).join(' · ') || '数据没有变化';
    });
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
      queueRows(mapRows(sheet));
    } catch (readError) { setMessage({ kind: 'err', text: `读取失败：${readError.message}` }); }
  }

  function exportXlsx() {
    const rows = [COLS.map((column) => column.label), ...shown.map((item) => [item.portfolioId, item.name])];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = COLS.map((column) => ({ wch: column.width }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, '广告组合库');
    XLSX.writeFile(workbook, `广告组合库_${market}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  if (error) return <div className="lib"><div className="note err" role="alert">{error}<button className="btn sm" onClick={load}>重新加载</button></div></div>;
  if (!data) return <div className="lib"><div className="empty">加载中…</div></div>;

  return (
    <div className="lib portfolio-page">
      <div className="lib-head">
        <div>
          <h1>广告组合库</h1>
          <p className="hint">{isPet ? '美国站广告组合库。开广告时手动选择组合，每个账号只使用自己的组合库。' : `${market} 站独立保存，自动和手动广告会按投放 SKU 的型号选择对应 Series；多个系列选择“混投”。每个账号只使用自己的组合库。`}</p>
        </div>
        <div className="spacer" />
        <button className="btn" onClick={exportXlsx}>导出 Excel</button>
        <label className="btn portfolio-file">
          导入 Excel
          <input type="file" accept=".xlsx,.xls,.csv" disabled={busy} onChange={(event) => { importFile(event.target.files[0]); event.target.value = ''; }} />
        </label>
      </div>

      <div className="lib-body">
        <div className="stack">
          <div className="card">
            <div className="card-title">批量添加</div>
            <textarea
              className="inp portfolio-paste resize-none" rows={8} value={draft}
              placeholder={isPet ? '从 Excel 直接复制两列到这里\n广告组合编号 → 广告组合名称\n\n101848370296114\t美国站宠物雨衣' : '从 Excel 直接复制两列到这里\n广告组合编号 → 广告组合名称\n\n101848370296114\tSP-CY 540 Series'}
              onChange={(event) => setDraft(event.target.value)}
            />
            <label className="row portfolio-replace">
              <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
              <span className="hint">整表替换当前 {market} 站组合库</span>
            </label>
            <div className="row">
              <span className="hint">{parsePasted(draft).length} 行待写入</span>
              <div className="spacer" />
              <button className="btn primary" disabled={busy || !draft.trim()} onClick={() => queueRows(parsePasted(draft))}>写入组合库</button>
            </div>
          </div>
          {!isPet && <div className="card">
            <div className="card-title">自动识别口径</div>
            <div className="libmeta">
              <div><span>单系列</span><b>SKU 型号 540 / 540XL → 名称含 540 Series</b></div>
              <div><span>多系列</span><b>投放 SKU 出现两个及以上型号 → 名称含“混投”</b></div>
              <div><span>未匹配</span><b>明确提示缺少的 SKU、型号或组合，不自动猜测</b></div>
            </div>
          </div>}
        </div>

        <div className="card lib-main">
          <div className="row wrap portfolio-toolbar">
            <label className="portfolio-search"><span className="sr-only">搜索广告组合</span><input ref={searchRef} className="inp" placeholder="搜索名称或编号…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
            {filter && <button className="btn sm" onClick={() => { setFilter(''); searchRef.current?.focus(); }}>清除搜索</button>}
            <span className="stat"><b>{shown.length}</b> / {items.length} 行</span>
          </div>
          {message && <div id="portfolio-feedback" className={`note ${message.kind}`} role={message.kind === 'err' ? 'alert' : 'status'}>{message.text}</div>}
          {pendingRows && (
            <div className="note warn portfolio-confirm" role="alert">
              <span>整表替换会删除当前 {market} 站已有的 {items.length} 行，再写入 {pendingRows.length} 行。此操作无法撤销。</span>
              <div className="spacer" />
              <button className="btn sm" onClick={() => setPendingRows(null)}>取消</button>
              <button className="btn danger sm" disabled={busy} onClick={() => saveRows(pendingRows, true)}>确认替换</button>
            </div>
          )}
          <div className="scroll portfolio-table-scroll">
            <table className="tbl">
              <thead><tr><th>广告组合编号</th><th>广告组合名称</th><th>{isPet ? '选择方式' : '自动分类'}</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {shown.map((item) => {
                  const editing = edit?.id === item.id;
                  const series = portfolioSeriesKey(item.name);
                  const category = isPet ? '手动选择' : isMixedPortfolio(item.name) ? '混投' : series ? `${series} Series` : '不参与自动匹配';
                  return (
                    <tr key={item.id}>
                      <td className="mono">{editing ? <input className="inp cellinp" aria-label={`广告组合编号 ${item.name}`} aria-invalid={!/^\d{1,30}$/.test(edit.portfolioId.trim())} aria-describedby={message ? 'portfolio-feedback' : undefined} value={edit.portfolioId} onChange={(event) => setEdit({ ...edit, portfolioId: event.target.value })} /> : item.portfolioId}</td>
                      <td>{editing ? <input className="inp cellinp" aria-label={`广告组合名称 ${item.portfolioId}`} aria-invalid={!edit.name.trim()} aria-describedby={message ? 'portfolio-feedback' : undefined} value={edit.name} onChange={(event) => setEdit({ ...edit, name: event.target.value })} /> : item.name}</td>
                      <td><span className={`tag ${category === '不参与自动匹配' ? 'gray' : 'blue'}`}>{category}</span></td>
                      <td>
                        {deleteItem?.id === item.id ? (
                          <div className="row portfolio-row-actions"><span className="hint">删除后无法恢复</span><button className="btn sm" onClick={() => setDeleteItem(null)}>取消</button><button className="btn danger sm" disabled={busy} onClick={async () => { if (await act(() => api.deletePortfolios([item.id]), '已删除 1 行')) setDeleteItem(null); }}>确认删除</button></div>
                        ) : editing ? (
                          <div className="row portfolio-row-actions"><button className="btn primary sm" disabled={busy || !/^\d{1,30}$/.test(edit.portfolioId.trim()) || !edit.name.trim()} onClick={async () => { if (await act(() => api.updatePortfolio(item.id, { portfolioId: edit.portfolioId, name: edit.name }), '已保存')) setEdit(null); }}>保存</button><button className="btn sm" onClick={() => setEdit(null)}>取消</button></div>
                        ) : (
                          <div className="row portfolio-row-actions"><button className="btn ghost sm" onClick={() => setEdit({ id: item.id, portfolioId: item.portfolioId, name: item.name })}>编辑</button><button className="btn danger ghost sm" onClick={() => setDeleteItem(item)}>删除</button></div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!shown.length && <tr><td colSpan={4} className="empty">{items.length ? '没有匹配的广告组合' : '组合库还是空的——导入你上传的两列表格，或从 Excel 复制到左侧。'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
