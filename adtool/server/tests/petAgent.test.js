import test from 'node:test';
import assert from 'node:assert/strict';
import { startPetTestServer } from './petHarness.js';

test('daily agent report, lessons, reviews and change timeline', async (t) => {
  process.env.PET_TODAY = '2026-10-12';
  const backend = await startPetTestServer();
  t.after(() => backend.close());
  const { db, url } = backend;
  const agent = await import('../src/petAgent.js');

  const sale = db.prepare('INSERT INTO pet_daily_sales (day, sku, asin, units, orders, sales) VALUES (?, ?, ?, ?, ?, ?)');
  for (let day = 4; day <= 10; day += 1) sale.run(`2026-10-${String(day).padStart(2, '0')}`, 'DOG-S', 'B000000001', 10, 9, 300);
  sale.run('2026-10-11', 'DOG-S', 'B000000001', 15, 14, 450);
  const proposal = db.prepare(`INSERT INTO pet_change_proposals (kind, target_key, target_json, before_json, after_json, reason, status, created_at, decided_at, executed_at, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const target = JSON.stringify({ sku: 'DOG-S', asin: 'B000000001', style: '方窝牛津', size: 'S' });
  const applied = proposal.run('listing_title', 'listing_title|dog-s', target, '"Old title"', '"New title"', 'ABA 词', 'applied',
    '2026-10-01 10:00:00', '2026-10-01 11:00:00', '2026-10-01 12:00:00', '2026-10-01 13:00:00').lastInsertRowid;
  const pending = proposal.run('listing_bullets', 'listing_bullets|dog-s', target, '["a"]', '["b"]', '五点', 'pending',
    '2026-10-11 10:00:00', null, null, null).lastInsertRowid;

  await t.test('context lists due reviews and cooldown', () => {
    const context = agent.agentContext({ today: '2026-10-12' });
    assert.equal(context.reportDay, '2026-10-11');
    assert.equal(context.pendingProposals, 1);
    assert.deepEqual(context.changesToReview.map((item) => [item.id, item.dueMilestone]), [[Number(applied), 7]]);
    assert.equal(context.cooldownSkus[0].sku, 'DOG-S');
    assert.equal(context.cooldownSkus[0].until, agent.COOLDOWN_DAYS === 14 ? '2026-10-15' : context.cooldownSkus[0].until);
  });

  await t.test('lessons and report are saved, reviews feed the timeline', () => {
    const lesson = agent.saveLesson({ title: '标题前 80 字符放核心词', body: '手机端只显示前 80 字符', area: 'listing', changeKind: 'listing_title', verdict: 'works',
      confidence: 'low', changeIds: [Number(applied)] }, { today: '2026-10-12' });
    assert.equal(lesson.fromDay, '2026-10-11');
    const updated = agent.saveLesson({ id: lesson.id, confidence: 'medium', changeIds: [99] });
    assert.equal(updated.confidence, 'medium');
    assert.equal(updated.title, '标题前 80 字符放核心词');
    assert.deepEqual(updated.changeIds, [Number(applied), 99]);
    assert.throws(() => agent.saveDailyReport({ headline: 'x', reviews: [{ changeId: 12345, verdict: 'works', text: 'x' }] }, { today: '2026-10-12' }), /没有这些改动编号/);
    assert.throws(() => agent.saveDailyReport({ day: '2026-10-12', headline: 'x' }, { today: '2026-10-12' }), /今天之前/);
    const saved = agent.saveDailyReport({ headline: '销量回升', sections: [{ area: 'inventory', status: 'bad', summary: 'S 码快断货', findings: [] }],
      actions: [{ type: 'proposal', priority: 'high', text: '改五点', proposalIds: [Number(pending)] }],
      reviews: [{ changeId: Number(applied), verdict: 'works', text: '销量 +50%', metrics: { unitsPerDayPct: 50 }, lessonId: lesson.id }],
      lessonsUsed: [lesson.id] }, { today: '2026-10-12' });
    assert.equal(saved.day, '2026-10-11');
    const report = agent.getReport('2026-10-11');
    assert.equal(report.kpis.sales.units.value, 15);
    assert.equal(report.kpis.sales.units.avg7, 10);
    assert.equal(report.kpis.sales.units.changePct, 50);
    assert.equal(report.changes[pending].statusLabel, '待确认');
    assert.equal(report.lessons[0].id, lesson.id);
    assert.equal(agent.listLessons()[0].timesUsed, 1);
    // 同一天再写覆盖
    agent.saveDailyReport({ headline: '重跑', reviews: [{ changeId: Number(applied), verdict: 'works', text: '再看一次' }] }, { today: '2026-10-12' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_agent_reports').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pet_change_reviews').get().n, 1);
    assert.equal(agent.runCalendar({ days: 3, today: '2026-10-12' }).map((item) => item.status).join(), 'done,missing,missing');

    const timeline = agent.changeTimeline({ days: 30, today: '2026-10-12' });
    const row = timeline.items.find((item) => item.id === Number(applied));
    assert.equal(row.verdict, 'works');
    assert.equal(row.reviews[0].daysAfter, 10);
    assert.deepEqual(row.steps.map((step) => step.state), ['done', 'done', 'done', 'done', 'done']);
    assert.deepEqual(timeline.items.find((item) => item.id === Number(pending)).steps.map((step) => step.state), ['done', 'now', 'todo', 'todo', 'todo']);
    assert.equal(timeline.stats.pending, 1);
    assert.equal(timeline.stats.works, 1);
    // 复盘过的改动不再出现在待复盘里
    assert.equal(agent.agentContext({ today: '2026-10-12' }).changesToReview.length, 0);
  });

  await t.test('pages: owner sees log and can retire lessons, operator only reads reports', async () => {
    const login = async (username) => {
      const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'pet-test-password' }) });
      return response.headers.get('set-cookie').split(';')[0];
    };
    const owner = await login('pet-owner'), operator = await login('pet-user');
    const get = (path, cookie) => fetch(`${url}/api/agent${path}`, { headers: { cookie } });
    assert.equal((await (await get('/reports/latest', operator)).json()).report.headline, '重跑');
    assert.equal((await get('/changelog', operator)).status, 403);
    const log = await (await get('/changelog', owner)).json();
    assert.equal(log.items.length, 2);
    const lessonId = agent.listLessons()[0].id;
    const retire = await fetch(`${url}/api/agent/lessons/${lessonId}/status`, { method: 'POST', headers: { cookie: owner, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'retired', reason: '样本太少' }) });
    assert.equal((await retire.json()).lesson.status, 'retired');
    assert.equal(agent.agentContext({ today: '2026-10-12' }).lessons.length, 0);
  });
});
