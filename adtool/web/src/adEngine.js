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
