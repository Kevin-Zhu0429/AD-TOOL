import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { spApiRequest, spApiAccounts, AMAZON_MARKETPLACES } from '../spApi.js';
import { reportWeeks, nextTuesday, asinBatches, REPORT_TYPE } from './publicAsinData.js';
import catalog from '../data/abaPublicTargets.json' with { type: 'json' };

const WEEK = 7 * 86400000;
const RETRY_DELAY = 24 * 3600000;
const MAX_BYTES = 50 * 1024 * 1024;
const terminal = new Set(['done', 'failed']);
const cleanError = (error) => String(error?.message || '同步失败，请重试')
  .replace(/https?:\/\/\S+/g, '[下载地址]').replace(/Atzr\|\S+/g, '[授权信息]').slice(0, 300);

export async function downloadPublicDocument(document) {
  let url;
  try { url = new URL(document.url); } catch { throw new Error('亚马逊没有返回有效下载地址'); }
  if (url.protocol !== 'https:') throw new Error('亚马逊下载地址必须使用 HTTPS');
  if (document.compressionAlgorithm && document.compressionAlgorithm !== 'GZIP')
    throw new Error('报告压缩格式不支持');
  const response = await fetch(url, { signal: AbortSignal.timeout(90000), redirect: 'error' });
  if (!response.ok) throw new Error('报告下载失败（HTTP ' + response.status + '）');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('报告文件超过 50 MB');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error('报告文件超过 50 MB');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  let bytes = Buffer.concat(chunks);
  if (document.compressionAlgorithm === 'GZIP') bytes = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('亚马逊报告不是有效 JSON'); }
}

