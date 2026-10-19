#!/usr/bin/env node
'use strict';
// Claude Code 狀態列腳本：
// 1. 把 rate_limits（5 小時 / 7 天用量）寫進 ~/.nadeshiko-pet/usage.json 給撫子看
// 2. 印出狀態列文字。如果安裝前你已經有自己的狀態列，會改成執行原本那個（保留你的樣子）。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const bridge = require('../app/lib/bridge');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (_) {}
  try { bridge.applyStatusline(input); } catch (_) {}

  const chain = bridge.readJSON(path.join(bridge.stateDir(), 'statusline-chain.json'));
  if (chain && chain.command) {
    try {
      const out = execSync(chain.command, { input: raw, encoding: 'utf8', timeout: 4000, stdio: ['pipe', 'pipe', 'ignore'], shell: chainShell() });
      process.stdout.write(out);
      return;
    } catch (_) { /* 原本的狀態列壞了就用撫子的 */ }
  }
  process.stdout.write(defaultLine(input));
});

// Claude Code 在 Windows 上用 Git Bash 跑狀態列，原本的指令也盡量用 Git Bash 跑
function chainShell() {
  if (process.platform !== 'win32') return '/bin/sh';
  const cands = [
    process.env.CLAUDE_CODE_GIT_BASH_PATH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return undefined; // 交給 Node 預設（cmd.exe）
}

function defaultLine(input) {
  const parts = ['撫子'];
  if (input.model && input.model.display_name) parts.push(input.model.display_name);
  const ctx = input.context_window && input.context_window.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = input.rate_limits || {};
  const nowSec = Date.now() / 1000;
  const fmt = (label, w) => {
    if (!w || typeof w.used_percentage !== 'number') return null;
    let s = `${label} ${Math.round(w.used_percentage)}%`;
    if (w.resets_at && w.resets_at > nowSec) {
      const mins = Math.round((w.resets_at - nowSec) / 60);
      s += mins >= 1440 ? `（${Math.floor(mins / 1440)}天後重置）` : mins >= 60 ? `（${Math.floor(mins / 60)}h${mins % 60}m）` : `（${mins}m）`;
    }
    return s;
  };
  const a = fmt('5h', rl.five_hour);
  const b = fmt('週', rl.seven_day);
  if (a) parts.push(a);
  if (b) parts.push(b);
  return parts.join(' │ ');
}
