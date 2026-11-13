'use strict';
// 撫子桌寵：畫面與行為
//
// 優先序：使用者互動（拖曳、摸頭）> 測試狀態 > Claude 狀態（暈倒 > 睡覺 > 疲憊 > 工作 > 思考 …）> 隨機行為
/* global PetCore, VoiceCore, ClipCore */

const host = window.petHost;
const core = PetCore;
const voiceCore = VoiceCore;
const clipCore = ClipCore;

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const bubbleEl = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const fxEl = document.getElementById('fx');

// 沒有左右腳交替的素材，用「大步 → 收腳 → 抬後腳 → 跨出」四張輪播
const ACTION_LINES = {
  yawn: '呼啊～', stretch: '嗯～～', wave: '嗨～', cheer: '好耶～', nap: 'Zzz…',
  curious: '嗯？', pose: '♪', happy: '嘿嘿♪', pat: '再摸一下嘛…', drag: '哇！放我下來～', dizzy: '暈…',
  pray: '願一切順利～', doze: 'Zzz…', curtsy: '日安～', pirouette: '轉一圈～', arabesque: '♪～',
  nod: '嗯嗯！', shake: '唔…不對吧？', mail: '有信來囉～', gift: '聖誕快樂～', birthday: '生日快樂～', lantern: '願望會實現的～', sparkler: '好漂亮～',
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
  clipInfo: {},     // 動畫片段每一格的 bbox／head（key 跟 bitmaps 一樣）
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
// blend：{ sprite, a } 疊在上面淡入的下一張圖（走路換腳時用，看起來像殘影過渡，不會硬切）
const view = { sprite: 'idle', flip: false, dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, pivot: 'feet', blend: null };

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
let audioCache = {};
let voiceVer = 0; // 語音工作室換了音檔後加一，避免讀到舊的快取
let nowPlaying = null;

// 從該狀態的 2~3 句裡隨機挑一句（不連續重複）；沒有台詞表就回 null
function chooseLine(key) {
  const arr = S.voice[key];
  if (!arr || !arr.length) return null;
  const i = voiceCore.pickIndex(arr.length, S.voiceLast[key]);
  S.voiceLast[key] = i;
  return arr[i];
}

// 超過 100% 的音量：audio.volume 最多 1，再大聲要接 Web Audio 的增益（每個 Audio 只能接一次）
let audioCtx = null;
function setLoudness(a, v) {
  if (v <= 1 && !a._gain) { a.volume = clamp(v, 0, 1); return; }
  try {
    if (!a._gain) {
      audioCtx = audioCtx || new AudioContext();
      const src = audioCtx.createMediaElementSource(a);
      a._gain = audioCtx.createGain();
      src.connect(a._gain).connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    a.volume = 1;
    a._gain.gain.value = clamp(v, 0, 2);
  } catch (_) { a.volume = clamp(v, 0, 1); }
}

function playFile(file, lineVol = 100) {
  const s = S.settings;
  if (!s.voice || !file || !(s.volume > 0)) return;
  try {
    let a = audioCache[file];
    if (!a) { a = new Audio(`${VOICE_DIR}${file}?v=${voiceVer}`); a.preload = 'auto'; audioCache[file] = a; } // 第一次要用才載入
    if (nowPlaying && nowPlaying !== a) nowPlaying.pause();
    setLoudness(a, (s.volume / 100) * (lineVol / 100));
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
  if (line && line.file && voiceReady(key)) playFile(line.file, line.vol);
  if (!opts.mute) S.say = { text, until: performance.now() + ms };
  return text;
}

// Claude 狀態切換時只出聲，字仍由狀態機（含工具名、剩餘體力等即時資訊）決定
function sayClaude(body) {
  const line = chooseLine(body);
  if (line && line.file && voiceReady(body)) playFile(line.file, line.vol);
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
  // 畫面上正在用的片段格先留著：片段重載好之前，畫面找不到那格會退回站姿 idle（休眠喚醒時躺著的她會彈起來一下）
  // 那格的頭頂位置（clipInfo）也一起留著，不然泡泡會跳到站姿的頭頂閃一下
  const keepInfo = {};
  for (const k of [view.sprite, view.blend && view.blend.sprite]) {
    if (k && !out[k] && S.bitmaps[k]) out[k] = S.bitmaps[k];
    if (k && S.clipInfo[k]) keepInfo[k] = S.clipInfo[k];
  }
  S.bitmaps = out;
  // 尺寸改了或顯示資源重建：動畫片段的圖也要重做，等下次用到再載入
  bitmapGen++;
  S.clipInfo = keepInfo;
  for (const k of Object.keys(clipRes)) delete clipRes[k];
}

// ---------- 動畫片段（clip）----------
// 祐用「動畫轉精靈幀」做的動作（manifest.clips）。一組 16 格、全部載入太吃記憶體（特大尺寸時一組就幾十 MB），
// 所以第一次用到才載入、同時最多留 CLIP_KEEP 組，超過就丟掉最久沒用的。載入完成前呼叫端退回舊的靜態圖。
const CLIP_KEEP = 5;
const clipRes = {};   // name → { state: 'loading' | 'ready' | 'failed', keys, used }
let bitmapGen = 0;    // 每重建一次加一，載到一半的舊結果就丟掉

const clipDef = (name) => (S.manifest && S.manifest.clips && S.manifest.clips[name]) || null;
const clipKey = (name, i) => `clip:${name}:${i}`;
const spriteInfo = (key) => S.manifest.sprites[key] || S.clipInfo[key] || S.manifest.sprites.idle;

// 載入完成回傳 true；還在載就先觸發載入、回傳 false
function ensureClip(name) {
  const def = clipDef(name);
  if (!def) return false;
  const have = clipRes[name];
  if (have) { have.used = performance.now(); return have.state === 'ready'; }
  const res = { state: 'loading', keys: [], used: performance.now() };
  clipRes[name] = res;
  const gen = bitmapGen;
  const px = Math.round(S.size * S.dpr);
  Promise.all(def.frames.map(async (file, i) => {
    // 不走 imageCache：片段會被丟掉重載，不要讓原圖永遠留在記憶體裡
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = `../sprites/clips/${file}`; });
    return [i, await createImageBitmap(img, { resizeWidth: px, resizeHeight: px, resizeQuality: 'high' })];
  })).then((list) => {
    if (gen !== bitmapGen || clipRes[name] !== res) { for (const [, b] of list) b.close(); return; }
    for (const [i, bmp] of list) {
      const k = clipKey(name, i);
      S.bitmaps[k] = bmp;
      S.clipInfo[k] = { bbox: def.bbox[i], head: def.head[i] };
      res.keys.push(k);
    }
    res.state = 'ready';
    evictClips();
  }).catch(() => { res.state = 'failed'; });
  return false;
}

// 站著發呆幾乎一直在播，固定留著不丟（不算在 CLIP_KEEP 裡）
const CLIP_PIN = new Set(['idle']);

function evictClips() {
  const ready = Object.entries(clipRes).filter(([n, r]) => r.state === 'ready' && !CLIP_PIN.has(n)).sort((a, b) => b[1].used - a[1].used);
  for (const [name, r] of ready.slice(CLIP_KEEP)) {
    for (const k of r.keys) { if (S.bitmaps[k]) S.bitmaps[k].close(); delete S.bitmaps[k]; delete S.clipInfo[k]; }
    delete clipRes[name];
  }
}

// 把片段在第 t 秒的畫面放進 view；片段還沒載好（或沒有這個片段）回傳 false，呼叫端用舊素材。
// opts：base 淡入淡出用的底圖（預設 idle）、fadeIn / fadeOut 秒數、dur 這個動作總長（有給才會淡出）
function playClip(name, t, opts) {
  const def = clipDef(name);
  if (!def || !ensureClip(name)) return false;
  const f = clipCore.frameAt(def, t);
  const c = clipCore.compose(f, (i) => clipKey(name, i), t, opts);
  view.sprite = c.sprite;
  view.blend = c.blend;
  return true;
}

// 片段還在載入中（載入失敗或沒有這個片段就不算）：呼叫端先別換圖，免得閃一下舊素材
const waitingClip = (name) => !!clipDef(name) && (!clipRes[name] || clipRes[name].state === 'loading');

// 整段只播一次的片段有多長（沒有這個片段回傳 0）
const clipSeconds = (name) => { const d = clipDef(name); return d ? clipCore.playLength(d) : 0; };

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
  const nb = view.blend && view.blend.a > 0.01 && S.bitmaps[view.blend.sprite];
  if (nb) {
    // 淡入的那張可以有自己的左右方向（影片走路往右時是鏡像，停下來淡回正面站姿時不要鏡像）
    if (view.blend.flip != null && view.blend.flip !== view.flip) {
      ctx.translate(px, py); ctx.scale(-1, 1); ctx.translate(-px, -py);
    }
    ctx.globalAlpha = Math.min(1, view.blend.a);
    ctx.drawImage(nb, S.padX, S.bubbleH, S.size, S.size);
    ctx.globalAlpha = 1;
  }
  drawSparks();
}

