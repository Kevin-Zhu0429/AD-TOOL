import express from 'express';
import bcrypt from 'bcryptjs';
import { db, audit } from './db.js';
import { LIBS, MARKETPLACES, libOf } from './libs.js';

export const authRouter = express.Router();

export { MARKETPLACES };

/**
 * users.marketplace 存的是逗号分隔的站点列表,例如 'ES,FR';owner 存 'ALL'。
 * 这里只认 MARKETPLACES 里的值 —— 'ALL' 解析出来是空数组,
 * 所以万一有 admin/operator 的行留着 'ALL',是「什么都碰不到」,不会误放权。
 */
export function parseMarkets(raw) {
  const out = [];
  for (const part of String(raw ?? '').split(',')) {
    const mk = part.trim().toUpperCase();
    if (MARKETPLACES.includes(mk) && !out.includes(mk)) out.push(mk);
  }
  return out;
}

/** 校验前端传来的站点列表,不合法或为空返回 null */
export function normMarkets(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const out = [];
  for (const raw of list) {
    const mk = String(raw).trim().toUpperCase();
    if (!mk) continue;
    if (!MARKETPLACES.includes(mk)) return null;
    if (!out.includes(mk)) out.push(mk);
  }
  return out.length ? out : null;
}

/** 商品部维护权:B/C/D/E 四类词库归他们管,超级管理员天然有 */
export function isGoods(row) {
  return row.role === 'owner' || !!(row.goods_admin ?? row.goodsAdmin);
}

/** 手动广告页的使用权:还在试用期,超级管理员天然有,其他人由超管逐个开 */
export function canManualAds(row) {
  return row.role === 'owner' || !!(row.manual_ads ?? row.manualAds);
}

/** 广告优化工作台的使用权:同样在试用期,超级管理员天然有,其他人由超管逐个开 */
export function canAdOpt(row) {
  return row.role === 'owner' || !!(row.ad_opt ?? row.adOpt);
}

/** 产品库与竞品分析使用权:超级管理员天然有,其他人由超管逐个开 */
export function canProductIntel(row) {
  return row.role === 'owner' || !!(row.product_intel ?? row.productIntel);
}

/**
 * 该用户在界面上能选哪些站点。
 * 超级管理员和商品部要跨站点看词库,给全部;其他人只给分配到的站点。
 */
export function visibleMarkets(row) {
  return isGoods(row) ? [...MARKETPLACES] : parseMarkets(row.marketplace);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    goodsAdmin: isGoods(row),
    manualAds: canManualAds(row),
    adOpt: canAdOpt(row),
    productIntel: canProductIntel(row),
    // 商品部账号可以不挂站点,这里单独留一份「自己负责的站点」给 A 类词库判权限
    ownMarkets: parseMarkets(row.marketplace),
    markets: visibleMarkets(row),
    // 看过的更新日志版本,前端拿它决定要不要自动弹更新
    seenVersion: row.seen_version ?? '',
  };
}

// ---------- 中间件 ----------

/**
 * 每个请求都按库里的最新状态刷新会话用户 ——
 * owner 改了谁的站点/角色/停用,对方下一个请求就生效,不用等重新登录。
 */
export function requireLogin(req, res, next) {
  const sess = req.session?.user;
  if (!sess) return res.status(401).json({ error: '未登录' });

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.id);
  if (!row) {
    return req.session.destroy(() => res.status(401).json({ error: '账号不存在' }));
  }
  if (!row.is_active) {
    return req.session.destroy(() => res.status(403).json({ error: '账号已停用' }));
  }

  req.session.user = publicUser(row);
  next();
}

export function requireRole(...roles) {
  return (req, res, next) =>
    requireLogin(req, res, () => {
      if (!roles.includes(req.session.user.role)) {
        return res.status(403).json({ error: '权限不足' });
      }
      next();
    });
}

