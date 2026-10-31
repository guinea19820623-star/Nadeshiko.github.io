'use strict';
const host = window.panelHost;
const $ = (id) => document.getElementById(id);

const TOGGLES = [
  ['random', '隨機動作'], ['walk', '在螢幕下緣走動'], ['fly', '偶爾飛起來'],
  ['voice', '語音'], ['perch', '坐到視窗邊緣'], ['bubble', '頭上小字'], ['staminaAlways', '體力條常駐'], ['alwaysOnTop', '保持在最上層'],
];
const FORCE = [
  [null, '自動（跟 Claude 連動）'], ['free', '精神飽滿（隨機）'], ['thinking', '思考中'], ['working', '工作中'],
  ['waiting', '等你確認'], ['done', '完成'], ['hello', '打招呼'], ['error', '出錯'],
  ['tired', '疲憊'], ['exhausted', '5h 用完（睡覺）'], ['faint', '暈倒（週上限）'],
];
const SIM = [
  ['開新工作階段', { hook_event_name: 'SessionStart', source: 'startup' }],
  ['送出提示（思考）', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }],
  ['呼叫工具 Bash（工作）', { hook_event_name: 'PreToolUse', tool_name: 'Bash' }],
  ['呼叫工具 Edit（工作）', { hook_event_name: 'PreToolUse', tool_name: 'Edit' }],
  ['要求權限（等你）', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }],
  ['回答結束（完成）', { hook_event_name: 'Stop' }],
  ['撞到用量上限', { hook_event_name: 'StopFailure', error: 'rate_limit' }],
  ['額度恢復自動續跑', { hook_event_name: 'Notification', notification_type: 'quota_auto_resume_fired' }],
  ['其他 API 錯誤', { hook_event_name: 'StopFailure', error: 'server_error' }],
  ['結束工作階段', { hook_event_name: 'SessionEnd', reason: 'other' }],
];
const ACTIONS = [
  ['walk', '走一走'], ['fly', '飛一圈'], ['yawn', '打哈欠'], ['stretch', '伸懶腰'],
  ['wave', '揮手'], ['curious', '東張西望'], ['cheer', '歡呼'], ['nap', '側睡'], ['sit', '坐下休息'], ['perch', '坐到視窗邊緣'], ['shy', '害羞'], ['wake', '睡醒爬起來'], ['land', '回到地面'],
];

const VLABEL = {
  yawn: '打哈欠', stretch: '伸懶腰', wave: '揮手', cheer: '歡呼', nap: '側睡', curious: '東張西望', pose: '擺姿勢', happy: '被點一下', pat: '摸頭',
  drag: '被拎起', dizzy: '摔暈', fly: '飛行', sit: '坐下休息', wake: '睡醒', hello: '打招呼', thinking: '思考中', working: '工作中',
  waiting: '等你確認', done: '完成', error: '出錯', tired: '疲憊', exhausted: '5h 用完（睡覺）', faint: '暈倒（週上限）', perch: '坐在視窗邊緣',
  shy: '害羞', greet_morning: '早安問候', greet_noon: '中午問候', greet_afternoon: '下午問候', greet_evening: '晚上問候', greet_night: '深夜問候',
  perch_lie: '趴在視窗上', drop: '飄落',
};
let voiceData = null;   // { lines, files, url, voice, max }
let studioAudio = null;

let settings = {};
let forced = null;

function bindRange(id, key, fmt) {
  const el = $(id);
  const out = $(`${id}-out`);
  el.value = settings[key];
  out.textContent = fmt(settings[key]);
  el.oninput = () => { out.textContent = fmt(Number(el.value)); };
  el.onchange = () => host.set(key, Number(el.value));
}

function render() {
  $('size').value = settings.size;
  $('size-out').textContent = `${settings.size}px`;
  $('volume').value = settings.volume;
  $('volume-out').textContent = `${settings.volume}%`;
  $('bubbleScale').value = settings.bubbleScale;
  $('bubbleScale-out').textContent = `${settings.bubbleScale}%`;
  $('walkStyle').value = settings.walkStyle || 'video';
  for (const k of ['tiredAt', 'faintAt', 'napAt']) {
    $(k).value = settings[k];
    $(`${k}-out`).textContent = `${settings[k]}%`;
  }
  for (const b of document.querySelectorAll('#toggles input')) b.checked = !!settings[b.dataset.key];
  for (const b of document.querySelectorAll('#force button')) b.classList.toggle('on', (b.dataset.key || null) === (forced || null));
}

