import express from 'express';
import { db, audit } from './db.js';
import { canRead, requireLogin } from './auth.js';
import { MARKETPLACES } from './libs.js';

export const productRouter = express.Router();

function requireProductIntel(req, res, next) {
  requireLogin(req, res, () => {
    if (!req.session.user.productIntel) {
      return res.status(403).json({ error: '账号未开通产品库与竞品分析功能' });
    }
    next();
  });
}

function marketFrom(value) {
  return String(value ?? '').trim().toUpperCase();
}

function authorizeMarket(req, res) {
  const marketplace = marketFrom(req.query.marketplace ?? req.body?.marketplace);
  if (!marketplace || !canRead(req.session.user, marketplace)) {
    res.status(403).json({ error: '无权访问这个站点' });
    return null;
  }
  return marketplace;
}

function cleanText(value, max = 5000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanDataMonth(value, allowLegacy = false) {
  const month = cleanText(value, 20);
  if (/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(month)) return month;
  if (allowLegacy && month === 'legacy') return month;
  return '';
}

function latestDataMonth(marketplace) {
  return db.prepare(
    `SELECT data_month FROM products WHERE marketplace = ?
     ORDER BY data_month = 'legacy', data_month DESC LIMIT 1`
  ).pluck().get(marketplace) ?? '';
}

function cleanProduct(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const product = { ...input };
  const asin = cleanText(product.asin, 24).toUpperCase();
  if (!asin) return null;
  product.asin = asin;
  product.brand = cleanText(product.brand, 120);
  product.model = cleanText(product.model, 120);
  product.color_grp = cleanText(product.color_grp, 40);
  product._manual = Array.isArray(product._manual)
    ? product._manual.filter((key) => key === 'brand' || key === 'color_grp')
    : [];
  for (const key of Object.keys(product)) {
    if (typeof product[key] === 'string') product[key] = cleanText(product[key]);
  }
  return product;
}

function rowToProduct(row) {
  try {
    return JSON.parse(row.data_json);
  } catch {
    return { asin: row.asin, brand: row.brand, model: row.model, color_grp: row.color_group };
  }
}

function importProductsForMarket(marketplace, rawProducts, dataMonth, sourceFile, userId) {
  const incoming = new Map();
  let skipped = 0;
  for (const raw of rawProducts) {
    const product = cleanProduct(raw);
    if (!product) {
      skipped += 1;
      continue;
    }
    incoming.set(product.asin, product);
  }

  const current = new Map(
    db.prepare('SELECT * FROM products WHERE marketplace = ? AND data_month = ?').all(marketplace, dataMonth)
      .map((row) => [row.asin, rowToProduct(row)])
  );
  const upsert = db.prepare(
    `INSERT INTO products
       (marketplace, data_month, source_file, asin, brand, model, color_group, data_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(marketplace, data_month, asin) DO UPDATE SET
       source_file = excluded.source_file,
       brand = excluded.brand,
       model = excluded.model,
       color_group = excluded.color_group,
       data_json = excluded.data_json,
       updated_at = datetime('now', 'localtime')`
  );

  let added = 0;
  let updated = 0;
  for (const [asin, product] of incoming) {
    const old = current.get(asin);
    if (old) {
      const manual = new Set(old._manual ?? []);
      for (const field of ['brand', 'color_grp']) {
        if (manual.has(field) && cleanText(old[field])) product[field] = old[field];
      }
      product._manual = [...manual];
      updated += 1;
    } else {
      added += 1;
    }
    upsert.run(
      marketplace, dataMonth, sourceFile, asin, product.brand, product.model, product.color_grp,
      JSON.stringify(product), userId
    );
  }
  return { added, updated, skipped, total: incoming.size, received: rawProducts.length };
}

const saveMarketImports = db.transaction((entries, dataMonth, sourceFile, userId) => Object.fromEntries(
  entries.map(([marketplace, products]) => [
    marketplace,
    importProductsForMarket(marketplace, products, dataMonth, sourceFile, userId),
  ])
));

function importTotals(results) {
  return Object.values(results).reduce((totals, result) => ({
    added: totals.added + result.added,
    updated: totals.updated + result.updated,
    skipped: totals.skipped + result.skipped,
    total: totals.total + result.total,
    received: totals.received + result.received,
  }), { added: 0, updated: 0, skipped: 0, total: 0, received: 0 });
}

productRouter.use(requireProductIntel);

productRouter.get('/', (req, res) => {
  const marketplace = authorizeMarket(req, res);
  if (!marketplace) return;
  const requestedMonth = cleanDataMonth(req.query.dataMonth, true);
  if (req.query.dataMonth && !requestedMonth) {
    return res.status(400).json({ error: '数据月份格式不正确' });
  }
  const months = db.prepare(
    `SELECT data_month AS month, COUNT(*) AS count, MAX(source_file) AS source_file
     FROM products WHERE marketplace = ? GROUP BY data_month
     ORDER BY data_month = 'legacy', data_month DESC`
  ).all(marketplace);
  const dataMonth = requestedMonth && months.some((item) => item.month === requestedMonth)
    ? requestedMonth
    : months[0]?.month || '';
  const products = db.prepare(
    'SELECT * FROM products WHERE marketplace = ? AND data_month = ? ORDER BY id'
  ).all(marketplace, dataMonth).map(rowToProduct);
  const settings = db.prepare(
    'SELECT own_brand, min_sales FROM product_settings WHERE marketplace = ?'
  ).get(marketplace) ?? { own_brand: '', min_sales: 100 };
  res.json({ products, settings, months, dataMonth });
});

productRouter.post('/import', (req, res) => {
  const marketplace = authorizeMarket(req, res);
  if (!marketplace) return;
  if (!Array.isArray(req.body?.products) || req.body.products.length > 20_000) {
    return res.status(400).json({ error: '产品数据格式不正确，单次最多 20000 条' });
  }
  const dataMonth = cleanDataMonth(req.body?.dataMonth);
  if (!dataMonth) return res.status(400).json({ error: '请提供文件名中的数据月份' });
  const sourceFile = cleanText(req.body?.sourceFile, 255);
  const results = saveMarketImports(
    [[marketplace, req.body.products]], dataMonth, sourceFile, req.session.user.id
  );
  const result = results[marketplace];
  audit(req.session.user.id, marketplace, 'import', 'products', null, {
    ...result, dataMonth, sourceFile,
  });
  res.json({ ...result, dataMonth });
});

productRouter.post('/import-all', (req, res) => {
  const groups = req.body?.productsByMarketplace;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    return res.status(400).json({ error: '分市场产品数据格式不正确' });
  }

  const combined = new Map();
  let received = 0;
  for (const [rawMarket, products] of Object.entries(groups)) {
    const marketplace = marketFrom(rawMarket);
    if (!MARKETPLACES.includes(marketplace)) {
      return res.status(400).json({ error: `无法识别国家：${cleanText(rawMarket, 20) || '空白'}` });
    }
    if (!canRead(req.session.user, marketplace)) {
      return res.status(403).json({ error: `无权导入 ${marketplace} 站产品数据` });
    }
    if (!Array.isArray(products)) {
      return res.status(400).json({ error: `${marketplace} 站产品数据格式不正确` });
    }
    received += products.length;
    combined.set(marketplace, [...(combined.get(marketplace) ?? []), ...products]);
  }
  if (!combined.size || received > 20_000) {
    return res.status(400).json({ error: '产品数据格式不正确，单次最多 20000 条' });
  }

  const dataMonth = cleanDataMonth(req.body?.dataMonth);
  if (!dataMonth) return res.status(400).json({ error: '无法从文件名识别数据月份' });
  const sourceFile = cleanText(req.body?.sourceFile, 255);
  const results = saveMarketImports([...combined], dataMonth, sourceFile, req.session.user.id);
  for (const [marketplace, result] of Object.entries(results)) {
    audit(req.session.user.id, marketplace, 'import', 'products', null, {
      ...result, dataMonth, sourceFile,
    });
  }
  res.json({ markets: results, totals: importTotals(results), dataMonth });
});