/** 能不能看某个站点的数据:owner 通吃,其他人看自己负责的站点 */
export function canRead(user, marketplace) {
  return MARKETPLACES.includes(marketplace) && (user.role === 'owner' || (user.markets ?? []).includes(marketplace));
}

/**
 * 能不能改某个站点自己维护的那部分词库(A 类无名词)。
 * 国家管理员和运营权限一致 —— 只要是自己负责的站点就能改。
 */
export function canWrite(user, marketplace) {
  return user.role === 'owner' || (user.ownMarkets ?? user.markets ?? []).includes(marketplace);
}

/**
 * 能不能改某一类词库。
 * A 类是运营 / 国家管理员按站点维护;B/C/D/E 由商品部统一维护。
 */
export function canWriteLib(user, libId, marketplace) {
  const lib = typeof libId === 'string' ? libOf(libId) : libId;
  if (!lib) return false;
  return lib.owner === 'goods' ? !!user.goodsAdmin : canWrite(user, marketplace);
}

/** 前端画界面用:这个人在这个站点每一类词库能不能改 */
export function libPerms(user, marketplace) {
  const out = {};
  for (const lib of LIBS) out[lib.id] = canWriteLib(user, lib, marketplace);
  return out;
}

// ---------- 登录 ----------

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: '请填写用户名和密码' });
  }

  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username).trim());

  // 不存在和密码错返回同一句,避免账号被枚举
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  if (!row.is_active) return res.status(403).json({ error: '账号已停用' });

  req.session.user = publicUser(row);
  audit(row.id, null, 'login', 'user', row.id, { markets: req.session.user.markets });
  res.json({ user: req.session.user });
});

authRouter.post('/logout', (req, res) => {
  const id = req.session?.user?.id;
  if (id) audit(id, null, 'logout', 'user', id, null);
  req.session.destroy(() => res.json({ ok: true }));
});

/**
 * 开页面时读一次。这里也按库里的最新状态刷新会话 ——
 * owner 改了角色 / 站点 / 手动广告权限,对方刷新一下页面就生效。
 */
authRouter.get('/me', (req, res) => {
  const sess = req.session?.user;
  if (!sess) return res.json({ user: null, marketplaces: MARKETPLACES });

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.id);
  if (!row || !row.is_active) {
    return req.session.destroy(() => res.json({ user: null, marketplaces: MARKETPLACES }));
  }
  req.session.user = publicUser(row);
  res.json({ user: req.session.user, marketplaces: MARKETPLACES });
});

/** 改自己的显示名 */
authRouter.patch('/profile', requireLogin, (req, res) => {
  const name = String(req.body?.displayName ?? '').trim();
  if (!name) return res.status(400).json({ error: '姓名不能为空' });
  if (name.length > 20) return res.status(400).json({ error: '姓名太长了,20 字以内' });

  const id = req.session.user.id;
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, id);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  req.session.user = publicUser(row);
  audit(id, null, 'update', 'user', id, { displayName: name });
  res.json({ user: req.session.user });
});

/**
 * 记下这个人看过的更新日志版本。
 * 存在账号上而不是浏览器里 —— 换台电脑登录也不会再弹同一版。
 * 版本号对前端来说是不透明的字符串,这里只做长度和字符校验。
 */
authRouter.post('/seen-version', requireLogin, (req, res) => {
  const version = String(req.body?.version ?? '').trim();
  if (!version || version.length > 24 || !/^[0-9A-Za-z.+-]+$/.test(version)) {
    return res.status(400).json({ error: '版本号不合法' });
  }
  const id = req.session.user.id;
  db.prepare('UPDATE users SET seen_version = ? WHERE id = ?').run(version, id);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  req.session.user = publicUser(row);
  res.json({ user: req.session.user });
});

