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

-- ---------- 库存变动（每次船长同步后对比在库） ----------
-- 每个账号每次同步记一条 run；在库从 >0 变成 0 记「新断货」，从 0 变成 >0 记「补货」。
-- 同步前没有库存值（空）的行不算变动，避免第一次同步把所有 0 库存都当成新断货。
-- 事件按「账号 + 国家 + 小写 SKU」关联 SKU 库，整表替换后 id 变了也能对上。
CREATE TABLE IF NOT EXISTS sku_stock_syncs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  out_count     INTEGER NOT NULL DEFAULT 0,
  restock_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sku_stock_syncs_user ON sku_stock_syncs (user_id, id);

CREATE TABLE IF NOT EXISTS sku_stock_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sync_id      INTEGER NOT NULL REFERENCES sku_stock_syncs(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country      TEXT    NOT NULL,
  brand        TEXT,
  model        TEXT,
  set_group    TEXT,
  sku          TEXT    NOT NULL,
  sku_key      TEXT    NOT NULL,
  asin         TEXT,
  kind         TEXT    NOT NULL CHECK (kind IN ('out', 'restock')),
  prev_stock   INTEGER,
  prev_transit INTEGER,
  stock        INTEGER,
  transit      INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sku_stock_events_sku ON sku_stock_events (user_id, country, sku_key, id);
CREATE INDEX IF NOT EXISTS idx_sku_stock_events_sync ON sku_stock_events (sync_id);

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
CREATE TABLE IF NOT EXISTS pet_price_ad_report_cache (
  channel_id TEXT NOT NULL,
  report_date TEXT NOT NULL,
  ad_id TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,
  ad_orders INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY(channel_id, report_date, ad_id)
);
CREATE TABLE IF NOT EXISTS pet_price_order_cache (
  snapshot_date TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  order_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY(snapshot_date, channel_id, order_key)
);
CREATE TABLE IF NOT EXISTS pet_captain_api_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER NOT NULL DEFAULT 0
);

-- 宠物美国站每日销量：亚马逊订单报告按太平洋时间、SKU 汇总。每次同步把覆盖到的日期整天重写。
-- sales 为订单金额(美元,不含税);estimated_sales 为其中待付款订单按 Listing 价估算的部分。
CREATE TABLE IF NOT EXISTS pet_daily_sales (
  day TEXT NOT NULL,
  sku TEXT NOT NULL COLLATE NOCASE,
  asin TEXT,
  units INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  sales REAL NOT NULL DEFAULT 0,
  estimated_sales REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(day, sku)
);
CREATE INDEX IF NOT EXISTS idx_pet_daily_sales_sku ON pet_daily_sales(sku, day);

