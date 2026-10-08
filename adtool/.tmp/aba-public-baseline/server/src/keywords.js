import express from 'express';
import { db, audit } from './db.js';
import { requireLogin, canRead, canWrite, canWriteLib, libPerms } from './auth.js';
import {
  LIBS, MARKETPLACES, cleanCell, dedupeKey, libOf, marketsOfScope, normRow, regionOf, scopeFor,
} from './libs.js';

export const negRouter = express.Router();

export { LIBS };

/** 每一类词库的默认套用方式,第一次打开某个站点时写进去 */
const DEFAULT_CONFIG = {
  A: { enabled: 1, match_type: '否定词组', level: 'camp' },
  B: { enabled: 1, match_type: '否定词组', level: 'camp' },
  C: { enabled: 1, match_type: '否定词组', level: 'camp' },
  D: { enabled: 1, match_type: '否定词组', level: 'camp' },
  // E 数据格式还没定,默认不往广告里带
  E: { enabled: 0, match_type: '', level: 'camp' },
};

const COLS = ['term', 'brand', 'series', 'printer', 'asin'];

/** 从 query 或 body 拿站点并校验读权限 */
function resolveMarket(req, res) {
  const mk = String(req.query.marketplace || req.body?.marketplace || '').toUpperCase();
  if (!MARKETPLACES.includes(mk)) {
    res.status(400).json({ error: '站点不合法' });
    return null;
  }
  if (!canRead(req.session.user, mk)) {
    res.status(403).json({ error: '无权访问该站点' });
    return null;
  }
  return mk;
}

/**
 * 拿到「这个站点的这一类词库实际读写哪个 scope」,顺带把权限判掉。
 * needWrite=true 时,A 类看站点归属,B/C/D/E 类看有没有商品部维护权。
 */
function resolveTarget(req, res, needWrite) {
  const mk = resolveMarket(req, res);
  if (!mk) return null;

  const lib = libOf(req.body?.lib ?? req.query.lib);
  if (!lib) {
    res.status(400).json({ error: '词库类型不合法' });
    return null;
  }
  const scope = scopeFor(lib, mk);
  if (!scope) {
    res.status(400).json({ error: `${mk} 站不在「${lib.name}」的覆盖范围里` });
    return null;
  }
  if (needWrite && !canWriteLib(req.session.user, lib, mk)) {
    res.status(403).json({
      error: lib.owner === 'goods'
        ? `「${lib.name}」由${lib.ownerName}维护,你这边是只读的`
        : '你不负责这个站点,改不了它的词库',
    });
    return null;
  }
  return { mk, lib, scope };
}

function ensureConfig(mk) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO neg_cat_config (marketplace, cat, enabled, match_type, level)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const lib of LIBS) {
    const d = DEFAULT_CONFIG[lib.id];
    ins.run(mk, lib.id, d.enabled, d.match_type, d.level);
  }
}

/** 某个 scope 下某一类词库的全部行 */
function itemsOf(lib, scope) {
  return db
    .prepare(
      `SELECT i.id, i.lib, i.scope, i.term, i.brand, i.series, i.printer, i.asin, i.note,
              i.created_at, u.display_name AS created_by_name
         FROM lib_items i LEFT JOIN users u ON u.id = i.created_by
        WHERE i.lib = ? AND i.scope = ?
        ORDER BY i.id`
    )
    .all(lib.id, scope);
}

negRouter.use(requireLogin);

/** 取某站点看得到的五类词库 + 套用设置 */
negRouter.get('/', (req, res) => {
  const mk = resolveMarket(req, res);
  if (!mk) return;
  ensureConfig(mk);

  const perms = libPerms(req.session.user, mk);
  const scopes = {};
  const items = {};
  for (const lib of LIBS) {
    const scope = scopeFor(lib, mk);
    scopes[lib.id] = scope
      ? { scope, markets: marketsOfScope(lib, scope), region: lib.scope === 'region' ? scope : null }
      : null;
    items[lib.id] = scope ? itemsOf(lib, scope) : [];
  }

  const config = db
    .prepare('SELECT cat AS lib, enabled, match_type, level FROM neg_cat_config WHERE marketplace = ?')
    .all(mk)
    .filter((c) => LIBS.some((l) => l.id === c.lib));

  res.json({
    marketplace: mk,
    region: regionOf(mk),
    libs: LIBS,
    scopes,
    items,
    config,
    perms,
  });
});

