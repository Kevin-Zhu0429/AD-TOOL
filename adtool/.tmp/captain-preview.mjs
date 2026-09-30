import { createServer } from '../web/node_modules/vite/dist/node/index.js';
import { startAbaTestServer } from '../server/tests/abaHarness.js';

Object.assign(process.env, {
  BRAND1_NAME: 'CY',
  BRAND1_MARKETS: 'ES,DE,FR,IT,UK',
  BRAND1_LWA_CLIENT_ID: 'preview-client',
  BRAND1_LWA_CLIENT_SECRET: 'preview-secret',
  BRAND1_LWA_REFRESH_TOKEN_EU: 'Atzr|preview',
  BRAND1_SELLER_ID_EU: 'PREVIEWSELLER',
});

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

const MARKETPLACES = ['A1RKKUPIHCS9HS', 'A1PA6795UKMFR9', 'A13V1IB3VIYZZH', 'APJ6JRA9NG5V4', 'A1F83G8C2ARO7P'];
global.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.host === 'api.amazon.com') return Response.json({ access_token: 'preview-token', expires_in: 3600 });
  if (url.pathname === '/sellers/v1/marketplaceParticipations') {
    return Response.json({ payload: MARKETPLACES.map((id) => ({
      marketplace: { id }, participation: { isParticipating: true, hasSuspendedListings: false },
    })) });
  }
  if (url.pathname === '/fba/inventory/v1/summaries') {
    return Response.json({ payload: { inventorySummaries: [{
      sellerSku: 'CY-PREVIEW-SKU',
      inventoryDetails: {
        fulfillableQuantity: 10, inboundShippedQuantity: 1, inboundReceivingQuantity: 2, inboundWorkingQuantity: 0,
      },
    }] } });
  }
  throw new Error(`Unexpected Amazon request: ${url.pathname}`);
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
