// Dispatch through the existing routers: the same permissions, transactions,
// audit entries and worker cache invalidation apply to website and MCP calls.
// No network port, credential forwarding or arbitrary API path is exposed.
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { authRouter } from './auth.js';
import { negRouter } from './keywords.js';
import { skuRouter } from './skus.js';
import { portfolioRouter } from './portfolios.js';
import { productRouter } from './products.js';
import { abaRouter } from './aba.js';
import { abaPublicRouter } from './abaPublic.js';
import { captainRouter } from './captain.js';
import { agedFeesRouter } from './agedFees.js';
import { listingsRouter } from './listings.js';
import { bumpOnWrite } from './workers/pool.js';

const api = express();
api.disable('x-powered-by');
api.use(bumpOnWrite);
for (const [name, router] of Object.entries({ auth: authRouter, neg: negRouter,
  sku: skuRouter, portfolio: portfolioRouter, products: productRouter,
  aba: abaRouter, 'aba-public': abaPublicRouter, captain: captainRouter, 'aged-fees': agedFeesRouter, listings: listingsRouter })) {
  api.use(`/api/${name}`, router);
}
api.use((_req, res) => res.status(404).json({ error: '接口不存在' }));
api.use((error, _req, res, _next) => {
  console.error('[mcp-api]', error.name);
  res.status(error.status || 500).json({ error: error.status ? error.message : '服务器内部错误' });
});

export function invokeApi(userId, method, route, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = route;
    req.headers = {};
    req.session = { user: { id: userId }, destroy(callback) { callback?.(); } };
    if (method === 'GET') {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== null) query.set(key, Array.isArray(value) ? value.join(',') : String(value));
      }
      req.url += `?${query}`;
    } else req.body = args;
    const res = new ServerResponse(req);
    const chunks = [];
    res.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
    res.end = (chunk) => {
      if (res.writableEnded) return res;
      if (chunk) chunks.push(Buffer.from(chunk));
      Object.defineProperty(res, 'writableEnded', { value: true });
      res.emit('finish');
      res.emit('close');
      socket.destroy();
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (res.statusCode >= 400) reject(Object.assign(new Error(data.error || '请求失败'), { status: res.statusCode }));
        else resolve(data);
      } catch (error) { reject(error); }
      return res;
    };
    api.handle(req, res);
  });
}
