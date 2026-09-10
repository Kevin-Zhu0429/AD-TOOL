import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { api } from '../api.js';
import { parseAbaReport } from '../../../shared/aba.js';
import { parseAsinUpload } from '../../../shared/abaAsin.js';
import * as XLSX from 'xlsx';

const number = new Intl.NumberFormat('zh-CN');
export default function AbaReportUpload({ market, kind = 'brand', onSaved }) {
  const [pending, setPending] = useState([]);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false), mounted = useRef(true), input = useRef(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isAsin = kind === 'asin', label = isAsin ? 'ASIN' : '品牌';
  async function choose(fileList) {
    if (busy.current) return;
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setError(''); setNotice('');
    if (files.length > 10) return setError('每次最多上传 10 份报告文件。');
    if (files.reduce((sum, f) => sum + f.size, 0) > 30 * 1024 * 1024) return setError('每批文件合计不能超过 30 MB。');
    busy.current = true; setReading(true);
    const next = [];
    for (const file of files) {
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('单份 CSV 不能超过 10 MB');
        const buffer = await file.arrayBuffer();
        if (isAsin && /\.xlsx$/i.test(file.name)) {
          const workbook = XLSX.read(buffer, { type: 'array', sheetRows: 100002 });
          const sheets = workbook.SheetNames.map((name) => {
            const sheet = workbook.Sheets[name];
            const range = sheet['!fullref'] || sheet['!ref'];
            if (range && XLSX.utils.decode_range(range).e.r > 100000) throw new Error('合并表最多支持 100,000 条搜索词记录');
            return { rows: XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: true }) };
          });
          const reports = parseAsinUpload({ name: file.name, sheets }, market);
          next.push({ name: file.name, sheets, reports });
          continue;
        }
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { text = new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
        const report = isAsin ? parseAsinUpload({ text, name: file.name }, market)[0] : parseAbaReport(text, file.name, market);
        if (next.some((f) => f.report?.[kind] === report[kind] && f.report?.week_end === report.week_end)) throw new Error(`本批次包含同 ${label} 同一周的重复报告，请只保留一份`);
        next.push({ name: file.name, text, report, reports: [report] });
      } catch (err) { next.push({ name: file.name, error: err.message }); }
    }
    if (mounted.current) { setPending(next); setReading(false); }
    busy.current = false;
  }
  async function save() {
    if (busy.current || !pending.length || pending.some((f) => f.error)) return;
    busy.current = true; setUploading(true); setError(''); setNotice('');
    try {
      const result = await (isAsin ? api.importAbaAsin : api.importAba)(market, pending.map(({ name, text, sheets }) => ({ name, text, ...(sheets ? { sheets } : {}) })));
      if (!mounted.current) return;
      const labels = { added: '已保存', updated: '已更新', unchanged: '已存在，无需重复保存' };
      setNotice(result.reports.map((r) => `${r[kind]} ${r.week_end}：${labels[r.status]} ${number.format(r.count)} 条`).join('；'));
      setPending([]); onSaved(result);
    } catch (err) {
      if (mounted.current) setError(`${err.message}。文件仍保留，可重试；相同报告重试不会重复累计。`);
    } finally { busy.current = false; if (mounted.current) setUploading(false); }
  }
  return <section className={`aba-upload${dragging ? ' dragging' : ''}`} aria-label={`上传${label}报告`}
    onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
    onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files); }}>
    <div className="aba-upload-top"><div><strong>上传{label}视图周报</strong>
      <p className="hint">{isAsin ? '支持原始 CSV 周报和合并 XLSX 表。' : '拖入原始 CSV，或选择文件。'}每次最多 10 份，单份 10 MB，合计 30 MB。</p>
      <p className="hint">{isAsin ? `原始 CSV 读取 A1、C1；合并 XLSX 按每行 AI 列 ASIN、AJ 列周数和日期拆分。文件应属于 ${market} 站，同 ASIN 同周重传替换该周明细。` : `同品牌同一周再次上传会更新该周，其他周保留。品牌和周数自动读取，文件须属于 ${market} 站。`}</p>
    </div><button className="btn" disabled={reading || uploading} onClick={() => input.current?.click()}><Icon name="upload" />{reading ? '正在读取…' : isAsin ? '选择 CSV / XLSX' : '选择 CSV'}</button>
      <input ref={input} type="file" accept={isAsin ? '.csv,.xlsx' : '.csv'} multiple hidden aria-label={`选择${label}视图 CSV${isAsin ? ' / XLSX' : ''}`} onChange={(e) => { choose(e.target.files); e.target.value = ''; }} />
    </div>
    {!!pending.length && <div className="aba-file-list">{pending.map((file, i) => <div className="aba-file" key={`${file.name}:${i}`}><div><strong>{file.name}</strong>
      {file.error ? <p className="aba-error-text">{file.error}</p> : <><p className="hint">{file.reports.length} 份周报 · {number.format(file.reports.reduce((sum, r) => sum + r.rows.length, 0))} 条记录</p><details open={file.reports.length === 1}><summary>查看 ASIN / 品牌和报告周</summary>{file.reports.map((report) => <p className="hint" key={`${report[kind]}:${report.week_end}`}>{report[kind]} · {report.week_end.slice(0, 4)} · 第 {report.week_number} 周 · {report.week_start} — {report.week_end} · {number.format(report.rows.length)} 条{!report.rows.length ? '（空周报）' : ''}</p>)}</details></>}
    </div><button className="btn ghost" disabled={uploading || reading} aria-label={`移除 ${file.name}`} onClick={() => setPending((p) => p.filter((_, n) => n !== i))}>移除</button></div>)}
      <button className="btn primary aba-save" disabled={uploading || reading || pending.some((f) => f.error)} onClick={save} aria-busy={uploading}>{uploading ? '正在保存…' : '上传并保存'}</button>
    </div>}
    <div className="aba-feedback" aria-live="polite">{error ? <span className="aba-error-text" role="alert">{error}</span> : notice || (reading ? '正在读取并校验文件…' : '')}</div>
  </section>;
}
