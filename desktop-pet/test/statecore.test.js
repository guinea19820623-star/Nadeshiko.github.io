'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../app/lib/statecore');

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const sec = NOW / 1000;
const usage = (five, week) => ({
  five_hour: five == null ? null : { used_percentage: five, resets_at: sec + 3600 },
  seven_day: week == null ? null : { used_percentage: week, resets_at: sec + 86400 },
});
const sess = (activity, ago = 1000, tool) => ({ id: 'a', activity, tool, ts: NOW - ago });

test('沒有任何資料 → 自由行動', () => {
  assert.strictEqual(core.resolve(null, NOW).body, 'free');
  assert.strictEqual(core.resolve({ sessions: [] }, NOW).body, 'free');
});

test('思考與工作', () => {
  assert.strictEqual(core.resolve({ sessions: [sess('thinking')] }, NOW).body, 'thinking');
  const r = core.resolve({ sessions: [sess('working', 1000, 'Bash')] }, NOW);
  assert.strictEqual(r.body, 'working');
  assert.strictEqual(r.tool, 'Bash');
  assert.strictEqual(core.bubbleText(r, NOW), '工作中 · Bash');
});

test('多個工作階段取最高優先：工作 > 思考 > 完成', () => {
  const r = core.resolve({ sessions: [sess('done'), sess('thinking'), sess('working', 500, 'Edit')] }, NOW);
  assert.strictEqual(r.body, 'working');
});

test('思考太久沒動靜視為中斷；完成只顯示幾秒', () => {
  assert.strictEqual(core.resolve({ sessions: [sess('thinking', 11 * 60 * 1000)] }, NOW).body, 'free');
  assert.strictEqual(core.resolve({ sessions: [sess('done', 2000)] }, NOW).body, 'done');
  assert.strictEqual(core.resolve({ sessions: [sess('done', 9000)] }, NOW).body, 'free');
});

test('用量 85% 以上 → 疲憊，優先於工作中', () => {
  assert.strictEqual(core.resolve({ usage: usage(84, 10) }, NOW).body, 'free');
  assert.strictEqual(core.resolve({ usage: usage(85, 10) }, NOW).body, 'tired');
  assert.strictEqual(core.resolve({ usage: usage(20, 90) }, NOW).body, 'tired');
  const r = core.resolve({ usage: usage(90, 10), sessions: [sess('working')] }, NOW);
  assert.strictEqual(r.body, 'tired');
  assert.strictEqual(r.activity, 'working');
  assert.strictEqual(core.bubbleText(r, NOW), "還在工作…體力剩 10%");
});

test('週上限 → 暈倒（最高優先）；5h 用完 → 睡覺', () => {
  assert.strictEqual(core.resolve({ usage: usage(30, 100), sessions: [sess('working')] }, NOW).body, 'faint');
  assert.strictEqual(core.resolve({ usage: usage(100, 60) }, NOW).body, 'exhausted');
  assert.strictEqual(core.resolve({ usage: usage(100, 100) }, NOW).body, 'faint');
});

test('門檻可以調整', () => {
  assert.strictEqual(core.resolve({ usage: usage(75, 10) }, NOW, { tiredAt: 70 }).body, 'tired');
});

test('過了重置時間的用量作廢', () => {
  const u = { five_hour: { used_percentage: 99, resets_at: sec - 10 }, seven_day: { used_percentage: 20, resets_at: sec + 99 } };
  assert.strictEqual(core.resolve({ usage: u }, NOW).body, 'free');
});

test('StopFailure(rate_limit) 旗標：依用量判斷是週上限還是 5h', () => {
  const lim = { hit: true, ts: NOW - 1000 };
  assert.strictEqual(core.resolve({ limit: lim, usage: usage(40, 98) }, NOW).body, 'faint');
  assert.strictEqual(core.resolve({ limit: lim, usage: usage(97, 50) }, NOW).body, 'exhausted');
  // 沒有用量資料：當作 5h，一小時後自動解除
  assert.strictEqual(core.resolve({ limit: lim }, NOW).body, 'exhausted');
  assert.strictEqual(core.resolve({ limit: { hit: true, ts: NOW - 2 * 3600 * 1000 } }, NOW).body, 'free');
});

test('fmtReset：同一天只顯示時間，其他天加星期', () => {
  const d = new Date(NOW);
  d.setHours(18, 5, 0, 0);
  assert.strictEqual(core.fmtReset(d.getTime() / 1000, d.getTime() - 3600 * 1000), '18:05');
  assert.match(core.fmtReset(d.getTime() / 1000 + 2 * 86400, d.getTime()), /^週. 18:05$/);
});
