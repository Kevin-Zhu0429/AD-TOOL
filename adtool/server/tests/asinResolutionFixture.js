import { asinFixture } from './abaAsinFixture.js';
import { publicFixture, publicTask } from './abaPublicFixture.js';
import { savePublicReports } from '../src/services/publicAsinData.js';

export const resolutionAsins = ['B000002601', 'B000002602', 'B000002603', 'B000002604', 'B000002605'];
export const resolutionQuery = 'cartouche hp 2620';
export const resolutionReports = resolutionAsins.map((asin, index) => ({ asin, week: 38, start: '2026-09-13', end: '2026-09-19',
  rows: [[resolutionQuery, 100, 1000, 100, 20, 100, [10, 20, 3, 5, 7][index], [2, 4, 0, 1, 1][index]]] }));
resolutionReports.push({ asin: resolutionAsins[0], week: 39, start: '2026-09-20', end: '2026-09-26',
  rows: [[resolutionQuery, 300, 3000, 300, 60, 300, 30, 6]] });
export const resolutionFiles = resolutionReports.map((report) => ({ name: `${report.asin}-${report.week}.csv`, text: asinFixture(report) }));
export const resolutionSkus = [
  { country: 'ES', brand: 'CE', asin: resolutionAsins[0], sku: 'SOURCE-301', model: '301', setGroup: 'BK' },
  { country: 'ES', brand: 'CE', asin: resolutionAsins[1], sku: 'SOURCE-304', model: '304', setGroup: 'BK' },
  { country: 'ES', brand: 'CE', asin: resolutionAsins[3], sku: 'SOURCE-305', model: '305', setGroup: 'BK' },
  { country: 'ES', brand: 'CE', asin: resolutionAsins[4], sku: 'SOURCE-MIX-301', model: '301', setGroup: 'BK' },
  { country: 'ES', brand: 'CE', asin: resolutionAsins[4], sku: 'SOURCE-MIX-304', model: '304', setGroup: 'C' },
];
export function seedResolutionReport(db, report, brand = 'CE') {
  const task = { ...publicTask, brand, week_start: report.start, week_end: report.end, asins_json: JSON.stringify([report.asin]) };
  const payload = publicFixture(task);
  const template = payload.dataByAsin[0];
  payload.dataByAsin = report.rows.map((r) => ({ ...structuredClone(template),
    searchQueryData: { searchQuery: r[0], searchQueryVolume: r[1] },
    impressionData: { totalQueryImpressionCount: r[2], asinImpressionCount: r[5] },
    clickData: { totalClickCount: r[3], asinClickCount: r[6] }, purchaseData: { totalPurchaseCount: r[4], asinPurchaseCount: r[7] },
  }));
  savePublicReports(db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
}
export function seedResolution(db) {
  const insert = db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)');
  insert.run('D', 'EU', 'HP', '301', 'Officejet', '2620', 'resolution-officejet');
  insert.run('D', 'EU', 'HP', '304', 'Deskjet', '2620', 'resolution-deskjet');
  resolutionReports.forEach((report) => seedResolutionReport(db, report));
}
