import { profile } from '../src/profile.js';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dRows } from './abaFixture.js';

// This harness only listens on loopback and never opens the project's real database.
export async function startAbaTestServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-aba-test-'));
  process.env.DATA_DIR = directory;
  const { db } = await import('../src/db.js');
  const { authRouter } = await import('../src/auth.js');
  const { abaRouter } = await import('../src/aba.js');
  const { skuRouter } = await import('../src/skus.js');
  const { portfolioRouter } = await import('../src/portfolios.js');
  const { captainRouter } = await import('../src/captain.js');
  const insertUser = db.prepare('INSERT INTO users (username, display_name, password_hash, role, marketplace, seen_version) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, role, market] of [['aba-test', 'operator', 'ES'], ['aba-other', 'owner', 'ALL'], ['aba-de', 'operator', 'DE']]) {
    insertUser.run(name, name, bcrypt.hashSync('local-test-password', 4), role, market, '999.0.0');
  }
  dRows.forEach((r, i) => db.prepare('INSERT INTO lib_items (lib, scope, brand, term, series, printer, dedupe) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('D', 'EU', r.brand, r.term, r.series, r.printer, `aba-test-${i}`));
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(session({ secret: 'aba-test-only', resave: false, saveUninitialized: false }));
  app.get('/api/config', (req, res) => res.json(profile));
  app.use('/api/auth', authRouter);
  app.use('/api/aba', abaRouter);
  app.use('/api/sku', skuRouter);
  app.use('/api/portfolio', portfolioRouter);
  app.use('/api/captain', captainRouter);
  app.get('/api/neg', (req, res) => res.json({ libs: [], items: {} }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  return { db, directory, url: `http://127.0.0.1:${server.address().port}`, async close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('adtool-aba-test-')) throw new Error('Unexpected test directory');
    await rm(resolved, { recursive: true, force: true });
  } };
}