async function main() {
  $('close').onclick = () => window.close();
  const init = await host.init();
  settings = init.settings;
  forced = init.forced;
  $('size').min = init.sizeMin;
  $('size').max = init.sizeMax;
  bindRange('size', 'size', (v) => `${v}px`);
  $('size').oninput = () => { $('size-out').textContent = `${$('size').value}px`; host.set('size', Number($('size').value)); };
  bindRange('volume', 'volume', (v) => `${v}%`);
  $('walkStyle').onchange = () => host.set('walkStyle', $('walkStyle').value);
  bindRange('bubbleScale', 'bubbleScale', (v) => `${v}%`);
  bindRange('tiredAt', 'tiredAt', (v) => `${v}%`);
  bindRange('faintAt', 'faintAt', (v) => `${v}%`);
  bindRange('napAt', 'napAt', (v) => `${v}%`);
  $('dir').textContent = `狀態資料夾：${init.stateDir}`;

  for (const [key, label] of TOGGLES) {
    const l = document.createElement('label');
    l.className = 'check';
    l.innerHTML = `<input type="checkbox" data-key="${key}"> ${label}`;
    l.querySelector('input').onchange = (e) => host.set(key, e.target.checked);
    $('toggles').appendChild(l);
  }
  for (const [key, label] of FORCE) {
    const b = document.createElement('button');
    b.textContent = label;
    if (key) b.dataset.key = key;
    b.onclick = () => host.force(key);
    $('force').appendChild(b);
  }
  for (const [label, input] of SIM) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { host.force(null); host.simHook(input); };
    $('sim').appendChild(b);
  }
  for (const [key, label] of ACTIONS) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => host.action(key);
    $('actions').appendChild(b);
  }
  for (const id of ['u5', 'u7']) $(id).oninput = () => { $(`${id}-out`).textContent = `${$(id).value}%`; };
  $('send-usage').onclick = () => { host.force(null); host.simUsage(Number($('u5').value), Number($('u7').value)); };
  $('clear').onclick = () => host.simClear();

  host.onSettings((s) => { settings = s; render(); });
  host.onForce((k) => { forced = k; render(); });
  host.onSnapshot(showSnap);
  showSnap(init.snapshot);
  render();
  initVoice();
}

// ---------- 語音工作室 ----------
function playBytes(bytes, mime) {
  if (studioAudio) { studioAudio.pause(); URL.revokeObjectURL(studioAudio.src); }
  const a = new Audio(URL.createObjectURL(new Blob([bytes], { type: mime })));
  a.volume = Math.max(0, Math.min(1, (settings.volume || 60) / 100));
  studioAudio = a;
  a.play().catch(() => {});
}

function vmsg(box, text, err) { const m = box.querySelector('.vmsg'); m.textContent = text || ''; m.classList.toggle('err', !!err); }