// 目前畫出來的頭頂在哪（視窗內座標），泡泡跟著它
function headPoint() {
  const info = spriteInfo(view.sprite);
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
  const info = spriteInfo(view.sprite);
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
  if (mode && mode.lying && !m.lying && m.name !== 'drag' && m.name !== 'wake') m = wakeMode(mode.wakeFrom || mode.body);
  // 坐著要換成別的動作時，先站起來再接下去
  else if (mode && mode.rise && m.name !== 'drag' && m.name !== 'rise') m = riseMode(mode.rise, m);
  if (mode && mode.exit) mode.exit();
  // 上一個動作剛好淡完（疊上去的圖已經全不透明）：直接換成那張，免得換動作的那一格閃回淡出前的畫面
  if (view.blend && view.blend.a >= 0.95) view.sprite = view.blend.sprite;
  mode = m;
  modeT = 0;
  Object.assign(view, { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, pivot: 'feet', blend: null });
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

// 躺著、坐著打盹時疊在影片上的呼吸（祐 2026-11-08）：只上下起伏（以腳底／地面為準），
// 影片播完躺下（坐下）那段才開始，前 2 秒慢慢加大，接縫不會跳
function breatheOver(t, amp, period) {
  if (t <= 0) { view.sy = 1; view.sx = 1; return; }
  const s = Math.sin((t / period) * Math.PI * 2) * Math.min(1, t / 2);
  view.sy = 1 + amp * s;
  view.sx = 1;
}

// 待機：呼吸 + 眨眼
function idleMode(duration = rand(5, 12), sprite = 'idle') {
  let nextBlink = rand(1.5, 4);
  let blinkUntil = -1;
  let doubleBlink = false;
  return {
    name: 'idle',
    enter() { if (sprite === 'idle') ensureClip('idle'); },
    update(dt, t) {
      // 新的站著發呆片段：呼吸、眨眼都在影片裡，不再疊程式的呼吸
      if (sprite === 'idle' && playClip('idle', t)) return t < duration;
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

// 動作 → 動畫片段（manifest.clips）。東張西望有正面與側身兩種，在 poseMode 裡隨機挑
// 歡呼：Claude 完成時用循環版 cheer，自己歡呼整段播一次 cheerall（最後放下手回站姿）
const POSE_CLIP = { yawn: 'yawn', stretch: 'stretch', wave: 'wave', cheer: 'cheerall', nap: 'sleep', pose: 'pose', shy: 'shy', happy: 'happy', curtsy: 'curtsy', pirouette: 'pirouette', arabesque: 'arabesque', nod: 'nod', shake: 'shake', mail: 'mail', gift: 'gift', birthday: 'birthday', lantern: 'lantern', sparkler: 'sparkler' };

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
    curtsy: { sprite: 'curtsy', dur: 4 },
    pirouette: { sprite: 'pirouette', dur: 5 },
    arabesque: { sprite: 'arabesque', dur: 4 },
    nod: { sprite: 'idle', dur: 3.4 },
    shake: { sprite: 'idle', dur: 4.2 },
    mail: { sprite: 'idle', dur: 4.1 },
    gift: { sprite: 'idle', dur: 5 },
    birthday: { sprite: 'idle', dur: 5.5 },
    lantern: { sprite: 'idle', dur: 4 },
    sparkler: { sprite: 'idle', dur: 4.7 },
  }[kind];
  // 有動畫片段就播片段，沒有（或還沒載好）退回舊的單張圖加程式動作
  const clip = kind === 'curious' ? 'curious' : POSE_CLIP[kind]; // 東張西望只留 49 格正面版（祐 2026-11-12）
  const def = clip && clipDef(clip);
  let dur = duration || conf.dur;
  if (def && !duration) {
    if (def.mode === 'once') dur = clipSeconds(clip);                          // 打哈欠、伸懶腰、東張西望：播完就結束
    else if (Number.isFinite(dur)) dur = Math.max(dur, clipSeconds(clip) + clipCore.loopLength(def)); // 揮手、歡呼：至少一輪
  }
  let lanternSent = false;
  return {
    name: kind,
    enter() {
      say(kind, 1800, { mute: kind === 'curious' });
      if (def) ensureClip(clip);
      if (kind === 'lantern') host.lantern(lanternRect(false)); // 先在背景把天燈小視窗開好，第 26 格時才不會慢半拍
    },
    update(dt, t) {
      // 放天燈：播到第 26 格那一刻，獨立的天燈跟影片裡的天燈重疊出現，接著一路往上飄（影片第 28 格起天燈已擦掉）
      if (kind === 'lantern' && !lanternSent && def && clipRes[clip] && clipRes[clip].state === 'ready' && clipFrameNo(clip, t) >= 26) {
        lanternSent = true;
        host.lantern(lanternRect(true));
      }
      // 仙女棒：影片裡只有棒子，火花照每格棒子尖端的位置補畫（第 12–31 格，30 起慢慢燒完）
      if (kind === 'sparkler' && def && clipRes[clip] && clipRes[clip].state === 'ready') emitSparks(dt, clipFrameNo(clip, t));
      // 片段本身就是動畫，不再疊程式的呼吸、搖晃與跳動
      if (def && playClip(clip, t, { base: 'idle', fadeIn: 0.2, fadeOut: 0.3, dur: Number.isFinite(dur) ? dur : undefined })) return t < dur;
      if (def && waitingClip(clip) && t < 1.5) return true; // 載入中沿用前一格，不閃舊圖
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
        view.sprite = eyes('curious', t, 0.7);
        view.rot = Math.sin(t * 1.6) * 0.02;
      }
      return t < dur;
    },
  };
}

// 依時段打招呼：開機與喚醒時提屈膝禮（祐 2026-11-03），跨過時段（早／午／下午／晚／深夜）時揮手
const periodOf = (h = new Date().getHours()) => (h >= 5 && h < 11 ? 'morning' : h < 14 && h >= 11 ? 'noon' : h >= 14 && h < 18 ? 'afternoon' : h >= 18 && h < 23 ? 'evening' : 'night');
// 開機、喚醒的招呼：平常提屈膝禮；主人生日（控制面板設定）捧蛋糕；12 月 24、25 日送聖誕禮物（祐 2026-11-12）
function greetClip(now = new Date()) {
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (S.settings && S.settings.birthdayOn && S.settings.birthday === mmdd && clipDef('birthday')) return 'birthday';
  const xmas = now.getMonth() === 11 && (now.getDate() === 24 || now.getDate() === 25);
  return xmas && clipDef('gift') ? 'gift' : 'curtsy';
}

function greetMode(period = periodOf(), clip = 'wave') {
  const key = clip === 'gift' || clip === 'birthday' ? clip : `greet_${period}`; // 送禮、生日就說祝福
  if (!clipDef(clip)) clip = 'wave';
  const dur = clipSeconds(clip) || 2.8; // 揮手新版、提屈膝禮都是整段播一次
  return {
    name: 'greet',
    enter() { say(key, 2800); ensureClip(clip); },
    update(dt, t) {
      if (playClip(clip, t, { base: 'idle', fadeIn: 0.2, fadeOut: 0.3, dur })) return t < dur;
      if (waitingClip(clip) && t < 1.5) return true; // 載入中沿用前一格，不閃單張圖
      view.sprite = clip;
      breathe(t);
      if (clip === 'wave') view.rot = Math.sin(t * Math.PI * 4.4) * 0.03;
      return t < dur;
    },
  };
}

// 坐下＋起身（祐 2026-11-03）：一段影片從站著發呆開始，坐下（播一次）→ 坐著（循環）→ 起身（播一次）站回原位
// SEATS[種類]：down／loop／rise 三個片段，base＝片段還沒載好時的單張圖
const SEATS = {
  kneel: { down: 'kneeldown', loop: 'kneel', rise: 'kneelup', base: 'sit1' },   // 跪坐
  knees: { down: 'kneesdown', loop: 'knees', rise: 'kneesup', base: 'sit2', breath: [0.008, 4.2] }, // 雙手放膝（13、22 各停 5 秒，靠程式呼吸）
  doze: { down: 'dozedown', loop: 'doze', rise: 'dozeup', base: 'doze' },
  // 站著打瞌睡：不是坐姿，但一樣是「閉眼 → 循環 → 醒來回站姿」。join 0：閉眼 1–4 直接接 5，不淡（淡 0.4 秒會讓第 4 格多停，閉眼比睜眼慢）
  standdoze: { down: 'standdozedown', loop: 'standdoze', rise: 'standdozeup', base: 'sleep', join: 0 },
  // 擺姿勢：16→1 擺出來、1–12 來回、回站姿 1→16（從當下那格接著播）
  pose: { down: 'posein', loop: 'poseloop', rise: 'poseout', base: 'pose', join: 0 },
  // 禱告：1–11 合掌閉眼、11–33 來回祈禱、回站姿從當下那格播到 46
  pray: { down: 'praydown', loop: 'prayloop', rise: 'prayup', base: 'praying', join: 0 }, // 抱膝打盹：影片本身就在呼吸，不再疊程式呼吸（breath：[幅度, 秒]）
};
// 坐著的動作：時間到或被打斷時，setMode 會先接 riseMode 播起身（見 mode.rise）
function seatedMode(name, kind, dur, line) {
  const seat = SEATS[kind];
  let t0 = -1;
  return {
    name,
    rise: seat.rise,
    enter() { say(line, 2200); ensureClip(seat.down); ensureClip(seat.loop); ensureClip(seat.rise); },
    update(dt, t) {
      // 坐下（閉眼）片段載好那一刻才開始算，免得載入時第一格被跳過；最多等 3 秒
      if (t0 < 0) { if (ensureClip(seat.down) || !waitingClip(seat.down) || t > 3) t0 = t; else return true; }
      const lt = t - t0;
      if (lieView(seat.down, seat.loop, lt, seat.join)) {
        if (seat.breath) breatheOver(lt - clipSeconds(seat.down), seat.breath[0], seat.breath[1]);
        return t < dur;
      }
      view.sprite = eyes(seat.base, t, 0.4);
      breathe(t, 0.007, 3.8);
      return t < dur;
    },
  };
}
// 坐下等待：跪坐、雙手放膝兩種隨機一種
function sitMode() {
  return seatedMode('sit', Math.random() < 0.5 ? 'kneel' : 'knees', rand(25, 60), 'sit');
}
// 坐著打盹：抱膝把臉埋在手臂上
function dozeMode() {
  return seatedMode('doze', 'doze', rand(25, 50), 'doze');
}
// 站著打瞌睡：閉眼、站著點頭呼吸，醒來倒著播回站姿（之後接累了、深夜）
function standDozeMode() {
  return seatedMode('standdoze', 'standdoze', rand(20, 40), 'doze');
}
// 擺姿勢：維持幾秒再回站姿
function posingMode() {
  return seatedMode('pose', 'pose', rand(5, 8), 'pose');
}
// 禱告：合掌祈禱幾秒再放下手
function prayMode() {
  return seatedMode('pray', 'pray', rand(6, 9), 'pray');
}
// 唱歌、拉小提琴、指揮（祐 2026-11-03）：只在使用者自己點曲子時才演出。開始（播一次）→ 循環到音樂播完 → 收尾（借用起身的機制）
// file：音樂檔名（唱歌在 app/music/、小提琴在 app/music/violin/、指揮在 app/music/conduct/）；沒有就只做動作 20 秒。
// 演出時被點一下就停（見點擊處理），Claude 的狀態等她演完再換
const MUSIC_DIR = '../music/';
const PERFORM = {
  sing: { start: 'singstart', loop: 'sing', end: 'singend', dir: '' },
  violin: { start: 'violinstart', loop: 'violin', end: 'violinend', dir: 'violin/' },
  conduct: { start: 'conductstart', loop: 'conduct', end: 'conductend', dir: 'conduct/' },
  // 豎琴、電子琴（祐 2026-11-13）：撫子照 app/scores/ 的樂譜自己彈，聲音即時合成（instrument.js），不用錄音檔
  harp: { start: 'harpstart', loop: 'harp', end: 'harpend', synth: 'harp' },
  keys: { start: 'keysstart', loop: 'keys', end: 'keysend', synth: 'piano' },
};
const PERFORMING = new Set(Object.keys(PERFORM));
function performMode(kind, file) {
  const p = PERFORM[kind];
  let audio = null;
  let ended = false;
  let title = file ? file.replace(/\.[^.]+$/, '') : '';
  let dur = file ? Infinity : 20;
  let synth = null, endAt = 0;
  return {
    name: kind,
    rise: p.end,
    enter() {
      ensureClip(p.start); ensureClip(p.loop); ensureClip(p.end);
      if (p.synth && file) {
        // 自己彈：讀樂譜、合成，等前奏動作（道具出現、拿好）播完才開始彈
        try {
          const score = host.readScore(file);
          const compiled = ScoreCore.compile(score);
          title = score.title || title;
          audioCtx = audioCtx || new AudioContext();
          if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
          const vol = S.settings.voice === false ? 0 : clamp(S.settings.volume / 100, 0, 1);
          synth = Instrument.makePlayer(audioCtx, p.synth, vol);
          const lead = clipDef(p.start) ? clipSeconds(p.start) : 0.5;
          const times = synth.play(compiled, lead);
          endAt = performance.now() + (times.end - audioCtx.currentTime) * 1000 + 600;
        } catch (e) { ended = true; S.say = { text: `彈不出來：${title}`, until: performance.now() + 4000 }; return; }
        S.say = { text: `♪ ${title}`, until: performance.now() + 3000 };
        return;
      }
      S.say = { text: title ? `♪ ${title}` : '♪～', until: performance.now() + 3000 };
      if (!file) return;
      try {
        audio = new Audio(MUSIC_DIR + p.dir + encodeURIComponent(file));
        audio.volume = clamp(S.settings.volume / 100, 0, 1);
        audio.onended = () => { ended = true; };
        audio.onerror = () => { ended = true; S.say = { text: `放不出來：${title}`, until: performance.now() + 4000 }; };
        audio.play().catch(() => { ended = true; });
      } catch (_) { ended = true; }
    },
    exit() { if (audio) { audio.pause(); audio = null; } if (synth) { synth.stop(); synth = null; } },
    update(dt, t) {
      if (!lieView(p.start, p.loop, t, p.synth ? 0 : undefined)) { view.sprite = 'idle'; breathe(t); }
      if (synth && performance.now() > endAt) ended = true;
      return !ended && t < dur;
    },
  };
}

// 起身：播完接原本要換的動作（next）；片段沒有就直接換
// 坐姿循環停在哪一格都可能，開頭用 0.25 秒從當下那格淡進起身的第 1 格
function riseMode(clip, next) {
  let base = view.sprite.startsWith('clip:') ? view.sprite : null;
  // 起身片段裡有畫面上正在用的那格（坐著循環的格通常都在起身片段裡）：直接從那格接著播，不用淡入（祐：不要跳格）
  let skip = 0;
  const cm = /^clip:(.+):(\d+)$/.exec(view.sprite);
  const cur = cm && clipDef(cm[1]);
  const rd = clipDef(clip);
  if (cur && rd) {
    const j = rd.frames.indexOf(cur.frames[+cm[2]]);
    if (j >= 0) { skip = clipCore.sum(rd.durations, 0, j - 1); base = null; }
  }
  let t0 = -1;
  return {
    name: 'rise',
    update(dt, t) {
      if (t0 < 0 && ensureClip(clip)) t0 = t;
      const T = clipSeconds(clip);
      const lt = t0 >= 0 ? t - t0 + skip : 0;
      if (t0 >= 0 && lt < T && playClip(clip, lt, base ? { base, fadeIn: 0.25 } : undefined)) return true;
      if (t0 < 0 && waitingClip(clip) && t < 3) return true;
      setMode(this.after ? this.after() : next); // after：起身途中又被點，站好再反應（見點擊處理）
      return true;
    },
  };
}

// 太久沒人理：側身躺下睡覺，直到有人摸她、點她或 Claude 開始工作
// 躺下片段播一次，接著在睡著的循環片段反覆（接縫淡 0.4 秒）；回傳 true＝畫好了，或還在載入（沿用前一格）
function lieView(down, loop, t, join = 0.4) {
  const dd = clipDef(down);
  const dl = dd ? clipSeconds(down) : 0;
  if (t < dl && playClip(down, t)) return true;
  const base = dd && clipRes[down] && clipRes[down].state === 'ready' ? clipKey(down, dd.frames.length - 1) : null;
  // join：從「躺下」最後一格淡進循環的秒數（0＝影片本來就連續，直接接）
  if (playClip(loop, Math.max(0, t - dl), base && join > 0 ? { base, fadeIn: join } : undefined)) return true;
  return waitingClip(down) || waitingClip(loop);
}

// 太久沒人理：躺下側睡（「側睡醒來」倒著播＝躺下，閉眼那幾格循環），直到有人摸她、點她或 Claude 開始工作
function lieMode() {
  return {
    name: 'nap',
    lying: true,
    wakeFrom: 'nap2',
    enter() { say('nap', 2200); ensureClip('nap2down'); ensureClip('nap2'); },
    update(dt, t) {
      if (lieView('nap2down', 'nap2', t)) { breatheOver(t - clipSeconds('nap2down'), 0.014, 4.8); return true; }
      view.sprite = 'sleepside';
      breathe(t, 0.012, 4.8);
      return true;
    },
  };
}

// 醒來站起：昏倒 → 「昏倒2+清醒」後半段；額度用完 → 「蓋棉被睡+起床」掀被站起；睡午覺、選單的睡醒 → 「側睡醒來」整段
// 躺的姿勢跟醒來片段的第 1 格不同時（目前沒有），把 from 加進 FADE_WAKE，開頭用 0.5 秒從當下那格淡過去
const WAKE_CLIP = { faint2: 'faint2up', nap2: 'nap2up', exhausted: 'blanketup' };
const FADE_WAKE = new Set();
function wakeMode(from) {
  const clip = WAKE_CLIP[from] || 'nap2up';
  const base = FADE_WAKE.has(from) && view.sprite.startsWith('clip:') ? view.sprite : null;
  let t0 = -1; // 片段載好那一刻才開始算，免得載入的那一下跳過開頭幾格
  return {
    name: 'wake',
    enter() { S.lastInteraction = performance.now(); say('wake', 2400); ensureClip(clip); },
    update(dt, t) {
      const T = clipSeconds(clip);
      if (t0 < 0 && ensureClip(clip)) t0 = t;
      // 開頭從躺著那格淡入、結尾淡回站姿，兩段用的底圖不同
      const lt = t - t0;
      let going = false;
      if (t0 >= 0 && playClip(clip, lt, base && lt < 0.5 ? { base, fadeIn: 0.5 } : { base: 'idle', fadeOut: 0.2, dur: T })) going = lt < T;
      else if (waitingClip(clip)) going = t < 3;
      if (!going && this.after) { setMode(this.after()); return true; } // 爬起來途中又被點：站好再反應
      return going;
    },
  };
}

// 走路（祐 2026-11-03）：往右「自然走路」、往左「雙手互握優雅漫步」，各一段影片，不用鏡像。
// 每段：轉身起步（原地）→ 走路循環 → 循環播完一輪再接「轉回正面」停下，最後淡回站姿。
// 腳步、身體起伏都是影片本身的，程式只負責移動；速度＝影片裡貼地那隻腳每格往後滑的距離（右 30px、左 37px）換算成身長／秒，腳才不會打滑。
// moving：哪幾格（原圖編號）是在走路、要跟著移動；轉身那幾格原地不動
const WALKS = {
  // 49 格版（2026-11-12）：貼地那隻腳每格往後滑 右 28px、左 14.5px（原圖），×0.958 縮放、每格 0.082 秒 → 身長／秒
  R: { start: 'walkRstart', loop: 'walkR', stop: 'walkRstop', speed: 0.498, moving: [8, 40] },
  // stopAfter：循環裡播完這幾格（原圖編號）就可以接收尾；左走第 22 格之後接 41 跟原本接 23 一樣順，不用把整圈走完才停
  L: { start: 'walkLstart', loop: 'walkL', stop: 'walkLstop', speed: 0.258, moving: [7, 43], stopAfter: [22, 40] },
};
// 片段在第 t 秒是原圖的第幾格（從檔名的編號讀）
function clipFrameNo(name, t) {
  const def = clipDef(name);
  const i = clipCore.frameAt(def, t).i;
  return parseInt(def.frames[i].match(/_(\d+)\./)[1], 10);
}

function walkMode() {
  const wa = S.workArea;
  const minX = wa.x + S.size * 0.3 - cx();
  const maxX = wa.x + wa.width - S.size * 0.3 - cx();
  let dir = Math.random() < 0.5 ? -1 : 1;
  if (S.pos.x < minX + 120) dir = 1;
  if (S.pos.x > maxX - 120) dir = -1;
  const target = clamp(S.pos.x + dir * rand(150, 520), minX, maxX);
  const sgn = target >= S.pos.x ? 1 : -1;
  const w = WALKS[sgn > 0 ? 'R' : 'L'];
  if (!clipDef(w.loop)) return idleMode(rand(2, 4)); // 素材不齊就站著
  let phase = 'start';
  let t0 = 0; // 這一段開始的時間
  let stopping = false;
  let seenEnd = false;
  return {
    name: 'walk',
    ownsPosition: true,
    enter() { ensureClip(w.start); ensureClip(w.loop); ensureClip(w.stop); view.flip = false; },
    update(dt, t) {
      view.dy = 0;
      view.rot = 0;
      if (phase === 'start') {
        if (playClip(w.start, t - t0, { base: 'idle', fadeIn: 0.15 })) {
          if (t - t0 >= clipSeconds(w.start)) { phase = 'loop'; t0 = t; }
        } else if (waitingClip(w.start) && t < 2) return true; // 載入中沿用前一格
        else { phase = 'loop'; t0 = t; }
      }
      if (phase === 'loop') {
        if (!stopping && ((target - S.pos.x) * sgn < 2 || t > 30)) stopping = true;
        const def = clipDef(w.loop);
        // 停下來：等循環播到可以接收尾的那格（預設最後一格）、剛要換下一格時，改接「轉回正面」，步伐才接得上
        if (stopping) {
          const i = clipCore.frameAt(def, t - t0).i;
          const no = parseInt(def.frames[i].match(/_(\d+)\./)[1], 10);
          const ends = w.stopAfter || [parseInt(def.frames[def.frames.length - 1].match(/_(\d+)\./)[1], 10)];
          if (ends.includes(no)) seenEnd = true;
          else if (seenEnd) { phase = 'stop'; t0 = t; }
        }
        if (phase === 'loop' && !playClip(w.loop, t - t0) && !waitingClip(w.loop)) return false;
      }
      if (phase === 'stop') {
        const T = clipSeconds(w.stop);
        if (t - t0 >= T || !playClip(w.stop, t - t0, { base: 'idle', fadeOut: 0.3, dur: T })) return false;
      }
      const cur = phase === 'start' ? w.start : phase === 'loop' ? w.loop : w.stop;
      const n = clipDef(cur) && clipRes[cur] && clipRes[cur].state === 'ready' ? clipFrameNo(cur, t - t0) : 0;
      if (n >= w.moving[0] && n <= w.moving[1]) moveTo(clamp(S.pos.x + sgn * w.speed * S.size * dt, minX, maxX), groundY());
      return true;
    },
    exit() { view.blend = null; },
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
  const kind = pickFly(); // 一趟只用一種姿勢（各自會眨眼），不再兩張輪流
  // 有起飛／落地片段的姿勢（飛行2：優雅起飛+落地）：先在原地播起飛，飛完回到地面再播落地
  const up = clipDef(`${kind}up`) ? `${kind}up` : null;
  const down = clipDef(`${kind}down`) ? `${kind}down` : null;
  let phase = up ? 'up' : 'fly';
  let t0 = 0; // 這一段開始的時間
  let tHover = 0; // 回到地面、等著接落地的那一刻
  let seenPeak = false;
  return {
    name: 'fly',
    ownsPosition: true,
    enter() {
      say('fly', 1400);
      if (clipDef(kind)) ensureClip(kind);
      if (up) { ensureClip(up); view.flip = pts[0].x < S.pos.x; } // 起飛就面向第一段要飛的方向
      if (down) ensureClip(down);
    },
    update(dt, t) {
      if (phase === 'up') {
        const T = clipSeconds(up);
        if (playClip(up, t) && t < T) return true;
        if (waitingClip(up) && t < 1.5) return true;
        phase = 'fly'; t0 = t;
      }
      if (phase === 'hover') {
        // 已經回到地面：繼續滑翔，等循環播到最後那一格（檔名編號最大、緊接落地第 1 格）才開始落地，頭的位置才接得上
        const def = clipDef(kind);
        const peak = def.frames.reduce((b, f, k) => (parseInt(f.match(/_(\d+)\./)[1], 10) > parseInt(def.frames[b].match(/_(\d+)\./)[1], 10) ? k : b), 0);
        const at = clipCore.frameAt(def, t - t0).i;
        if (at === peak) seenPeak = true;
        // 最後那一格播完（剛離開它）才切落地；最多等一輪循環
        if (!(seenPeak && at !== peak) && t - tHover < clipCore.loopLength(def) + 0.3) { flyView(kind, t - t0, false); return true; }
        phase = 'down'; t0 = t;
      }
      if (phase === 'down') {
        const lt = t - t0;
        const T = clipSeconds(down);
        if (playClip(down, lt, { base: 'idle', fadeOut: 0.3, dur: T }) && lt < T) {
          if (view.blend && view.blend.sprite === 'idle') view.blend.flip = false; // 往左飛時落地是鏡像的，淡回不鏡像的站姿
          return true;
        }
        if (waitingClip(down) && lt < 1.5) return true;
        return false;
      }
      const p = pts[i];
      const ex = p.x - S.pos.x;
      const ey = p.y - S.pos.y;
      const d = Math.hypot(ex, ey);
      if (d < 6) {
        i++;
        if (i >= pts.length) {
          moveTo(S.pos.x, groundY());
          if (down) { phase = clipDef(kind) && clipDef(kind).mode === 'loop' ? 'hover' : 'down'; tHover = t; if (phase === 'down') t0 = t; view.rot = 0; view.dy = 0; return true; }
          return false;
        }
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
      flyView(kind, t - t0, !up); // 從起飛片段接過來的不用再從站姿淡入
      if (Math.abs(vx) > 8) view.flip = vx < 0;
      view.rot = clamp(vy / speed, -1, 1) * 0.08 * (view.flip ? -1 : 1);
      view.dy = kind === 'fly4' ? 0 : Math.sin(t * 2.4) * S.size * 0.015; // 飛行49 影片本身就在上下飄
      return t < 40;
    },
    exit() { view.flip = false; },
  };
}

// 飛行：飛行49（祐 2026-11-12，小仙子式，取代兩種舊飛行 fly2、fly3），起飛 fly4up → 飛 fly4 → 落地 fly4down
function pickFly() { return clipDef('fly4') ? 'fly4' : ['fly2', 'fly3'].find(clipDef) || 'fly2'; }

// 仙女棒火花（祐 2026-11-12）：仙女棒49 的棒子尖端（原圖座標，逐格量的），換成視窗座標噴金色火花，畫在 draw() 的最上層
const SPARK_TIPS = {
  12: [575, 550], 13: [578, 482], 14: [565, 460], 15: [557, 445], 16: [558, 445], 17: [580, 456], 18: [583, 462],
  19: [568, 450], 20: [535, 442], 21: [552, 452], 22: [542, 522], 23: [540, 545], 24: [560, 510], 25: [585, 458],
  26: [538, 400], 27: [518, 407], 28: [512, 408], 29: [517, 408], 30: [583, 412], 31: [598, 480],
};
const SPARK_S = 614 / 701.5 * 1.1196, SPARK_DX = 14; // 跟 build_clips.py #88 的縮放、蹲著時往右挪的 14px 一致
const sparks = [];
let sparkGlow = null;
function emitSparks(dt, no) {
  const p = SPARK_TIPS[no];
  if (!p) return;
  const k = S.size / S.manifest.canvas;
  const x = S.padX + (332 + SPARK_DX + (p[0] - 384) * SPARK_S) * k + view.dx;
  const y = S.bubbleH + (648 - (694 - p[1]) * SPARK_S) * k + view.dy;
  const burnout = no >= 30 ? 0.35 : 1;
  sparkGlow = { x, y, a: burnout, at: performance.now() };
  let n = 170 * burnout * dt + Math.random();
  while (n-- >= 1) {
    const ang = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 170) * k;
    sparks.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 20 * k, life: 0.18 + Math.random() * 0.35, age: 0, k });
  }
}
function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.age += dt;
    if (s.age > s.life) { sparks.splice(i, 1); continue; }
    s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 260 * s.k * dt; s.vx *= 0.96; s.vy *= 0.96;
  }
}
function drawSparks() {
  const glowOn = sparkGlow && performance.now() - sparkGlow.at < 150;
  if (!sparks.length && !glowOn) return;
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  if (glowOn) {
    const r = S.size * 0.09;
    const g = ctx.createRadialGradient(sparkGlow.x, sparkGlow.y, 0, sparkGlow.x, sparkGlow.y, r);
    g.addColorStop(0, `rgba(255,250,220,${0.9 * sparkGlow.a})`);
    g.addColorStop(0.4, `rgba(255,200,110,${0.45 * sparkGlow.a})`);
    g.addColorStop(1, 'rgba(255,160,60,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sparkGlow.x, sparkGlow.y, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.lineCap = 'round';
  for (const s of sparks) {
    const a = 1 - s.age / s.life;
    ctx.strokeStyle = `rgba(255,${200 + Math.round(55 * a)},${120 + Math.round(100 * a)},${a})`;
    ctx.lineWidth = Math.max(1, 2.2 * s.k * 2.2);
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x - s.vx * 0.05, s.y - s.vy * 0.05); ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// 放天燈：天燈在第 26 格時的畫布位置（660×660，tools/patches/make_lantern49.py 算出來的），換成螢幕座標交給主程序的小視窗
const LANTERN_AT = { x: 318.3, y: -11.5, w: 116, h: 143 };
function lanternRect(go) {
  const k = S.size / S.manifest.canvas;
  return { // 天燈本身在螢幕上的位置與大小；光暈、光點要的邊界由主程序加。go＝false 先開好藏著，true 才顯示並開始飄
    go,
    x: S.pos.x + S.padX + LANTERN_AT.x * k + view.dx,
    y: S.pos.y + S.bubbleH + LANTERN_AT.y * k + view.dy,
    w: LANTERN_AT.w * k, h: LANTERN_AT.h * k,
    speed: 213 * k, // 影片裡天燈 26→28 每格往上約 17.5 原圖像素（×0.98、每格 0.082 秒），接著用同樣的速度飄
  };
}
function flyView(kind, t, fade = true) {
  if (clipDef(kind) && playClip(kind, t, fade ? { base: 'idle', fadeIn: 0.2 } : undefined)) return;
  if (waitingClip(kind)) return; // 載入中沿用前一格
  view.blend = null;
  view.sprite = 'idle';
}
// 緩降（側身張開雙手）：新的片段在原地循環，往下飄是程式移動位置
function floatView(t) {
  if (playClip('float', t)) return;
  view.blend = null;
  view.sprite = 'float';
}

// 坐／趴到別的視窗上：飛過去 → 停著（視窗一動或消失就輕輕飄下來）→ 坐夠了飛回地面。只有 Windows 能取得視窗位置。
// 三種停法：趴在視窗上緣（lie_top）、坐在視窗下緣（sit_edge，頭在視窗前面，不怕頂到螢幕上方）、坐在上緣（sit_edge，上緣夠低才用）。
// 兩個姿勢都有同名的新動畫片段（單張圖＝片段第 1 格，seat 一致），坐著時播片段。
const PERCH_KINDS = [
  { kind: 'lie', sprites: ['lie_top'], edge: 'top', weight: 1.2, say: 'perch_lie' },
  { kind: 'sit_bottom', sprites: ['sit_edge'], edge: 'bottom', weight: 1.2, say: 'perch' },
  { kind: 'sit_top', sprites: ['sit_edge'], edge: 'top', weight: 0.4, say: 'perch' },
];

function perchSeat(w, v) {
  const k = S.size / S.manifest.canvas;
  const info = S.manifest.sprites[v.sprite];
  const edgeY = v.edge === 'bottom' ? w.y + w.h : w.y;
  return { y: edgeY - S.bubbleH - info.seat * k, k, info };
}

// only：'lie' 只找能趴的、'sit' 只找能坐的（撫子叫的「趴到視窗上」用）
async function pickPerch(only) {
  let res = { list: [], error: null };
  try { res = await host.windows(); } catch (e) { res = { list: [], error: String(e.message || e) }; }
  const wa = S.workArea;
  const all = res.list || [];
  const cands = [];
  all.forEach((w, idx) => {
    if (w.w < S.size * 0.55 || w.x >= wa.x + wa.width || w.x + w.w <= wa.x) return;
    for (const kind of PERCH_KINDS) {
      if (only && (only === 'lie') !== (kind.kind === 'lie')) continue;
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
  const flyKind = pickFly();
  // stay：撫子叫的（或之後要常駐的）就一直待著，Claude 工作時也不下來；點她一下、視窗動了才飄下來（祐 2026-11-08）
  const dur = opts.stay ? Infinity : rand(40, 110);
  let sitT = 0;
  let seekPromise = null;
  const seatPos = (w, v) => {
    const frac = v.kind === 'lie' ? 0.5 : 0.5 + side * 0.22;
    return {
      x: clamp(w.x + w.w * frac, w.x + S.size * 0.3, w.x + w.w - S.size * 0.3) - cx(),
      y: perchSeat(w, v).y,
    };
  };
  const px = 1; // 視窗動超過 1 像素就算動了（祐定案：最敏感）
  const checkEvery = 350; // 多久查一次視窗位置（毫秒）；常駐 PowerShell 回得很快，查勤一點沒負擔
  const changed = (a, b) => Math.abs(a.x - b.x) > px || Math.abs(a.y - b.y) > px || Math.abs(a.w - b.w) > px || Math.abs(a.h - b.h) > px;
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
    if (res.error) return; // 這次沒拿到清單（PowerShell 出錯）就當沒事，不要誤判成視窗消失
    const w = (res.list || []).find((x) => x.id === target.w.id);
    if (!w) { phase = 'drop'; phaseT = 0; return; }
    if (phase === 'fly') { target.w = w; return; } // 飛的途中視窗動了就改飛向新位置
    if (phase === 'sit' && changed(w, snap)) { phase = 'drop'; phaseT = 0; return; }
    target.w = w;
  }).catch(() => {});
  return {
    name: 'perch',
    stay: !!opts.stay,
    ownsPosition: true,
    enter() { if (clipDef(flyKind)) ensureClip(flyKind); ensureClip('float'); },
    update(dt, t) {
      phaseT += dt;
      if (phase === 'seek') {
        view.sprite = 'idle';
        breathe(t);
        if (!seekPromise) {
          seekPromise = pickPerch(opts.only).then(({ ok, why: w }) => {
            if (!ok) { why = w; phase = 'none'; return; }
            target = { w: ok.w, v: { ...ok.v } };
            target.v.sprite = ok.v.sprite;
            phase = 'fly'; phaseT = 0;
            ensureClip(target.v.sprite); // 飛過去的路上先載好坐／趴的片段
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
        flyView(flyKind, t);
        view.dy = Math.sin(t * 2.4) * S.size * 0.012;
        if (performance.now() > checkAt) { checkAt = performance.now() + checkEvery; refresh(); }
        const dest = seatPos(target.w, target.v);
        if (go(dest, dt, S.size * 1.1) && phase === 'fly') {
          phase = 'sit'; phaseT = 0; view.flip = false; snap = { ...target.w }; checkAt = performance.now() + 1000;
          say(target.v.say, 2600);
        }
        return phaseT < 20 || phase !== 'fly';
      }
      if (phase === 'sit') {
        sitT += dt;
        view.blend = null;
        const base = target.v.sprite;
        if (!playClip(base, sitT)) {
          view.sprite = eyes(base, sitT, 0.8);
          breathe(sitT, base === 'lie_top' ? 0.01 : 0.006, 3.8);
          view.rot = base === 'lie_top' ? 0 : Math.sin(sitT * 1.1) * 0.006;
        }
        if (performance.now() > checkAt) { checkAt = performance.now() + checkEvery; refresh(); }
        if (sitT > dur) { phase = 'leave'; phaseT = 0; }
        return true;
      }
      if (phase === 'drop') {
        // 視窗動了或不見了：不黏過去，慢慢飄落到地面
        if (phaseT < 0.05) { vy = 0; say('drop', 2200); }
        floatView(phaseT);
        vy = Math.min(vy + S.size * 0.9 * dt, S.size * 0.55);
        const ny = Math.min(S.pos.y + vy * dt, groundY());
        moveTo(S.pos.x + Math.sin(phaseT * 1.6) * S.size * 0.1 * dt, ny);
        view.rot = Math.sin(phaseT * 1.6) * 0.03;
        if (ny >= groundY()) { view.rot = 0; return false; }
        return phaseT < 20;
      }
      // leave：飛回地面
      flyView(flyKind, t);
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
  // 從視窗邊緣（坐著、趴著）或飛行中被打斷：不是被丟下來的，用「緩降」姿勢飄著落地，不會暈
  const gentle = !!(mode && (mode.name === 'perch' || mode.name === 'fly'));
  return {
    name: 'fall',
    ownsPosition: true,
    enter() {
      // 先把落地要用的片段載好（掉下來的這段時間通常就夠了）
      if (gentle) { ensureClip('float'); return; }
      const drop = groundY() - S.pos.y;
      if (drop > S.size * 2.2) ensureClip('tumble');
      else if (drop > S.size * 0.15) ensureClip('land');
    },
    update(dt, t) {
      if (landed < 0) {
        vy += (gentle ? 700 : 2600) * dt;
        if (gentle) vy = Math.min(vy, S.size * 1.2);
        const ny = Math.min(S.pos.y + vy * dt, groundY());
        moveTo(S.pos.x, ny);
        if (gentle) floatView(t);
        else view.sprite = dragKind;
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
      view.rot = 0;
      view.dx = 0;
      view.dy = 0;
      // 高處摔下：摔在地上 → 撐起來 → 站好（「高處摔倒再爬起」第 3–25 格，約 4.6 秒）
      if (dizzy) {
        const T = clipSeconds('tumble');
        if (T && playClip('tumble', lt, { base: 'idle', fadeOut: 0.2, dur: T })) return lt < T;
        if (waitingClip('tumble') && lt < 1) return true; // 載入中沿用前一格，不閃舊圖
        // 沒有片段：用昏倒2 側躺一下，再淡回站姿
        const LIE = 1.4; const UP = 0.5;
        if (playClip('faintb', lt, { base: 'idle', fadeOut: UP, dur: LIE + UP })) return lt < LIE + UP;
        if (waitingClip('faintb') && lt < LIE) return true; // 載入中沿用前一格，不閃舊圖
        view.blend = null;
        view.sprite = 'idle';
        return lt < 0.3;
      }
      // 低處落下：著地、蹲下緩衝、站起來（「低處落地」第 13–25 格，約 2 秒）；只被拎起一點點就不播
      if (!gentle && groundY() - startY > S.size * 0.15) {
        const T = clipSeconds('land');
        if (T && playClip('land', lt, { base: 'idle', fadeOut: 0.2, dur: T })) return lt < T;
      }
      view.blend = null;
      view.sprite = 'idle';
      // 輕輕落地（飄下來）：小小的壓扁回彈，站穩就接下一個動作
      if (gentle) {
        const squash = Math.exp(-lt * 7) * Math.cos(lt * 22) * 0.05;
        view.sy = 1 - squash;
        view.sx = 1 + squash * 0.6;
        return lt < 0.3;
      }
      // 片段還沒載好、或只是輕輕放下：用站姿蹲一下（0.1 秒蹲下、停 0.15 秒、0.3 秒站直）
      const k = lt < 0.1 ? lt / 0.1 : lt < 0.25 ? 1 : Math.max(0, 1 - (lt - 0.25) / 0.3);
      const e = k * k * (3 - 2 * k);
      view.sy = 1 - 0.14 * e;
      view.sx = 1 + 0.07 * e;
      return lt < 0.6;
    },
    exit() { if (after) setTimeout(after, 0); },
  };
}

// Claude 狀態對應的姿勢（持續到狀態改變）
// Claude 狀態 → 動畫片段（持續型：先播開頭一次，之後在循環範圍反覆）。
// 等你確認用「拿平板揮手」那組、打招呼用單純揮手；暈倒只用「昏倒2」（側躺），舊的新版「昏倒」祐決定不用。
// 睡覺（5 小時用完）照祐的指定仍用舊的側睡 62。
const CLAUDE_CLIP = { thinking: 'think', working: 'work', waiting: 'waitwave', hello: 'wave', done: 'cheer', error: 'confused' };
// 49 格新版（有進場、循環、退場）：進場播一次、循環反覆，狀態一變先從當下那格播退場回站姿（跟坐姿同一套 riseMode）
const CLAUDE_SEQ = {
  working: { down: 'workdown', loop: 'workloop', rise: 'workup' },
  error: { down: 'errdown', loop: 'errloop', rise: 'errup' },
  thinking: { down: 'thinkdown', loop: 'thinkloop', rise: 'thinkup' },
  waiting: { down: 'waitdown', loop: 'waitloop', rise: 'waitup' },
  // 週上限（祐 2026-11-14）：新的暈倒＋起身49，從站姿頭暈坐倒、垂頭昏迷循環，恢復時從當下那格起身（不再躺平，免得跟蓋棉被睡覺太像）
  faint: { down: 'faint3down', loop: 'faint3', rise: 'faint3up' },
};

function claudeMode(body) {
  // 暈倒：「昏倒2+清醒」倒著播加速＝倒下，閉眼那 10 格循環，醒來正著播後半段（取代舊 24 系列）
  // 額度用完：「蓋棉被睡+起床」倒著播＝鑽進棉被躺下，閉眼那 12 格循環，醒來正著播掀被站起
  const seq = CLAUDE_SEQ[body] && clipDef(CLAUDE_SEQ[body].loop) ? CLAUDE_SEQ[body] : null;
  const clip = seq ? null : CLAUDE_CLIP[body];
  let t0 = -1;
  let act = null, nextAt = 0, hold = null, idleAt = 0; // 疲憊：正在播的小動作、下一次開始的時間、播完停住的那格、站姿循環開始的時間
  return {
    name: `claude:${body}`,
    body,
    // 疲憊結束：正在打哈欠／揉眼就從當下那格播完（兩段結尾都是站好），站著時直接接下一個狀態
    get rise() { return seq ? seq.rise : act ? act.name : undefined; },
    wakeFrom: body === 'faint' ? 'faint2' : body,
    lying: body === 'exhausted' || (body === 'faint' && !seq), // 新暈倒是坐著，走 rise；素材缺時才退回舊的側躺昏倒
    enter() {
      if (seq) { ensureClip(seq.down); ensureClip(seq.loop); ensureClip(seq.rise); }
      if (clip) ensureClip(clip);
      if (body === 'tired') { ensureClip('tiredrub'); ensureClip('yawn'); ensureClip('idle'); nextAt = 2 + Math.random() * 3; }
      if (body === 'faint' && !seq) { ensureClip('faint2down'); ensureClip('faint2'); }
      if (body === 'exhausted') { ensureClip('blanketdown'); ensureClip('blanket'); }
    },
    update(dt, t) {
      if (seq) {
        // 進場片段載好那一刻才開始算（最多等 3 秒），之後進場 → 循環，影片本身連續不用淡入
        if (t0 < 0) { if (ensureClip(seq.down) || !waitingClip(seq.down) || t > 3) t0 = t; else return true; }
        if (lieView(seq.down, seq.loop, t - t0, 0)) return true;
      }
      if (clip && playClip(clip, t, { base: 'idle', fadeIn: 0.25 })) return true;
      if (clip && waitingClip(clip) && t < 1.5) return true; // 載入中沿用前一格，不閃舊圖
      if (body === 'faint' && lieView('faint2down', 'faint2', t)) return true;
      if (body === 'exhausted' && lieView('blanketdown', 'blanket', t)) return true;
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
          // 祐 2026-11-14：站姿循環，每 10–15 秒穿插一次「打哈欠」或「揉眼」（疲憊49 的 1→45），兩段都完整播：站→動作→站
          if (!act && t >= nextAt) {
            const pick = ['yawn', 'tiredrub'].filter((k) => clipDef(k) && ensureClip(k));
            if (pick.length) act = { name: pick[Math.floor(Math.random() * pick.length)], at: t, from: hold || (view.sprite.startsWith('clip:') ? view.sprite : null) };
          }
          if (act) {
            const lt = t - act.at;
            // 上一段停住的那格淡進新的一段（兩段影片的站姿差一點點，淡 0.3 秒就看不出來）
            if (lt < clipSeconds(act.name) && playClip(act.name, lt, act.from ? { base: act.from, fadeIn: 0.3 } : undefined)) break;
            hold = clipKey(act.name, clipDef(act.name).frames.length - 1);
            act = null;
            nextAt = t + 10 + Math.random() * 5;
            idleAt = t;
          }
          // 兩段之間：站姿循環（站著發呆49），從剛播完那格淡進去；影片本身就有呼吸，不用程式晃（祐 2026-11-14）
          if (playClip('idle', t - idleAt, hold && t - idleAt < 0.4 ? { base: hold, fadeIn: 0.3 } : undefined)) break;
          view.blend = null;
          view.sprite = hold || eyes('tired', t, 0.9);
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

// 拎起有兩種（新版：乖乖被拎著 drag、掙扎亂踢 drag2），每次拎起隨機挑一種，整段都用同一種
// 兩組片段建置時都把頭頂對到同一點（build_clips.py 的 HANG），所以游標一直在後頸附近
let dragKind = 'drag';
function dragMode() {
  dragKind = S.manifest.sprites.drag2 && Math.random() < 0.5 ? 'drag2' : 'drag';
  return {
    name: 'drag',
    ownsPosition: true,
    enter() { say('drag', 1500); ensureClip(dragKind); },
    update(dt, t) {
      view.pivot = 'grip';
      if (playClip(dragKind, t)) {
        // 片段本身就在晃，只疊被甩動的彈簧擺動
        const target = clamp(-drag.vx * 0.0008, -0.35, 0.35);
        drag.swingV += ((target - drag.swing) * 60 - drag.swingV * 6) * dt;
        drag.swing += drag.swingV * dt;
        view.rot = drag.swing;
        drag.vx *= 0.85;
        return true;
      }
      view.sprite = eyes(dragKind, t, 0.5);
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
    const shy = clicks.length >= 3;
    if (shy) clicks = [];
    // 唱歌、拉琴、指揮時被點：停下來回到站姿（不跳開心）
    if (mode && PERFORMING.has(mode.name)) { clicks = []; setMode(idleMode()); return; }
    hearts(shy ? 3 : 2);
    // 坐著／躺著被點會先起身；起身途中再點（連點兩下），不要打斷，排到站好之後再開心跳或害羞
    if (mode && (mode.name === 'rise' || mode.name === 'wake')) { mode.after = () => poseMode(shy ? 'shy' : 'happy'); return; }
    const react = () => setMode(poseMode(shy ? 'shy' : 'happy'));
    // 飛行中、坐在視窗邊緣被點到：人不能站在空中反應，先飄落到地面再做
    if (!onGround()) { if (mode && mode.name !== 'fall') setMode(fallMode(react)); return; }
    react();
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
    stroke.flips = 0;
    // 在空中被摸頭：一樣先飄落再撒嬌
    if (!onGround()) { if (mode && mode.name !== 'fall') setMode(fallMode(() => setMode(patMode()))); return; }
    setMode(patMode());
  }
}

// 摸頭撒嬌：持續撫摸就一直害羞，停手一下就結束
function patMode() {
  let lastHeart = 0;
  // 摸頭49：閉眼合手 → 左右搖擺循環 → 停手後從當下那格播到站姿（rise）；沒有新片段才用舊的 16 格
  const seq = !!clipDef('patloop');
  let t0 = -1;
  return {
    name: 'pat',
    rise: seq ? 'patup' : undefined,
    enter() { say('pat', 2000); hearts(3); if (seq) { ensureClip('patdown'); ensureClip('patloop'); ensureClip('patup'); } else ensureClip('pat'); },
    update(dt, t) {
      let drawn = false;
      if (seq) {
        if (t0 < 0 && (ensureClip('patdown') || !waitingClip('patdown') || t > 1)) t0 = t;
        drawn = t0 < 0 || lieView('patdown', 'patloop', t - t0, 0);
      }
      if (!drawn && !playClip('pat', t, { fadeIn: 0.15 })) {
        view.sprite = 'pat';
        breathe(t, 0.01, 2.2);
        view.rot = Math.sin(t * 5) * 0.015;
      }
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
// 撫子回覆時可以叫、而且 Claude 工作中也會先演完的短動作（長的坐下、睡覺不算，免得卡住工作狀態）
const EMOTE_SHORT = new Set(['yawn', 'stretch', 'wave', 'cheer', 'curious', 'pose', 'happy', 'shy', 'pray', 'curtsy', 'pirouette', 'arabesque', 'nod', 'shake', 'mail', 'gift', 'birthday', 'lantern', 'sparkler']);
const FREE = new Set(['idle', 'walk', 'fly', 'yawn', 'stretch', 'wave', 'cheer', 'curious', 'pose', 'nap', 'sit', 'perch', 'shy', 'greet', 'pray', 'doze', 'standdoze', 'curtsy', 'pirouette', 'arabesque', 'nod', 'shake', 'mail', 'gift', 'birthday', 'lantern', 'sparkler']);

function chooseFree() {
  const s = S.settings;
  const idleFor = (performance.now() - Math.max(S.lastInteraction, S.lastClaudeActive)) / 1000;
  if (!s.random) return idleMode(Infinity);
  // 冷落太久就睡午覺，有人來（滑鼠、Claude）就醒
  if (idleFor > 5 * 60 && onGround()) return lieMode();
  // 坐著打盹（新動作）：冷落兩分鐘以上，有機會坐下打瞌睡，再久就會側躺睡午覺
  if (idleFor > 120 && onGround() && clipDef('doze') && Math.random() < 0.35) return dozeMode();
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
    pray: clipDef('prayloop') ? 3 : 0,
    ballet: clipDef('pirouette') || clipDef('arabesque') ? 4 : 0, // 芭蕾不用配樂，偶爾跳一小段
    perch: s.perch && onGround() ? 5 : 0,
  });
  if (k === 'ballet') {
    const b = ['pirouette', 'arabesque'].filter(clipDef);
    return onGround() ? poseMode(b[Math.floor(Math.random() * b.length)]) : fallMode();
  }
  if (k === 'pose') return onGround() ? posingMode() : fallMode();
  if (k === 'pray') return onGround() ? prayMode() : fallMode();
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

  const busy = mode && (INTERACTIONS.has(mode.name) || mode.emote);
  const waking = mode && (mode.name === 'wake' || mode.name === 'rise' || PERFORMING.has(mode.name) || mode.stay);
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
  updateSparks(dt);
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

  // 體力條移除（祐 2026-11-14）：用量看 Claude 對話框下面的用量圈圈，桌寵只用動作和「有點累了…」提醒
  const visible = !!text;
  bubbleEl.classList.toggle('hidden', !visible);
  if (!visible) return; // 淡出時保留舊字，不會閃出空白泡泡
  // 思考/工作時，句尾的「…」改成會動的點點
  const dots = text.endsWith('…') && (r.body === 'thinking' || r.body === 'working');
  if (dots) text = text.slice(0, -1);
  if (bubbleText.textContent !== text) bubbleText.textContent = text;
  bubbleText.classList.toggle('dots', dots);
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
  host.onVoice((v) => { // 語音工作室採用了新台詞或音檔
    if (nowPlaying) nowPlaying.pause();
    audioCache = {}; voiceVer++;
    S.voice = voiceCore.build(v.lines, v.files);
  });
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
  host.onAction((k) => runAction(k));
  // 撫子（Claude）回覆時叫的動作：tools/act.js 寫 act.json → 主程序轉過來。
  // 短動作在 Claude 工作中也會先演完再回去工作（mode.emote 讓狀態機先等一下）；say＝頭上要顯示的字
  host.onEmote((e) => {
    if (!e || !e.action) return;
    runAction(e.action, true);
    if (e.say) S.say = { text: String(e.say).slice(0, 40), until: performance.now() + 3200 };
  });
  function runAction(k, emote) {
    S.lastInteraction = performance.now();
    if (k === 'land') { refreshGeom(true).then(() => setMode(fallMode())); return; }
    // 'sing'／'violin'／'conduct'＝只做動作；'sing:檔名' 等＝配音樂
    const [pk, ...rest] = k.split(':');
    if (PERFORMING.has(pk)) {
      const make = () => performMode(pk, rest.join(':') || null);
      if (!onGround()) setMode(fallMode(() => setMode(make()))); else setMode(make());
      return;
    }
    const base = k === 'walk' ? walkMode : k === 'fly' ? flyMode : k === 'sit' ? sitMode : k === 'doze' ? dozeMode : k === 'standdoze' ? standDozeMode : k === 'pose' ? posingMode : k === 'pray' ? prayMode : k === 'nap' ? lieMode : k === 'wake' ? wakeMode : k === 'perch' ? () => perchMode({ manual: true, stay: !!emote })
      : k === 'perch_lie' ? () => perchMode({ manual: true, stay: !!emote, only: 'lie' }) : () => poseMode(k);
    const make = emote && EMOTE_SHORT.has(k) ? () => Object.assign(base(), { emote: true }) : base;
    if (k !== 'fly' && !onGround()) { setMode(fallMode(() => setMode(make()))); return; }
    setMode(make());
  }
  // 休眠喚醒後：清掉殘留的按住狀態，並重新宣告穿透狀態（跟主程序一致）
  host.onRecover(() => {
    drag.down = null; drag.active = false;
    S.ignoring = true; S.hover = false;
    buildBitmaps().catch(() => {}); // 休眠後顯示資源可能失效，重建一次
    if (mode && mode.name === 'drag') { refreshGeom(true).then(() => setMode(fallMode())); }
  });
  // 喚醒快捷鍵／托盤圖示：躺著就爬起來，否則提屈膝禮打招呼
  host.onSummon(() => {
    S.lastInteraction = performance.now();
    if (mode && mode.name === 'drag') return;
    setMode(mode && mode.lying ? wakeMode(mode.wakeFrom || mode.body) : (onGround() ? greetMode(periodOf(), greetClip()) : fallMode()));
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
  freeQueue = () => greetMode(periodOf(), greetClip());
  setInterval(() => {
    const p = periodOf();
    if (p !== lastPeriod) { lastPeriod = p; if (!freeQueue) freeQueue = () => greetMode(p); }
  }, 30000);
  requestAnimationFrame(loop);
}

// 給自動測試看的窗口
window.__pet = { S, view, headPoint, get mode() { return mode && mode.name; }, setMode, dragMode, idleMode, poseMode, walkMode, flyMode, fallMode, wakeMode, claudeState };

start();
