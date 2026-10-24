'use strict';
// 撫子桌寵：畫面與行為
//
// 優先序：使用者互動（拖曳、摸頭）> 測試狀態 > Claude 狀態（暈倒 > 睡覺 > 疲憊 > 工作 > 思考 …）> 隨機行為
/* global PetCore, VoiceCore */

const host = window.petHost;
const core = PetCore;
const voiceCore = VoiceCore;

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const bubbleEl = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const staminaEl = document.getElementById('stamina');
const fxEl = document.getElementById('fx');

// 沒有左右腳交替的素材，用「大步 → 收腳 → 抬後腳 → 跨出」四張輪播
const WALK_FRAMES = ['walk4', 'walk1', 'walk2', 'walk3'];
const ACTION_LINES = {
  yawn: '呼啊～', stretch: '嗯～～', wave: '嗨～', cheer: '好耶～', nap: 'Zzz…',
  curious: '嗯？', pose: '♪', happy: '嘿嘿♪', pat: '再摸一下嘛…', drag: '哇！放我下來～', dizzy: '暈…',
};

const S = {
  settings: null,
  manifest: null,
  bubbleH: 52,
  padX: 40,
  snapshot: null,
  forced: null,
  size: 250,
  dpr: 1,
  bitmaps: {},
  pos: { x: 0, y: 0 },
  workArea: { x: 0, y: 0, width: 1280, height: 720 },
  ignoring: true,
  hover: false,
  lastInteraction: performance.now(),
  lastClaudeActive: performance.now(),
  say: null,        // { text, until }
  voice: {},        // key → [{ text, file }]
  voiceLast: {},    // key → 上次唸的是第幾句
  voiceAt: {},      // key → 上次開口的時間（冷卻用）
};

// 目前畫面要怎麼畫
const view = { sprite: 'idle', flip: false, dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, pivot: 'feet' };

