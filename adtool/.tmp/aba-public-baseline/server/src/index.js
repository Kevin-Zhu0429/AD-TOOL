import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { authRouter } from './auth.js';
import { negRouter } from './keywords.js';
import { skuRouter } from './skus.js';
import { portfolioRouter } from './portfolios.js';
import { productRouter } from './products.js';
import { abaRouter } from './aba.js';
import { abaPublicRouter, startPublicAbaScheduler } from './abaPublic.js';
import { captainRouter } from './captain.js';
import { agedFeesRouter } from './agedFees.js';
import { bumpOnWrite } from './workers/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 8080;
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
const SqliteStore = SqliteStoreFactory(session);

// JSON 接口和前端 JS/CSS 都按 gzip 传,线上 Nginx 目前没有压缩
app.use(compression());

// API responses contain live and often account-specific data. Never let browsers
// or reverse proxies reuse a response after an account or library change.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

app.use(bumpOnWrite);
app.use(express.json({ limit: '50mb' }));
app.use(
  session({
    store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 900_000 } }),
    secret: process.env.SESSION_SECRET || 'change-me-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 12 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
    },
  })
);

app.use('/api/auth', authRouter);
app.use('/api/neg', negRouter);
app.use('/api/sku', skuRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/products', productRouter);
app.use('/api/aba', abaRouter);
app.use('/api/aba-public', abaPublicRouter);
app.use('/api/captain', captainRouter);
app.use('/api/aged-fees', agedFeesRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 正式上线时前端打包产物放这,开发阶段没有这个目录就跳过
const DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(DIST)) {
  // assets 下的文件名带内容哈希,内容变了文件名就变,可以放心缓存一年;
  // 找不到就直接 404,别回 index.html,否则发版后旧页面按需加载时会拿到一段 HTML
  app.use('/assets', express.static(path.join(DIST, 'assets'), {
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/assets', (req, res) => res.status(404).end());
  // index.html 每次都回源确认,发版后马上拿到新的资源列表
  app.use(express.static(DIST, {
    setHeaders: (res, file) => {
      if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    },
  }));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => res.send('后端在跑。前端请另开 npm run dev'));
}

app.use((err, req, res, next) => {
  console.error(err);
  if (err.status === 413) return res.status(413).json({ error: '单次上传内容超过服务器限制，请刷新页面后重试' });
  res.status(500).json({ error: '服务器内部错误' });
});

startPublicAbaScheduler();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http://localhost:${PORT}`);
});
