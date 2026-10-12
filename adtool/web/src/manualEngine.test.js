import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualPlan, buildManualWorkbookData } from './manualEngine.js';

const base = (patch = {}) => ({
  camp: 'ES_SP_KW_301', group: '', portfolio: '', date: '20260730', budget: 5, defBid: 0.3,
  strategy: 'down', places: { TOS: '', ROS: '', PP: '' }, bidMode: 'bid',
  skus: 'SKU-1', mode: 'kw', splitGroup: false,
  kw: {
    精准: { on: true, bid: '0.5', text: '' },
    词组: { on: true, bid: '0.4', text: '' },
    广泛: { on: true, bid: '', text: '' },
  },
  tgt: {}, ...patch,
});

test('三合一:一份词同时写成精准 / 词组 / 广泛,各用各的出价', () => {
  const plan = buildManualPlan(base({ kwTriple: true, kwShared: 'hp 301 ink\n"hp 301"\nhp 301 ink' }), null);
  assert.equal(plan.ok, true, plan.problems.join(';'));
  assert.equal(plan.targets, 6);
  assert.deepEqual(plan.units.map((u) => [u.key, u.bid, u.items.map((i) => i.text)]), [
    ['精准', 0.5, ['[hp 301 ink]', '[hp 301]']],
    ['词组', 0.4, ['"hp 301 ink"', '"hp 301"']],
    ['广泛', 0.3, ['hp 301 ink', 'hp 301']],
  ]);
  const wb = buildManualWorkbookData([{ plan }]);
  assert.deepEqual(wb.bad, []);
});

test('三合一:关掉的匹配类型不写,分开填的旧词不参与', () => {
  const task = base({ kwTriple: true, kwShared: 'canon 245' });
  task.kw.词组 = { on: false, bid: '', text: '' };
  task.kw.精准.text = 'old word';
  const plan = buildManualPlan(task, null);
  assert.deepEqual(plan.units.map((u) => u.key), ['精准', '广泛']);
  assert.deepEqual(plan.units[0].items.map((i) => i.text), ['[canon 245]']);
});

test('三合一:没粘词时拦住生成', () => {
  const plan = buildManualPlan(base({ kwTriple: true, kwShared: '' }), null);
  assert.equal(plan.ok, false);
  assert.ok(plan.problems.some((p) => p.includes('三合一')));
});

test('三合一 + 每种匹配单独一个广告组', () => {
  const plan = buildManualPlan(base({ kwTriple: true, kwShared: 'epson 202', splitGroup: true }), null);
  assert.deepEqual(plan.groups.map((g) => g.name), ['ES_SP_KW_301_精准', 'ES_SP_KW_301_词组', 'ES_SP_KW_301_广泛']);
  assert.deepEqual(buildManualWorkbookData([{ plan }]).bad, []);
});
