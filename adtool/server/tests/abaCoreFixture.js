import { asinFixture } from './abaAsinFixture.js';
import { publicFixture, publicTask } from './abaPublicFixture.js';
import { savePublicReports } from '../src/services/publicAsinData.js';

export const coreA = 'B000003051', coreB = 'B000003052';
const row = (query, impressions) => [query, 20, impressions, impressions / 10, Math.floor(impressions / 100), 20, 2, 0];
export const coreReports = [
  { asin: coreA, week: 38, start: '2026-09-13', end: '2026-09-19', rows: [
    row('cartouche hp 305', 1000), row('hp305XLink', 300), row('cartouche imprimante', 200), row('encre noire', 100),
    row('hp 305', 50), row('hp ink 9999', 700), row('cartouche hp deskjet 2700', 400), row('canon PG545 ink', 500),
    row('305xl', 60), row('cartucce 305', 70), row('301xl', 80), row('canon 541', 90),
    row('imprimante canon', 110), row('hp deskjet', 120), row('canon 260261 ink', 40),
    row('302', 50), row('ho 302', 60), row('ho 302 noir', 70), row('67', 80), row('canon ts302', 90),
  ] },
  { asin: coreB, week: 38, start: '2026-09-13', end: '2026-09-19', rows: [row('cartouche hp 305', 1000)] },
  { asin: coreA, week: 39, start: '2026-09-20', end: '2026-09-26', rows: [row('cartouche hp 305', 2000)] },
];
export const coreFiles = coreReports.map((report) => ({ name: `${report.asin}-${report.week}.csv`, text: asinFixture(report) }));
export const coreSkus = [
  { country: 'ES', brand: 'CE', sku: 'CORE-A305', asin: coreA, model: '305', setGroup: 'BK' },
  { country: 'ES', brand: 'CY', sku: 'CORE-B305', asin: coreB, model: '305', setGroup: 'C' },
];
export function seedPublicCoreReports(db) {
  db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)')
    .run('D', 'EU', 'Canon', '545/546', 'PIXMA', 'TS302, TS67', 'core-numeric-overlap');
  db.prepare('INSERT INTO lib_items(lib,scope,brand,term,series,printer,dedupe) VALUES(?,?,?,?,?,?,?)')
    .run('D', 'EU', 'HP', '67', 'Deskjet', '1255', 'core-two-digit-cartridge');
  for (const report of coreReports) {
    const task = { ...publicTask, brand: report.asin === coreA ? 'CE' : 'CY', week_start: report.start,
      week_end: report.end, asins_json: JSON.stringify([report.asin]) };
    const payload = publicFixture(task);
    const template = payload.dataByAsin[0];
    payload.dataByAsin = report.rows.map((r) => ({ ...structuredClone(template),
      searchQueryData: { searchQuery: r[0], searchQueryVolume: r[1] },
      impressionData: { totalQueryImpressionCount: r[2], asinImpressionCount: r[5] },
      clickData: { totalClickCount: r[3], asinClickCount: r[6] }, purchaseData: { totalPurchaseCount: r[4], asinPurchaseCount: r[7] },
    }));
    savePublicReports(db, { task, payload, marketplaceId: 'A1RKKUPIHCS9HS' });
  }
}