// ---------- 小工具 ----------
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (weights) => {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries.length ? entries[0][0] : 'idle';
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const winW = () => S.size + S.padX * 2;
const winH = () => S.size + S.bubbleH;
const cx = () => S.padX + S.size / 2; // 角色中心線（視窗內座標）
const groundPx = () => (S.manifest.ground / S.manifest.canvas) * S.size;
const groundY = () => S.workArea.y + S.workArea.height - S.bubbleH - groundPx();
const onGround = () => Math.abs(S.pos.y - groundY()) < 2;

// ---------- 語音 ----------
const VOICE_DIR = '../voice/';
const VOICE_COOLDOWN = { thinking: 60000, working: 60000, tired: 120000, exhausted: 120000, faint: 120000, nap: 30000, sit: 30000, perch: 30000, perch_lie: 30000, drop: 20000, shy: 8000 };
const audioCache = {};
let nowPlaying = null;

// 從該狀態的 2~3 句裡隨機挑一句（不連續重複）；沒有台詞表就回 null
function chooseLine(key) {
  const arr = S.voice[key];
  if (!arr || !arr.length) return null;
  const i = voiceCore.pickIndex(arr.length, S.voiceLast[key]);
  S.voiceLast[key] = i;
  return arr[i];
}

function playFile(file) {
  const s = S.settings;
  if (!s.voice || !file || !(s.volume > 0)) return;
  try {
    let a = audioCache[file];
    if (!a) { a = new Audio(VOICE_DIR + file); a.preload = 'auto'; audioCache[file] = a; } // 第一次要用才載入
    if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
    a.volume = clamp(s.volume / 100, 0, 1);
    a.currentTime = 0;
    nowPlaying = a;
    a.play().catch(() => {}); // 音檔壞掉或被擋下就靜音，不影響動作
  } catch (_) { /* ignore */ }
}

// 這個狀態現在可以開口嗎（冷卻中就安靜，字照出）
function voiceReady(key) {
  const now = performance.now();
  if (now - (S.voiceAt[key] || -1e9) < (VOICE_COOLDOWN[key] || 4000)) return false;
  S.voiceAt[key] = now;
  return true;
}

// 回傳要顯示的字：有台詞表就用挑到的那句（跟聲音同步），沒有就用固定字
function say(key, ms = 1800, opts = {}) {
  const line = chooseLine(key);
  const text = line ? line.text : (ACTION_LINES[key] || key);
  if (line && line.file && voiceReady(key)) playFile(line.file);
  if (!opts.mute) S.say = { text, until: performance.now() + ms };
  return text;
}

// Claude 狀態切換時只出聲，字仍由狀態機（含工具名、剩餘體力等即時資訊）決定
function sayClaude(body) {
  const line = chooseLine(body);
  if (line && line.file && voiceReady(body)) playFile(line.file);
}

function moveTo(x, y) {
  const nx = Math.round(x);
  const ny = Math.round(y);
  if (nx === Math.round(S.pos.x) && ny === Math.round(S.pos.y)) { S.pos.x = x; S.pos.y = y; return; }
  S.pos.x = x; S.pos.y = y;
  host.move(nx, ny);
}

async function refreshGeom(force) {
  const g = await host.geom();
  if (!g) return;
  S.workArea = g.workArea;
  if (force || !mode || !mode.ownsPosition) { S.pos.x = g.bounds.x; S.pos.y = g.bounds.y; }
  // 視窗尺寸被系統改掉（高 DPI 縮放的捨入誤差）時，拉回正確大小
  if (Math.abs(g.bounds.width - winW()) > 1 || Math.abs(g.bounds.height - winH()) > 1) host.move(S.pos.x, S.pos.y);
}

// ---------- 素材 ----------
async function buildBitmaps() {
  S.dpr = window.devicePixelRatio || 1;
  const l = core.layout(S.size);
  S.padX = l.padX;
  S.bubbleH = l.bubbleH;
  const px = Math.round(S.size * S.dpr);
  canvas.width = Math.round(winW() * S.dpr);
  canvas.height = Math.round(winH() * S.dpr);
  canvas.style.width = `${winW()}px`;
  canvas.style.height = `${winH()}px`;
  const entries = Object.entries(S.manifest.sprites);
  const out = {};
  await Promise.all(entries.map(async ([key, info]) => {
    const img = await loadImage(`../sprites/${info.file}`);
    out[key] = await createImageBitmap(img, { resizeWidth: px, resizeHeight: px, resizeQuality: 'high' });
  }));
  S.bitmaps = out;
}

const imageCache = {};
function loadImage(src) {
  if (!imageCache[src]) {
    imageCache[src] = new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }
  return imageCache[src];
}

// ---------- 繪圖 ----------
function draw() {
  const d = S.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bmp = S.bitmaps[view.sprite] || S.bitmaps.idle;
  if (!bmp) return;
  let px, py;
  if (view.pivot === 'grip' && drag.grip) {
    px = drag.grip.x; py = drag.grip.y;
  } else if (view.pivot === 'center') {
    px = cx(); py = S.bubbleH + S.size * 0.55;
  } else {
    px = cx(); py = S.bubbleH + groundPx();
  }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.translate(px + view.dx, py + view.dy);
  ctx.rotate(view.rot);
  ctx.scale(view.sx * (view.flip ? -1 : 1), view.sy);
  ctx.translate(-px, -py);
  ctx.drawImage(bmp, S.padX, S.bubbleH, S.size, S.size);
}

// 目前畫出來的頭頂在哪（視窗內座標），泡泡跟著它
function headPoint() {
  const info = S.manifest.sprites[view.sprite] || S.manifest.sprites.idle;
  const k = S.size / S.manifest.canvas;
  let x = S.padX + info.head[0] * k;
  if (view.flip) x = 2 * cx() - x;
  let y = S.bubbleH + info.head[1] * k;
  if (view.pivot === 'grip' && drag.grip) { x = drag.grip.x; y = drag.grip.y - S.size * 0.06; }
  return { x: x + view.dx, y: y + view.dy };
}

function alphaAt(x, y) {
  if (x < 0 || y < 0 || x >= winW() || y >= winH()) return 0;
  return ctx.getImageData(Math.floor(x * S.dpr), Math.floor(y * S.dpr), 1, 1).data[3];
}

// 頭部範圍（用來判斷摸頭）
function isHead(x, y) {
  const info = S.manifest.sprites[view.sprite] || S.manifest.sprites.idle;
  const k = S.size / S.manifest.canvas;
  const top = S.bubbleH + info.bbox[1] * k + view.dy;
  const h = (info.bbox[3] - info.bbox[1]) * k;
  return y >= top && y <= top + h * 0.34 && Math.abs(x - cx()) < S.size * 0.3;
}

// ---------- 效果 ----------
function hearts(n = 3, x = cx(), y = S.bubbleH + S.size * 0.2) {
  for (let i = 0; i < n; i++) {
    const h = document.createElement('span');
    h.className = 'heart';
    h.textContent = '♥';
    h.style.left = `${x + rand(-S.size * 0.18, S.size * 0.18)}px`;
    h.style.top = `${y + rand(-8, 14)}px`;
    h.style.fontSize = `${Math.round(clamp(S.size * 0.07, 11, 30))}px`;
    h.style.animationDelay = `${i * 0.12}s`;
    fxEl.appendChild(h);
    setTimeout(() => h.remove(), 1700 + i * 120);
  }
}

// ---------- 行為（modes） ----------
// 每個 mode：{ name, enter(), update(dt, t) → 回傳 false 代表結束, ownsPosition? }
let mode = null;
let modeT = 0;

function setMode(m) {
  // 躺著（睡覺、暈倒）要換成別的動作時，先慢慢爬起來；被拎起則直接抓走
  if (mode && mode.lying && !m.lying && m.name !== 'drag' && m.name !== 'wake') m = wakeMode();
  if (mode && mode.exit) mode.exit();
  mode = m;
  modeT = 0;
  Object.assign(view, { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, pivot: 'feet' });
  if (m.enter) m.enter();
}

// 有閉眼版（xxx_b）的姿勢，每隔幾秒眨一下眼；seed 讓不同姿勢不要同時眨
function eyes(base, t, seed = 0) {
  if (!S.manifest.sprites[`${base}_b`]) return base;
  const u = t + seed;
  const p = u % 4.6;
  const closed = p < 0.13 || (p > 0.3 && p < 0.42 && Math.floor(u / 4.6) % 4 === 0);
  return closed ? `${base}_b` : base;
}

function breathe(t, amp = 0.008, period = 3.2) {
  const s = Math.sin((t / period) * Math.PI * 2);
  view.sy = 1 + amp * s;
  view.sx = 1 - amp * 0.45 * s;
}

// 待機：呼吸 + 眨眼
function idleMode(duration = rand(5, 12), sprite = 'idle') {
  let nextBlink = rand(1.5, 4);
  let blinkUntil = -1;
  let doubleBlink = false;
  return {
    name: 'idle',
    update(dt, t) {
      breathe(t);
      if (sprite === 'idle') {
        if (t >= nextBlink) {
          blinkUntil = t + 0.13;
          doubleBlink = !doubleBlink && Math.random() < 0.2;
          nextBlink = doubleBlink ? t + 0.28 : t + rand(2.5, 6);
        }
        view.sprite = t < blinkUntil ? 'blink' : 'idle';
      } else {
        view.sprite = sprite;
      }
      return t < duration;
    },
  };
}

// 定點姿勢（打哈欠、伸懶腰、揮手…）
function poseMode(kind, duration) {
  const conf = {
    yawn: { sprite: 'yawn', dur: 2.6 },
    stretch: { sprite: 'stretch', dur: 2.8 },
    wave: { sprite: 'wave', dur: 2.6 },
    cheer: { sprite: 'cheer', dur: 2.2 },
    curious: { sprite: 'curious', dur: 3.6 },
    pose: { sprite: 'pose', dur: 4 },
    happy: { sprite: 'happy', dur: 1.4 },
    shy: { sprite: 'shy', dur: 2.8 },
    nap: { sprite: 'sleep', dur: Infinity },
  }[kind];
  const dur = duration || conf.dur;
  return {
    name: kind,
    enter() { say(kind, 1800, { mute: kind === 'curious' }); },
    update(dt, t) {
      view.sprite = conf.sprite;
      breathe(t, kind === 'nap' ? 0.012 : 0.008, kind === 'nap' ? 4.5 : 3.2);
      if (kind === 'wave') view.rot = Math.sin(t * Math.PI * 4.4) * 0.035;
      if (kind === 'stretch') { const k = Math.sin(clamp(t / dur, 0, 1) * Math.PI); view.sy *= 1 + 0.035 * k; view.sx *= 1 - 0.015 * k; }
      if (kind === 'yawn') { const k = Math.sin(clamp(t / dur, 0, 1) * Math.PI); view.sy *= 1 + 0.015 * k; }
      if (kind === 'cheer' || kind === 'happy') {
        const hop = Math.abs(Math.sin(t * Math.PI * (kind === 'cheer' ? 2.2 : 3)));
        view.dy = -hop * S.size * 0.045 * (t < dur - 0.3 ? 1 : 0);
      }
      if (kind === 'shy') {
        view.sprite = eyes('shy', t, 0.5);
        view.rot = Math.sin(t * 2.2) * 0.018;
      }
      if (kind === 'curious') {
        view.sprite = eyes(Math.floor(t / 1.2) % 2 ? 'curious2' : 'curious', t, 0.7);
        view.rot = Math.sin(t * 1.6) * 0.02;
      }
      return t < dur;
    },
  };
}

// 依時段打招呼：開機後、以及跨過時段（早／午／下午／晚／深夜）時
const periodOf = (h = new Date().getHours()) => (h >= 5 && h < 11 ? 'morning' : h < 14 && h >= 11 ? 'noon' : h >= 14 && h < 18 ? 'afternoon' : h >= 18 && h < 23 ? 'evening' : 'night');
function greetMode(period = periodOf()) {
  const key = `greet_${period}`;
  return {
    name: 'greet',
    enter() { say(key, 2800); },
    update(dt, t) {
      view.sprite = 'wave';
      breathe(t);
      view.rot = Math.sin(t * Math.PI * 4.4) * 0.03;
      return t < 2.8;
    },
  };
}

// 坐下等待：跪坐與側坐隨機一種，偶爾眨眼
function sitMode() {
  const kind = Math.random() < 0.5 ? 'sit1' : 'sit2';
  const dur = rand(25, 60);
  return {
    name: 'sit',
    enter() { say('sit', 2200); },
    update(dt, t) {
      view.sprite = eyes(kind, t, kind === 'sit1' ? 0.4 : 2.1);
      breathe(t, 0.007, 3.8);
      // 剛坐下時輕輕沉一下
      if (t < 0.4) view.dy = Math.sin((t / 0.4) * Math.PI) * S.size * 0.012;
      return t < dur;
    },
  };
}

// 太久沒人理：側身躺下睡覺，直到有人摸她、點她或 Claude 開始工作
function lieMode() {
  return {
    name: 'nap',
    lying: true,
    enter() { say('nap', 2200); },
    update(dt, t) {
      view.sprite = 'sleepside';
      breathe(t, 0.012, 4.8);
      return true;
    },
  };
}

// 睡醒／暈倒後爬起來：躺著撐起 → 坐起揉眼睛 → 準備站起，然後接回站立
function wakeMode() {
  const seq = [['wake1', 1.5], ['wake2', 1.7], ['wake3', 1.3]];
  const total = seq.reduce((a, [, d]) => a + d, 0);
  return {
    name: 'wake',
    enter() { S.lastInteraction = performance.now(); say('wake', 2400); },
    update(dt, t) {
      let acc = 0;
      for (const [k, d] of seq) {
        if (t < acc + d) { view.sprite = k === 'wake1' ? k : eyes(k, t, 0.3); break; }
        acc += d;
      }
      breathe(t, 0.008, 2.6);
      return t < total;
    },
  };
}

// 在螢幕下緣走路：四張側身圖輪播 + 彈跳；往左走就鏡像
function walkMode() {
  const wa = S.workArea;
  // S.pos 是視窗左上角；角色中心要留在螢幕內
  const minX = wa.x + S.size * 0.3 - cx();
  const maxX = wa.x + wa.width - S.size * 0.3 - cx();
  let dir = Math.random() < 0.5 ? -1 : 1;
  if (S.pos.x < minX + 120) dir = 1;
  if (S.pos.x > maxX - 120) dir = -1;
  const dist = rand(150, 520);
  const target = clamp(S.pos.x + dir * dist, minX, maxX);
  const speed = S.size * 0.32; // px / 秒
  return {
    name: 'walk',
    ownsPosition: true,
    update(dt, t) {
      const remaining = target - S.pos.x;
      if (Math.abs(remaining) < 2) return false;
      const step = Math.sign(remaining) * Math.min(Math.abs(remaining), speed * dt);
      moveTo(S.pos.x + step, groundY());
      const phase = t * 5.6; // 每秒約 5.6 張
      view.sprite = WALK_FRAMES[Math.floor(phase) % WALK_FRAMES.length];
      view.flip = remaining < 0;
      view.dy = -Math.abs(Math.sin(phase * Math.PI / 2)) * S.size * 0.012;
      view.rot = Math.sin(phase * Math.PI) * 0.012;
      return t < 30;
    },
  };
}

// 飛一圈：兩張飛行圖交替，沿平滑曲線飛到幾個點，最後落地
function flyMode() {
  const wa = S.workArea;
  const minX = wa.x + S.size * 0.3 - cx();
  const maxX = wa.x + wa.width - S.size * 0.3 - cx();
  const pts = [];
  const n = Math.floor(rand(2, 4));
  for (let i = 0; i < n; i++) {
    pts.push({
      x: rand(minX, maxX),
      y: rand(wa.y + wa.height * 0.12, groundY() - S.size * 0.35),
    });
  }
  pts.push({ x: clamp(pts[pts.length - 1].x + rand(-200, 200), minX, maxX), y: groundY() });
  let i = 0;
  const speed = S.size * 0.85;
  let vx = 0; let vy = 0;
  const kind = Math.random() < 0.5 ? 'fly1' : 'fly2'; // 一趟只用一種姿勢（各自會眨眼），不再兩張輪流
  return {
    name: 'fly',
    ownsPosition: true,
    enter() { say('fly', 1400); },
    update(dt, t) {
      const p = pts[i];
      const ex = p.x - S.pos.x;
      const ey = p.y - S.pos.y;
      const d = Math.hypot(ex, ey);
      if (d < 6) {
        i++;
        if (i >= pts.length) { moveTo(S.pos.x, groundY()); return false; }
        return true;
      }
      // 帶一點慣性，轉彎比較柔
      const ax = (ex / d) * speed - vx;
      const ay = (ey / d) * speed - vy;
      vx += ax * Math.min(1, dt * 2.5);
      vy += ay * Math.min(1, dt * 2.5);
      let ny = S.pos.y + vy * dt + Math.sin(t * 3) * 0.6;
      ny = Math.min(ny, groundY());
      moveTo(S.pos.x + vx * dt, ny);
      view.sprite = eyes(kind, t, 0.2);
      if (Math.abs(vx) > 8) view.flip = vx < 0;
      view.rot = clamp(vy / speed, -1, 1) * 0.08 * (view.flip ? -1 : 1);
      view.dy = Math.sin(t * 2.4) * S.size * 0.015;
      return t < 40;
    },
  };
}

// 坐／趴到別的視窗上：飛過去 → 停著（視窗一動或消失就輕輕飄下來）→ 坐夠了飛回地面。只有 Windows 能取得視窗位置。
// 三種停法：趴在視窗上緣（lie_top）、坐在視窗下緣（sit_edge／sit_edge2，頭在視窗前面，不怕頂到螢幕上方）、坐在上緣（sit_edge，上緣夠低才用）。
const PERCH_KINDS = [
  { kind: 'lie', sprites: ['lie_top'], edge: 'top', weight: 1.2, say: 'perch_lie' },
  { kind: 'sit_bottom', sprites: ['sit_edge', 'sit_edge2'], edge: 'bottom', weight: 1.2, say: 'perch' },
  { kind: 'sit_top', sprites: ['sit_edge'], edge: 'top', weight: 0.4, say: 'perch' },
];

function perchSeat(w, v) {
  const k = S.size / S.manifest.canvas;
  const info = S.manifest.sprites[v.sprite];
  const edgeY = v.edge === 'bottom' ? w.y + w.h : w.y;
  return { y: edgeY - S.bubbleH - info.seat * k, k, info };
}

async function pickPerch() {
  let res = { list: [], error: null };
  try { res = await host.windows(); } catch (e) { res = { list: [], error: String(e.message || e) }; }
  const wa = S.workArea;
  const all = res.list || [];
  const cands = [];
  all.forEach((w, idx) => {
    if (w.w < S.size * 0.55 || w.x >= wa.x + wa.width || w.x + w.w <= wa.x) return;
    for (const kind of PERCH_KINDS) {
      const sprite = kind.sprites.filter((n) => S.manifest.sprites[n])[Math.floor(Math.random() * kind.sprites.length)] || kind.sprites[0];
      if (!S.manifest.sprites[sprite]) continue;
      const v = { ...kind, sprite };
      const { y, k } = perchSeat(w, v);
      if (y + S.bubbleH + S.manifest.sprites[sprite].bbox[1] * k < wa.y - 4) continue; // 頭會頂出螢幕
      if (y + S.bubbleH + S.manifest.ground * k > wa.y + wa.height + 6) continue; // 腳（或趴著的身體）會掉出螢幕
      // 要停的那條邊被別的視窗蓋住就不去（清單由前到後）
      const ex = w.x + w.w / 2;
      const ey = v.edge === 'bottom' ? w.y + w.h - 3 : w.y + 3;
      if (all.slice(0, idx).some((o) => ex > o.x + 4 && ex < o.x + o.w - 4 && ey > o.y + 4 && ey < o.y + o.h - 4)) continue;
      cands.push({ w, v, weight: kind.weight * (idx < 3 ? 1.5 : 1) });
    }
  });
  let why = null;
  if (!cands.length) {
    if (res.error) why = res.error;
    else if (!all.length) why = '沒有偵測到其他視窗（最小化或全螢幕的不算）';
    else why = `偵測到 ${all.length} 個視窗，但都太窄、太高、太靠下緣，或邊緣被別的視窗蓋住`;
    return { ok: null, why };
  }
  let r = Math.random() * cands.reduce((t, c) => t + c.weight, 0);
  let chosen = cands[0];
  for (const c of cands) { if ((r -= c.weight) <= 0) { chosen = c; break; } }
  return { ok: chosen, why: null };
}

function perchMode(opts = {}) {
  let phase = 'seek';
  let target = null; // { w, v }
  let snap = null;
  let phaseT = 0;
  let checkAt = 0;
  let vx = 0; let vy = 0;
  let why = null;
  const side = Math.random() < 0.5 ? -1 : 1;
  const flyKind = Math.random() < 0.5 ? 'fly1' : 'fly2';
  const dur = rand(40, 110);
  let sitT = 0;
  let seekPromise = null;
  const seatPos = (w, v) => {
    const frac = v.kind === 'lie' ? 0.5 : 0.5 + side * 0.22;
    return {
      x: clamp(w.x + w.w * frac, w.x + S.size * 0.3, w.x + w.w - S.size * 0.3) - cx(),
      y: perchSeat(w, v).y,
    };
  };
  const changed = (a, b) => Math.abs(a.x - b.x) > 4 || Math.abs(a.y - b.y) > 4 || Math.abs(a.w - b.w) > 4 || Math.abs(a.h - b.h) > 4;
  const go = (dest, dt, speed) => {
    const ex = dest.x - S.pos.x; const ey = dest.y - S.pos.y;
    const d = Math.hypot(ex, ey);
    if (d < 4) { moveTo(dest.x, dest.y); return true; }
    vx += ((ex / d) * speed - vx) * Math.min(1, dt * 3);
    vy += ((ey / d) * speed - vy) * Math.min(1, dt * 3);
    const step = Math.min(1, d / (Math.hypot(vx, vy) * dt + 1e-6));
    moveTo(S.pos.x + vx * dt * step, S.pos.y + vy * dt * step);
    if (Math.abs(vx) > 8) view.flip = vx < 0;
    return false;
  };
  const refresh = () => host.windows().then((res) => {
    const w = (res.list || []).find((x) => x.id === target.w.id);
    if (!w) { phase = 'drop'; phaseT = 0; return; }
    if (phase === 'fly') { target.w = w; return; } // 飛的途中視窗動了就改飛向新位置
    if (phase === 'sit' && changed(w, snap)) { phase = 'drop'; phaseT = 0; return; }
    target.w = w;
  }).catch(() => {});
  return {
    name: 'perch',
    ownsPosition: true,
    update(dt, t) {
      phaseT += dt;
      if (phase === 'seek') {
        view.sprite = 'idle';
        breathe(t);
        if (!seekPromise) {
          seekPromise = pickPerch().then(({ ok, why: w }) => {
            if (!ok) { why = w; phase = 'none'; return; }
            target = { w: ok.w, v: { ...ok.v } };
            target.v.sprite = ok.v.sprite;
            phase = 'fly'; phaseT = 0;
          });
        }
        if (phaseT > 20) { why = '偵測視窗逾時'; phase = 'none'; }
        return true;
      }
      if (phase === 'none') {
        if (opts.manual) { S.say = { text: `找不到可以坐的視窗：${why || '原因不明'}`, until: performance.now() + 6000 }; }
        return false;
      }
      if (phase === 'fly') {
        view.sprite = eyes(flyKind, t, 0.2);
        view.dy = Math.sin(t * 2.4) * S.size * 0.012;
        if (performance.now() > checkAt) { checkAt = performance.now() + 1200; refresh(); }
        const dest = seatPos(target.w, target.v);
        if (go(dest, dt, S.size * 1.1) && phase === 'fly') {
          phase = 'sit'; phaseT = 0; view.flip = false; snap = { ...target.w }; checkAt = performance.now() + 1000;
          say(target.v.say, 2600);
        }
        return phaseT < 20 || phase !== 'fly';
      }
      if (phase === 'sit') {
        sitT += dt;
        const base = target.v.sprite;
        view.sprite = eyes(base, sitT, 0.8);
        breathe(sitT, base === 'lie_top' ? 0.01 : 0.006, 3.8);
        view.rot = base === 'lie_top' ? 0 : Math.sin(sitT * 1.1) * 0.006;
        if (performance.now() > checkAt) { checkAt = performance.now() + 1200; refresh(); }
        if (sitT > dur) { phase = 'leave'; phaseT = 0; }
        return true;
      }
      if (phase === 'drop') {
        // 視窗動了或不見了：不黏過去，慢慢飄落到地面
        if (phaseT < 0.05) { vy = 0; say('drop', 2200); }
        view.sprite = 'float';
        vy = Math.min(vy + S.size * 0.9 * dt, S.size * 0.55);
        const ny = Math.min(S.pos.y + vy * dt, groundY());
        moveTo(S.pos.x + Math.sin(phaseT * 1.6) * S.size * 0.1 * dt, ny);
        view.rot = Math.sin(phaseT * 1.6) * 0.03;
        if (ny >= groundY()) { view.rot = 0; return false; }
        return phaseT < 20;
      }
      // leave：飛回地面
      view.sprite = eyes(flyKind, t, 0.2);
      const dest = { x: S.pos.x + side * 40, y: groundY() };
      dest.x = clamp(dest.x, S.workArea.x - cx() + S.size * 0.3, S.workArea.x + S.workArea.width - cx() - S.size * 0.3);
      if (go(dest, dt, S.size * 1.0)) return false;
      return phaseT < 12;
    },
    exit() { view.flip = false; },
  };
}

// 落下：放開拖曳、或狀態要她回地面時
function fallMode(after) {
  // 從拖曳接手時，把抓著時的位移慢慢收回來
  const dx0 = view.dx;
  const dy0 = view.dy;
  const rot0 = view.rot;
  let vy = 0;
  const startY = S.pos.y;
  let landed = -1;
  let dizzy = false;
  const gentle = !!(mode && mode.name === 'perch'); // 從視窗邊緣下來：飄著落地，不會暈
  return {
    name: 'fall',
    ownsPosition: true,
    update(dt, t) {
      if (landed < 0) {
        vy += (gentle ? 700 : 2600) * dt;
        if (gentle) vy = Math.min(vy, S.size * 1.2);
        const ny = Math.min(S.pos.y + vy * dt, groundY());
        moveTo(S.pos.x, ny);
        view.sprite = gentle ? 'float' : dragKind;
        view.dx = dx0 * Math.exp(-t * 9);
        view.dy = dy0 * Math.exp(-t * 9);
        view.rot = rot0 * Math.exp(-t * 6);
        if (ny >= groundY()) {
          landed = t;
          dizzy = !gentle && groundY() - startY > S.size * 2.2;
          if (dizzy) say('dizzy');
        }
        return true;
      }
      const lt = t - landed;
      // 落地的壓扁回彈
      const squash = Math.exp(-lt * 7) * Math.cos(lt * 22) * 0.07;
      view.sy = 1 - squash;
      view.sx = 1 + squash * 0.6;
      view.rot = 0;
      view.dx = 0;
      view.dy = 0;
      if (dizzy) { view.sprite = lt < 1.8 ? 'faint' : 'curious'; return lt < 2.6; }
      view.sprite = 'curious';
      return lt < 0.9;
    },
    exit() { if (after) setTimeout(after, 0); },
  };
}

// Claude 狀態對應的姿勢（持續到狀態改變）
function claudeMode(body) {
  return {
    name: `claude:${body}`,
    body,
    lying: body === 'exhausted' || body === 'faint',
    update(dt, t) {
      switch (body) {
        case 'thinking':
          view.sprite = eyes('think', t);
          breathe(t);
          view.rot = Math.sin(t * 1.9) * 0.018;
          break;
        case 'working':
          view.sprite = eyes(Math.floor(t / 4.5) % 2 ? 'work2' : 'work', t);
          breathe(t, 0.006, 2.4);
          view.dy = -Math.abs(Math.sin(t * Math.PI * 3.2)) * S.size * 0.004;
          break;
        case 'waiting':
        case 'hello':
          view.sprite = eyes('wave', t, 1.3);
          breathe(t);
          view.rot = Math.sin(t * Math.PI * 4.4) * 0.035;
          break;
        case 'done': {
          view.sprite = 'cheer';
          const hop = Math.abs(Math.sin(t * Math.PI * 2.2));
          view.dy = t < 2.6 ? -hop * S.size * 0.05 : 0;
          break;
        }
        case 'error':
          view.sprite = eyes('confused', t);
          breathe(t);
          view.rot = Math.sin(t * 1.7) * 0.02;
          break;
        case 'tired': {
          // 偶爾打個哈欠
          const cyc = t % 14;
          view.sprite = cyc > 11.5 ? 'yawn' : eyes('tired', t, 0.9);
          breathe(t, 0.012, 4.6);
          break;
        }
        case 'exhausted':
          view.sprite = 'sleepside';
          breathe(t, 0.014, 4.8);
          break;
        case 'faint':
          view.sprite = 'faint';
          view.sy = 1 + Math.sin(t * 1.3) * 0.006;
          break;
        default:
          view.sprite = 'idle';
      }
      return true;
    },
  };
}

// ---------- 互動：拖曳、點擊、摸頭 ----------
const drag = { down: null, active: false, grip: null, swing: 0, swingV: 0, vx: 0 };
const stroke = { lastX: null, dir: 0, flips: 0, firstAt: 0, lastAt: 0 };

// 拎起有兩種姿勢（抱起來的 drag、歪著身子的 drag2），每次拎起隨機挑一種，整段都用同一種，各自會眨眼
let dragKind = 'drag';
function dragMode() {
  dragKind = S.manifest.sprites.drag2 && Math.random() < 0.5 ? 'drag2' : 'drag';
  return {
    name: 'drag',
    ownsPosition: true,
    enter() { say('drag', 1500); },
    update(dt, t) {
      view.sprite = eyes(dragKind, t, 0.5);
      view.pivot = 'grip';
      // 第二種姿勢頭的位置不同，位移補回讓頭對著游標
      if (dragKind === 'drag2') {
        const a = S.manifest.sprites.drag;
        const b = S.manifest.sprites.drag2;
        const k = S.size / S.manifest.canvas;
        view.dx = (a.head[0] - b.head[0]) * k;
        view.dy = (a.head[1] - b.head[1]) * k;
      }
      // 彈簧擺動：被往右甩，身體往左晃（以拎住的後頸為軸）
      const target = clamp(-drag.vx * 0.0008, -0.35, 0.35);
      drag.swingV += ((target - drag.swing) * 60 - drag.swingV * 6) * dt;
      drag.swing += drag.swingV * dt;
      view.rot = drag.swing + Math.sin(t * 2.2) * 0.03;
      drag.vx *= 0.85;
      return true;
    },
  };
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (alphaAt(e.clientX, e.clientY) < 24) return;
  drag.down = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, t: performance.now() };
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  const x = e.clientX;
  const y = e.clientY;
  if (drag.down && !drag.active) {
    if (Math.hypot(e.screenX - drag.down.sx, e.screenY - drag.down.sy) > 5) {
      drag.active = true;
      // 不管抓哪裡，都像拎住後頸一樣：視窗對齊到讓「拎起圖」的頭頂在游標下
      const info = S.manifest.sprites.drag;
      const k = S.size / S.manifest.canvas;
      drag.grip = { x: S.padX + info.head[0] * k, y: S.bubbleH + info.head[1] * k + S.size * 0.06 };
      drag.swing = 0; drag.swingV = 0; drag.vx = 0;
      host.dragStart(drag.grip.x, drag.grip.y);
      setMode(dragMode());
      S.lastInteraction = performance.now();
    }
    return;
  }
  if (drag.active) return;
  // 點擊穿透：只有碰到不透明的地方才接住滑鼠
  const solid = alphaAt(x, y) >= 24;
  setHover(solid);
  if (solid && isHead(x, y)) detectStroke(x);
}

