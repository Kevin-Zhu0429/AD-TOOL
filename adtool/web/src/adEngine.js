import * as XLSX from 'xlsx';
import { SHEET } from '../../shared/adEngine.js';
export * from '../../shared/adEngine.js';

const COL_WIDTHS = [10, 12, 8, 34, 34, 18, 12, 12, 14, 34, 34, 12, 12, 10, 9, 10, 24, 14, 8, 30, 14, 12, 12, 20, 24, 8, 18];

export function downloadWorkbook(aoa, filename) {
  const ns = XLSX.utils.aoa_to_sheet(aoa);
  ns['!cols'] = COL_WIDTHS.map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ns, SHEET);
  XLSX.writeFile(wb, filename, { bookType: 'xlsx' });
}

/**
 * 一个文件里放多页:[{ name, aoa, widths? }]。
 * 「开设广告」页 SP(商品推广活动)和 SB(品牌推广多个广告组广告活动)各一页,一次上传后台。
 */
export function downloadSheets(sheets, filename) {
  const wb = XLSX.utils.book_new();
  for (const { name, aoa, widths } of sheets) {
    const ns = XLSX.utils.aoa_to_sheet(aoa);
    ns['!cols'] = (widths ?? COL_WIDTHS).map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, ns, name);
  }
  XLSX.writeFile(wb, filename, { bookType: 'xlsx' });
}