/** 写入一批行。replace=true 时先把该 scope 下这一类清空(月度整表更新用) */
function insertRows(target, rows, replace, user) {
  const { lib, scope, mk } = target;
  const errors = [];
  const ok = [];
  const seen = new Set();

  rows.forEach((raw, i) => {
    const r = normRow(lib, raw);
    if (r.error) {
      if (r.error !== '空行') errors.push(`第 ${i + 1} 行:${r.error}`);
      return;
    }
    const key = dedupeKey(lib, r.row);
    if (seen.has(key)) return; // 这一批里自己重复的,静默跳过
    seen.add(key);
    ok.push({ row: r.row, dedupe: key });
  });

  const ins = db.prepare(
    `INSERT OR IGNORE INTO lib_items
       (lib, scope, term, brand, series, printer, asin, note, dedupe, created_by)
     VALUES (@lib, @scope, @term, @brand, @series, @printer, @asin, @note, @dedupe, @created_by)`
  );

  let added = 0;
  let dup = 0;
  let removed = 0;
  db.transaction(() => {
    if (replace) {
      removed = db.prepare('DELETE FROM lib_items WHERE lib = ? AND scope = ?')
        .run(lib.id, scope).changes;
    }
    for (const { row, dedupe } of ok) {
      const params = { lib: lib.id, scope, dedupe, created_by: user.id, note: row.note ?? null };
      for (const c of COLS) params[c] = row[c] ?? null;
      if (ins.run(params).changes) added++;
      else dup++;
    }
  })();

  if (added || removed) {
    audit(user.id, mk, replace ? 'replace' : 'import', 'lib_items', null, {
      lib: lib.id, scope, added, removed,
    });
  }
  return { added, duplicated: dup, removed, errors: errors.slice(0, 20), errorCount: errors.length };
}

/** 结构化批量写入,前端读 Excel 后按列名映射好再发过来 */
negRouter.post('/rows', (req, res) => {
  const target = resolveTarget(req, res, true);
  if (!target) return;

  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: '没有要写入的行' });
  if (rows.length > 20000) return res.status(400).json({ error: '一次最多 20000 行,分批传' });

  res.json(insertRows(target, rows, !!req.body?.replace, req.session.user));
});

/**
 * 整段文本批量写入。
 * 单列词库:一行一个词。
 * 多列词库:从 Excel 直接复制过来即可(列之间是 Tab);没有 Tab 时按逗号切,
 *          但 D 类除外 —— 它的墨盒型号本身就写成「575, 576」,逗号不能当分隔符。
 */