let clicks = [];
function onPointerUp(e) {
  if (!drag.down) return;
  const wasDrag = drag.active;
  const d = drag.down;
  drag.down = null;
  drag.active = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  S.lastInteraction = performance.now();
  if (wasDrag) {
    host.dragEnd();
    refreshGeom(true).then(() => setMode(fallMode()));
    return;
  }
  if (performance.now() - d.t < 450) {
    // 點一下：開心地跳一下；五秒內連點三次就害羞
    const nowT = performance.now();
    clicks = clicks.filter((c) => nowT - c < 5000);
    clicks.push(nowT);
    if (clicks.length >= 3) { clicks = []; hearts(3); setMode(poseMode('shy')); return; }
    hearts(2);
    setMode(poseMode('happy'));
  }
}

function detectStroke(x) {
  const now = performance.now();
  if (stroke.lastX != null) {
    const dx = x - stroke.lastX;
    if (Math.abs(dx) > 3) {
      const dir = Math.sign(dx);
      if (stroke.dir && dir !== stroke.dir) {
        if (now - stroke.lastAt > 900) { stroke.flips = 0; stroke.firstAt = now; }
        stroke.flips++;
        stroke.lastAt = now;
      }
      stroke.dir = dir;
    }
  }
  stroke.lastX = x;
  if (stroke.flips >= 3 && (!mode || mode.name !== 'pat')) {
    S.lastInteraction = now;
    setMode(patMode());
  }
}

