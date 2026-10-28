#!/usr/bin/env node
'use strict';
// 事先生成撫子的語音台詞：讀 app/voice/lines.json，每句產生 app/voice/<key>_<序號>.mp3
//
//   node tools/generate-voices.js                 # 用本機 Breeze-TTS（預設），只補缺的檔案
//   node tools/generate-voices.js --force         # 全部重新生成
//   node tools/generate-voices.js --only pat,wave # 只生成指定狀態
//   node tools/generate-voices.js --engine edge   # 改用 Edge TTS（需要 pip install edge-tts）
//   node tools/generate-voices.js --check         # 檢查哪些台詞還沒有音檔
//   node tools/generate-voices.js --list          # 只列出會生成哪些，不呼叫任何服務
//
// Breeze 選項：--url http://127.0.0.1:8080  --voice agent_girl  --model breeze-tts
// 輸出格式：有 ffmpeg 就轉成 mp3（小很多）；沒有就保留服務回傳的格式（通常是 wav）。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const voice = require('../app/lib/voicecore');
const studio = require('../app/lib/voicestudio');

const DIR = path.join(__dirname, '..', 'app', 'voice');

function parseArgs(argv) {
  const o = { engine: 'breeze', url: 'http://127.0.0.1:8080', voice: null, model: 'breeze-tts', force: false, only: null, list: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') o.force = true;
    else if (a === '--list') o.list = true;
    else if (a === '--check') o.check = true;
    else if (a === '--engine') o.engine = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--voice') o.voice = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--only') o.only = argv[++i].split(',');
    else { console.error(`不認識的參數：${a}`); process.exit(2); }
  }
  if (!o.voice) o.voice = o.engine === 'edge' ? 'zh-TW-HsiaoChenNeural' : 'agent_girl';
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasFfmpeg = () => spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// 句尾補「……」，避免 TTS 把最後一個字吃掉；語音工作室可以替每句設定補幾個（pad）與後面接幾毫秒靜音（tail）
const spoken = (l) => studio.spokenText(l, l.pad == null ? 1 : l.pad);

async function breeze(o, text) {
  // 一次只能處理一個請求；忙碌（409）就等一下再試
  for (let n = 0; n < 20; n++) {
    const res = await fetch(`${o.url}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, input: text, voice: o.voice, response_format: 'wav' }),
    });
    if (res.status === 409) { await sleep(1500); continue; }
    if (!res.ok) throw new Error(`Breeze 回應 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return { data: Buffer.from(await res.arrayBuffer()), ext: 'wav' };
  }
  throw new Error('Breeze 一直在忙，放棄這一句');
}

function edge(o, text, tmp) {
  const r = spawnSync('edge-tts', ['--voice', o.voice, '--text', text, '--write-media', tmp], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`edge-tts 失敗：${(r.error && r.error.message) || r.stderr}`);
  return { data: fs.readFileSync(tmp), ext: 'mp3' };
}

function save(base, got, ffmpeg) {
  const raw = path.join(DIR, `${base}.${got.ext}`);
  if (got.ext === 'mp3' || !ffmpeg) { fs.writeFileSync(raw, got.data); return path.basename(raw); }
  const tmp = path.join(DIR, `${base}.tmp.${got.ext}`);
  const out = path.join(DIR, `${base}.mp3`);
  fs.writeFileSync(tmp, got.data);
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-ac', '1', '-ar', '24000', '-b:a', '48k', out]);
  fs.unlinkSync(tmp);
  if (r.status !== 0) { fs.writeFileSync(raw, got.data); return path.basename(raw); } // 轉檔失敗就留原檔
  return path.basename(out);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const lines = JSON.parse(fs.readFileSync(path.join(DIR, 'lines.json'), 'utf8'));
  const existing = new Set(fs.readdirSync(DIR));
  const jobs = [];
  for (const [key, arr] of Object.entries(lines)) {
    if (key.startsWith('_') || (o.only && !o.only.includes(key))) continue;
    arr.forEach((l, i) => {
      const base = voice.fileBase(key, i);
      const done = voice.EXTS.some((e) => existing.has(`${base}.${e}`));
      if (o.force || !done) jobs.push({ key, base, text: spoken(l), shown: l.text, tail: l.tail || 0 });
    });
  }
  if (o.check) {
    console.log(jobs.length ? `缺音檔 ${jobs.length} 句：` : '所有台詞都有音檔。');
    for (const j of jobs) console.log(`  ${j.base}  ${j.shown}`);
    process.exitCode = jobs.length ? 1 : 0;
    return;
  }
  console.log(`要生成 ${jobs.length} 句（引擎：${o.engine}，聲音：${o.voice}）`);
  if (o.list) { for (const j of jobs) console.log(`  ${j.base}  ${j.text}`); return; }
  const ffmpeg = hasFfmpeg();
  if (!ffmpeg) console.log('找不到 ffmpeg：Breeze 的 wav 會直接保留（檔案較大，裝了 ffmpeg 再跑一次 --force 可轉成 mp3）');
  let ok = 0; const failed = [];
  for (const j of jobs) {
    try {
      const got = o.engine === 'edge' ? edge(o, j.text, path.join(DIR, `${j.base}.tmp-edge.mp3`)) : await breeze(o, j.text);
      if (got.ext === 'wav' && j.tail) got.data = studio.padWavSilence(got.data, j.tail);
      const name = save(j.base, got, ffmpeg);
      fs.rmSync(path.join(DIR, `${j.base}.tmp-edge.mp3`), { force: true });
      ok++;
      console.log(`✓ ${name}  ${j.shown}`);
    } catch (e) {
      failed.push(j.base);
      console.log(`✗ ${j.base}  ${e.message}`);
      if (/fetch failed|ECONNREFUSED/.test(`${e.message} ${e.cause && (e.cause.code || e.cause.message)}`)) { console.log('連不上語音服務，請先啟動 Breeze-TTS（或加 --engine edge）。'); break; }
    }
  }
  console.log(`完成 ${ok} 句${failed.length ? `，失敗 ${failed.length} 句：${failed.join(', ')}` : ''}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
