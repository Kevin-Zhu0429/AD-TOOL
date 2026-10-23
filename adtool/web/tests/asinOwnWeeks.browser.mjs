import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startAbaTestServer } from '../../server/tests/abaHarness.js';
import { ownIds, ownSkus, ownFiles, ownPrinterQuery, ownSecondQuery, seedOwnWeeks } from '../../server/tests/asinOwnWeeksFixture.js';
const require=createRequire(import.meta.url), { chromium }=require(process.env.PLAYWRIGHT_MODULE||'playwright'), XLSX=require('xlsx');
const backend=await startAbaTestServer(); let vite,browser;
try {
  seedOwnWeeks(backend.db);
  vite=await createServer({ root:fileURLToPath(new URL('../',import.meta.url)), server:{ host:'127.0.0.1',port:0,proxy:{ '/api':{ target:backend.url,changeOrigin:true } } } }); await vite.listen();
  browser=await chromium.launch({ channel:'msedge',headless:true });
  const page=await browser.newPage({ viewport:{ width:1440,height:1000 },reducedMotion:'reduce' }); const errors=[]; page.on('pageerror',(e)=>errors.push(e.message));
  const base='http://127.0.0.1:'+vite.httpServer.address().port;
  const login=(username)=>page.request.post(base+'/api/auth/login',{ data:{ username,password:'local-test-password' } });
  await login('aba-test'); assert.ok((await page.request.post(base+'/api/aba/asin/import',{ data:{ marketplace:'ES',files:ownFiles } })).ok());
  await login('aba-other'); assert.ok((await page.request.post(base+'/api/aba-skus/import',{ data:{ rows:ownSkus } })).ok());
  await login('aba-test'); await page.goto(base);
  for (const scope of ['private','public']) {
    await page.locator('.topnav').getByRole('button',{ name:scope==='private'?'ABA 报告':'ABA报告（公共）',exact:true }).click();
    if (scope==='private') await page.getByRole('button',{ name:'ASIN 视图',exact:true }).click();
    else await page.locator('.aba-public-countries button').filter({ hasText:'西班牙' }).click();
    const view=page.locator('.aba-asin-view'), endpoint=scope==='private'?'/api/aba/asin?':'/api/aba-public/asin?';
    const idle=()=>view.locator('.aba-results[aria-busy="false"]').waitFor();
    const perform=async(fn)=>{ await Promise.all([page.waitForResponse((r)=>r.url().includes(endpoint)&&!r.url().includes('export=1')&&r.status()===200),fn()]); await idle(); };
    const choose=async(label,value)=>{ if (await view.getByLabel(label,{ exact:true }).inputValue()!==value) await perform(()=>view.getByLabel(label,{ exact:true }).selectOption(value)); };
    const search=(query)=>perform(()=>view.getByLabel('搜索查询 / 墨盒型号',{ exact:true }).fill(query));
    const allWeeks=()=>perform(()=>view.getByRole('button',{ name:'全选',exact:true }).click());
    const download=async()=>{
      const pending=page.waitForEvent('download'); await view.getByRole('button',{ name:'导出 Excel',exact:true }).click();
      const book=XLSX.readFile(await(await pending).path()), rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{ header:1,defval:'' });
      const col=(name)=>rows[0].indexOf(name);
      const rare=rows.slice(1).find((r)=>r[col('ASIN')]===ownIds[1]);
      assert.equal(rare[col('SKU')],'h65xlcpg'); assert.equal(rare[col('ASIN IMP')],12); assert.equal(rare[col('ASIN 点击')],1); assert.equal(rare[col('ASIN 购买')],0);
      assert.equal(rare[col('ASIN CVR')],0); assert.equal(rare[col('市场IMP(原始总量)')],4510); assert.equal(rare[col('市场点击TT(原始总量)')],105.75); assert.equal(rare[col('市场购买TT(原始总量)')],34.25);
      const zero=rows.slice(1).find((r)=>r[col('ASIN')]===ownIds[2]); assert.equal(zero[col('ASIN IMP')],10); assert.equal(zero[col('ASIN 点击')],1); assert.equal(zero[col('ASIN 购买')],0.5);
      return rare;
    };
    await idle(); await choose('词类型','printer'); await choose('显示方式','printers'); await allWeeks(); await choose('多周统计','average'); await search(ownPrinterQuery);
    assert.equal(await view.locator('.aba-group-row').count(),1); assert.equal(await view.locator('.aba-group-row td').nth(7).innerText(),'25.75');
    await download();
    await search(ownSecondQuery);
    const secondDownload=page.waitForEvent('download'); await view.getByRole('button',{ name:'导出 Excel',exact:true }).click();
    const secondBook=XLSX.readFile(await(await secondDownload).path());
    const secondCells=XLSX.utils.sheet_to_json(secondBook.Sheets[secondBook.SheetNames[0]],{ header:1,defval:'' });
    const secondCol=(label)=>secondCells[0].indexOf(label);
    const secondRare=secondCells.slice(1).find((r)=>r[secondCol('ASIN')]===ownIds[1]);
    assert.equal(secondRare[secondCol('ASIN IMP')],23); assert.equal(secondRare[secondCol('ASIN 点击')],1);
    assert.equal(secondRare[secondCol('ASIN 购买')],0); assert.equal(secondRare[secondCol('市场IMP(原始总量)')],1400.5);
    await search(ownPrinterQuery);
    await choose('ASIN',ownIds[1]); await choose('显示方式','queries');
    const row=view.locator('.aba-table tbody tr').first(); assert.equal(await row.locator('td').nth(6).innerText(),'12'); assert.equal(await row.locator('td').nth(7).innerText(),'1'); assert.equal(await row.locator('td').nth(8).innerText(),'0');
    await page.screenshot({ path:fileURLToPath(new URL('../../.tmp/asin-own-week-'+scope+'.png',import.meta.url)),fullPage:true });
    await choose('ASIN',''); await allWeeks(); await choose('词类型','cartridge'); await choose('显示方式','cores'); await search('hp 65 ink'); await download();
    await page.setViewportSize({ width:390,height:844 }); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true); await page.setViewportSize({ width:1440,height:1000 });
  }
  assert.deepEqual(errors,[]); console.log('Own-week ASIN export passed: private/public, four-week selection, 12/1/0 and 23/1/0 one-week sources under four/two global query weeks, real zero rows, printer/core XLSX, page equality, full market originals and narrow layout.');
} finally { await browser?.close(); await vite?.close(); await backend.close(); }