authRouter.post('/change-password', requireLogin, (req, res) => {
  const { oldPassword, newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(oldPassword ?? '', row.password_hash)) {
    return res.status(401).json({ error: '原密码错误' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), row.id);
  audit(row.id, null, 'update', 'user', row.id, { field: 'password' });
  res.json({ ok: true });
});

// ---------- 账号管理(仅 owner) ----------

authRouter.get('/users', requireRole('owner'), (req, res) => {
  const users = db
    .prepare(
      `SELECT id, username, display_name, role, marketplace, goods_admin, manual_ads,
              ad_opt, product_intel, is_active, created_at
         FROM users ORDER BY role, marketplace, id`
    )
    .all()
    .map((u) => ({
      ...u,
      markets: visibleMarkets(u),
      // 商品部账号 markets 是全部站点,这里单独给一份「实际分配到的站点」供账号管理显示和编辑
      ownMarkets: parseMarkets(u.marketplace),
      goodsAdmin: isGoods(u),
      manualAds: canManualAds(u),
      adOpt: canAdOpt(u),
      productIntel: canProductIntel(u),
    }));
  res.json({ users });
});

authRouter.post('/users', requireRole('owner'), (req, res) => {
  const { username, displayName, password, role } = req.body ?? {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: '用户名、姓名、密码都要填' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (!['owner', 'admin', 'operator'].includes(role)) {
    return res.status(400).json({ error: '角色不合法' });
  }
  const goods = role === 'owner' || !!req.body?.goodsAdmin;
  const manual = role === 'owner' || !!req.body?.manualAds;
  const adOpt = role === 'owner' || !!req.body?.adOpt;
  const productIntel = role === 'owner' || !!req.body?.productIntel;
  let mk = 'ALL';
  if (role !== 'owner') {
    const list = normMarkets(req.body?.markets ?? req.body?.marketplace);
    // 纯商品部账号可以不挂站点 —— 他们维护的是 B/C/D/E 区域库,不管某一个站点
    if (!list && !goods) {
      return res.status(400).json({ error: '至少选一个站点,且站点必须合法' });
    }
    mk = (list ?? []).join(',');
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO users
           (username, display_name, password_hash, role, marketplace, goods_admin, manual_ads,
            ad_opt, product_intel)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        username.trim(), displayName.trim(), bcrypt.hashSync(password, 10),
        role, mk, goods ? 1 : 0, manual ? 1 : 0, adOpt ? 1 : 0, productIntel ? 1 : 0
      );
    audit(req.session.user.id, null, 'create', 'user', info.lastInsertRowid, {
      username, role, markets: mk, goodsAdmin: goods, manualAds: manual, adOpt, productIntel,
    });
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    throw e;
  }
});

authRouter.patch('/users/:id', requireRole('owner'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '账号不存在' });

  const { displayName, role, isActive } = req.body ?? {};

  if (id === req.session.user.id && (role !== undefined || isActive === false)) {
    return res.status(400).json({ error: '不能改自己的角色或停用自己' });
  }
  if (role !== undefined && !['owner', 'admin', 'operator'].includes(role)) {
    return res.status(400).json({ error: '角色不合法' });
  }

  const nextRole = role ?? row.role;
  const given = req.body?.markets ?? req.body?.marketplace;
  const nextGoods =
    nextRole === 'owner'
      ? 1
      : req.body?.goodsAdmin === undefined
        ? row.goods_admin
        : req.body.goodsAdmin ? 1 : 0;
  const nextManual =
    nextRole === 'owner'
      ? 1
      : req.body?.manualAds === undefined
        ? row.manual_ads
        : req.body.manualAds ? 1 : 0;
  const nextAdOpt =
    nextRole === 'owner'
      ? 1
      : req.body?.adOpt === undefined
        ? row.ad_opt
        : req.body.adOpt ? 1 : 0;
  const nextProductIntel =
    nextRole === 'owner'
      ? 1
      : req.body?.productIntel === undefined
        ? row.product_intel
        : req.body.productIntel ? 1 : 0;

  let nextMk = 'ALL';
  if (nextRole !== 'owner') {
    const isOwnerDowngrade = row.role === 'owner';
    if (given !== undefined) {
      const list = normMarkets(given);
      // 纯商品部账号可以不挂站点
      if (!list && (isOwnerDowngrade || !nextGoods)) {
        if (isOwnerDowngrade) {
          return res.status(400).json({ error: '改成非超级管理员时要同时指定负责的站点' });
        }
        return res.status(400).json({ error: '至少选一个站点,且站点必须合法' });
      }
      nextMk = (list ?? []).join(',');
    } else {
      // 从超级管理员降级时库里存的是 ALL,必须同时指定负责哪些站点
      const kept = parseMarkets(row.marketplace);
      if (isOwnerDowngrade || (!kept.length && !nextGoods)) {
        return res.status(400).json({ error: '改成非超级管理员时要同时指定负责的站点' });
      }
      nextMk = kept.join(',');
    }
  }

  db.prepare(
    `UPDATE users SET display_name = ?, role = ?, marketplace = ?, goods_admin = ?,
                      manual_ads = ?, ad_opt = ?, product_intel = ?, is_active = ?
      WHERE id = ?`
  ).run(
    displayName ?? row.display_name,
    nextRole,
    nextMk,
    nextGoods,
    nextManual,
    nextAdOpt,
    nextProductIntel,
    isActive === undefined ? row.is_active : isActive ? 1 : 0,
    id
  );
  audit(req.session.user.id, null, 'update', 'user', id, {
    role: nextRole, markets: nextMk, goodsAdmin: !!nextGoods,
    manualAds: !!nextManual, adOpt: !!nextAdOpt,
    productIntel: !!nextProductIntel,
  });
  res.json({ ok: true });
});

