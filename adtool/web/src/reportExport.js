import * as XLSX from 'xlsx';

export function downloadReportRows(columns, items, name) {
  const rows = items.map((item) => columns.map((column) => {
    const value = item[column.key];
    if (value == null || value === '') return '';
    return column.rate || column.kind === 'rate' ? value / 100 : value;
  }));
  const sheet = XLSX.utils.aoa_to_sheet([columns.map((c) => c.label), ...rows]);
  columns.forEach((column, c) => {
    if (!column.rate && column.kind !== 'rate') return;
    rows.forEach((_, i) => { const cell = sheet[XLSX.utils.encode_cell({ r: i + 1, c })]; if (cell) cell.z = '0.00%'; });
  });
  sheet['!cols'] = columns.map((c) => ({ wch: ['query', 'linked_skus', 'period'].includes(c.key) ? 40 : 18 }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '搜索词明细');
  XLSX.writeFile(book, `${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
