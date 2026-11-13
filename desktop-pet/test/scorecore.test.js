'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sc = require('../app/lib/scorecore');

test('toMidi：音名、升降、沿用八度', () => {
  assert.strictEqual(sc.toMidi('C4', 0).midi, 60);
  assert.strictEqual(sc.toMidi('A4', 0).midi, 69);
  assert.strictEqual(sc.toMidi('D#5', 0).midi, 75);
  assert.strictEqual(sc.toMidi('Bb3', 0).midi, 58);
  assert.strictEqual(sc.toMidi('E', 5).midi, 76);
  assert.throws(() => sc.toMidi('H4', 4));
});

test('parseVoice：長度沿用、休止、和弦、小節線', () => {
  const r = sc.parseVoice('E5 D# | A4:2 r C4+E:3');
  assert.deepStrictEqual(r.notes.map((n) => [n.at, n.len, n.midi]), [
    [0, 1, 76], [1, 1, 75], [2, 2, 69], [6, 3, 60], [6, 3, 64],
  ]);
  assert.strictEqual(r.length, 9);
});

test('compile：多聲部換成秒、按時間排序', () => {
  const s = sc.compile({ tempo: 0.5, voices: ['C5 D', 'C3:2'] });
  assert.strictEqual(s.seconds, 1);
  assert.deepStrictEqual(s.notes.map((n) => [n.t, n.midi]), [[0, 48], [0, 72], [0.5, 74]]);
});

test('附的樂譜都讀得懂，而且每首都標了作曲家', () => {
  const dir = path.join(__dirname, '..', 'app', 'scores');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const score = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const s = sc.compile(score);
    assert.ok(s.notes.length > 10, f);
    assert.ok(s.seconds > 5 && s.seconds < 600, f);
    assert.ok(score.composer, `${f} 要標作曲家（版權）`);
  }
});
