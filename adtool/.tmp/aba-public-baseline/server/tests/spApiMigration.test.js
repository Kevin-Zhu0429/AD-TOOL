import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('switching to SP-API clears Captain-era bindings but keeps SKU stock and SP-API bindings', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'adtool-spapi-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // 升级前的库:一组船长绑定和一组已经是亚马逊的绑定
  const old = new Database(path.join(directory, 'adtool.db'));
  old.pragma('foreign_keys = ON');
  old.exec(fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const userId = old.prepare(
    "INSERT INTO users (username, display_name, password_hash, role, marketplace) VALUES ('kevin', 'kevin', 'x', 'owner', 'ALL')"
  ).run().lastInsertRowid;
  old.prepare(
    `INSERT INTO sku_items (user_id, country, brand, sku, stock, transit, dedupe)
     VALUES (?, 'ES', 'CY', 'CY-1', 12, 3, 'ES|cy-1')`
  ).run(userId);
  for (const [groupKey, channelId] of [['cy_eu:EU', 'mNzI23ZROVlJVGdBrWbjug=='], ['cc_eu:EU', 'spapi:SELLER:A1RKKUPIHCS9HS']]) {
    const bindingId = old.prepare(
      `INSERT INTO captain_channel_bindings (user_id, brand, brand_key, country, open_channel_id, channel_name)
       VALUES (?, 'CY', 'cy', 'ES', ?, 'store')`
    ).run(userId, channelId).lastInsertRowid;
    old.prepare(
      "INSERT INTO captain_channel_groups (group_key, group_name, scope, brand, brand_key) VALUES (?, ?, 'EU', 'CY', 'cy')"
    ).run(groupKey, groupKey);
    old.prepare('INSERT INTO captain_channel_group_members (group_key, open_channel_id) VALUES (?, ?)').run(groupKey, channelId);
    old.prepare("INSERT INTO captain_channel_assignments (group_key, country, user_id) VALUES (?, 'ES', ?)").run(groupKey, userId);
    old.prepare(
      "INSERT INTO captain_inventory_snapshots (binding_id, sku_key, sku, stock) VALUES (?, 'cy-1', 'CY-1', 99)"
    ).run(bindingId);
  }
  old.pragma('user_version = 2');
  old.close();

  process.env.DATA_DIR = directory;
  const { db } = await import('../src/db.js');
  t.after(() => db.close());

  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(db.prepare('SELECT open_channel_id FROM captain_channel_bindings').all(),
    [{ open_channel_id: 'spapi:SELLER:A1RKKUPIHCS9HS' }]);
  assert.deepEqual(db.prepare('SELECT group_key FROM captain_channel_groups').all(), [{ group_key: 'cc_eu:EU' }]);
  assert.deepEqual(db.prepare('SELECT group_key FROM captain_channel_assignments').all(), [{ group_key: 'cc_eu:EU' }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM captain_inventory_snapshots').get().n, 1);
  assert.deepEqual(db.prepare('SELECT stock, transit FROM sku_items').get(), { stock: 12, transit: 3 });
});
