import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
