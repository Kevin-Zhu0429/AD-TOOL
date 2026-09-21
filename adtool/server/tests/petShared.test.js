import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { migratePetShared } from '../src/petShared.js';

test('pet migration keeps latest duplicates, archives originals, survives account deletion and is idempotent', () => {
 const db=new Database(':memory:');
 try {
  db.exec(fs.readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
  db.exec('CREATE TABLE app_metadata(key TEXT PRIMARY KEY,value TEXT)');
  db.exec(`INSERT INTO users(id,username,display_name,password_hash) VALUES(1,'a','A','x'),(2,'b','B','x')`);
  db.exec(`INSERT INTO portfolio_items(user_id,marketplace,portfolio_id,name,updated_at) VALUES(1,'US','123','old','2026-01-01'),(2,'US','123','new','2026-02-01')`);
  db.exec(`INSERT INTO aba_reports(user_id,marketplace,brand,week_start,week_end,week_number,source_file,content_hash,updated_at)
   VALUES(1,'US','Pet','2026-01-04','2026-01-10',2,'old','a','2026-01-11'),(2,'US','pet','2026-01-04','2026-01-10',2,'new','b','2026-01-12')`);
  db.exec(`INSERT INTO aba_queries(report_id,query,query_volume,impressions,clicks,purchases) VALUES(1,'dog',10,20,2,1),(2,'dog',30,40,4,2)`);
  migratePetShared(db);
  assert.equal(db.prepare('SELECT name FROM portfolio_items').get().name,'new');
  assert.equal(db.prepare('SELECT user_id FROM portfolio_items').get().user_id,-1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM aba_reports').get().n,1);
  assert.equal(db.prepare('SELECT query_volume FROM aba_queries').get().query_volume,30);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pet_shared_migration_archive').get().n,6);
  migratePetShared(db);
  db.exec('DELETE FROM users WHERE id IN (1,2)');
  assert.equal(db.prepare('SELECT count(*) AS n FROM aba_reports').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM portfolio_items').get().n,1);
 } finally { db.close(); }
});
