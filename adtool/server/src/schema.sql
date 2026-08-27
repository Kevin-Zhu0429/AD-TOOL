-- 词库 + 广告批量开发系统 建表脚本
-- 每次启动执行,IF NOT EXISTS 保证可重复运行

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 用户 ----------
-- role: owner    = Kevin,所有国家 + 账号管理
--       admin    = 国家管理员,负责站点的词库可编辑
--       operator = 运营,权限与 admin 相同(仅名称区分职级)
-- marketplace: 该用户负责的站点,逗号分隔可以填多个,例如 'ES,FR'。owner 填 ALL
-- goods_admin: 商品部维护权,B/C/D/E 四类词库归他们管
-- manual_ads : 手动广告页的使用权。这一页还在试用期,默认谁都没有,由超级管理员逐个开
-- ad_opt     : 广告优化工作台的使用权。同样在试用期,默认全关,由超级管理员逐个开
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
  stock      INTEGER,
  transit    INTEGER,
  dedupe     TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_unique ON sku_items (user_id, dedupe);
CREATE INDEX IF NOT EXISTS idx_sku_user ON sku_items (user_id, country);
