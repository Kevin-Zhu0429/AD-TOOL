// Local entry point: paths are anchored to this file, never the terminal directory.
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'server');
const require = createRequire(path.join(server, 'package.json'));
const [profile, action, ...args] = process.argv.slice(2);
if (!['pet', 'ink'].includes(profile) || !['dev', 'start', 'seed'].includes(action)) {
  console.error('用法：npm run dev:pet / dev:ink / start:pet / start:ink / seed:pet / seed:ink');
  process.exit(1);
}

const dotenv = require('dotenv');
const envFile = path.join(server, '.env');
const saved = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};
const pet = profile === 'pet';
// Ignore stale APP_PROFILE / DATA_DIR / PORT from previously used terminals.
const dataDir = pet
  ? process.env.PET_DATA_DIR || path.join(server, 'data-pet')
  : process.env.INK_DATA_DIR || path.resolve(server, saved.DATA_DIR || 'data');
const port = pet ? 8081 : 8080;
const webPort = pet ? 5174 : 5173;
const env = {
  ...saved, ...process.env,
  APP_PROFILE: profile,
  DATA_DIR: path.resolve(dataDir),
  PORT: String(port),
  COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
  SESSION_COOKIE_NAME: pet ? 'adtool.pet.sid' : 'connect.sid',
  ADTOOL_API_TARGET: `http://127.0.0.1:${port}`,
};
const children = new Set();
let stopping = false;
let input;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  input?.close();
  process.stdin.pause();
  for (const child of children) child.kill();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function run(file, argv, cwd) {
  const child = spawn(process.execPath, [file, ...argv], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.add(child);
  child.on('error', (err) => { console.error(err.message); stop(1); });
  child.on('exit', (code) => { children.delete(child); if (!stopping) stop(code ?? 1); });
  return child;
}
async function freePort(value) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`端口 ${value} 已被占用。请在原来的启动终端按 Ctrl+C 停止旧服务，再执行此命令。`)));
    probe.listen(value, '0.0.0.0', () => probe.close(resolve));
  });
}
try {
  console.log(`\n${pet ? '宠物版（美国站）' : '墨盒版'} · 数据目录：${env.DATA_DIR}`);
  if (action === 'seed') {
    if (args.length !== 3) throw new Error(`首次创建账号：npm run seed:${profile} -- 用户名 显示名 密码`);
    run(path.join(server, 'src/seed.js'), args, server);
  } else {
    input = readline.createInterface({ input: process.stdin, output: process.stdout });
    input.on('SIGINT', () => stop());
    input.on('line', (line) => { if (line.trim().toLowerCase() === 'q') stop(); });
    if (action === 'start' && !fs.existsSync(path.join(root, 'web/dist/index.html'))) {
      throw new Error('请先在 adtool 目录运行 npm run build，然后重新启动。');
    }
    await freePort(port);
    if (action === 'dev') await freePort(webPort);
    run(path.join(server, 'src/index.js'), [], server);
    let ready = false;
    for (let attempt = 0; attempt < 80 && !stopping; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(500) });
        if (response.ok && (await response.json()).id === profile) { ready = true; break; }
      } catch { /* Wait for the new backend to finish opening its database. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!stopping && !ready) throw new Error('后端未能就绪，请查看上面的错误信息。');
    if (!stopping) {
      if (action === 'dev') run(path.join(root, 'web/node_modules/vite/bin/vite.js'), ['--port', String(webPort), '--strictPort', '--clearScreen', 'false'], path.join(root, 'web'));
      console.log(`\n打开：http://localhost:${action === 'dev' ? webPort : port}\n按 Ctrl+C 或输入 q 回车，停止本次启动的服务。\n`);
    }
  }
} catch (err) {
  console.error(err.message);
  stop(1);
}
