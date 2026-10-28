// 語音工作室的核心：呼叫 Breeze 生成、補句尾、量長度、寫回台詞表。
// 純 Node（不碰 Electron），測試在 test/voicestudio.test.js；控制面板與 tools/generate-voices.js 共用。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const voice = require('./voicecore');

const DEFAULTS = { url: 'http://127.0.0.1:8080', voice: 'agent_girl', model: 'breeze-tts' };
const MAX_LINES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 實際送去唸的字：去掉結尾的「…」後補 dots 個「……」，避免 TTS 把最後一個字吃掉
function spokenText(line, dots = 1) {
  const base = String(line.say || line.text || '').replace(/[…]+$/, '');
  return base + '……'.repeat(Math.max(0, Math.min(5, dots | 0)));
}

// 一次只能處理一個請求；忙碌（409）就等一下再試
async function synth(o, text, fetchImpl = fetch) {
  const cfg = { ...DEFAULTS, ...o };
  for (let n = 0; n < 20; n++) {
    const res = await fetchImpl(`${cfg.url}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, input: text, voice: cfg.voice, response_format: 'wav' }),
    });
    if (res.status === 409) { await sleep(cfg.retryMs == null ? 1500 : cfg.retryMs); continue; }
    if (!res.ok) throw new Error(`Breeze 回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('Breeze 一直在忙，放棄這一句');
}

// 解析 WAV：回傳 { fmt:{channels,rate,bits}, dataStart, dataLen } 或 null（不是 PCM wav）
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12; let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') {
      if (size === 0 || size === 0xffffffff || pos + 8 + size > buf.length) size = buf.length - (pos + 8); // 串流輸出常寫 0 或 -1
      return fmt ? { fmt, dataStart: pos + 8, dataLen: size } : null;
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

function wavDurationMs(buf) {
  const w = parseWav(buf);
  if (!w || !w.fmt.rate) return null;
  return Math.round((w.dataLen / (w.fmt.channels * (w.fmt.bits / 8)) / w.fmt.rate) * 1000);
}

// 在 wav 後面接 ms 毫秒的靜音（純 JS，不需要 ffmpeg）；格式不認得就原樣回傳
function padWavSilence(buf, ms) {
  const w = parseWav(buf);
  if (!w || !(ms > 0)) return buf;
  const frame = w.fmt.channels * (w.fmt.bits / 8);
  const add = Math.round((ms / 1000) * w.fmt.rate) * frame;
  const head = Buffer.from(buf.subarray(0, w.dataStart + w.dataLen));
  const out = Buffer.concat([head, Buffer.alloc(add)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(w.dataLen + add, w.dataStart - 4);
  return out;
}

const hasFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// 存成音檔：有 ffmpeg 就轉 mp3（小很多），沒有就留 wav。回傳檔名
function saveAudio(dir, base, wav, ffmpeg = hasFfmpeg()) {
  for (const e of voice.EXTS) fs.rmSync(path.join(dir, `${base}.${e}`), { force: true }); // 舊檔（任何副檔名）換掉
  if (ffmpeg) {
    const tmp = path.join(dir, `${base}.tmp.wav`);
    const out = path.join(dir, `${base}.mp3`);
    fs.writeFileSync(tmp, wav);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-ar', '24000', '-b:a', '48k', out]);
    fs.rmSync(tmp, { force: true });
    if (r.status === 0) return `${base}.mp3`;
  }
  fs.writeFileSync(path.join(dir, `${base}.wav`), wav);
  return `${base}.wav`;
}

// 台詞表寫回去：維持原本「一個狀態一行」的排版，改起來好看、git diff 也小
function formatLines(lines) {
  const one = (l) => JSON.stringify(l).replace(/","/g, '", "').replace(/":"/g, '": "').replace(/,"/g, ', "').replace(/":(\d)/g, '": $1');
  const rows = Object.entries(lines).map(([k, v]) => (Array.isArray(v) ? ` ${JSON.stringify(k)}: [${v.map(one).join(', ')}]` : ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`));
  return `{\n${rows.join(',\n')}\n}\n`;
}

// 採用：把第 i 句換成新內容（i 等於現有句數就是新增，最多 3 句），存檔。回傳新的台詞表
function adopt(dir, key, i, entry, wav) {
  const file = path.join(dir, 'lines.json');
  const lines = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = Array.isArray(lines[key]) ? lines[key] : null;
  if (!arr) throw new Error(`沒有這個狀態：${key}`);
  if (!(i >= 0 && i <= arr.length && i < MAX_LINES)) throw new Error(`第 ${i + 1} 句不能存（每個狀態最多 ${MAX_LINES} 句）`);
  const clean = { text: String(entry.text || '').trim() };
  if (!clean.text) throw new Error('頭上顯示的字不能是空的');
  const say = String(entry.say || '').trim();
  if (say && say !== clean.text) clean.say = say;
  if (entry.pad != null && entry.pad !== 1) clean.pad = entry.pad | 0;
  if (entry.tail) clean.tail = entry.tail | 0;
  arr[i] = clean;
  const name = wav ? saveAudio(dir, voice.fileBase(key, i), wav) : null;
  fs.writeFileSync(file, formatLines(lines));
  return { lines, file: name };
}

module.exports = { DEFAULTS, MAX_LINES, spokenText, synth, parseWav, wavDurationMs, padWavSilence, hasFfmpeg, saveAudio, formatLines, adopt };