-- FBA 库存拆开的数(最近一次同步):在库 = available + transshipment + receiving,在途 = working + shipped
CREATE TABLE IF NOT EXISTS pet_inventory_detail (
  sku TEXT PRIMARY KEY COLLATE NOCASE,
  asin TEXT,
  available INTEGER NOT NULL DEFAULT 0,
  transshipment INTEGER NOT NULL DEFAULT 0,
  receiving INTEGER NOT NULL DEFAULT 0,
  working INTEGER NOT NULL DEFAULT 0,
  shipped INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 业务报告「销售与流量」:按天、按子 ASIN 的访问量、页面浏览、订购件数、销售额、购物车占有率、转化率
CREATE TABLE IF NOT EXISTS pet_traffic_daily (
  day TEXT NOT NULL,
  asin TEXT NOT NULL,
  parent_asin TEXT,
  sessions INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  order_items INTEGER NOT NULL DEFAULT 0,
  sales REAL NOT NULL DEFAULT 0,
  browser_sessions INTEGER NOT NULL DEFAULT 0,
  mobile_sessions INTEGER NOT NULL DEFAULT 0,
  buy_box_pct REAL,
  unit_session_pct REAL,
  PRIMARY KEY(day, asin)
);
CREATE INDEX IF NOT EXISTS idx_pet_traffic_asin ON pet_traffic_daily(asin, day);
-- 拉过的天和全店合计;报告里没有的 ASIN 当天就是 0 访问
CREATE TABLE IF NOT EXISTS pet_traffic_days (
  day TEXT PRIMARY KEY,
  asins INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  units INTEGER NOT NULL DEFAULT 0,
  sales REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
);

-- 亚马逊 Listing 当前售价和状态,每次同步整表替换
CREATE TABLE IF NOT EXISTS pet_listing_cache (
  sku TEXT PRIMARY KEY COLLATE NOCASE,
  asin TEXT,
  price REAL,
  status TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 宠物 SKU 成本:人工导入或在 SKU 库里改,单位美元/件。按 SKU 单独存,SKU 库整表替换不会清掉成本
CREATE TABLE IF NOT EXISTS pet_sku_costs (
  sku TEXT PRIMARY KEY COLLATE NOCASE,
  fob REAL CHECK (fob >= 0),
  first_leg REAL CHECK (first_leg >= 0),
  duty REAL CHECK (duty >= 0),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 亚马逊 Fee Preview 报告里的预估费用,每天同步一次。报告里没有的 SKU(比如断货下架)保留上次的值
-- referral_rate = 佣金 / 报告时的售价,改价后按新售价重算佣金
CREATE TABLE IF NOT EXISTS pet_sku_fees (
  sku TEXT PRIMARY KEY COLLATE NOCASE,
  asin TEXT,
  fba_fee REAL,
  referral_fee REAL,
  referral_rate REAL,
  fee_price REAL,
  size_tier TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 每月目标与人工数据：目标、实际利润和广告花费由人填写,实际销量和销售额由同步数据计算
CREATE TABLE IF NOT EXISTS pet_monthly_targets (
  month TEXT PRIMARY KEY,
  target_units INTEGER,
  target_sales REAL,
  target_profit REAL,
  actual_profit REAL,
  ad_spend REAL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ---------- Claude 连接器(MCP)授权 ----------
-- 网站自己当 OAuth 授权服务器:Claude 先注册客户端,再跳到网站登录页由超级管理员授权,
-- 换到的访问令牌只能只读调用 /mcp。令牌和授权码只存 SHA-256 摘要,数据库泄露也拿不到原值。
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id  TEXT PRIMARY KEY,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes         TEXT NOT NULL,
  resource       TEXT,
  expires_at     INTEGER NOT NULL
);
-- kind: access = 调用 /mcp 用的短期令牌;refresh = 换新访问令牌用,每用一次换一个新的
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id  TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes     TEXT NOT NULL,
  resource   TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_expiry ON mcp_oauth_tokens (expires_at);

-- ---------- 宠物版产品情报:竞品监控 ----------
-- 竞品按「家族」(父 ASIN,没有变体就是它自己)挂在自家款式下。
-- style_key = SKU 库的款式;没填款式的 SKU 用 SKU 前面的款号(如 RR22002BKM → RR22002)。
-- status: active 已加入监控 / suggested 系统推荐待确认 / ignored 已忽略(以后不再推荐)
CREATE TABLE IF NOT EXISTS pet_competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_key TEXT NOT NULL,
  asin TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suggested','ignored')),
  source TEXT NOT NULL DEFAULT 'manual',
  score REAL,
  evidence_json TEXT,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (style_key, asin)
);
CREATE INDEX IF NOT EXISTS idx_pet_competitors_asin ON pet_competitors(asin);

-- 亚马逊目录里每个 ASIN(竞品家族、竞品子体、自家 ASIN)的最新情况,每天同步覆盖
CREATE TABLE IF NOT EXISTS pet_catalog_items (
  asin TEXT PRIMARY KEY,
  parent_asin TEXT,
  children_json TEXT,
  title TEXT,
  brand TEXT,
  bullets_json TEXT,
  size TEXT,
  color TEXT,
  product_type TEXT,
  main_image TEXT,
  image_count INTEGER,
  bsr INTEGER,
  bsr_category TEXT,
  sub_bsr INTEGER,
  sub_category TEXT,
  price REAL,
  list_price REAL,
  offers INTEGER,
  backend_terms TEXT,
  issues_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_catalog_parent ON pet_catalog_items(parent_asin);

-- 每天一份快照,用来画走势和找变化。标题、五点摘要、主图只在家族那一行存
CREATE TABLE IF NOT EXISTS pet_catalog_snapshots (
  asin TEXT NOT NULL,
  day TEXT NOT NULL,
  price REAL,
  bsr INTEGER,
  sub_bsr INTEGER,
  title TEXT,
  bullets_hash TEXT,
  main_image TEXT,
  children_json TEXT,
  PRIMARY KEY (asin, day)
);

-- 竞品变化提醒:降价 / 涨价 / 改标题 / 改五点 / 换主图 / 排名大涨 / 无购物车 / 变体增减
CREATE TABLE IF NOT EXISTS pet_competitor_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  family_asin TEXT NOT NULL,
  asin TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE (day, asin, kind)
);
CREATE INDEX IF NOT EXISTS idx_pet_competitor_changes_day ON pet_competitor_changes(day DESC);

-- 卖家精灵等第三方导出的月度数据:评分、评论数、子体销量。亚马逊接口没有这些
CREATE TABLE IF NOT EXISTS pet_competitor_metrics (
  asin TEXT NOT NULL,
  month TEXT NOT NULL,
  parent_asin TEXT,
  rating REAL,
  reviews INTEGER,
  units INTEGER,
  revenue REAL,
  price REAL,
  source_file TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  PRIMARY KEY (asin, month)
);

-- 品牌分析搜索词报告里,和我们核心词相关的那部分:每个词点击前 3 的 ASIN
CREATE TABLE IF NOT EXISTS pet_search_term_top (
  week_end TEXT NOT NULL,
  term TEXT NOT NULL,
  rank INTEGER NOT NULL,
  asin TEXT NOT NULL,
  item_name TEXT,
  click_share REAL,
  conversion_share REAL,
  search_rank INTEGER,
  PRIMARY KEY (week_end, term, rank)
);

-- ---------- 改动待确认队列 ----------
-- Claude(通过连接器)提出的 Listing 和广告改动先放这里,超级管理员在「待确认改动」页勾选确认后才执行:
-- Listing 用 SP-API 提交;广告有广告 API 凭证时直接调用,没有时生成批量表人工上传。每一步都记进 pet_change_log。
CREATE TABLE IF NOT EXISTS pet_change_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL DEFAULT 'claude',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- kind:listing_title / listing_bullets / listing_search_terms / listing_price / ad_state / ad_bid / ad_budget / ad_negative
-- target_key:同一个对象同一个字段只留一条待确认,新提议会替代旧的
-- status:pending 待确认、queued 排队、running 执行中、submitted 已提交等生效、applied 已生效、not_applied 未生效、
--        export 待导出批量表、exported 已导出待上传、failed 失败、rejected 已拒绝、superseded 被新提议替代
CREATE TABLE IF NOT EXISTS pet_change_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES pet_change_batches(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  warnings_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT,
  result_json TEXT,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'claude',
  revert_of INTEGER REFERENCES pet_change_proposals(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  decided_at TEXT,
  executed_at TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_change_status ON pet_change_proposals(status, id);
CREATE INDEX IF NOT EXISTS idx_pet_change_target ON pet_change_proposals(target_key, status);

CREATE TABLE IF NOT EXISTS pet_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER REFERENCES pet_change_proposals(id) ON DELETE CASCADE,
  batch_id INTEGER,
  actor TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_change_log_at ON pet_change_log(id DESC);
