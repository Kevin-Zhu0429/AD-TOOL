import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function startPetTestServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-pet-test-'));
  process.env.APP_PROFILE = 'pet'; process.env.DATA_DIR = directory;
  const { db } = await import('../src/db.js');
  const { profile } = await import('../src/profile.js');
  const { authRouter } = await import('../src/auth.js');
  const { skuRouter } = await import('../src/skus.js');
  const { abaRouter } = await import('../src/aba.js');
  const { productRouter } = await import('../src/products.js');
  const { portfolioRouter } = await import('../src/portfolios.js');
  const { captainRouter } = await import('../src/captain.js');
  for (const [username, role] of [['pet-owner', 'owner'], ['pet-user', 'operator']]) {
    db.prepare(`INSERT INTO users (username, display_name, password_hash, role, marketplace, manual_ads, ad_opt, product_intel, seen_version)
      VALUES (?, ?, ?, ?, ?, 1, 1, 1, '999.0.0')`).run(username, username, bcrypt.hashSync('pet-test-password', 4), role, role === 'owner' ? 'ALL' : 'US');
  }
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use(session({ secret: 'pet-test-only', resave: false, saveUninitialized: false }));
  app.get('/api/config', (req, res) => res.json(profile));
  app.use('/api/auth', authRouter); app.use('/api/sku', skuRouter); app.use('/api/aba', abaRouter);
  app.use('/api/products', productRouter); app.use('/api/portfolio', portfolioRouter); app.use('/api/captain', captainRouter);
  app.use('/api/neg', (req, res) => res.status(404).json({ error: '宠物版未启用共享否定词库' }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  return { db, directory, url: `http://127.0.0.1:${server.address().port}`, async close() {
    await new Promise((resolve) => server.close(resolve)); db.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('adtool-pet-test-')) throw new Error('Unexpected test directory');
    await rm(resolved, { recursive: true, force: true });
  } };
}