/** 持久队列：每次推进一个阶段，后台定时调用；页面不负责驱动任务。 */
export function createPublicSync({ db, save, onSaved = () => {}, targets = catalog,
  accounts = spApiAccounts, request = spApiRequest, download = downloadPublicDocument,
  now = Date.now, createInterval = 60500, pollInterval = 15000 }) {
  db.prepare('INSERT OR IGNORE INTO aba_public_schedule(id,next_due) VALUES(1,?)').run(nextTuesday(now()));
  let busy = false;
  const instance = randomUUID(); // 每个执行器独立；真实锁由 SQLite 事务管理。
  const accountFor = (task) => accounts().find((a) => a.brand.toLowerCase() === task.brand.toLowerCase()
    && a.markets.includes(task.marketplace) && a.region === AMAZON_MARKETPLACES[task.marketplace]?.region);
  const latestJob = () => db.prepare('SELECT * FROM aba_public_jobs ORDER BY id DESC LIMIT 1').get() ?? null;
  function attention() {
    const items = db.prepare(`SELECT marketplace,brand,week_start,week_end,COUNT(*) AS asinCount,
      GROUP_CONCAT(DISTINCT error) AS error,MIN(created_at) AS createdAt,MAX(updated_at) AS updatedAt
      FROM aba_public_actions GROUP BY marketplace,brand,week_start,week_end
      ORDER BY week_end DESC,marketplace,brand`).all();
    return { total: items.length, asinTotal: items.reduce((n, item) => n + item.asinCount, 0), items };
  }
  function status() {
    const job = latestJob();
    const tasks = job ? db.prepare('SELECT id,marketplace,brand,week_start,week_end,asins_json,stage,polls,attempts,rows_saved,error,next_at FROM aba_public_tasks WHERE job_id=? ORDER BY id').all(job.id).map(({ asins_json, ...t }) => ({ ...t, asinCount: JSON.parse(asins_json).length })) : [];
    const summary = {
      total: tasks.length, completed: tasks.filter((t) => t.stage === 'done').length,
      failed: tasks.filter((t) => t.stage === 'failed').length,
      asinTotal: tasks.reduce((n, t) => n + t.asinCount, 0),
      asinCompleted: tasks.filter((t) => t.stage === 'done').reduce((n, t) => n + t.asinCount, 0),
      rows: tasks.reduce((n, t) => n + t.rows_saved, 0),
    };
    const missing = targets.filter((t) => !accountFor(t)).map((t) => t.marketplace + ' / ' + t.brand + ' 缺少对应亚马逊品牌授权');
    return {
      markets: [...new Set(targets.map((t) => t.marketplace))],
      targets: targets.map((t) => ({ marketplace: t.marketplace, brand: t.brand, count: t.asins.length })),
      nextDue: db.prepare('SELECT next_due FROM aba_public_schedule WHERE id=1').get().next_due,
      retry: db.prepare(`SELECT source_job_id AS sourceJobId,due_at AS dueAt,state,retry_job_id AS jobId
        FROM aba_public_retries WHERE state='pending' OR source_job_id=? OR retry_job_id=?
        ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END,due_at LIMIT 1`).get(job?.id ?? 0, job?.id ?? 0) ?? null,
      job, tasks, summary, issues: missing,
    };
  }
  function start(actorId = null, slot = null) {
    return db.transaction(() => {
      const active = db.prepare("SELECT id FROM aba_public_jobs WHERE state='running'").get();
      if (active) return { jobId: active.id, alreadyRunning: true };
      if (slot && db.prepare('SELECT id FROM aba_public_jobs WHERE schedule_slot=?').get(slot)) return { alreadyRunning: false };
      const weeks = reportWeeks(now(), 4);
      const settings = db.prepare('SELECT * FROM aba_public_schedule WHERE id=1').get();
      const first = settings.first_week || weeks.at(-1).week_end;
      const latest = weeks[0].week_end;
      const periods = [];
      for (let end = Date.parse(latest); end >= Date.parse(first); end -= WEEK)
        periods.push({ week_start: new Date(end - 6 * 86400000).toISOString().slice(0, 10), week_end: new Date(end).toISOString().slice(0, 10) });
      const at = now();
      const { lastInsertRowid: id } = db.prepare('INSERT INTO aba_public_jobs(trigger_kind,schedule_slot,actor_id,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(slot ? 'scheduled' : 'manual', slot, actorId, at, at);
      const exists = db.prepare('SELECT 1 FROM aba_public_reports WHERE marketplace=? AND asin=? AND week_end=?');
      const insert = db.prepare('INSERT INTO aba_public_tasks(job_id,marketplace,brand,week_start,week_end,asins_json) VALUES(?,?,?,?,?,?)');
      for (const period of periods) for (const target of targets) {
        const missing = target.asins.filter((asin) => period.week_end === latest || !exists.get(target.marketplace, asin, period.week_end));
        for (const batch of asinBatches(missing))
          insert.run(id, target.marketplace, target.brand, period.week_start, period.week_end, JSON.stringify(batch));
      }
      db.prepare('UPDATE aba_public_schedule SET first_week=? WHERE id=1').run(first);
      return { jobId: Number(id), alreadyRunning: false };
    })();
  }
  function update(id, patch) {
    const fields = Object.keys(patch);
    db.prepare('UPDATE aba_public_tasks SET ' + fields.map((k) => k + '=?').join(',') + ' WHERE id=?')
      .run(...Object.values(patch), id);
  }
  function startDueRetry() {
    return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM aba_public_jobs WHERE state='running'").get()) return;
      const plan = db.prepare("SELECT * FROM aba_public_retries WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT 1").get(now());
      if (!plan) return;
      const failed = db.prepare("SELECT * FROM aba_public_tasks WHERE job_id=? AND stage='failed'").all(plan.source_job_id);
      // 在补拉时刻之前若管理员已同步成功，不再请求那些 ASIN；按成功任务而非旧报告判断。
      const recovered = new Set(db.prepare("SELECT marketplace,brand,week_end,asins_json FROM aba_public_tasks WHERE job_id>? AND stage='done'")
        .all(plan.source_job_id).flatMap((t) => JSON.parse(t.asins_json).map((asin) => [t.marketplace, t.brand, t.week_end, asin].join(':'))));
      const pending = failed.map((task) => ({ ...task, asins: JSON.parse(task.asins_json)
        .filter((asin) => !recovered.has([task.marketplace, task.brand, task.week_end, asin].join(':'))) })).filter((task) => task.asins.length);
      if (!pending.length) {
        db.prepare("UPDATE aba_public_retries SET state='cancelled' WHERE source_job_id=?").run(plan.source_job_id);
        return;
      }
      const at = now();
      const { lastInsertRowid: id } = db.prepare("INSERT INTO aba_public_jobs(trigger_kind,created_at,updated_at) VALUES('retry',?,?)").run(at, at);
      const insert = db.prepare('INSERT INTO aba_public_tasks(job_id,marketplace,brand,week_start,week_end,asins_json) VALUES(?,?,?,?,?,?)');
      for (const task of pending) insert.run(id, task.marketplace, task.brand, task.week_start, task.week_end, JSON.stringify(task.asins));
      db.prepare("UPDATE aba_public_retries SET state='running',retry_job_id=? WHERE source_job_id=?").run(id, plan.source_job_id);
    })();
  }
  function finish(job) {
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM aba_public_jobs WHERE id=? AND state='running'").get(job.id)) return;
      const tasks = db.prepare('SELECT * FROM aba_public_tasks WHERE job_id=?').all(job.id);
      if (!tasks.every((t) => terminal.has(t.stage))) return;
      const failed = tasks.filter((t) => t.stage === 'failed');
      const at = now();
      if (job.trigger_kind === 'retry') {
        db.prepare("UPDATE aba_public_retries SET state='done' WHERE retry_job_id=?").run(job.id);
        const put = db.prepare(`INSERT INTO aba_public_actions(marketplace,brand,week_start,week_end,asin,error,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(marketplace,brand,week_end,asin)
          DO UPDATE SET error=excluded.error,updated_at=excluded.updated_at`);
        for (const task of failed) for (const asin of JSON.parse(task.asins_json))
          put.run(task.marketplace, task.brand, task.week_start, task.week_end, asin, task.error, at, at);
      } else if (failed.length) {
        // 定时任务锚定周二 12:00，因此补拉为周三 12:00；手动任务锚定启动时刻。
        db.prepare('INSERT OR IGNORE INTO aba_public_retries(source_job_id,due_at) VALUES(?,?)')
          .run(job.id, (job.schedule_slot ?? job.created_at) + RETRY_DELAY);
      }
      const reason = failed.length ? failed.length + ' 批报告失败，已保存的报告仍可查看；'
        + (job.trigger_kind === 'retry' ? '自动补拉仍失败，已列入超级管理员待处理事项' : '已安排次日自动补拉') : '';
      db.prepare('UPDATE aba_public_jobs SET state=?,updated_at=?,error=? WHERE id=?').run(
        failed.length ? failed.length === tasks.length ? 'failed' : 'partial' : 'done', at, reason, job.id);
    })();
  }
  function claim(jobId) {
    return db.transaction(() => {
      const pending = db.prepare("SELECT * FROM aba_public_tasks WHERE job_id=? AND stage NOT IN ('done','failed') AND next_at<=? AND locked_until<=? ORDER BY CASE WHEN report_id IS NULL THEN 1 ELSE 0 END, id")
        .all(jobId, now(), now());
      const lanes = new Set();
      const selected = [];
      for (const task of pending) {
        const account = accountFor(task);
        const lane = account ? account.sellerId + ':' + account.region : task.marketplace + ':' + task.brand;
        if (lanes.has(lane)) continue;
        if (!task.report_id && account) {
          db.prepare('INSERT OR IGNORE INTO aba_public_lanes(lane) VALUES(?)').run(lane);
          const next = db.prepare('SELECT next_create FROM aba_public_lanes WHERE lane=?').get(lane).next_create;
          if (next > now()) continue;
          db.prepare('UPDATE aba_public_lanes SET next_create=? WHERE lane=?').run(now() + createInterval, lane);
        }
        lanes.add(lane);
        update(task.id, { locked_until: now() + 5 * 60000 });
        selected.push({ task, account });
        if (selected.length === 4) break;
      }
      return selected;
    })();
  }
  async function advance(task, account) {
    const marketplace = AMAZON_MARKETPLACES[task.marketplace];
    const call = (path, options = {}) => request(account, marketplace.region, path, { ...options, role: '品牌分析 (Brand Analytics)' });
    const heartbeat = setInterval(() => update(task.id, { locked_until: now() + 5 * 60000 }), 60000);
    heartbeat.unref();
    try {
      if (!account) throw new Error(task.brand + ' / ' + task.marketplace + ' 缺少对应亚马逊品牌授权，请配置后重试同步');
      if (!task.report_id) {
        update(task.id, { stage: 'requesting', error: '' });
        const result = await call('/reports/2021-06-30/reports', { method: 'POST', body: {
          reportType: REPORT_TYPE, marketplaceIds: [marketplace.id],
          dataStartTime: task.week_start + 'T00:00:00Z', dataEndTime: task.week_end + 'T23:59:59Z',
          reportOptions: { reportPeriod: 'WEEK', asin: JSON.parse(task.asins_json).join(' ') },
        } });
        if (!result.reportId) throw new Error('亚马逊没有返回报告编号');
        update(task.id, { report_id: result.reportId, stage: 'waiting', next_at: now() + pollInterval, polls: 0, attempts: 0 });
      } else {
        update(task.id, { stage: 'waiting' });
        const result = await call('/reports/2021-06-30/reports/' + encodeURIComponent(task.report_id));
        if (result.processingStatus === 'DONE') {
          if (!result.reportDocumentId) throw new Error('亚马逊没有返回报告文档编号');
          const documentLane = account.sellerId + ':' + account.region + ':document';
          const availableAt = db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO aba_public_lanes(lane) VALUES(?)').run(documentLane);
            const next = db.prepare('SELECT next_create FROM aba_public_lanes WHERE lane=?').get(documentLane).next_create;
            if (next > now()) return next;
            db.prepare('UPDATE aba_public_lanes SET next_create=? WHERE lane=?').run(now() + createInterval, documentLane);
            return 0;
          })();
          if (availableAt) {
            update(task.id, { stage: 'waiting_download', next_at: availableAt });
            return;
          }
          update(task.id, { stage: 'downloading', error: '' });
          const document = await call('/reports/2021-06-30/documents/' + encodeURIComponent(result.reportDocumentId));
          const payload = await download(document);
          update(task.id, { stage: 'saving' });
          const saved = await save({ payload, task, marketplaceId: marketplace.id });
          update(task.id, { stage: 'done', rows_saved: saved.rows, error: '', attempts: 0 });
          const clear = db.prepare('DELETE FROM aba_public_actions WHERE marketplace=? AND brand=? AND week_end=? AND asin=?');
          db.transaction(() => {
            for (const asin of JSON.parse(task.asins_json)) clear.run(task.marketplace, task.brand, task.week_end, asin);
          })();
          onSaved();
        } else if (['IN_QUEUE', 'IN_PROGRESS'].includes(result.processingStatus) && task.polls < 120) {
          update(task.id, { stage: 'waiting', polls: task.polls + 1, next_at: now() + pollInterval, attempts: 0 });
        } else {
          throw new Error(result.processingStatus === 'FATAL' ? '亚马逊报告生成失败；请确认品牌分析权限、ASIN 归属及报告周是否已发布'
            : result.processingStatus === 'CANCELLED' ? '亚马逊已取消报告，可能尚无可用数据，请稍后重试同步'
              : task.polls >= 120 ? '等待报告超过 30 分钟，请稍后重试同步' : '亚马逊返回未知报告状态');
        }
      }
    } catch (error) {
      const retryable = account && (error.upstreamStatus === 429 || error.upstreamStatus >= 500
        || error.name === 'TimeoutError' || /下载失败|连不上/.test(error.message));
      const retry = retryable && task.attempts < 3;
      update(task.id, { stage: retry ? task.report_id ? 'waiting' : 'queued' : 'failed',
        attempts: task.attempts + 1, error: cleanError(error),
        next_at: now() + Math.min(300000, 60000 * 2 ** task.attempts) });
    } finally {
      clearInterval(heartbeat);
      update(task.id, { locked_until: 0 });
      db.prepare('UPDATE aba_public_jobs SET updated_at=? WHERE id=?').run(now(), task.job_id);
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      startDueRetry();
      const settings = db.prepare('SELECT * FROM aba_public_schedule WHERE id=1').get();
      if (settings.next_due <= now()) {
        const result = start(null, settings.next_due);
        if (!result.alreadyRunning) db.prepare('UPDATE aba_public_schedule SET next_due=? WHERE id=1').run(nextTuesday(now()));
      }
      const job = db.prepare("SELECT * FROM aba_public_jobs WHERE state='running'").get();
      if (!job) return;
      await Promise.all(claim(job.id).map(({ task, account }) => advance(task, account)));
      finish(job);
    } finally { busy = false; }
  }
  return { start, tick, status, attention, instance };
}
