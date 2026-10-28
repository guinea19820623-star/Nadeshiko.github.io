'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../app/lib/voicestudio');
const lines = require('../app/voice/lines.json');

// 做一個假的 PCM wav（單聲道 24kHz 16bit）
function wav(ms, { streaming = false } = {}) {
  const n = Math.round(ms / 1000 * 24000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(streaming ? 0xffffffff : n * 2, 40);
  b.fill(1, 44);
  return b;
}

test('spokenText：去掉結尾的…再補指定個數的「……」', () => {
  assert.strictEqual(s.spokenText({ text: '嗨～' }), '嗨～……');
  assert.strictEqual(s.spokenText({ text: 'Zzz…', say: '呼……呼……' }, 2), '呼……呼…………');
  assert.strictEqual(s.spokenText({ text: '好' }, 0), '好');
  assert.strictEqual(s.spokenText({ text: '好' }, 99), '好' + '……'.repeat(5));
});

test('wav：量長度、補靜音，串流寫法（長度 -1）也能處理', () => {
  assert.strictEqual(s.wavDurationMs(wav(1000)), 1000);
  assert.strictEqual(s.wavDurationMs(wav(1000, { streaming: true })), 1000);
  const p = s.padWavSilence(wav(1000), 300);
  assert.strictEqual(s.wavDurationMs(p), 1300);
  assert.strictEqual(p.readUInt32LE(4), p.length - 8);
  assert.strictEqual(s.wavDurationMs(s.padWavSilence(wav(500, { streaming: true }), 250)), 750);
  const junk = Buffer.from('not a wav at all, just bytes................................');
  assert.strictEqual(s.padWavSilence(junk, 300), junk);
  assert.strictEqual(s.wavDurationMs(junk), null);
});

test('synth：送出正確的請求；忙碌（409）會重試；錯誤要講清楚', async () => {
  const calls = [];
  let busy = 2;
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (busy-- > 0) return { status: 409, ok: false };
    return { status: 200, ok: true, arrayBuffer: async () => wav(100) };
  };
  const out = await s.synth({ url: 'http://x:1', voice: 'v1', retryMs: 1 }, '嗨……', f);
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls[2], { url: 'http://x:1/v1/audio/speech', body: { model: 'breeze-tts', input: '嗨……', voice: 'v1', response_format: 'wav' } });
  assert.strictEqual(s.wavDurationMs(out), 100);
  await assert.rejects(s.synth({}, 'a', async () => ({ status: 500, ok: false, text: async () => 'boom' })), /500.*boom/);
});

test('formatLines：跟現有 lines.json 排版逐字相同（採用時 git diff 只會有改的那一行）', () => {
  const orig = fs.readFileSync(path.join(__dirname, '../app/voice/lines.json'), 'utf8');
  assert.strictEqual(s.formatLines(lines), orig);
});

test('adopt：換第 i 句、新增、上限、換音檔（舊副檔名清掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  fs.copyFileSync(path.join(__dirname, '../app/voice/lines.json'), path.join(dir, 'lines.json'));
  fs.writeFileSync(path.join(dir, 'wave_2.mp3'), 'old');
  const r = s.adopt(dir, 'wave', 1, { text: '你好呀～', say: '你好呀', pad: 2, tail: 200 }, wav(300));
  assert.deepStrictEqual(r.lines.wave[1], { text: '你好呀～', say: '你好呀', pad: 2, tail: 200 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8'));
  assert.deepStrictEqual(saved.wave[1], r.lines.wave[1]);
  assert.strictEqual(saved.wave.length, 3);
  assert.ok(!fs.existsSync(path.join(dir, 'wave_2.wav')) !== !fs.existsSync(path.join(dir, 'wave_2.mp3')), 'wave_2 只能留一種格式');
  assert.ok(r.file.startsWith('wave_2.'));
  // 預設值不會寫進台詞表（pad=1、say 跟字一樣、沒有 tail）
  s.adopt(dir, 'wave', 0, { text: '嗨～', say: '嗨～', pad: 1, tail: 0 }, null);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'lines.json'), 'utf8')).wave[0], { text: '嗨～' });
  // 已經 3 句，第 4 句不能新增；空字、沒有的狀態也要擋
  assert.throws(() => s.adopt(dir, 'wave', 3, { text: 'x' }, null), /最多 3 句/);
  assert.throws(() => s.adopt(dir, 'wave', 0, { text: '  ' }, null), /不能是空的/);
  assert.throws(() => s.adopt(dir, 'nope', 0, { text: 'x' }, null), /沒有這個狀態/);
  fs.rmSync(dir, { recursive: true, force: true });
});