negRouter.post('/bulk', (req, res) => {
  const target = resolveTarget(req, res, true);
  if (!target) return;
  const { lib } = target;

  const rows = [];
  for (const line of String(req.body?.text ?? '').replace(/\r/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    if (lib.cols.length === 1) {
      rows.push({ [lib.cols[0].key]: line });
      continue;
    }
    let parts = line.split('\t');
    if (parts.length === 1 && lib.id !== 'D') parts = line.split(/[,，]/);
    const row = {};
    lib.cols.forEach((c, i) => { row[c.key] = parts[i] ?? ''; });
    rows.push(row);
  }
  if (!rows.length) return res.status(400).json({ error: '没读到内容' });

  res.json(insertRows(target, rows, !!req.body?.replace, req.session.user));
});

/** 改一行 */
negRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM lib_items WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '这一行不存在' });

  const lib = libOf(row.lib);
  if (!lib) return res.status(400).json({ error: '词库类型不合法' });

  // 区域库改的是整个区域,权限按锚点站点判(商品部通吃,其他人改不了)
  const mk = lib.scope === 'market' ? row.scope : marketsOfScope(lib, row.scope)[0];
  if (!canWriteLib(req.session.user, lib, mk)) {
    return res.status(403).json({
      error: lib.owner === 'goods'
        ? `「${lib.name}」由${lib.ownerName}维护,你这边是只读的`
        : '你不负责这个站点,改不了它的词库',
    });
  }

  const merged = {};
  for (const c of lib.cols) {
    merged[c.key] = req.body?.[c.key] === undefined ? row[c.key] : req.body[c.key];
  }
  merged.note = req.body?.note === undefined ? row.note : req.body.note;

  const r = normRow(lib, merged);
  if (r.error) return res.status(400).json({ error: r.error });

  const params = { id, dedupe: dedupeKey(lib, r.row), note: r.row.note ?? null };
  for (const c of COLS) params[c] = r.row[c] ?? null;

  try {
    db.prepare(
      `UPDATE lib_items
          SET term = @term, brand = @brand, series = @series, printer = @printer,
              asin = @asin, note = @note, dedupe = @dedupe,
              updated_at = datetime('now','localtime')
        WHERE id = @id`
    ).run(params);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '这一条已经在库里了' });
    }
    throw e;
  }

  audit(req.session.user.id, mk, 'update', 'lib_items', id, { lib: lib.id, scope: row.scope });
  res.json({ ok: true });
});

/** 删除,支持批量 */
negRouter.post('/delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: '没有要删除的行' });
  if (ids.length > 20000) return res.status(400).json({ error: '一次最多删 20000 行' });

  const rows = db
    .prepare(`SELECT * FROM lib_items WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  if (!rows.length) return res.json({ deleted: 0 });

  for (const r of rows) {
    const lib = libOf(r.lib);
    if (!lib) return res.status(400).json({ error: '这一行的词库类型不合法' });
    const mk = lib.scope === 'market' ? r.scope : marketsOfScope(lib, r.scope)[0];
    if (!canWriteLib(req.session.user, lib, mk)) {
      return res.status(403).json({ error: '这里面有你改不了的词库' });
    }
  }

  const stmt = db.prepare('DELETE FROM lib_items WHERE id = ?');
  db.transaction((list) => list.forEach((r) => stmt.run(r.id)))(rows);

  const first = rows[0];
  audit(req.session.user.id, null, 'delete', 'lib_items', null, {
    lib: first.lib,
    scope: first.scope,
    count: rows.length,
    sample: rows.slice(0, 5).map((r) => r.term ?? r.asin),
  });
  res.json({ deleted: rows.length });
});

/** 改某个站点某一类词库的套用设置(只影响这个站点生成的广告) */
negRouter.post('/config', (req, res) => {
  const mk = resolveMarket(req, res);
  if (!mk) return;
  const lib = libOf(req.body?.lib);
  if (!lib) return res.status(400).json({ error: '词库类型不合法' });
  // 套用设置是「这个站点开广告时怎么用」,归站点负责人管,不需要商品部权限
  if (!canWrite(req.session.user, mk)) {
    return res.status(403).json({ error: '你不负责这个站点,改不了它的套用设置' });
  }

  ensureConfig(mk);
  const cur = db
    .prepare('SELECT * FROM neg_cat_config WHERE marketplace = ? AND cat = ?')
    .get(mk, lib.id);

  const { enabled, matchType, level } = req.body ?? {};
  db.prepare(
    `UPDATE neg_cat_config SET enabled = ?, match_type = ?, level = ?
      WHERE marketplace = ? AND cat = ?`
  ).run(
    enabled === undefined ? cur.enabled : enabled ? 1 : 0,
    matchType === undefined ? cur.match_type : cleanCell(matchType),
    level === undefined ? cur.level : cleanCell(level),
    mk,
    lib.id
  );
  audit(req.session.user.id, mk, 'update', 'neg_cat_config', null, { lib: lib.id });
  res.json({ ok: true });
});
