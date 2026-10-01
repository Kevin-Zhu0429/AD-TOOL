import express from 'express';
import { db, audit } from './db.js';
import { requireLogin } from './auth.js';
import { isPet, PET_SHOP_ID } from './profile.js';
import { pacificDay, shiftDay } from './petAmazon.js';
import { priceSyncStatus, syncAmazonData } from './priceStrategySync.js';
import { buildPriceBoard, monthlySummary, recentDays, weeklySummary } from './petSales.js';

export const priceStrategyRouter = express.Router();
priceStrategyRouter.use(requireLogin);
priceStrategyRouter.use((req, res, next) => isPet ? next() : res.status(404).json({ error: '未启用价格策略表' }));

// 测试可以用 PET_TODAY 固定「今天」;正式环境始终是美国太平洋时间的今天
const todayOf = () => (process.env.NODE_ENV === 'test' && process.env.PET_TODAY) || pacificDay(new Date());

/** 价格策略表:SKU 库全部 SKU,按今天实时计算 */
priceStrategyRouter.get('/', (req, res) => {
  const today = todayOf();
  const from = [recentDays(today)[0], `${today.slice(0, 7)}-01`].sort()[0];
  const skus = db.prepare("SELECT sku,asin,style,size,color,stock,transit FROM sku_items WHERE user_id=? AND country='US'").all(PET_SHOP_ID);
  const sales = db.prepare('SELECT day,sku,asin,units FROM pet_daily_sales WHERE day>=? AND day<=?').all(from, today);
  const listings = db.prepare('SELECT sku,asin,price,status FROM pet_listing_cache').all();
  res.json({ ...buildPriceBoard({ skus, sales, listings, today }), sync: priceSyncStatus() });
});

/** 销售统计:周销量 + 每月数据 */
priceStrategyRouter.get('/stats', (req, res) => {
  const today = todayOf();
  const year = Number(req.query.year || today.slice(0, 4));
  const weeks = Number(req.query.weeks || 8);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: '年份不合法' });
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 53) return res.status(400).json({ error: '周数需在 1–53 之间' });
  const sync = priceSyncStatus();
  const coveredFrom = sync.coverage?.from ?? null;
  const weekFrom = shiftDay(today, -7 * weeks - 7);
  const unitsByDay = new Map(db.prepare('SELECT day, SUM(units) AS units FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY day')
    .all(weekFrom, today).map((row) => [row.day, row.units]));
  const actuals = new Map(db.prepare(`SELECT substr(day,1,7) AS month, SUM(units) AS units, SUM(sales) AS sales,
    SUM(estimated_sales) AS estimatedSales FROM pet_daily_sales WHERE day>=? AND day<=? GROUP BY month`)
    .all(`${year}-01-01`, `${year}-12-31`).map((row) => [row.month, row]));
  const targets = new Map(db.prepare(`SELECT month, target_units AS targetUnits, target_sales AS targetSales,
    target_profit AS targetProfit, actual_profit AS actualProfit, ad_spend AS adSpend FROM pet_monthly_targets WHERE month LIKE ?`)
    .all(`${year}-%`).map((row) => [row.month, row]));
  res.json({ today, year, coveredFrom, weekly: weeklySummary(unitsByDay, today, weeks, coveredFrom),
    monthly: monthlySummary({ year, actuals, targets, today, coveredFrom }), sync });
});

const TARGET_FIELDS = [['targetUnits', 'target_units', '目标销量', true], ['targetSales', 'target_sales', '目标销售额'],
  ['targetProfit', 'target_profit', '目标利润额'], ['actualProfit', 'actual_profit', '实际利润额', false, true],
  ['adSpend', 'ad_spend', '广告花费']];

priceStrategyRouter.put('/targets/:month', (req, res) => {
  const month = String(req.params.month);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: '月份格式应为 YYYY-MM' });
  const values = {};
  for (const [key, column, label, integer, signed] of TARGET_FIELDS) {
    const raw = req.body?.[key];
    if (raw === null || raw === undefined || String(raw).trim() === '') { values[column] = null; continue; }
    const number = Number(raw);
    if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || (!signed && number < 0)) {
      return res.status(400).json({ error: `${label}必须是${integer ? '非负整数' : signed ? '有效数字' : '非负数字'}` });
    }
    values[column] = number;
  }
  db.prepare(`INSERT INTO pet_monthly_targets(month,target_units,target_sales,target_profit,actual_profit,ad_spend,updated_by)
    VALUES(@month,@target_units,@target_sales,@target_profit,@actual_profit,@ad_spend,@actor)
    ON CONFLICT(month) DO UPDATE SET target_units=excluded.target_units,target_sales=excluded.target_sales,
      target_profit=excluded.target_profit,actual_profit=excluded.actual_profit,ad_spend=excluded.ad_spend,
      updated_by=excluded.updated_by,updated_at=datetime('now','localtime')`).run({ month, ...values, actor: req.session.user.id });
  audit(req.session.user.id, 'US', 'update', 'pet_monthly_targets', null, { month, ...values });
  res.json({ ok: true });
});

priceStrategyRouter.get('/status', (req, res) => res.json(priceSyncStatus()));

priceStrategyRouter.post('/sync', (req, res) => {
  const status = priceSyncStatus();
  if (!status.configured) return res.status(503).json({ error: status.issues[0] ?? '服务器还没有配置宠物店铺的亚马逊 SP-API 凭证' });
  if (status.running) return res.status(409).json({ error: '亚马逊数据正在同步' });
  void syncAmazonData(req.session.user.id).catch((error) => console.error('[price-sync]', error.message));
  res.status(202).json({ accepted: true });
});
