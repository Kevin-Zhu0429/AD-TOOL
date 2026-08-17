import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, canRead, canWrite, MARKETPLACES } from './auth.js';

export const negRouter = express.Router();

export const CATS = [
  { id: 'model', name: '型号', kw: true, desc: '本店不卖 / 没有的墨盒、打印机型号' },
  { id: 'brand', name: '品牌', kw: true, desc: '不投的品牌、友商品牌' },
  { id: 'irrel', name: '无关词', kw: true, desc: '品类外 / 意图不符的词' },
  { id: 'asin', name: '否定ASIN', kw: false, desc: '榜单上无关的热卖 ASIN' },
];

const ASIN_RE = /^B0[0-9A-Z]{8}$/;
const KW_MAX = 80;

function normTerm(cat, raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { error: '空词' };
  if (cat === 'asin') {
    const m = s.match(/^asin\s*=\s*"?([^"]+)"?$/i);
    const code = (m ? m[1] : s).trim().toUpperCase();
    if (!ASIN_RE.test(code)) return { error: `ASIN 格式不对: ${s.slice(0, 20)}` };
    return { term: code };
  }
  if (s.length > KW_MAX) return { error: `超过 ${KW_MAX} 字符: ${s.slice(0, 20)}…` };
  return { term: s };
}

/** 从 query 或 body 拿站点并校验权限 */
function resolveMarket(req, res, needWrite) {
  const mk = String(req.query.marketplace || req.body?.marketplace || '').toUpperCase();
  if (!MARKETPLACES.includes(mk)) {
    res.status(400).json({ error: '站点不合法' });
    return null;
  }
  const u = req.session.user;
  if (!canRead(u, mk)) {
    res.status(403).json({ error: '无权访问该站点' });
    return null;
  }
  if (needWrite && !canWrite(u, mk)) {
    res.status(403).json({ error: '你不负责这个站点,改不了它的词库' });
    return null;
  }
  return mk;
}

function ensureConfig(mk) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO neg_cat_config (marketplace, cat, enabled, match_type, level)
     VALUES (?, ?, 1, ?, 'camp')`
  );
  for (const c of CATS) ins.run(mk, c.id, c.kw ? '否定词组' : '');
}

negRouter.use(requireLogin);

/** 取某站点全部词库 + 分类设置 */
negRouter.get('/', (req, res) => {
  const mk = resolveMarket(req, res, false);
  if (!mk) return;
  ensureConfig(mk);

  const terms = db
    .prepare(
      `SELECT n.id, n.cat, n.term, n.note, n.created_at, u.display_name AS created_by_name
         FROM neg_terms n LEFT JOIN users u ON u.id = n.created_by
        WHERE n.marketplace = ? ORDER BY n.cat, n.id DESC`
    )
    .all(mk);

  const config = db
    .prepare('SELECT cat, enabled, match_type, level FROM neg_cat_config WHERE marketplace = ?')
    .all(mk);

  res.json({
    marketplace: mk,
    cats: CATS,
    terms,
    config,
    canEdit: canWrite(req.session.user, mk),
  });
});

/** 批量新增,整段文本一行一个词 */
negRouter.post('/bulk', (req, res) => {
  const mk = resolveMarket(req, res, true);
  if (!mk) return;

  const { cat, text } = req.body ?? {};
  if (!CATS.some((c) => c.id === cat)) {
    return res.status(400).json({ error: '分类不合法' });
  }

  const errors = [];
  const ok = [];
  const seen = new Set();

  for (const line of String(text ?? '').replace(/\r/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    const r = normTerm(cat, line);
    if (r.error) {
      errors.push(r.error);
      continue;
    }
    const key = r.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ok.push(r.term);
  }

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO neg_terms (marketplace, cat, term, created_by) VALUES (?, ?, ?, ?)`
  );
  let added = 0;
  let dup = 0;
  db.transaction((list) => {
    for (const t of list) {
      if (stmt.run(mk, cat, t, req.session.user.id).changes) added++;
      else dup++;
    }
  })(ok);

  if (added) audit(req.session.user.id, mk, 'import', 'neg_terms', null, { cat, added });
  res.json({ added, duplicated: dup, errors: errors.slice(0, 20), errorCount: errors.length });
});

/** 改一个词 */
negRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM neg_terms WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '词不存在' });
  if (!canWrite(req.session.user, row.marketplace)) {
    return res.status(403).json({ error: '你不负责这个站点,改不了它的词库' });
  }

  const { term, note } = req.body ?? {};
  let nextTerm = row.term;
  if (term !== undefined) {
    const r = normTerm(row.cat, term);
    if (r.error) return res.status(400).json({ error: r.error });
    nextTerm = r.term;
  }

  try {
    db.prepare(
      `UPDATE neg_terms SET term = ?, note = ?, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(nextTerm, note ?? row.note, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '这个词已经在库里了' });
    }
    throw e;
  }
  audit(req.session.user.id, row.marketplace, 'update', 'neg_terms', id, {
    from: row.term,
    to: nextTerm,
  });
  res.json({ ok: true });
});

/** 删除,支持批量 */
negRouter.post('/delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: '没有要删除的词' });

  const rows = db
    .prepare(`SELECT * FROM neg_terms WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  if (!rows.length) return res.json({ deleted: 0 });

  for (const r of rows) {
    if (!canWrite(req.session.user, r.marketplace)) {
      return res.status(403).json({ error: '你不负责这个站点,改不了它的词库' });
    }
  }

  const stmt = db.prepare('DELETE FROM neg_terms WHERE id = ?');
  db.transaction((list) => list.forEach((r) => stmt.run(r.id)))(rows);

  audit(req.session.user.id, rows[0].marketplace, 'delete', 'neg_terms', null, {
    count: rows.length,
    sample: rows.slice(0, 5).map((r) => r.term),
  });
  res.json({ deleted: rows.length });
});

/** 改分类默认设置 */
negRouter.post('/config', (req, res) => {
  const mk = resolveMarket(req, res, true);
  if (!mk) return;
  const { cat, enabled, matchType, level } = req.body ?? {};
  if (!CATS.some((c) => c.id === cat)) {
    return res.status(400).json({ error: '分类不合法' });
  }
  ensureConfig(mk);
  const cur = db
    .prepare('SELECT * FROM neg_cat_config WHERE marketplace = ? AND cat = ?')
    .get(mk, cat);

  db.prepare(
    `UPDATE neg_cat_config SET enabled = ?, match_type = ?, level = ? WHERE marketplace = ? AND cat = ?`
  ).run(
    enabled === undefined ? cur.enabled : enabled ? 1 : 0,
    matchType ?? cur.match_type,
    level ?? cur.level,
    mk,
    cat
  );
  res.json({ ok: true });
});
