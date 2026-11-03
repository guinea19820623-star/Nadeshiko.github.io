'use strict';
const test = require('node:test');
const assert = require('node:assert');
const c = require('../app/lib/clipcore');
const fs = require('node:fs');
const path = require('node:path');

const D = (n, s = 0.2) => Array.from({ length: n }, () => s);
const once = { mode: 'once', durations: D(4) };
const loop = { mode: 'loop', durations: D(10), intro: [0, 2], loop: [3, 9], xfade: 0.3 };

test('once：依時間走過每一格，播完停在最後一格並標記 done', () => {
  assert.strictEqual(c.frameAt(once, 0).i, 0);
  assert.strictEqual(c.frameAt(once, 0.45).i, 2);
  const e = c.frameAt(once, 5);
  assert.strictEqual(e.i, 3);
  assert.ok(e.done);
  assert.ok(Math.abs(c.playLength(once) - 0.8) < 1e-9);
});

test('loop：先播 intro 一次，之後只在 loop 範圍裡反覆', () => {
  assert.strictEqual(c.frameAt(loop, 0.1).i, 0);
  assert.strictEqual(c.frameAt(loop, 0.5).i, 2);
  assert.strictEqual(c.frameAt(loop, 0.65).i, 3);
  const len = c.loopLength(loop); // 7 格 × 0.2
  const intro = c.playLength(loop);
  assert.ok(Math.abs(len - 1.4) < 1e-9 && Math.abs(intro - 0.6) < 1e-9);
  for (let t = intro; t < intro + len * 5; t += 0.037) {
    const f = c.frameAt(loop, t);
    assert.ok(f.i >= 3 && f.i <= 9, `t=${t} 跑出 loop 範圍：${f.i}`);
  }
  // 第二輪跟第一輪同一時間點是同一格
  assert.strictEqual(c.frameAt(loop, intro + 0.5).i, c.frameAt(loop, intro + len + 0.5).i);
});

test('loop 接縫：最後 xfade 秒淡入下一輪第一格，淡到 1 時剛好等於下一輪開頭', () => {
  const intro = c.playLength(loop);
  const len = c.loopLength(loop);
  const mid = c.frameAt(loop, intro + len - 0.15);
  assert.strictEqual(mid.next, 3);
  assert.ok(mid.a > 0.4 && mid.a < 0.6);
  assert.strictEqual(c.frameAt(loop, intro + len - 0.5).next, -1);
  assert.ok(c.frameAt(loop, intro + len - 0.001).a > 0.99);
});

test('compose：開頭從底圖淡入、結尾淡回底圖', () => {
  const key = (i) => `k${i}`;
  const f = c.frameAt(once, 0.05);
  const a = c.compose(f, key, 0.05, { base: 'idle', fadeIn: 0.2, fadeOut: 0.2, dur: 1 });
  assert.strictEqual(a.sprite, 'idle');
  assert.strictEqual(a.blend.sprite, 'k0');
  assert.ok(Math.abs(a.blend.a - 0.25) < 1e-9);
  const m = c.compose(c.frameAt(once, 0.5), key, 0.5, { base: 'idle', fadeIn: 0.2, fadeOut: 0.2, dur: 1 });
  assert.strictEqual(m.sprite, 'k2');
  assert.strictEqual(m.blend, null);
  const z = c.compose(c.frameAt(once, 0.9), key, 0.9, { base: 'idle', fadeIn: 0.2, fadeOut: 0.2, dur: 1 });
  assert.strictEqual(z.blend.sprite, 'idle');
  assert.ok(Math.abs(z.blend.a - 0.5) < 1e-9);
  // 持續型（沒有 dur）不會淡出
  assert.strictEqual(c.compose(c.frameAt(loop, 0.8), key, 0.8, { fadeOut: 0.3 }).blend, null);
});

test('manifest.clips：每個片段的格數、時間、bbox 與檔案都對得上', () => {
  const dir = path.join(__dirname, '..', 'app', 'sprites');
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const names = Object.keys(man.clips || {});
  assert.ok(names.length > 0, 'manifest 裡沒有 clips');
  for (const [name, def] of Object.entries(man.clips)) {
    const n = def.frames.length;
    assert.ok(n >= 2, `${name} 格數不足`);
    assert.strictEqual(def.durations.length, n, `${name} durations 數量不對`);
    assert.strictEqual(def.bbox.length, n, `${name} bbox 數量不對`);
    assert.strictEqual(def.head.length, n, `${name} head 數量不對`);
    // 坐姿循環開頭那格會刻意停住幾秒（眨眼、點頭不要太頻繁），所以上限放到 6 秒
    assert.ok(def.durations.every((s) => s > 0 && s < 6), `${name} 有不合理的秒數`);
    if (def.mode === 'loop') {
      const [l0, l1] = def.loop;
      assert.ok(l0 >= 0 && l1 < n && l1 > l0, `${name} loop 範圍錯誤`);
      if (def.intro) assert.ok(def.intro[0] >= 0 && def.intro[1] < l0, `${name} intro 必須在 loop 之前`);
    } else assert.strictEqual(def.mode, 'once');
    for (const f of def.frames) assert.ok(fs.existsSync(path.join(dir, 'clips', f)), `${name} 缺檔 ${f}`);
  }
});
