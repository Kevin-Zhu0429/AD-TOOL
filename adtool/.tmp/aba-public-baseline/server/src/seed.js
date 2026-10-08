/**
 * 一次性脚本:创建超级管理员(owner)
 * 用法: node src/seed.js kevin 凯文 你的密码
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db } from './db.js';

const [username, displayName, password] = process.argv.slice(2);

if (!username || !displayName || !password) {
  console.error('用法: node src/seed.js <用户名> <显示名> <密码>');
  process.exit(1);
}

if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
  console.error(`用户 ${username} 已存在`);
  process.exit(1);
}

db.prepare(
  `INSERT INTO users (username, display_name, password_hash, role, marketplace)
   VALUES (?, ?, ?, 'owner', 'ALL')`
).run(username, displayName, bcrypt.hashSync(password, 10));

console.log(`超级管理员 ${username} 创建完成,可管理所有站点和账号`);
