import express from 'express';
import bcrypt from 'bcryptjs';
import { db, audit } from './db.js';

export const authRouter = express.Router();

export const MARKETPLACES = ['ES', 'DE', 'FR', 'IT', 'UK', 'US', 'CA'];

// ---------- 中间件 ----------

export function requireLogin(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: '未登录' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session?.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

/**
 * 判断当前用户能不能访问某个站点的数据。
 * owner 通吃,其他人只能碰自己那个站点。
 */
export function canRead(user, marketplace) {
  return user.role === 'owner' || user.marketplace === marketplace;
}

/** 能不能改某个站点的词库 —— operator 一律只读 */
export function canWrite(user, marketplace) {
  if (user.role === 'owner') return true;
  if (user.role === 'admin') return user.marketplace === marketplace;
  return false;
}

/** 该用户在界面上能选哪些站点 */
export function visibleMarkets(user) {
  return user.role === 'owner' ? MARKETPLACES : [user.marketplace];
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    marketplace: row.marketplace,
    markets: visibleMarkets({ role: row.role, marketplace: row.marketplace }),
  };
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
  audit(row.id, row.marketplace, 'login', 'user', row.id, null);
  res.json({ user: req.session.user });
});

authRouter.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get('/me', (req, res) => {
  res.json({ user: req.session?.user ?? null, marketplaces: MARKETPLACES });
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
  audit(id, row.marketplace, 'update', 'user', id, { displayName: name });
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
  audit(row.id, row.marketplace, 'update', 'user', row.id, { field: 'password' });
  res.json({ ok: true });
});

// ---------- 账号管理(仅 owner) ----------

authRouter.get('/users', requireRole('owner'), (req, res) => {
  const users = db
    .prepare(
      `SELECT id, username, display_name, role, marketplace, is_active, created_at
         FROM users ORDER BY marketplace, role, id`
    )
    .all();
  res.json({ users });
});

authRouter.post('/users', requireRole('owner'), (req, res) => {
  const { username, displayName, password, role, marketplace } = req.body ?? {};
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: '用户名、姓名、密码都要填' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (!['owner', 'admin', 'operator'].includes(role)) {
    return res.status(400).json({ error: '角色不合法' });
  }
  const mk = role === 'owner' ? 'ALL' : marketplace;
  if (role !== 'owner' && !MARKETPLACES.includes(mk)) {
    return res.status(400).json({ error: '站点不合法' });
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, role, marketplace)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(username.trim(), displayName.trim(), bcrypt.hashSync(password, 10), role, mk);
    audit(req.session.user.id, mk, 'create', 'user', info.lastInsertRowid, { username, role });
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

  const { displayName, role, marketplace, isActive } = req.body ?? {};

  if (id === req.session.user.id && (role !== undefined || isActive === false)) {
    return res.status(400).json({ error: '不能改自己的角色或停用自己' });
  }
  if (role !== undefined && !['owner', 'admin', 'operator'].includes(role)) {
    return res.status(400).json({ error: '角色不合法' });
  }

  const nextRole = role ?? row.role;
  const nextMk = nextRole === 'owner' ? 'ALL' : (marketplace ?? row.marketplace);
  if (nextRole !== 'owner' && !MARKETPLACES.includes(nextMk)) {
    return res.status(400).json({ error: '站点不合法' });
  }

  db.prepare(
    `UPDATE users SET display_name = ?, role = ?, marketplace = ?, is_active = ?
      WHERE id = ?`
  ).run(
    displayName ?? row.display_name,
    nextRole,
    nextMk,
    isActive === undefined ? row.is_active : isActive ? 1 : 0,
    id
  );
  audit(req.session.user.id, nextMk, 'update', 'user', id, { role: nextRole, marketplace: nextMk });
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

/** 最近的操作留痕,owner 看全部,其他人看自己站点 */
authRouter.get('/audit', requireLogin, (req, res) => {
  const u = req.session.user;
  const rows =
    u.role === 'owner'
      ? db
          .prepare(
            `SELECT a.*, us.display_name AS who FROM audit_log a
               LEFT JOIN users us ON us.id = a.user_id
              ORDER BY a.id DESC LIMIT 200`
          )
          .all()
      : db
          .prepare(
            `SELECT a.*, us.display_name AS who FROM audit_log a
               LEFT JOIN users us ON us.id = a.user_id
              WHERE a.marketplace = ? ORDER BY a.id DESC LIMIT 200`
          )
          .all(u.marketplace);
  res.json({ logs: rows });
});
