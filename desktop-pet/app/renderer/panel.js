'use strict';
const host = window.panelHost;
const $ = (id) => document.getElementById(id);

const TOGGLES = [
  ['random', '隨機動作'], ['walk', '在螢幕下緣走動'], ['fly', '偶爾飛起來'],
  ['bubble', '頭上小字'], ['staminaAlways', '體力條常駐'], ['alwaysOnTop', '保持在最上層'],
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
  ['wave', '揮手'], ['curious', '東張西望'], ['cheer', '歡呼'], ['nap', '睡午覺'], ['land', '回到地面'],
];

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
  for (const k of ['tiredAt', 'faintAt', 'napAt']) {
    $(k).value = settings[k];
    $(`${k}-out`).textContent = `${settings[k]}%`;
  }
  for (const b of document.querySelectorAll('#toggles input')) b.checked = !!settings[b.dataset.key];
  for (const b of document.querySelectorAll('#force button')) b.classList.toggle('on', (b.dataset.key || null) === (forced || null));
}

async function main() {
  const init = await host.init();
  settings = init.settings;
  forced = init.forced;
  $('size').min = init.sizeMin;
  $('size').max = init.sizeMax;
  bindRange('size', 'size', (v) => `${v}px`);
  $('size').oninput = () => { $('size-out').textContent = `${$('size').value}px`; host.set('size', Number($('size').value)); };
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
}

function showSnap(snap) {
  $('snap').textContent = JSON.stringify(snap, null, 1);
}

main();