productRouter.patch('/:asin', (req, res) => {
  const marketplace = authorizeMarket(req, res);
  if (!marketplace) return;
  const asin = cleanText(req.params.asin, 24).toUpperCase();
  const requestedMonth = cleanDataMonth(req.body?.dataMonth, true);
  if (req.body?.dataMonth && !requestedMonth) {
    return res.status(400).json({ error: '数据月份格式不正确' });
  }
  const dataMonth = requestedMonth || latestDataMonth(marketplace);
  const row = db.prepare(
    'SELECT * FROM products WHERE marketplace = ? AND data_month = ? AND asin = ?'
  ).get(marketplace, dataMonth, asin);
  if (!row) return res.status(404).json({ error: '产品不存在' });

  const current = rowToProduct(row);
  const allowed = new Set([
    'brand', 'model', 'color_grp', 'color', 'price', 'rating', 'reviews',
    'reviews_new', 'child_sales', 'sales', 'bsr_small', 'days', 'ship', 'title',
  ]);
  const changes = req.body?.changes;
  if (!changes || typeof changes !== 'object') {
    return res.status(400).json({ error: '没有要保存的改动' });
  }
  const touched = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed.has(key)) continue;
    current[key] = typeof value === 'string' ? cleanText(value) : value;
    if (key === 'brand' || key === 'color_grp') {
      current._manual = [...new Set([...(current._manual ?? []), key])];
    }
    touched.push(key);
  }
  const product = cleanProduct(current);
  db.prepare(
    `UPDATE products SET brand = ?, model = ?, color_group = ?, data_json = ?,
       updated_at = datetime('now', 'localtime')
     WHERE marketplace = ? AND data_month = ? AND asin = ?`
  ).run(
    product.brand, product.model, product.color_grp, JSON.stringify(product),
    marketplace, dataMonth, asin
  );
  audit(req.session.user.id, marketplace, 'update', 'product', row.id, {
    asin, dataMonth, fields: touched,
  });
  res.json({ product });
});

