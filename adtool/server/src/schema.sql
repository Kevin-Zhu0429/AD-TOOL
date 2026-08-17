-- 词库 + 广告批量开发系统 建表脚本
-- 每次启动执行,IF NOT EXISTS 保证可重复运行

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 用户 ----------
-- role: owner    = Kevin,所有国家 + 账号管理
--       admin    = 国家管理员,负责站点的词库可编辑
--       operator = 运营,权限与 admin 相同(仅名称区分职级)
-- marketplace: 该用户负责的站点,逗号分隔可以填多个,例如 'ES,FR'。owner 填 ALL
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'operator'
                        CHECK (role IN ('owner', 'admin', 'operator')),
  marketplace   TEXT    NOT NULL DEFAULT 'ES',
  is_active     INTEGER NOT NULL DEFAULT 1,
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
