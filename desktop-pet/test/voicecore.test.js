'use strict';
const test = require('node:test');
const assert = require('node:assert');
const v = require('../app/lib/voicecore');
const lines = require('../app/voice/lines.json');

test('台詞表：每個狀態 2~3 句，且有文字', () => {
  for (const [k, arr] of Object.entries(lines)) {
    if (k.startsWith('_')) continue;
    assert.ok(arr.length >= 2 && arr.length <= 3, `${k} 有 ${arr.length} 句`);
    for (const l of arr) assert.ok(l.text && l.text.trim(), `${k} 有空白台詞`);
  }
});

test('build：音檔對得上才給 file，沒有就是 null（只出字）', () => {
  const b = v.build({ wave: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }, ['wave_1.mp3', 'wave_3.wav', 'other.mp3']);
  assert.deepStrictEqual(b.wave.map((x) => x.file), ['wave_1.mp3', null, 'wave_3.wav']);
  assert.deepStrictEqual(v.build({ x: [{ text: 'a' }] }, []).x[0].file, null);
});

test('pickIndex：不連續重複，範圍正確', () => {
  for (let last = 0; last < 3; last++) {
    for (let t = 0; t < 200; t++) {
      const i = v.pickIndex(3, last);
      assert.ok(i >= 0 && i < 3 && i !== last);
    }
  }
  assert.strictEqual(v.pickIndex(1, 0), 0);
});
