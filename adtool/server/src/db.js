import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeKey, libOf, regionOf } from './libs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 所有数据只落在 DATA_DIR 里 —— 将来搬到别的机器就是拷这一个目录
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'adtool.db');
export const dataDir = DATA_DIR;
export const db = new Database(DB_PATH);

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
 */
function migrate() {
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

  if (db.pragma('user_version', { simple: true }) >= 1) return;

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
