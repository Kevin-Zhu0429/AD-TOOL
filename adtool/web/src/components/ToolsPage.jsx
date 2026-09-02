import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import Icon from './Icon.jsx';
import './ToolsPage.css';

const MAX_PREVIEW = 8;

function safeName(name) {
  return String(name || '表格').replace(/[\\/?*:[\]]/g, '_').slice(0, 31);
}

export default function ToolsPage() {
  const inputRef = useRef(null);
  const [books, setBooks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [withSource, setWithSource] = useState(true);

  const totalRows = useMemo(
    () => books.reduce((sum, book) => sum + book.sheets.reduce((n, sheet) => n + sheet.rows.length, 0), 0),
    [books],
  );
  const preview = useMemo(() => books.flatMap((book) => book.sheets.flatMap((sheet) =>
    sheet.rows.map((row) => ({ ...row, __file: book.name, __sheet: sheet.name })))).slice(0, MAX_PREVIEW), [books]);
  const columns = useMemo(() => {
    const found = [];
    const seen = new Set();
    books.forEach((book) => book.sheets.forEach((sheet) => sheet.headers.forEach((header) => {
      if (!seen.has(header)) { seen.add(header); found.push(header); }
    })));
    return found;
  }, [books]);

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const parsed = await Promise.all(files.map(async (file) => {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
        const sheets = workbook.SheetNames.map((name) => {
          const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
          const headers = rows.reduce((all, row) => {
            Object.keys(row).forEach((key) => { if (!all.includes(key)) all.push(key); });
            return all;
          }, []);
          return { name, rows, headers };
        }).filter((sheet) => sheet.rows.length);
        return { id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, sheets };
      }));
      const usable = parsed.filter((book) => book.sheets.length);
      if (!usable.length) throw new Error('没有读到可合并的数据,请确认表格第一行是表头。');
      setBooks((old) => [...old.filter((book) => !usable.some((next) => next.id === book.id)), ...usable]);
    } catch (e) {
      setError(`读取失败:${e.message || '请检查文件格式'}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  function download() {
    const rows = books.flatMap((book) => book.sheets.flatMap((sheet) => sheet.rows.map((row) => {
      const normalized = Object.fromEntries(columns.map((column) => [column, row[column] ?? '']));
      return withSource ? { 来源文件: book.name, 来源工作表: sheet.name, ...normalized } : normalized;
    })));
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = (withSource ? ['来源文件', '来源工作表', ...columns] : columns)
      .map((header) => ({ wch: Math.min(40, Math.max(12, String(header).length * 2 + 2)) }));
    const output = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(output, sheet, safeName('合并结果'));
    XLSX.writeFile(output, `Excel合并结果_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return (
    <div className="tools-page animate-in">
      <div className="page-head">
        <h1>小工具</h1>
        <p className="hint">日常工具都会收在这里,所有账号无需权限即可使用。</p>
      </div>

      <section className="tool-card">
        <div className="tool-title-row">
          <span className="tool-icon"><Icon name="layers" size={20} /></span>
          <div><h2>Excel 表格合并</h2><p className="hint">把多个工作簿里的所有非空工作表合并成一张表</p></div>
          <span className="tag green">本机处理</span>
        </div>

        <button className="tool-drop" disabled={busy} onClick={() => inputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
          <Icon name="upload" size={25} />
          <b>{busy ? '正在读取表格…' : '选择或拖入 Excel 文件'}</b>
          <span>支持 .xlsx、.xls 和 .csv,可一次选择多个文件</span>
        </button>
        <input ref={inputRef} hidden multiple type="file" accept=".xlsx,.xls,.csv" onChange={(e) => addFiles(e.target.files)} />
        {error && <div className="tool-error"><Icon name="alert" />{error}</div>}

        {!!books.length && <>
          <div className="tool-summary">
            <b>{books.length}</b> 个文件 · <b>{books.reduce((n, b) => n + b.sheets.length, 0)}</b> 张工作表 · <b>{totalRows}</b> 行数据
            <div className="spacer" />
            <label><input type="checkbox" checked={withSource} onChange={(e) => setWithSource(e.target.checked)} /> 保留来源文件和工作表</label>
            <button className="btn sm ghost" onClick={() => setBooks([])}>清空</button>
            <button className="btn primary" onClick={download}><Icon name="download" />下载合并结果</button>
          </div>
          <div className="tool-files">
            {books.map((book) => <div className="tool-file" key={book.id}>
              <Icon name="file" /><span>{book.name}</span><small>{book.sheets.length} 张表 · {book.sheets.reduce((n, s) => n + s.rows.length, 0)} 行</small>
              <button aria-label={`移除 ${book.name}`} onClick={() => setBooks((old) => old.filter((x) => x.id !== book.id))}><Icon name="x" /></button>
            </div>)}
          </div>
          <div className="tool-preview"><div className="tool-preview-title">数据预览 <span>前 {Math.min(MAX_PREVIEW, totalRows)} 行</span></div>
            <div className="table-scroll"><table><thead><tr>{withSource && <><th>来源文件</th><th>来源工作表</th></>}{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{preview.map((row, i) => <tr key={i}>{withSource && <><td>{row.__file}</td><td>{row.__sheet}</td></>}{columns.map((c) => <td key={c}>{String(row[c] ?? '')}</td>)}</tr>)}</tbody></table></div>
          </div>
        </>}
        <p className="tool-privacy"><Icon name="lock" />文件只在你的浏览器中读取和合并,不会上传到服务器。</p>
      </section>
    </div>
  );
}
