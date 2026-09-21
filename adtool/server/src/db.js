import { profile, isPet } from './profile.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeKey, libOf, regionOf } from './libs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 所有数据只落在 DATA_DIR 里 —— 将来搬到别的机器就是拷这一个目录
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', isPet ? 'data-pet' : 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'adtool.db');
export const dataDir = DATA_DIR;
export const db = new Database(DB_PATH);

// Prevent a pet deployment from opening a copied ink database, or vice versa.
const hasMetadata = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_metadata'").get();
const savedProfile = hasMetadata ? db.prepare("SELECT value FROM app_metadata WHERE key='profile'").get()?.value : null;
const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
if ((savedProfile && savedProfile !== profile.id) || (!savedProfile && isPet && hasUsers && db.prepare('SELECT 1 FROM users LIMIT 1').get())) {
  db.close();
  throw new Error('数据库品类不匹配，请为宠物版设置独立的 DATA_DIR，并从空库初始化。');
}
db.exec('CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare("INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('profile', ?)").run(profile.id);

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);
migrate();

/**
 * 老库升级 —— 每次启动跑一遍,已经改过的自动跳过。
 * 1) users 加「商品部维护权」列:B/C/D/E 四类词库归商品部管
 * 2) users 加「手动广告使用权」「广告优化使用权」两列:默认全关,由超级管理员逐个开
 * 3) users 加「看过的更新日志版本」列:老账号是空的,登录后会看到全部更新
 * 4) users 加「产品库与竞品分析使用权」列:默认全关,由超级管理员逐个开
 * 5) 旧的 neg_terms 搬进 lib_items:无关词→A,品牌→B,型号和 ASIN→C
 * 6) 产品库按“站点 + 数据月份 + ASIN”隔离；无法追溯月份的旧数据放进“历史数据”
 */
function migrate() {
  const petSkuColumns = new Set(db.prepare('PRAGMA table_info(sku_items)').all().map((c) => c.name));
  for (const name of ['style', 'size', 'color', 'fabric']) {
    if (!petSkuColumns.has(name)) db.exec('ALTER TABLE sku_items ADD COLUMN ' + name + ' TEXT');
  }
  const abaColumns = db.prepare('PRAGMA table_info(aba_queries)').all().map((c) => c.name);
  for (const column of ['brand_impressions', 'brand_clicks', 'brand_purchases']) {
    if (!abaColumns.includes(column)) db.exec(`ALTER TABLE aba_queries ADD COLUMN ${column} INTEGER CHECK(${column} >= 0)`);
  }
  if (!db.prepare('PRAGMA table_info(sku_items)').all().some((c) => c.name === 'asin')) {
    db.exec('ALTER TABLE sku_items ADD COLUMN asin TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sku_asin ON sku_items (user_id, country, asin)');
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('goods_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN goods_admin INTEGER NOT NULL DEFAULT 0');
    console.log('[db] users 加上 goods_admin 列');
  }
  if (!cols.includes('manual_ads')) {
    db.exec('ALTER TABLE users ADD COLUMN manual_ads INTEGER NOT NULL DEFAULT 0');
    console.log('[db] users 加上 manual_ads 列');
  }
  if (!cols.includes('ad_opt')) {
    db.exec('ALTER TABLE users ADD COLUMN ad_opt INTEGER NOT NULL DEFAULT 0');
    console.log('[db] users 加上 ad_opt 列');
  }
  if (!cols.includes('seen_version')) {
    db.exec("ALTER TABLE users ADD COLUMN seen_version TEXT NOT NULL DEFAULT ''");
    console.log('[db] users 加上 seen_version 列');
  }
  if (!cols.includes('product_intel')) {
    db.exec('ALTER TABLE users ADD COLUMN product_intel INTEGER NOT NULL DEFAULT 0');
    console.log('[db] users 加上 product_intel 列');
  }

  const version = db.pragma('user_version', { simple: true });
  if (version < 1) {
    const old = db
      .prepare('SELECT marketplace, cat, term, note, created_by, created_at FROM neg_terms')
      .all();

    if (old.length) {
      // 旧库是按站点存的,B/C 现在按区域存,同区多个站点的词合并成一份
      const ins = db.prepare(
        `INSERT OR IGNORE INTO lib_items (lib, scope, term, asin, note, dedupe, created_by, created_at)
         VALUES (@lib, @scope, @term, @asin, @note, @dedupe, @created_by, @created_at)`
      );
      let moved = 0;
      db.transaction(() => {
        for (const r of old) {
          const region = regionOf(r.marketplace)?.id ?? null;
          const map = {
            irrel: { lib: 'A', scope: r.marketplace, term: r.term, asin: null },
            brand: { lib: 'B', scope: region, term: r.term, asin: null },
            model: { lib: 'C', scope: region, term: r.term, asin: null },
            asin: { lib: 'C', scope: region, term: null, asin: r.term },
          }[r.cat];
          if (!map || !map.scope) continue;
          moved += ins.run({
            ...map,
            dedupe: dedupeKey(libOf(map.lib), map),
            note: r.note,
            created_by: r.created_by,
            created_at: r.created_at,
          }).changes;
        }
      })();
      console.log(`[db] 旧词库搬进 lib_items:${moved} 条`);
    }

    // 老的分类设置用的是 model/brand/irrel/asin,新界面按 A–E 重新生成,直接丢掉
    db.exec("DELETE FROM neg_cat_config WHERE cat NOT IN ('A','B','C','D','E')");
    db.pragma('user_version = 1');
  }

  if (version < 2) {
    const productCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
    if (!productCols.includes('data_month')) {
      db.exec(`
        BEGIN;
        ALTER TABLE products RENAME TO products_before_months;
        DROP INDEX IF EXISTS idx_products_market_model;
        CREATE TABLE products (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          marketplace TEXT    NOT NULL,
          data_month  TEXT    NOT NULL DEFAULT 'legacy',
          source_file TEXT    NOT NULL DEFAULT '',
          asin        TEXT    NOT NULL,
          brand       TEXT,
          model       TEXT,
          color_group TEXT,
          data_json   TEXT    NOT NULL,
          created_by  INTEGER REFERENCES users(id),
          created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
          UNIQUE (marketplace, data_month, asin)
        );
        INSERT INTO products
          (id, marketplace, data_month, source_file, asin, brand, model, color_group,
           data_json, created_by, created_at, updated_at)
        SELECT id, marketplace, 'legacy', '', asin, brand, model, color_group,
               data_json, created_by, created_at, updated_at
        FROM products_before_months;
        DROP TABLE products_before_months;
        CREATE INDEX idx_products_market_model
          ON products (marketplace, model, color_group);
        COMMIT;
      `);
      console.log('[db] 产品库已按月份隔离，旧记录归入“历史数据”');
    }
    db.pragma('user_version = 2');
  }
}

/** 写一条操作留痕 */
export function audit(userId, marketplace, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (user_id, marketplace, action, entity, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    userId ?? null,
    marketplace ?? null,
    action,
    entity,
    entityId ?? null,
    detail ? JSON.stringify(detail) : null
  );
}

console.log(`[db] ${DB_PATH}`);
