import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { readFile } from 'node:fs/promises';

/** Run the same real XLSX download checks against private and public ASIN routes. */
export async function checkAsinExports(page, view, apiPath) {
  const idle = () => view.locator('.aba-results[aria-busy="false"]').waitFor();
  const choose = async (label, value) => {
    const select = view.getByLabel(label, { exact: true });
    if (await select.inputValue() === value) return;
    const response = page.waitForResponse((r) => r.url().includes(apiPath + '?') && !r.url().includes('export=1') && r.status() === 200);
    await select.selectOption(value);
    await response; await idle();
  };
  const download = async (display) => {
    const response = page.waitForResponse((r) => r.url().includes(apiPath + '?') && r.url().includes('export=1') && r.status() === 200);
    const file = page.waitForEvent('download');
    await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
    const data = await (await response).json();
    const book = XLSX.read(await readFile(await (await file).path()), { type: 'buffer', cellNF: true });
    const name = display === 'queries' ? '搜索查询明细' : '机型分类汇总';
    assert.deepEqual(book.SheetNames, [name]);
    const cells = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' });
    assert.ok(cells.length > 1);
    const column = (label) => cells[0].indexOf(label);
    const body = cells.slice(1);
    assert.equal(data.view, display);
    if (display === 'queries') {
      assert.equal(body.length, data.total);
      assert.deepEqual(body.map((r) => r[column('搜索词')]), data.items.map((r) => r.query));
      assert.deepEqual(body.map((r) => r[column('市场 IMP')]), data.items.map((r) => r.market_impressions ?? ''));
      assert.deepEqual(body.map((r) => r[column('ASIN 点击')]), data.items.map((r) => r.asin_clicks ?? ''));
      assert.ok(body.every((r) => r[column('报告周')] && r[column('统计方式')]));
      const rateIndex = column('ASIN CVR');
      data.items.forEach((row, index) => {
        assert.equal(body[index][rateIndex], row.asin_cvr === null ? '' : row.asin_cvr / 100);
        if (row.asin_cvr !== null) assert.equal(book.Sheets[name][XLSX.utils.encode_cell({ r: index + 1, c: rateIndex })].z, '0.00%');
      });
    } else {
      assert.deepEqual(new Set(body.map((r) => r[column('搜索词')])), new Set(data.items.flatMap((group) => group.query_rows.map((r) => r.query))));
    }
  };
  for (const display of ['queries', 'printers']) {
    await choose('显示方式', display);
    for (const type of ['all', 'printer', 'cartridge']) {
      await choose('词类型', type);
      assert.equal(await view.getByRole('button', { name: '导出 Excel', exact: true }).isEnabled(), true);
      await download(display);
    }
  }
  await choose('显示方式', 'queries'); await choose('词类型', 'all');
  const exportPattern = '**' + apiPath + '?*export=1*';
  await page.route(exportPattern, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"模拟导出失败"}' }));
  await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
  await view.getByRole('alert').filter({ hasText: '模拟导出失败' }).waitFor();
  await page.unroute(exportPattern);
  await download('queries');
  await view.getByRole('alert').filter({ hasText: '模拟导出失败' }).waitFor({ state: 'hidden' });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route(exportPattern, async (route) => { await gate; await route.fulfill({ status: 503, body: '{}' }).catch(() => {}); });
  let staleDownloads = 0;
  const listener = () => { staleDownloads++; };
  page.on('download', listener);
  await view.getByRole('button', { name: '导出 Excel', exact: true }).click();
  assert.equal(await view.getByRole('button', { name: '正在导出…', exact: true }).isDisabled(), true);
  await choose('词类型', 'cartridge');
  await view.getByRole('button', { name: '导出 Excel', exact: true }).waitFor();
  release(); await page.unroute(exportPattern);
  assert.equal(staleDownloads, 0);
  page.off('download', listener);
  await choose('词类型', 'all');
  await view.getByLabel('搜索查询 / 墨盒型号', { exact: true }).fill('export-no-results-89732');
  await view.getByRole('heading', { name: '没有匹配的搜索查询' }).waitFor();
  assert.equal(await view.getByRole('button', { name: '导出 Excel', exact: true }).isDisabled(), true);
  await view.getByRole('button', { name: '清除搜索', exact: true }).first().click();
  await idle();
}
