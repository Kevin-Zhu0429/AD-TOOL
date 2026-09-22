-- 词库 + 广告批量开发系统 建表脚本
-- 每次启动执行,IF NOT EXISTS 保证可重复运行

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ABA reports are private to the uploading account, including owner accounts.
CREATE TABLE IF NOT EXISTS aba_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  brand TEXT NOT NULL COLLATE NOCASE,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  week_number INTEGER NOT NULL CHECK (week_number BETWEEN 1 AND 53),
  source_file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, marketplace, brand, week_end)
);
CREATE TABLE IF NOT EXISTS aba_queries (
  report_id INTEGER NOT NULL REFERENCES aba_reports(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  query_volume INTEGER NOT NULL CHECK(query_volume >= 0),
  impressions INTEGER NOT NULL CHECK(impressions >= 0),
  clicks INTEGER NOT NULL CHECK(clicks >= 0),
  click_rate REAL CHECK(click_rate >= 0),
  click_price REAL CHECK(click_price >= 0),
  purchases INTEGER NOT NULL CHECK(purchases >= 0),
  brand_impressions INTEGER CHECK(brand_impressions >= 0),
  brand_clicks INTEGER CHECK(brand_clicks >= 0),
  brand_purchases INTEGER CHECK(brand_purchases >= 0),
  PRIMARY KEY(report_id, query)
);

CREATE TABLE IF NOT EXISTS aba_asin_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  asin TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  week_number INTEGER NOT NULL CHECK(week_number BETWEEN 1 AND 53),
  source_file TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, marketplace, asin, week_end)
);
CREATE TABLE IF NOT EXISTS aba_asin_queries (
  report_id INTEGER NOT NULL REFERENCES aba_asin_reports(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  query_volume INTEGER NOT NULL CHECK(query_volume >= 0),
  market_impressions INTEGER NOT NULL CHECK(market_impressions >= 0),
  market_clicks INTEGER NOT NULL CHECK(market_clicks >= 0),
  market_purchases INTEGER NOT NULL CHECK(market_purchases >= 0),
  asin_impressions INTEGER NOT NULL CHECK(asin_impressions >= 0),
  asin_clicks INTEGER NOT NULL CHECK(asin_clicks >= 0),
  asin_purchases INTEGER NOT NULL CHECK(asin_purchases >= 0),
  PRIMARY KEY(report_id, query)
);

-- ---------- 用户 ----------
-- role: owner    = Kevin,所有国家 + 账号管理
--       admin    = 国家管理员,负责站点的词库可编辑
--       operator = 运营,权限与 admin 相同(仅名称区分职级)
-- marketplace: 该用户负责的站点,逗号分隔可以填多个,例如 'ES,FR'。owner 填 ALL
-- goods_admin: 商品部维护权,B/C/D/E 四类词库归他们管
-- manual_ads : 手动广告页的使用权。这一页还在试用期,默认谁都没有,由超级管理员逐个开
-- ad_opt     : 广告优化工作台的使用权。同样在试用期,默认全关,由超级管理员逐个开
-- product_intel: 产品库与竞品分析使用权,默认全关,由超级管理员逐个开
-- seen_version: 这个人看过的更新日志版本号。比它新的更新会在首页自动弹一次,
--               看过就不再弹,直到下次发新版。存在账号上,换台电脑登录也不会重复弹
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'operator'
                        CHECK (role IN ('owner', 'admin', 'operator')),
  marketplace   TEXT    NOT NULL DEFAULT 'ES',
  goods_admin   INTEGER NOT NULL DEFAULT 0,
  manual_ads    INTEGER NOT NULL DEFAULT 0,
  ad_opt        INTEGER NOT NULL DEFAULT 0,
  product_intel INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  seen_version  TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------- 否定词库 ----------
-- cat   : model=型号  brand=品牌  irrel=无关词  asin=否定ASIN
-- match : 否定词组 / 否定精准匹配   (asin 类为空)
-- level : camp=广告活动级  group=广告组级      (asin 类为空)
CREATE TABLE IF NOT EXISTS neg_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT    NOT NULL,
  cat         TEXT    NOT NULL CHECK (cat IN ('model', 'brand', 'irrel', 'asin')),
  term        TEXT    NOT NULL,
  match_type  TEXT,
  level       TEXT,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 同一个站点同一分类下,同一个词只能有一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_neg_unique
  ON neg_terms (marketplace, cat, term);
CREATE INDEX IF NOT EXISTS idx_neg_market ON neg_terms (marketplace, cat);

-- ---------- 分类级默认设置 ----------
-- 每个站点每个分类的默认匹配方式和否定层级,生成广告时套用
CREATE TABLE IF NOT EXISTS neg_cat_config (
  marketplace TEXT    NOT NULL,
  cat         TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  match_type  TEXT    NOT NULL DEFAULT '否定词组',
  level       TEXT    NOT NULL DEFAULT 'camp',
  PRIMARY KEY (marketplace, cat)
);

-- ---------- 操作留痕 ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  marketplace TEXT,
  action      TEXT    NOT NULL,
  entity      TEXT    NOT NULL,
  entity_id   INTEGER,
  detail      TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log (user_id, created_at DESC);

-- 注意:sessions 表故意不在这里建。
-- better-sqlite3-session-store 会自己建,列顺序必须由它决定,
-- 手动建会导致 session 内容和过期时间存反,表现为「登录成功但下一个请求就说未登录」。

-- ---------- 五类词库(A/B/C/D/E) ----------
-- lib   : A 无名词 / B 非售品牌 / C 非售流量干扰墨盒 / D 在售墨盒型号和相关打印机 / E 原装竞品ASIN
-- scope : 站点库存站点码(ES、US…),区域库存区域码(EU、NA、AU)
--         区域库只存一份 —— 欧洲传德国、美洲传美国,同区其他站点自动跟着变
-- 各列具体含义看 libs.js 里的 LIBS 定义,不同 lib 用到的列不一样
CREATE TABLE IF NOT EXISTS lib_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lib         TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  term        TEXT,
  brand       TEXT,
  series      TEXT,
  printer     TEXT,
  asin        TEXT,
  note        TEXT,
  dedupe      TEXT    NOT NULL,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 同一个 scope 同一类词库里,判重列一样的只留一条
CREATE UNIQUE INDEX IF NOT EXISTS idx_lib_unique ON lib_items (lib, scope, dedupe);
CREATE INDEX IF NOT EXISTS idx_lib_scope ON lib_items (lib, scope);

-- ---------- SKU 库 ----------
-- 每个账号各存各的:user_id 就是上传人,别人看不到,大家只传自己负责的品牌。
-- 开广告时按「国家 + 型号」筛出 SKU,勾选后填进投放 SKU 框。
-- dedupe = 国家|小写SKU,同一个账号同一个国家里同一个 SKU 只留一条,再传就更新库存。
CREATE TABLE IF NOT EXISTS sku_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  country    TEXT    NOT NULL,
  brand      TEXT,
  model      TEXT,
  set_group  TEXT,
  sku        TEXT    NOT NULL,
  asin       TEXT,
  stock      INTEGER,
  transit    INTEGER,
  dedupe     TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_unique ON sku_items (user_id, dedupe);
CREATE INDEX IF NOT EXISTS idx_sku_user ON sku_items (user_id, country);

-- ---------- 船长 BI 店铺绑定与库存快照 ----------
-- API 凭证只放环境变量；兼容表保存真实库存来源及旧版单账号绑定。
-- 新版负责人关系由下方店铺组与国家分配表维护。
CREATE TABLE IF NOT EXISTS captain_channel_bindings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand           TEXT    NOT NULL,
  brand_key       TEXT    NOT NULL,
  country         TEXT    NOT NULL,
  open_channel_id TEXT    NOT NULL UNIQUE,
  channel_name    TEXT    NOT NULL,
  site_id         INTEGER,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_sync_at    INTEGER,
  last_sync_status TEXT,
  last_sync_detail TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_captain_binding_user
  ON captain_channel_bindings (user_id, brand_key, country, enabled);

-- 库存来源与网站负责人分开保存。同一个欧洲库存店铺组可共用一份库存，
-- 但 ES / DE / FR / IT 可分别写入不同网站账号的 SKU 库。
CREATE TABLE IF NOT EXISTS captain_channel_groups (
  group_key   TEXT PRIMARY KEY,
  group_name  TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  brand       TEXT    NOT NULL,
  brand_key   TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS captain_channel_group_members (
  group_key       TEXT NOT NULL REFERENCES captain_channel_groups(group_key) ON DELETE CASCADE,
  open_channel_id TEXT NOT NULL UNIQUE REFERENCES captain_channel_bindings(open_channel_id) ON DELETE CASCADE,
  PRIMARY KEY (group_key, open_channel_id)
);

CREATE TABLE IF NOT EXISTS captain_channel_assignments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key  TEXT    NOT NULL REFERENCES captain_channel_groups(group_key) ON DELETE CASCADE,
  country    TEXT    NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (group_key, country)
);

CREATE INDEX IF NOT EXISTS idx_captain_assignment_user
  ON captain_channel_assignments (user_id, country, enabled);

-- inventory_list 是按修改时间增量返回；保存每家店最后一次看到的完整数量，
-- 才能在多店铺之间稳定汇总，而不会因某个 SKU 本轮没变化就少算库存。
CREATE TABLE IF NOT EXISTS captain_inventory_snapshots (
  binding_id INTEGER NOT NULL REFERENCES captain_channel_bindings(id) ON DELETE CASCADE,
  sku_key    TEXT    NOT NULL,
  sku        TEXT    NOT NULL,
  asin       TEXT,
  stock      INTEGER NOT NULL DEFAULT 0,
  transit    INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (binding_id, sku_key)
);

-- ---------- 广告组合库 ----------
-- 广告组合编号由亚马逊账号和站点共同决定，因此按用户 + 站点隔离。
-- 名称用于从“540 Series”“混投”等业务写法自动匹配投放 SKU。
CREATE TABLE IF NOT EXISTS portfolio_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketplace  TEXT    NOT NULL,
  portfolio_id TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (user_id, marketplace, portfolio_id)
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user_market
  ON portfolio_items (user_id, marketplace, name);

-- ---------- 分市场产品库 ----------
-- 完整卖家精灵记录以 JSON 保存；高频筛选字段单独建列并建索引。
CREATE TABLE IF NOT EXISTS products (
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

CREATE INDEX IF NOT EXISTS idx_products_market_model
  ON products (marketplace, model, color_group);

CREATE TABLE IF NOT EXISTS product_settings (
  marketplace TEXT PRIMARY KEY,
  own_brand    TEXT NOT NULL DEFAULT '',
  min_sales    INTEGER NOT NULL DEFAULT 100,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
-- 宠物美国站价格策略：按日期与 SKU 保留快照，业务字段以 JSON 存储。
CREATE TABLE IF NOT EXISTS pet_price_strategy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US' CHECK (marketplace = 'US'),
  sku TEXT NOT NULL COLLATE NOCASE,
  data_json TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(snapshot_date, marketplace, sku)
);
CREATE INDEX IF NOT EXISTS idx_pet_price_strategy_date ON pet_price_strategy(snapshot_date DESC, sku);

CREATE TABLE IF NOT EXISTS pet_price_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pet_price_inventory_cache (
  channel_id TEXT NOT NULL,
  sku TEXT NOT NULL COLLATE NOCASE,
  available_stock INTEGER,
  inbound_stock INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY(channel_id, sku)
);
CREATE TABLE IF NOT EXISTS pet_price_ad_cache (
  channel_id TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY(channel_id, ad_id)
);
CREATE TABLE IF NOT EXISTS pet_captain_api_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER NOT NULL DEFAULT 0
);