/**
 * 永久删除账号。账号私有数据随账号一起删除；共享业务数据只移除创建人/更新人引用，
 * 操作日志保留且去掉已删除账号的外键，确保历史事件不会被改写或阻止删除。
 */
authRouter.delete('/users/:id', requireRole('owner'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: '账号不合法' });
  }
  if (id === req.session.user.id) {
    return res.status(400).json({ error: '不能删除当前登录的账号' });
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '账号不存在' });

  db.transaction(() => {
    const affectedCaptainGroups = db.prepare(
      `SELECT member.group_key
         FROM captain_channel_group_members member
         JOIN captain_channel_bindings binding
           ON binding.open_channel_id = member.open_channel_id
        WHERE binding.user_id = ?
        UNION
       SELECT assignment.group_key
         FROM captain_channel_assignments assignment
        WHERE assignment.user_id = ?`
    ).all(id, id);

    // 新版店铺组的库存来源是共享的；如果仍有其他国家负责人，把兼容外键转给其中一人，
    // 避免删除一个账号时连带删掉其他账号仍在使用的库存快照。
    const sharedCaptainBindings = db.prepare(
      `SELECT binding.id, member.group_key
         FROM captain_channel_bindings binding
         JOIN captain_channel_group_members member
           ON member.open_channel_id = binding.open_channel_id
        WHERE binding.user_id = ?`
    ).all(id);
    const replacementCaptainUser = db.prepare(
      `SELECT user_id
         FROM captain_channel_assignments
        WHERE group_key = ? AND user_id <> ?
        ORDER BY enabled DESC, id ASC LIMIT 1`
    );
    const reassignCaptainBinding = db.prepare(
      `UPDATE captain_channel_bindings
          SET user_id = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?`
    );
    for (const binding of sharedCaptainBindings) {
      const replacement = replacementCaptainUser.get(binding.group_key, id);
      if (replacement) reassignCaptainBinding.run(replacement.user_id, binding.id);
    }

    // 这些是共享数据：保留内容，只移除已删除账号的归属引用。
    db.prepare('UPDATE neg_terms SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE lib_items SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE products SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE product_settings SET updated_by = NULL WHERE updated_by = ?').run(id);
    db.prepare('UPDATE audit_log SET user_id = NULL WHERE user_id = ?').run(id);

    // 旧版 SKU 外键没有 ON DELETE CASCADE，显式清理账号私有 SKU。
    db.prepare('DELETE FROM sku_items WHERE user_id = ?').run(id);

    // ABA、广告组合、船长绑定及分配由外键级联清理。
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    // 删除账号的旧版库存绑定后，不保留没有任何库存来源的空店铺组。
    const deleteEmptyCaptainGroup = db.prepare(
      `DELETE FROM captain_channel_groups
        WHERE group_key = ?
          AND NOT EXISTS (
          SELECT 1 FROM captain_channel_group_members member
           WHERE member.group_key = captain_channel_groups.group_key
        )`
    );
    for (const group of affectedCaptainGroups) deleteEmptyCaptainGroup.run(group.group_key);

    audit(req.session.user.id, null, 'delete', 'user', id, {
      role: row.role,
      markets: row.marketplace,
    });
  })();

  res.json({ ok: true });
});

