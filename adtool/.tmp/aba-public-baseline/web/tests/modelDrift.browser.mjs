import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import * as XLSX from 'xlsx';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = fileURLToPath(new URL('../../.tmp/', import.meta.url));
await mkdir(output, {recursive:true});
const rows = [
 {brand:'HP',term:'350, 351',printer:'D4200'},
 {brand:'HP',term:'21, 22',printer:'F350'},
 {brand:'Canon',term:'510, 511',printer:'MX350'},
 {brand:'HP',term:'305',series:'DeskJet',printer:'2700'},
 {brand:'Canon',term:'545, 546',printer:'TS305'},
 {brand:'HP',term:'21, 22',series:'OfficeJet',printer:'4310'},
 {brand:'HP',term:'308',series:'DeskJet',printer:'4310'},
 {brand:'HP',term:'338, 343',series:'PhotoSmart',printer:'2570'},
 {brand:'HP',term:'337, 343',series:'PhotoSmart',printer:'2570'},
 {brand:'HP',term:'336, 342',series:'PhotoSmart',printer:'2570'},
 {brand:'HP',term:'110',series:'PhotoSmart',printer:'2570'},
 {brand:'HP',term:'45',printer:'9999'},
 {brand:'HP',term:'78',printer:'9999'},
 {brand:'HP',term:'56, 57',printer:'D5550'},
 {brand:'HP',term:'27, 28',printer:'D3500'},
];
const library={libs:[{id:'D',special:'series'}],items:{D:rows}};
const skus=['350','21','56','338','305'].map(model=>({sku:'SKU-'+model,model}));
const html=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><title>搜索词检测回归验证</title><link rel="stylesheet" href="/src/index.css"><style>html,body{margin:0;width:100%;height:100%}#host{height:100vh}</style></head><body><div id="host" data-theme="light"></div><script type="module">
import {mountOptimizer} from '/src/optApp.js';
import css from '/src/components/optimizer.css?inline';
const host=document.querySelector('#host');const shadow=host.attachShadow({mode:'open'});
const style=document.createElement('style');style.textContent=css;shadow.append(style);
const mount=document.createElement('div');shadow.append(mount);
const app=mountOptimizer(mount,host,{streamThresholdBytes:1});
const library=${JSON.stringify(library)},skus=${JSON.stringify(skus)};
window.updateTestLibrary=(items=skus,lib=library)=>app.setLibrary('FR',lib,'',items);
window.updateTestLibrary();
</script></body></html>`;
const server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0},plugins:[{name:'drift-test-harness',configureServer(s){s.middlewares.use('/__drift-test',(_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});}}]});
await server.listen();
let browser;
try {
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
 const page=await browser.newPage({viewport:{width:1600,height:980}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__drift-test`);
 await page.locator('#btnLoadA').waitFor();
 const terms=['cartouche hp 350 xl noir','hp305xl',"cartouche d'encre canon350 et 351",'hp 4310','amazon cartouche encre hp 2570','hp 9999',"cartouche d'encre 56 ou 27",'black ink multipack'];
 function workbook(models=['350','21','56','338']){
  const wb=XLSX.utils.book_new();
  const bulk=[{Product:'Sponsored Products',Entity:'Campaign','Campaign ID':'c1','Campaign Name':'截图案例验证',State:'enabled','Daily Budget':10},
  {Product:'Sponsored Products',Entity:'Ad Group','Campaign ID':'c1','Ad Group ID':'g1','Ad Group Name':'组一',State:'enabled','Ad Group Default Bid':0.3},
  ...models.map((model,i)=>({Product:'Sponsored Products',Entity:'Product Ad','Campaign ID':'c1','Ad Group ID':'g1','Ad ID':'a'+i,SKU:'SKU-'+model,State:'enabled'})),
  {Product:'Sponsored Products',Entity:'Campaign','Campaign ID':'c2','Campaign Name':'资料缺失验证',State:'enabled','Daily Budget':10},
  {Product:'Sponsored Products',Entity:'Product Ad','Campaign ID':'c2','Ad Group ID':'g2','Ad ID':'missing',SKU:'missing',State:'enabled'}];
  const search=terms.map((term,i)=>({'Campaign ID':'c1','Ad Group ID':'g1','Customer Search Term':term,Impressions:100,Clicks:2,Spend:1-i*0.01,Orders:1,Sales:10}));
  search.push({'Campaign ID':'c2','Ad Group ID':'g2','Customer Search Term':'hp305xl',Impressions:10,Clicks:1,Spend:0.1});
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(bulk),'Sponsored Products Campaigns');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(search),'SP Search Term Report');
  return {name:'drift-fixture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(wb,{type:'buffer',bookType:'xlsx'})};
 }
 async function analysis(){await page.locator('[data-view="analysis"]').click();await page.locator('[data-antab="drift"]').click();}
 const termRow=(term,campaign='截图案例验证')=>page.locator('#anbody tbody tr').filter({has:page.getByText(term,{exact:true})}).filter({hasText:campaign});
 await page.locator('#fileA').setInputFiles(workbook());
 await page.locator('#fileAName').filter({hasText:'drift-fixture.xlsx'}).waitFor();
 await page.locator('#btnSet').click();
 assert.equal(await page.locator('#s_scope option[value="all"]').isDisabled(),true,'streamed workbook only exports changed rows');
 await page.locator('#maskSet').getByRole('button',{name:'关闭',exact:true}).click();
 await analysis();
 assert.equal(await page.locator('#anbody tbody tr').count(),6);
 for (const [term,label] of [['hp305xl','疑似跑偏'],[terms[2],'需核对品牌'],['hp 4310','需人工判断'],['hp 9999','需核对词库'],[terms[6],'部分匹配']]) assert.ok((await termRow(term).innerText()).includes(label),term);
 assert.equal(await termRow(terms[4]).count(),0,'confirmed compatible PhotoSmart 2570 must not be reported');
 const ambiguous=await termRow('hp 4310').innerText();
 assert.match(ambiguous,/OFFICEJET4310[\s\S]*21, 22[\s\S]*DESKJET4310[\s\S]*308/);
 assert.ok((await termRow('hp305xl','资料缺失验证').innerText()).includes('资料不足'));
 assert.equal(await termRow(terms[0]).count(),0);
 assert.match(await page.locator('#chgCount').innerText(),/^0 处改动/);
 assert.match(await page.locator('[data-driftfilter="drift"]').innerText(),/疑似跑偏\s+1/);
 await page.locator('[data-driftfilter="review"]').click();
 assert.equal(await page.locator('#anbody tbody tr').count(),1);
 assert.ok((await page.locator('#anbody tbody tr').innerText()).includes('需人工判断'));
 await page.locator('[data-driftfilter="mapping_conflict"]').click();
 assert.equal(await page.locator('#anbody tbody tr').count(),1);
 assert.ok((await page.locator('#anbody tbody tr').innerText()).includes('hp 9999'));
 await page.locator('[data-driftfilter=""]').click();
 await page.screenshot({path:output+'drift-desktop.png'});
 await page.locator('#anQ').fill('no-such-search-term');
 await page.locator('#anbody .empty').waitFor();
 assert.match(await page.locator('#anbody .empty').innerText(),/没有检测到/);
 await page.locator('#anQ').fill('');
 await termRow('hp 4310').waitFor();
 await page.locator('[data-view="work"]').click();
 await page.locator('.crow[data-id="c1"]').click();
 await page.locator('[data-tab="st"]').click();
 const detail=await page.locator('#detail').innerText();
 for(const label of ['疑似跑偏','部分匹配','需核对品牌','需核对词库','需人工判断']) assert.ok(detail.includes(label),label);
 assert.ok(detail.includes(terms[0]));
 await analysis();
 await page.setViewportSize({width:520,height:850});
 await page.screenshot({path:output+'drift-narrow.png'});
 assert.equal(await termRow('hp 4310').count(),1);
 assert.ok(await termRow('hp 4310').locator('button').first().isEnabled());
 await page.setViewportSize({width:1600,height:980});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.querySelector('#host').dataset.theme='dark';});
 await page.screenshot({path:output+'drift-dark.png'});
 await page.evaluate(()=>window.updateTestLibrary([]));
 assert.match(await page.locator('#anbody .empty').innerText(),/SKU 库没有数据/);
 await page.evaluate(()=>window.updateTestLibrary());
 await termRow('hp 4310').waitFor();
 await page.evaluate(()=>window.updateTestLibrary(undefined,{libs:[{id:'D'}],items:{D:[]}}));
 assert.match(await page.locator('#anbody .empty').innerText(),/词库没有型号数据/);
 await page.evaluate(()=>window.updateTestLibrary());
 await termRow('hp 4310').waitFor();
 await page.locator('#fileA').setInputFiles(workbook(['305']));
 await page.locator('#main').waitFor({state:'visible'});
 await analysis();
 assert.equal(await termRow('hp305xl').count(),0,'new workbook must clear campaign context');
 assert.ok((await termRow(terms[0]).innerText()).includes('疑似跑偏'));
 await termRow(terms[0]).getByRole('button',{name:'精准',exact:true}).focus();
 await page.keyboard.press('Enter');
 await termRow(terms[0]).getByText('已加入否定').waitFor();
 assert.match(await page.locator('#chgCount').innerText(),/^1 处改动/);
 assert.deepEqual(errors,[]);
 console.log('PASS: six result states, both views, no-results, missing library, desktop/narrow/dark, workbook reload, keyboard negative action; no browser errors.');
} finally {await browser?.close();await server.close();}
