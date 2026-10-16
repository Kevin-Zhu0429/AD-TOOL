import * as XLSX from 'xlsx';
import * as core from '../../shared/sbEngine.js';
export * from '../../shared/sbEngine.js';
export const parseSbAssets = (buffer) => core.parseSbAssets(buffer, XLSX);