function renderVoice() {
  const key = $('v-key').value;
  const arr = (voiceData.lines[key] || []).slice();
  const box = $('v-lines');
  box.textContent = '';
  const have = (i) => voiceData.files.some((f) => new RegExp(`^${key}_${i + 1}\\.(mp3|ogg|wav)$`).test(f));
  const slots = arr.map((l, i) => ({ l, i, isNew: false }));
  if (arr.length < voiceData.max) slots.push({ l: { text: '' }, i: arr.length, isNew: true });
  for (const { l, i, isNew } of slots) {
    const d = document.createElement('div');
    d.className = 'vline';
    d.innerHTML = `<h3>${isNew ? '＋ 新增一句' : `第 ${i + 1} 句`}${!isNew && !have(i) ? '（還沒有音檔）' : ''}</h3>
      <div class="f"><span>顯示</span><input type="text" class="t-text" placeholder="頭上顯示的字"></div>
      <div class="f"><span>唸</span><input type="text" class="t-say" placeholder="實際唸的字（空白＝跟顯示一樣）"></div>
      <div class="f"><span>句尾</span><span>補 <input type="number" class="t-pad" min="0" max="5" step="1"> 個「……」，再接 <input type="number" class="t-tail" min="0" max="1500" step="50"> 毫秒靜音</span></div>
      <div class="f"><span>次數</span><span>連生 <input type="number" class="t-n" min="1" max="5" step="1" value="1"> 次，挑一個最好的</span></div>
      <div class="btns"><button class="b-play">▶ 試聽現有</button><button class="b-gen primary">生成</button></div>
      <div class="takes"></div><p class="vmsg"></p>`;
    d.querySelector('.t-text').value = l.text || '';
    d.querySelector('.t-say').value = l.say || '';
    d.querySelector('.t-pad').value = l.pad == null ? 1 : l.pad;
    d.querySelector('.t-tail').value = l.tail || 0;
    const play = d.querySelector('.b-play');
    if (isNew || !have(i)) play.disabled = true;
    play.onclick = async () => {
      const r = await host.voiceRead(key, i);
      if (r) playBytes(r.bytes, r.mime); else vmsg(d, '這句還沒有音檔', true);
    };
    const entry = () => ({
      text: d.querySelector('.t-text').value, say: d.querySelector('.t-say').value,
      pad: Number(d.querySelector('.t-pad').value), tail: Number(d.querySelector('.t-tail').value),
    });
    const adoptBtn = (label, takeId) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = async () => {
        const r = await host.voiceAdopt({ key, i, entry: entry(), takeId });
        if (r.error) { vmsg(d, r.error, true); return; }
        voiceData = { ...voiceData, lines: r.lines, files: r.files };
        renderVoice();
        const nb = $('v-lines').querySelectorAll('.vline')[i];
        if (nb) vmsg(nb, takeId ? '已採用，撫子下次開口就是新的聲音' : '已存台詞（音檔沒變）');
      };
      return b;
    };
    if (!isNew) d.querySelector('.btns').appendChild(adoptBtn('只存文字（不換音檔）', null));
    d.querySelector('.b-gen').onclick = async (ev) => {
      const e = entry();
      if (!e.text.trim() && !e.say.trim()) { vmsg(d, '請先填要唸的字', true); return; }
      const btn = ev.currentTarget;
      const n = Math.max(1, Math.min(5, Number(d.querySelector('.t-n').value) || 1));
      btn.disabled = true;
      vmsg(d, `生成中…（${n} 次，一次只能做一個）`);
      d.querySelector('.takes').textContent = '';
      const r = await host.voiceGen({ ...e, takes: n });
      btn.disabled = false;
      if (r.error) { vmsg(d, r.error, true); return; }
      vmsg(d, `唸的是：${r.text}`);
      r.takes.forEach((t, k) => {
        const row = document.createElement('div');
        row.className = 'take';
        const p = document.createElement('button');
        p.textContent = `▶ 版本 ${k + 1}`;
        p.onclick = () => playBytes(t.bytes, 'audio/wav');
        const ms = document.createElement('span');
        ms.className = 'ms';
        ms.textContent = t.ms == null ? '' : `${(t.ms / 1000).toFixed(2)} 秒`;
        row.append(p, ms, adoptBtn('採用這個', t.id));
        d.querySelector('.takes').appendChild(row);
      });
      if (r.takes[0]) playBytes(r.takes[0].bytes, 'audio/wav');
    };
    box.appendChild(d);
  }
}

async function initVoice() {
  voiceData = await host.voiceList();
  const sel = $('v-key');
  for (const k of Object.keys(voiceData.lines)) {
    if (k.startsWith('_')) continue;
    const o = document.createElement('option');
    o.value = k;
    o.textContent = VLABEL[k] ? `${VLABEL[k]}（${k}）` : k;
    sel.appendChild(o);
  }
  sel.onchange = renderVoice;
  $('v-url').value = voiceData.url || '';
  $('v-name').value = voiceData.voice || '';
  $('v-url').onchange = () => host.set('voiceUrl', $('v-url').value.trim());
  $('v-name').onchange = () => host.set('voiceName', $('v-name').value.trim());
  renderVoice();
}

function showSnap(snap) {
  $('snap').textContent = JSON.stringify(snap, null, 1);
}

main();
