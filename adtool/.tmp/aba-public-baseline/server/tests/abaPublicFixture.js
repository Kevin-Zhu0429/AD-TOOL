import { REPORT_TYPE } from '../src/services/publicAsinData.js';
export function publicFixture(task, marketplaceId = 'A1RKKUPIHCS9HS', { empty = false, multiplier = 1 } = {}) {
  const asins = JSON.parse(task.asins_json);
  return {
    reportSpecification: { reportType: REPORT_TYPE, reportOptions: { reportPeriod: 'WEEK', asin: asins.join(' ') },
      dataStartTime: task.week_start, dataEndTime: task.week_end, marketplaceIds: [marketplaceId] },
    dataByAsin: empty ? [] : asins.flatMap((asin) => ['hp deskjet 2820e', 'cartuchos hp 305'].map((query) => ({
      asin, startDate: task.week_start, endDate: task.week_end,
      searchQueryData: { searchQuery: query, searchQueryVolume: 100 * multiplier },
      impressionData: { totalQueryImpressionCount: 1000 * multiplier, asinImpressionCount: 200 * multiplier },
      clickData: { totalClickCount: 100 * multiplier, asinClickCount: 10 * multiplier },
      purchaseData: { totalPurchaseCount: 20 * multiplier, asinPurchaseCount: 5 * multiplier },
    }))),
  };
}
export const publicTask = { marketplace: 'ES', brand: 'CE', week_start: '2026-09-27', week_end: '2026-10-03', report_id: 'test-report', asins_json: JSON.stringify(['B000000305', 'B000000306']) };