// 摸頭撒嬌：持續撫摸就一直害羞，停手一下就結束
function patMode() {
  let lastHeart = 0;
  return {
    name: 'pat',
    enter() { say('pat', 2000); hearts(3); },
    update(dt, t) {
      view.sprite = 'pat';
      breathe(t, 0.01, 2.2);
      view.rot = Math.sin(t * 5) * 0.015;
      if (t - lastHeart > 0.9 && performance.now() - stroke.lastAt < 600) { hearts(1); lastHeart = t; }
      if (t > 3.5 && performance.now() - stroke.lastAt < 1300) { freeQueue = () => poseMode('shy'); return false; } // 摸太久會害羞
      return performance.now() - stroke.lastAt < 1300;
    },
    exit() { stroke.flips = 0; },
  };
}

function setHover(v) {
  if (v !== S.hover) S.hover = v;
  const ignore = !v;
  if (ignore !== S.ignoring) {
    S.ignoring = ignore;
    host.setIgnore(ignore);
  }
}

// ---------- 主迴圈 ----------
function claudeState() {
  const now = Date.now();
  const r = core.resolve(S.snapshot, now, {
    tiredAt: S.settings.tiredAt, faintAt: S.settings.faintAt, napAt: S.settings.napAt,
  });
  if (S.forced) {
    r.body = S.forced;
    if (['thinking', 'working', 'waiting', 'done', 'hello', 'error'].includes(S.forced)) r.activity = S.forced;
  }
  return r;
}

