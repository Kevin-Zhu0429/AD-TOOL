// 产品库:清洗、按月份 upsert、读取整月产品。导入和整月 JSON 解析都在 worker 线程里执行。
import { writeAudit } from '../dbConnect.js';

export function cleanText(value, max = 5000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cleanProduct(input) {
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

export function rowToProduct(row) {
  try {
    return JSON.parse(row.data_json);
  } catch {
    return { asin: row.asin, brand: row.brand, model: row.model, color_grp: row.color_group };
  }
}

function importProductsForMarket(db, marketplace, rawProducts, dataMonth, sourceFile, userId) {
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

/** 一批(一个或多个站点)产品写在同一个事务里,每个站点记一条操作留痕 */
export function importProducts(db, { entries, dataMonth, sourceFile, userId }) {
  const results = db.transaction(() => Object.fromEntries(
    entries.map(([marketplace, products]) => [
      marketplace,
      importProductsForMarket(db, marketplace, products, dataMonth, sourceFile, userId),
    ])
  ))();
  for (const [marketplace, result] of Object.entries(results)) {
    writeAudit(db, userId, marketplace, 'import', 'products', null, { ...result, dataMonth, sourceFile });
  }
  return results;
}

/** 站点的月份列表 + 选中月份的全部产品 + 站点设置 */
export function listProducts(db, marketplace, requestedMonth) {
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
  return { products, settings, months, dataMonth };
}