authRouter.post('/users/:id/reset-password', requireRole('owner'), (req, res) => {
  const { newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  const id = Number(req.params.id);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), id);
  audit(req.session.user.id, null, 'update', 'user', id, { field: 'password', by: 'owner' });
  res.json({ ok: true });
});

/**
 * 浏览器本机完成的关键操作没有对应业务写接口，在这里补一条受控留痕。
 * 模块、动作和详情都使用白名单，避免把表格内容、关键词或文件内容写进日志。
 */
const AUDIT_MODULES = new Set([
  'home', 'builder', 'manual', 'optimizer', 'library', 'skus', 'portfolios',
  'aba', 'products', 'tools', 'admin', 'profile',
]);
const CLIENT_AUDIT_ACTIONS = new Set(['open', 'import_local', 'export', 'clear_local']);

function safeAuditDetail(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 12)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 100);
  }
  return Object.keys(out).length ? out : null;
}

authRouter.post('/audit/events', requireLogin, (req, res) => {
  const module = String(req.body?.module ?? '');
  const action = String(req.body?.action ?? '');
  const marketplace = String(req.body?.marketplace ?? '').trim().toUpperCase();
  if (!AUDIT_MODULES.has(module) || !CLIENT_AUDIT_ACTIONS.has(action)) {
    return res.status(400).json({ error: '操作日志类型不合法' });
  }
  if (marketplace && !canRead(req.session.user, marketplace)) {
    return res.status(403).json({ error: '没有这个站点的权限' });
  }
  audit(
    req.session.user.id,
    marketplace || null,
    action,
    `module_${module}`,
    null,
    safeAuditDetail(req.body?.detail)
  );
  res.json({ ok: true });
});

/** 操作统计和明细只允许超级管理员读取。 */
authRouter.get('/audit', requireRole('owner'), (req, res) => {
  const stats = db.prepare(
    `SELECT u.id, u.username, u.display_name, u.role, u.is_active,
            SUM(CASE WHEN a.created_at >= datetime('now', 'localtime', '-7 days') THEN 1 ELSE 0 END) AS seven_day,
            SUM(CASE WHEN a.created_at >= datetime('now', 'localtime', '-30 days') THEN 1 ELSE 0 END) AS thirty_day,
            MAX(a.created_at) AS last_action_at
       FROM users u
       LEFT JOIN audit_log a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY seven_day DESC, thirty_day DESC, u.id`
  ).all();
  const logs = db.prepare(
    `SELECT a.*, us.display_name AS who, us.username
       FROM audit_log a
       LEFT JOIN users us ON us.id = a.user_id
      ORDER BY a.id DESC LIMIT 500`
  ).all();
  const totals = stats.reduce((sum, row) => ({
    sevenDay: sum.sevenDay + Number(row.seven_day || 0),
    thirtyDay: sum.thirtyDay + Number(row.thirty_day || 0),
  }), { sevenDay: 0, thirtyDay: 0 });
  res.json({ stats, totals, logs });
});