const INTERACTIONS = new Set(['drag', 'fall', 'pat', 'happy']);
const FREE = new Set(['idle', 'walk', 'fly', 'yawn', 'stretch', 'wave', 'cheer', 'curious', 'pose', 'nap', 'sit', 'perch', 'shy', 'greet']);

function chooseFree() {
  const s = S.settings;
  const idleFor = (performance.now() - Math.max(S.lastInteraction, S.lastClaudeActive)) / 1000;
  if (!s.random) return idleMode(Infinity);
  // 冷落太久就睡午覺，有人來（滑鼠、Claude）就醒
  if (idleFor > 5 * 60 && onGround()) return lieMode();
  if (idleFor > 80 && onGround() && Math.random() < 0.7) return sitMode();
  const hour = new Date().getHours();
  const late = hour >= 23 || hour < 6;
  const k = pick({
    walk: s.walk ? 30 : 0,
    fly: s.fly ? 8 : 0,
    curious: 14,
    yawn: late ? 14 : 6,
    stretch: 7,
    wave: 5,
    cheer: 4,
    pose: 8,
    perch: s.perch && onGround() ? 5 : 0,
  });
  if (k === 'walk') return onGround() ? walkMode() : fallMode();
  if (k === 'fly') return flyMode();
  if (k === 'perch') return perchMode();
  return onGround() ? poseMode(k) : fallMode();
}

