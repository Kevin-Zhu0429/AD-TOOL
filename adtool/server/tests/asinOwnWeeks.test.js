import test from 'node:test';
import assert from 'node:assert/strict';
import { startAbaTestServer } from './abaHarness.js';
import { ownIds, ownSkus, ownFiles, ownWeeks, ownPrinterQuery, ownCoreQuery, ownSecondQuery, seedOwnWeeks } from './asinOwnWeeksFixture.js';
import { buildAsinExport } from '../../web/src/abaAsinExport.js';
test('private/public source export averages match per-ASIN pages for 1/2/4 observed weeks, zero rows and both classifications', async (t) => {
  const server = await startAbaTestServer(); t.after(() => server.close()); seedOwnWeeks(server.db);
  const post = async (path, data, cookie = '') => {
    const response = await fetch(server.url+'/api'+path, { method:'POST', headers:{ cookie, 'Content-Type':'application/json' }, body:JSON.stringify(data) });
    assert.equal(response.status,200,await response.clone().text()); return { cookie:response.headers.get('set-cookie')?.split(';')[0], data:await response.json() };
  };
  const cookie=(await post('/auth/login',{ username:'aba-test', password:'local-test-password' })).cookie;
  const owner=(await post('/auth/login',{ username:'aba-other', password:'local-test-password' })).cookie;
  await post('/aba/asin/import',{ marketplace:'ES', files:ownFiles },cookie);
  await post('/aba-skus/import',{ rows:ownSkus },owner);
  for (const endpoint of ['/aba/asin','/aba-public/asin']) {
    const get=async (query) => {
      const response=await fetch(server.url+'/api'+endpoint+'?'+new URLSearchParams({ marketplace:'ES', weeks:ownWeeks.map((w)=>w.end).join(','), aggregation:'average', wordType:query.q===ownCoreQuery?'cartridge':'printer', ...query }),{ headers:{ cookie } });
      assert.equal(response.status,200); return response.json();
    };
    const twoWeekTerm=await get({ view:'printers', q:ownSecondQuery, export:'1' });
    assert.equal(twoWeekTerm.selectedWeeks.length,4);
    const rare=twoWeekTerm.items[0].query_rows.find((r)=>r.asin===ownIds[1]);
    assert.equal(rare.average_weeks,1); assert.equal(rare.asin_impressions,23); assert.equal(rare.asin_clicks,1);
    assert.equal(twoWeekTerm.items[0].periods.length,2);
    const secondBook=buildAsinExport(twoWeekTerm), secondCol=(key)=>secondBook.columns.findIndex((c)=>c.key===key);
    const secondCells=secondBook.rows.find((r)=>r[secondCol('asin')]===ownIds[1]);
    assert.equal(secondCells[secondCol('asin_impressions')],23); assert.equal(secondCells[secondCol('asin_clicks')],1);
    assert.equal(secondCells[secondCol('market_impressions_original')],1400.5);
    for (const [view,query] of [['printers',ownPrinterQuery],['cores',ownCoreQuery]]) {
      const all=await get({ view, q:query, export:'1' }); assert.equal(all.selectedWeeks.length,4); assert.equal(all.total,1);
      assert.equal(all.items[0].asin_clicks,25.75);
      const details=await get({ view:'queries', q:query });
      const book=buildAsinExport(all), col=(key)=>book.columns.findIndex((c)=>c.key===key);
      for (const [index,imp,clicks,purchases,weeks] of [[0,250,25,5,4],[1,12,1,0,1],[2,10,1,0.5,2]]) {
        const source=all.items[0].query_rows.find((r)=>r.asin===ownIds[index]);
        const website=details.items.find((r)=>r.asin===ownIds[index]);
        const cells=book.rows.find((r)=>r[col('asin')]===ownIds[index]);
        assert.equal(source.average_weeks,weeks);
        for (const [key,value] of [['asin_impressions',imp],['asin_clicks',clicks],['asin_purchases',purchases]]) {
          assert.equal(source[key],value); assert.equal(cells[col(key)],value); assert.equal(cells[col(key)],website[key]);
        }
        assert.equal(cells[col('asin_cvr')],website.asin_cvr/100); assert.equal(cells[col('brand_share')],website.brand_share/100);
        assert.equal(cells[col('market_impressions_original')],4510); assert.equal(cells[col('market_clicks_original')],105.75);
        assert.equal(cells[col('market_purchases_original')],34.25);
      }
      const filtered=await get({ view:'queries', q:query, asin:ownIds[1], brand:'pg', model:'65' });
      assert.equal(filtered.items[0].asin_impressions,12); assert.equal(filtered.items[0].asin_clicks,1);
      const sum=await get({ view, q:query, aggregation:'sum', export:'1' });
      assert.equal(sum.items[0].query_rows.find((r)=>r.asin===ownIds[0]).asin_clicks,100);
      assert.equal(sum.items[0].query_rows.find((r)=>r.asin===ownIds[1]).asin_clicks,1);
      const weekly=await get({ view:'queries', q:query, merge:'0', aggregation:'sum' });
      assert.equal(weekly.items.filter((r)=>r.asin===ownIds[2]).length,2);
    }
  }
});
