import { businessUserId } from './profile.js';
import express from 'express';
import { db, audit } from './db.js';
import { canRead, requireLogin } from './auth.js';
import { MARKETPLACES } from './libs.js';

export const portfolioRouter = express.Router();
portfolioRouter.use(requireLogin);

const COLS = [
  { key: 'portfolioId', label: '广告组合编号', required: true, width: 22 },
  { key: 'name', label: '广告组合名称', required: true, width: 28 },
];

function marketplace(req, res) {
  const value = String(req.query.marketplace ?? req.body?.marketplace ?? '').trim().toUpperCase();
  if (!MARKETPLACES.includes(value)) {
    res.status(400).json({ error: '站点不合法' });
    return '';
  }
  if (!canRead(req.session.user, value)) {
    res.status(403).json({ error: `没有 ${value} 站的访问权限` });
    return '';
  }
  return value;
}

function normRow(raw) {
  const portfolioId = String(raw?.portfolioId ?? raw?.portfolio_id ?? '').trim();
  const name = String(raw?.name ?? '').trim();
  if (!portfolioId) return { error: '广告组合编号不能为空' };
  if (!/^\d{1,30}$/.test(portfolioId)) return { error: '广告组合编号只能填写数字' };
  if (!name) return { error: '广告组合名称不能为空' };
  if (name.length > 200) return { error: '广告组合名称最多 200 个字符' };
  return { row: { portfolioId, name } };
}

portfolioRouter.get('/', (req, res) => {
  const mk = marketplace(req, res);
  if (!mk) return;
  const items = db.prepare(
    `SELECT id, portfolio_id AS portfolioId, name, created_at, updated_at
       FROM portfolio_items
      WHERE user_id = ? AND marketplace = ?
      ORDER BY name COLLATE NOCASE, portfolio_id`
  ).all(businessUserId(req.session.user.id), mk);
  res.json({ cols: COLS, marketplace: mk, items });
});

portfolioRouter.post('/rows', (req, res) => {
  const mk = marketplace(req, res);
  if (!mk) return;
  const input = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!input) return res.status(400).json({ error: '没有要写入的行' });
  if (input.length > 5000) return res.status(400).json({ error: '一次最多导入 5000 行' });

  const errors = [];
  const rows = new Map();
  input.forEach((raw, index) => {
    if (!String(raw?.portfolioId ?? raw?.portfolio_id ?? '').trim() && !String(raw?.name ?? '').trim()) return;
    const result = normRow(raw);
    if (result.error) errors.push(`第 ${index + 1} 行：${result.error}`);
    else rows.set(result.row.portfolioId, result.row);
  });
  if (errors.length) return res.status(400).json({ error: errors.slice(0, 5).join('；'), errorCount: errors.length });
  if (!rows.size) return res.status(400).json({ error: '没有有效的数据行' });

  const exists = db.prepare('SELECT id FROM portfolio_items WHERE user_id = ? AND marketplace = ? AND portfolio_id = ?');
  const upsert = db.prepare(
    `INSERT INTO portfolio_items (user_id, marketplace, portfolio_id, name)
     VALUES (@userId, @marketplace, @portfolioId, @name)
     ON CONFLICT (user_id, marketplace, portfolio_id) DO UPDATE SET
       name = excluded.name, updated_at = datetime('now', 'localtime')`
  );
  let added = 0;
  let updated = 0;
  let removed = 0;
  db.transaction(() => {
    if (req.body?.replace) {
      removed = db.prepare('DELETE FROM portfolio_items WHERE user_id = ? AND marketplace = ?')
        .run(businessUserId(req.session.user.id), mk).changes;
    }
    for (const row of rows.values()) {
      const had = !req.body?.replace && exists.get(businessUserId(req.session.user.id), mk, row.portfolioId);
      upsert.run({ ...row, userId: businessUserId(req.session.user.id), marketplace: mk });
      if (had) updated += 1;
      else added += 1;
    }
  })();
  audit(req.session.user.id, mk, req.body?.replace ? 'replace' : 'import', 'portfolio_items', null, { added, updated, removed });
  res.json({ added, updated, removed });
});

portfolioRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM portfolio_items WHERE id = ? AND user_id = ?')
    .get(id, businessUserId(req.session.user.id));
  if (!current) return res.status(404).json({ error: '这一行不存在' });
  const result = normRow({
    portfolioId: req.body?.portfolioId ?? current.portfolio_id,
    name: req.body?.name ?? current.name,
  });
  if (result.error) return res.status(400).json({ error: result.error });
  try {
    db.prepare(
      `UPDATE portfolio_items SET portfolio_id = ?, name = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ? AND user_id = ?`
    ).run(result.row.portfolioId, result.row.name, id, businessUserId(req.session.user.id));
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '这个广告组合编号已经存在' });
    throw error;
  }
  audit(req.session.user.id, current.marketplace, 'update', 'portfolio_items', id, result.row);
  res.json({ ok: true });
});

portfolioRouter.post('/delete', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) return res.status(400).json({ error: '没有要删除的行' });
  const remove = db.prepare('DELETE FROM portfolio_items WHERE id = ? AND user_id = ?');
  let deleted = 0;
  db.transaction(() => { for (const id of ids) deleted += remove.run(id, businessUserId(req.session.user.id)).changes; })();
  if (deleted) audit(req.session.user.id, null, 'delete', 'portfolio_items', null, { count: deleted });
  res.json({ deleted, skipped: ids.length - deleted });
});