let lastBody = null;
let freeQueue = null;

function tick(dt) {
  const r = claudeState();
  if (r.activity !== 'idle' || r.body !== 'free') S.lastClaudeActive = performance.now();

  const busy = mode && INTERACTIONS.has(mode.name);
  const waking = mode && mode.name === 'wake';
  if (!busy && !waking) {
    if (r.body !== 'free') {
      // Claude 有狀態：在空中先落地，再擺對應姿勢
      if (!mode || mode.body !== r.body) {
        if (!onGround() && (!mode || mode.name !== 'fall')) setMode(fallMode());
        else if (!mode || mode.name !== 'fall') setMode(claudeMode(r.body));
      }
    } else if (!mode || mode.body) {
      // 剛從 Claude 狀態回到自由：先站一下
      if (!onGround()) setMode(fallMode());
      else setMode(lastBody === 'done' ? idleMode(rand(3, 6)) : idleMode(rand(2, 5)));
    }
  }
  if (r.body !== lastBody && r.body !== 'free') sayClaude(r.body);
  lastBody = r.body;

  modeT += dt;
  const alive = mode ? mode.update(dt, modeT) : false;
  if (!alive) {
    if (mode && mode.name === 'nap') S.lastInteraction = performance.now();
    if (r.body !== 'free' && !busy) setMode(onGround() ? claudeMode(r.body) : fallMode());
    else if (freeQueue && onGround()) { const q = freeQueue; freeQueue = null; setMode(q()); }
    else if (mode && mode.name === 'idle') setMode(chooseFree());
    else setMode(idleMode());
  }
  draw();
  updateBubble(r);
}

