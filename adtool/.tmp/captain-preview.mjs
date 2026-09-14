import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { startAbaTestServer } from '../server/tests/abaHarness.js';

process.env.CAPTAIN_CLIENT_ID = 'preview-client';
process.env.CAPTAIN_CLIENT_SECRET = 'preview-secret';
process.env.CAPTAIN_INITIAL_LOOKBACK_DAYS = '1';

const originalFetch = global.fetch;
const backend = await startAbaTestServer();
const operator = backend.db.prepare("SELECT id FROM users WHERE username = 'aba-test'").get();
for (const country of ['ES', 'DE', 'FR', 'IT', 'UK']) {
  backend.db.prepare(
    `INSERT INTO sku_items
       (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
     VALUES (?, ?, 'CY', '301', 'BKC', 'CY-PREVIEW-SKU', 0, 0, ?)`
  ).run(operator.id, country, `${country}|cy-preview-sku`);
}

global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'preview-token', expires_in: 3600 });
  if (url.pathname === '/v1/open_user/get_site_list') {
    return Response.json({ code: 200, data: [
      { site_id: 1, code: 'ES' }, { site_id: 2, code: 'DE' },
      { site_id: 3, code: 'FR' }, { site_id: 4, code: 'IT' }, { site_id: 5, code: 'UK' },
    ] });
  }
  if (url.pathname === '/v1/open_user/get_channel_list') {
    const data = [
      { title: 'CY_EU_DE', site_id: 2, open_channel_id: 'preview-de', status: 1 },
      { title: 'CY_EU_ES', site_id: 1, open_channel_id: 'preview-es', status: 1 },
      { title: 'CY_EU_FR', site_id: 3, open_channel_id: 'preview-fr', status: 1 },
      { title: 'CY_EU_IT', site_id: 4, open_channel_id: 'preview-it', status: 1 },
      { title: 'CY_EU_UK', site_id: 5, open_channel_id: 'preview-uk', status: 1 },
    ];
    return Response.json({ code: 200, max_result: data.length, data });
  }
  if (url.pathname === '/v1/open_fba/inventory_list') {
    return Response.json({ code: 200, max_result: 1, data: [{
      SKU: 'CY-PREVIEW-SKU', fulfillable_quantity: 10,
      inbound_shipped_quantity: 1, inbound_receiving_quantity: 2,
      inbound_working_quantity: 0, is_delete: 0,
    }] });
  }
  throw new Error(`Unexpected Captain request: ${url.pathname}`);
};

const vite = await createServer({
  root: new URL('../web/', import.meta.url).pathname.slice(1),
  server: { host: '127.0.0.1', port: 4175, proxy: { '/api': { target: backend.url, changeOrigin: true } } },
});
await vite.listen();
console.log('CAPTAIN_PREVIEW=http://127.0.0.1:4175');

async function close() {
  global.fetch = originalFetch;
  await vite.close();
  await backend.close();
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
await new Promise(() => {});
