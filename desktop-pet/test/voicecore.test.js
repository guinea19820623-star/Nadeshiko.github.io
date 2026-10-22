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

// 程式裡開口用到的每個台詞鍵，台詞表都要有（否則只出預設字、沒有聲音）
test('pet.js 用到的 say 鍵都在台詞表裡', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'pet.js'), 'utf8');
  const lines = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app', 'voice', 'lines.json'), 'utf8'));
  const keys = new Set();
  for (const m of src.matchAll(/\bsay\('([a-z_]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/say: '([a-z_]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/`greet_\$\{/g)) for (const p of ['morning', 'noon', 'afternoon', 'evening', 'night']) keys.add(`greet_${p}`);
  const missing = [...keys].filter((k) => !lines[k] && !['kind'].includes(k));
  assert.deepEqual(missing, []);
});
