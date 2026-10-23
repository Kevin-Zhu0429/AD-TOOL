import { asinFixture } from './abaAsinFixture.js';
import { publicFixture, publicTask } from './abaPublicFixture.js';
import { savePublicReports } from '../src/services/publicAsinData.js';
export const ownIds = ['B000006501', 'B0BZJ2F2SK', 'B000006503'];
export const ownPrinterQuery = 'hp deskjet 3700 printer ink cartridges';
export const ownCoreQuery = 'hp 65 ink';
export const ownWeeks = [
  { week: 39, start: '2026-09-20', end: '2026-09-26' }, { week: 40, start: '2026-09-27', end: '2026-10-03' },
  { week: 41, start: '2026-10-04', end: '2026-10-10' }, { week: 42, start: '2026-10-11', end: '2026-10-17' },
];
const markets = [[4400,100,30], [4500,110,36], [5051,117,36], [4089,96,35]];
const report = (asin, index, counts) => ({ asin, ...ownWeeks[index], rows: [ownPrinterQuery, ownCoreQuery]
  .map((query) => [query, 100, ...markets[index], ...counts]) });
export const ownReports = ownWeeks.map((_, i) => report(ownIds[0], i, [100*(i+1),10*(i+1),2*(i+1)]));
ownReports.push(report(ownIds[1],3,[12,1,0]), report(ownIds[2],0,[20,2,1]), report(ownIds[2],1,[0,0,0]));
export const ownFiles = ownReports.map((r) => ({ name: `${r.asin}-${r.week}.csv`, text: asinFixture(r) }));
export const ownSkus = ownIds.map((asin, i) => ({ country: 'ES', asin, brand: ['CE','PG','CC'][i], model: '65',
  sku: ['FOUR-WEEKS-65','h65xlcpg','ZERO-WEEK-65'][i], setGroup: 'C' }));
export function seedOwnWeeks(db) {
  db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)')
    .run('D','EU','HP','65','DESKJET','3700','own-weeks-65');
  for (const r of ownReports) {
    const task = { ...publicTask, brand: ownSkus.find((s) => s.asin === r.asin).brand,
      week_start: r.start, week_end: r.end, asins_json: JSON.stringify([r.asin]) };
    const payload = publicFixture(task), template = payload.dataByAsin[0];
    payload.dataByAsin = r.rows.map((v) => ({ ...structuredClone(template),
      searchQueryData: { searchQuery: v[0], searchQueryVolume: v[1] },
      impressionData: { totalQueryImpressionCount: v[2], asinImpressionCount: v[5] },
      clickData: { totalClickCount: v[3], asinClickCount: v[6] }, purchaseData: { totalPurchaseCount: v[4], asinPurchaseCount: v[7] } }));
    savePublicReports(db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
  }
}