function updateBubble(r) {
  if (!S.settings.bubble) { bubbleEl.classList.add('hidden'); return; }
  let text = '';
  const now = performance.now();
  const interacting = mode && INTERACTIONS.has(mode.name);
  if (S.say && S.say.until > now && (interacting || r.body === 'free')) text = S.say.text;
  else if (r.body !== 'free') text = core.bubbleText(r, Date.now());
  else if (mode && mode.name === 'nap') text = 'Zzz…';

  const u = r.usage || {};
  const hasUsage = u.five != null || u.week != null;
  const showStamina = hasUsage && (S.settings.staminaAlways || S.hover || ['tired', 'exhausted', 'faint'].includes(r.body));

  const visible = !!text || showStamina;
  bubbleEl.classList.toggle('hidden', !visible);
  if (!visible) return; // 淡出時保留舊字，不會閃出空白泡泡
  // 思考/工作時，句尾的「…」改成會動的點點
  const dots = text.endsWith('…') && (r.body === 'thinking' || r.body === 'working');
  if (dots) text = text.slice(0, -1);
  if (bubbleText.textContent !== text) bubbleText.textContent = text;
  bubbleText.classList.toggle('dots', dots);
  staminaEl.classList.toggle('hidden', !showStamina);
  if (showStamina) {
    setBar('5', u.five);
    setBar('7', u.week);
  }
  placeBubble();
}

