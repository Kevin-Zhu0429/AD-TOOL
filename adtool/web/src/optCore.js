import * as XLSX from 'xlsx';
import * as core from '../../shared/optCore.js';
export * from '../../shared/optCore.js';
export const parse = (buffer) => core.parse(buffer, XLSX);
export const parseSearchTermReport = (buffer, model) => core.parseSearchTermReport(buffer, model, XLSX);
export const isBulkSheet = (sheet) => core.isBulkSheet(sheet, XLSX);
export const nonBulkSheets = (workbook) => core.nonBulkSheets(workbook, XLSX);
