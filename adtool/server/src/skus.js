import express from 'express';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { MARKETPLACES } from './libs.js';
import { SKU_COLS, dedupeKey, normRow } from './skuLib.js';

export const skuRouter = express.Router();

skuRouter.use(requireLogin);

const SELECT = `SELECT s.id, s.user_id, s.country, s.brand, s.model,
                       s.set_group AS setGroup, s.sku, s.stock, s.transit,
                       s.created_at, s.updated_at, u.display_name AS owner_name
                  FROM sku_items s LEFT JOIN users u ON u.id = s.user_id`;

/** 这一行是不是自己的 —— SKU 库谁传的谁改,超级管理员也只能看别人的,不能改 */
function ownRow(req, id) {
  const row = db.prepare('SELECT * FROM sku_items WHERE id = ?').get(id);
  if (!row) return { error: 404 };
  if (row.user_id !== req.session.user.id) return { error: 403 };
  return { row };
}

/**
 * 自己的 SKU 库。
 * ?marketplace=ES 只看某个站点;超级管理员加 ?scope=all 可以看全部账号的(只读)。
 */
skuRouter.get('/', (req, res) => {
  const me = req.session.user;
  const all = String(req.query.scope ?? '') === 'all' && me.role === 'owner';
  const mk = String(req.query.marketplace ?? '').toUpperCase();

  const where = [];
  const args = [];
  if (!all) { where.push('s.user_id = ?'); args.push(me.id); }
  if (mk) {
    if (!MARKETPLACES.includes(mk)) return res.status(400).json({ error: '站点不合法' });
    where.push('s.country = ?');
    args.push(mk);
  }
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
               ORDER BY s.country, s.brand, s.model, s.sku`;

  res.json({
    cols: SKU_COLS,
    marketplaces: MARKETPLACES,
    scope: all ? 'all' : 'mine',
    canViewAll: me.role === 'owner',
    items: db.prepare(sql).all(...args),
  });
});

/**
 * 写入一批行。
 * 同一个国家里同一个 SKU 再传一次算更新(库存会跟着变),不算重复。
 * replace=true 时先把这批数据里出现过的那几个国家清空 —— 月度整表更新用,
 * 传 ES 的表只会动 ES,不会误删别的国家。
 */
function saveRows(user, rows, replace) {
  const errors = [];
  const ok = [];
  const seen = new Set();

  rows.forEach((raw, i) => {
    if (!SKU_COLS.some((c) => String(raw?.[c.key] ?? '').trim())) return;   // 空行
    const r = normRow(raw);
    if (r.error) {
      errors.push(`第 ${i + 1} 行:${r.error}`);
      return;
    }
    const key = dedupeKey(r.row);
    if (seen.has(key)) return;      // 这一批里自己重复的,后一条为准
    seen.add(key);
    ok.push({ row: r.row, dedupe: key });
  });

  const ins = db.prepare(
    `INSERT INTO sku_items (user_id, country, brand, model, set_group, sku, stock, transit, dedupe)
     VALUES (@user_id, @country, @brand, @model, @setGroup, @sku, @stock, @transit, @dedupe)
     ON CONFLICT (user_id, dedupe) DO UPDATE SET
       brand = excluded.brand, model = excluded.model, set_group = excluded.set_group,
       sku = excluded.sku, stock = excluded.stock, transit = excluded.transit,
       updated_at = datetime('now', 'localtime')`
  );
  const exists = db.prepare('SELECT id FROM sku_items WHERE user_id = ? AND dedupe = ?');

  let added = 0;
  let updated = 0;
  let removed = 0;
  const countries = [...new Set(ok.map((x) => x.row.country))];

  db.transaction(() => {
    if (replace) {
      for (const c of countries) {
        removed += db.prepare('DELETE FROM sku_items WHERE user_id = ? AND country = ?')
          .run(user.id, c).changes;
      }
    }
    for (const { row, dedupe } of ok) {
      const had = !replace && exists.get(user.id, dedupe);
      ins.run({ ...row, user_id: user.id, dedupe });
      if (had) updated++;
      else added++;
    }
  })();

  if (added || updated || removed) {
    audit(user.id, countries.length === 1 ? countries[0] : null,
      replace ? 'replace' : 'import', 'sku_items', null,
      { added, updated, removed, countries });
  }
  return { added, updated, removed, errors: errors.slice(0, 20), errorCount: errors.length };
}

/** 结构化批量写入,前端读完 Excel 按列名映射好再发过来 */
skuRouter.post('/rows', (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: '没有要写入的行' });
  if (rows.length > 20000) return res.status(400).json({ error: '一次最多 20000 行,分批传' });
  res.json(saveRows(req.session.user, rows, !!req.body?.replace));
});

/**
 * 整段文本批量写入。从 Excel 直接复制过来就行(列之间是 Tab),
 * 也认 ~ 和 | 分隔。SKU 和型号本身带 - ,所以不拿 - 当分隔符。
 */
skuRouter.post('/bulk', (req, res) => {
  const rows = [];
  for (const line of String(req.body?.text ?? '').replace(/\r/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.split(/\s*[~|]\s*/);
    const row = {};
    SKU_COLS.forEach((c, i) => { row[c.key] = parts[i] ?? ''; });
    rows.push(row);
  }
  if (!rows.length) return res.status(400).json({ error: '没有要写入的行' });
  res.json(saveRows(req.session.user, rows, !!req.body?.replace));
});

/** 改一行(只能改自己的) */
skuRouter.patch('/:id', (req, res) => {
  const found = ownRow(req, Number(req.params.id));
  if (found.error === 404) return res.status(404).json({ error: '这一行不存在' });
  if (found.error === 403) return res.status(403).json({ error: 'SKU 库是各账号自己的,改不了别人的行' });

  const cur = found.row;
  const merged = {
    country: req.body?.country ?? cur.country,
    brand: req.body?.brand ?? cur.brand,
    model: req.body?.model ?? cur.model,
    setGroup: req.body?.setGroup ?? cur.set_group,
    sku: req.body?.sku ?? cur.sku,
    stock: req.body?.stock ?? cur.stock,
    transit: req.body?.transit ?? cur.transit,
  };
  const r = normRow(merged);
  if (r.error) return res.status(400).json({ error: r.error });

  const dedupe = dedupeKey(r.row);
  const clash = db
    .prepare('SELECT id FROM sku_items WHERE user_id = ? AND dedupe = ? AND id != ?')
    .get(req.session.user.id, dedupe, cur.id);
  if (clash) return res.status(409).json({ error: '同一个国家里已经有这个 SKU 了' });

  db.prepare(
    `UPDATE sku_items SET country = @country, brand = @brand, model = @model,
            set_group = @setGroup, sku = @sku, stock = @stock, transit = @transit,
            dedupe = @dedupe, updated_at = datetime('now', 'localtime')
      WHERE id = @id`
  ).run({ ...r.row, dedupe, id: cur.id });

  audit(req.session.user.id, r.row.country, 'update', 'sku_items', cur.id, { sku: r.row.sku });
  res.json({ ok: true });
});

/** 删除若干行(只删得掉自己的) */
skuRouter.post('/delete', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map(Number)
    .filter((n) => Number.isInteger(n));
  if (!ids.length) return res.status(400).json({ error: '没有要删的行' });

  const del = db.prepare('DELETE FROM sku_items WHERE id = ? AND user_id = ?');
  let deleted = 0;
  db.transaction(() => {
    for (const id of ids) deleted += del.run(id, req.session.user.id).changes;
  })();

  if (deleted) audit(req.session.user.id, null, 'delete', 'sku_items', null, { count: deleted });
  res.json({ deleted, skipped: ids.length - deleted });
});
