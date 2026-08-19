import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db } from './db.js';
import { authRouter } from './auth.js';
import { negRouter } from './keywords.js';
import { skuRouter } from './skus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 8080;

const SqliteStore = SqliteStoreFactory(session);

app.use(express.json({ limit: '10mb' }));
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
      secure: false, // 内网 http,开了 cookie 就发不出去
    },
  })
);

app.use('/api/auth', authRouter);
app.use('/api/neg', negRouter);
app.use('/api/sku', skuRouter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 正式上线时前端打包产物放这,开发阶段没有这个目录就跳过
const DIST = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('后端在跑。前端请另开 npm run dev'));
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] http://localhost:${PORT}`);
});