productRouter.post('/delete', (req, res) => {
  const marketplace = authorizeMarket(req, res);
  if (!marketplace) return;
  const asins = Array.isArray(req.body?.asins)
    ? [...new Set(req.body.asins.map((value) => cleanText(value, 24).toUpperCase()).filter(Boolean))]
    : [];
  if (!asins.length || asins.length > 5000) {
    return res.status(400).json({ error: '请选择要删除的产品' });
  }
  const requestedMonth = cleanDataMonth(req.body?.dataMonth, true);
  if (req.body?.dataMonth && !requestedMonth) {
    return res.status(400).json({ error: '数据月份格式不正确' });
  }
  const dataMonth = requestedMonth || latestDataMonth(marketplace);
  const remove = db.prepare(
    'DELETE FROM products WHERE marketplace = ? AND data_month = ? AND asin = ?'
  );
  const tx = db.transaction(() => asins.reduce(
    (count, asin) => count + remove.run(marketplace, dataMonth, asin).changes, 0
  ));
  const deleted = tx();
  audit(req.session.user.id, marketplace, 'delete', 'products', null, {
    asins, dataMonth, deleted,
  });
  res.json({ deleted });
});

productRouter.post('/settings', (req, res) => {
  const marketplace = authorizeMarket(req, res);
  if (!marketplace) return;
  const ownBrand = cleanText(req.body?.ownBrand, 120);
  const minSales = Math.max(0, Math.min(10_000_000, Number(req.body?.minSales) || 100));
  db.prepare(
    `INSERT INTO product_settings (marketplace, own_brand, min_sales, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(marketplace) DO UPDATE SET
       own_brand = excluded.own_brand,
       min_sales = excluded.min_sales,
       updated_by = excluded.updated_by,
       updated_at = datetime('now', 'localtime')`
  ).run(marketplace, ownBrand, minSales, req.session.user.id);
  audit(req.session.user.id, marketplace, 'update', 'product_settings', null, {
    ownBrand, minSales,
  });
  res.json({ settings: { own_brand: ownBrand, min_sales: minSales } });
});