let bubbleFitKey = '';
// 泡泡放在頭頂正上方；碰到視窗或螢幕邊緣就往內閃，小尾巴仍指著頭
function placeBubble() {
  // 字體大小：設定的倍率；太長放不下視窗時自動縮小一點，避免被切掉
  const want = clamp((S.settings.bubbleScale || 100) / 100, 0.7, 2.2);
  const key = `${want}|${bubbleText.textContent}|${winW()}`;
  if (key !== bubbleFitKey) {
    bubbleFitKey = key;
    bubbleEl.style.setProperty('--fs', want);
    const over = bubbleEl.offsetWidth - (winW() - 8);
    if (over > 0) bubbleEl.style.setProperty('--fs', Math.max(0.7, want * (winW() - 10) / bubbleEl.offsetWidth).toFixed(3));
  }
  const w = bubbleEl.offsetWidth;
  const h = bubbleEl.offsetHeight;
  const head = headPoint();
  const wa = S.workArea;
  const m = 3;
  let left = head.x - w / 2;
  // 先避開螢幕邊（換算成視窗內座標），再確保不超出視窗本身
  left = clamp(left, wa.x + m - S.pos.x, wa.x + wa.width - m - w - S.pos.x);
  left = clamp(left, m, winW() - w - m);
  let top = head.y - h - 8;
  if (S.pos.y + top < wa.y + m) top = wa.y + m - S.pos.y;
  top = clamp(top, m, winH() - h - m);
  bubbleEl.style.left = `${Math.round(left)}px`;
  bubbleEl.style.top = `${Math.round(top)}px`;
  bubbleEl.style.setProperty('--tail-x', `${Math.round(clamp(head.x - left, 34, w - 34))}px`);
  bubbleEl.classList.toggle('no-tail', top + h > head.y);
}

function setBar(id, v) {
  const bar = document.getElementById(`bar${id}`);
  const pct = document.getElementById(`pct${id}`);
  // 體力條顯示「剩餘」，比較直覺
  const left = v == null ? null : clamp(100 - v, 0, 100);
  bar.style.width = `${left == null ? 0 : left}%`;
  bar.style.background = left == null ? 'transparent' : left <= 15 ? 'var(--bad)' : left <= 40 ? 'var(--warn)' : 'var(--ok)';
  pct.textContent = left == null ? '–' : `${Math.round(left)}%`;
}

let lastFrame = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  try { tick(dt); } catch (e) { console.error(e); }
  requestAnimationFrame(loop);
}

// ---------- 啟動 ----------
async function start() {
  const init = await host.init();
  S.settings = init.settings;
  S.manifest = init.manifest;
  S.snapshot = init.snapshot;
  if (init.voice) S.voice = voiceCore.build(init.voice.lines, init.voice.files);
  S.forced = init.forced;
  S.size = S.settings.size;
  await buildBitmaps();
  await refreshGeom();
  setInterval(refreshGeom, 3000);

  host.onSnapshot((snap) => { S.snapshot = snap; });
  host.onForce((k) => { S.forced = k; });
  host.onSettings(async (s) => {
    if (!s) return;
    const resized = s.size !== S.size;
    S.settings = s;
    if (resized) {
      S.size = s.size;
      await buildBitmaps();
      await refreshGeom();
    }
  });
  host.onAction((k) => {
    S.lastInteraction = performance.now();
    if (k === 'land') { refreshGeom(true).then(() => setMode(fallMode())); return; }
    const make = k === 'walk' ? walkMode : k === 'fly' ? flyMode : k === 'sit' ? sitMode : k === 'nap' ? lieMode : k === 'wake' ? wakeMode : k === 'perch' ? () => perchMode({ manual: true }) : () => poseMode(k);
    if (k !== 'fly' && !onGround()) { setMode(fallMode(() => setMode(make()))); return; }
    setMode(make());
  });
  // 休眠喚醒後：清掉殘留的按住狀態，並重新宣告穿透狀態（跟主程序一致）
  host.onRecover(() => {
    drag.down = null; drag.active = false;
    S.ignoring = true; S.hover = false;
    buildBitmaps().catch(() => {}); // 休眠後顯示資源可能失效，重建一次
    if (mode && mode.name === 'drag') { refreshGeom(true).then(() => setMode(fallMode())); }
  });
  // 喚醒快捷鍵／托盤圖示：躺著就爬起來，否則揮手打招呼
  host.onSummon(() => {
    S.lastInteraction = performance.now();
    if (mode && mode.name === 'drag') return;
    setMode(mode && mode.lying ? wakeMode() : (onGround() ? poseMode('wave') : fallMode()));
  });
  // 保險：滑鼠停在她身上時，每秒重新宣告一次「接住滑鼠」，萬一狀態不同步也會自己修好
  setInterval(() => { if (S.hover && !S.ignoring && !drag.active) host.setIgnore(false); }, 1000);
  host.onDragMove((v) => { drag.vx = v.vx * 60; });

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('mouseleave', () => { if (!drag.active) setHover(false); });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (alphaAt(e.clientX, e.clientY) >= 24) host.menu();
  });
  window.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    host.resizeStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  setMode(idleMode(2));
  // 開機招呼 + 跨時段招呼
  let lastPeriod = periodOf();
  freeQueue = () => greetMode();
  setInterval(() => {
    const p = periodOf();
    if (p !== lastPeriod) { lastPeriod = p; if (!freeQueue) freeQueue = () => greetMode(p); }
  }, 30000);
  requestAnimationFrame(loop);
}

// 給自動測試看的窗口
window.__pet = { S, view, headPoint, get mode() { return mode && mode.name; }, setMode, dragMode, idleMode, poseMode, walkMode, flyMode, fallMode, claudeState };

start();
