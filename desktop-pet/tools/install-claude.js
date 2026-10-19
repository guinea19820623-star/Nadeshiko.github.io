#!/usr/bin/env node
'use strict';
// 把撫子的 hooks 和狀態列加進 Claude Code 的使用者設定 ~/.claude/settings.json。
//
//   node tools/install-claude.js            安裝（會先備份 settings.json）
//   node tools/install-claude.js --dry-run  只印出會變成什麼樣子，不寫檔
//   node tools/install-claude.js --uninstall 移除撫子加的東西，並還原原本的狀態列
//   node tools/install-claude.js --no-statusline  只裝 hooks，不動狀態列
//
// Claude Desktop 的 Code 分頁和終端機版共用這份設定，所以兩邊都會連動。
const fs = require('fs');
const os = require('os');
const path = require('path');
const bridge = require('../app/lib/bridge');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const UNINSTALL = args.has('--uninstall');
const NO_STATUSLINE = args.has('--no-statusline');

const MARK = 'pet-hook.js';
const SL_MARK = 'pet-statusline.js';
const settingsPath = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
const root = path.resolve(__dirname, '..');
// Windows 上 Claude Code 用 Git Bash 跑指令，反斜線會被吃掉，所以一律用正斜線
const fwd = (p) => p.replace(/\\/g, '/');
const hookCmd = `node "${fwd(path.join(root, 'hooks', 'pet-hook.js'))}"`;
const slCmd = `node "${fwd(path.join(root, 'hooks', 'pet-statusline.js'))}"`;

// 要監聽的事件。async: true → 在背景跑，完全不拖慢 Claude。
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'SubagentStart', 'PreCompact', 'Stop', 'StopFailure', 'SessionEnd',
];

function load() {
  if (!fs.existsSync(settingsPath)) return {};
  const text = fs.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`讀不懂 ${settingsPath}（JSON 格式有誤），為了安全先不動它：${e.message}`);
    process.exit(1);
  }
}

function stripOurs(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !(h.command || '').includes(MARK)) }))
      .filter((g) => g.hooks.length > 0);
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
}

function main() {
  const settings = load();
  const before = JSON.stringify(settings, null, 2);
  const chainFile = path.join(bridge.stateDir(), 'statusline-chain.json');

  stripOurs(settings);

  if (UNINSTALL) {
    if (settings.statusLine && (settings.statusLine.command || '').includes(SL_MARK)) {
      const chain = bridge.readJSON(chainFile);
      if (chain && chain.original) settings.statusLine = chain.original;
      else delete settings.statusLine;
      if (!DRY) { try { fs.unlinkSync(chainFile); } catch (_) {} }
    }
  } else {
    settings.hooks = settings.hooks || {};
    for (const ev of EVENTS) {
      settings.hooks[ev] = settings.hooks[ev] || [];
      settings.hooks[ev].push({ hooks: [{ type: 'command', command: hookCmd, async: true, timeout: 10 }] });
    }
    if (!NO_STATUSLINE) {
      const cur = settings.statusLine;
      if (cur && cur.command && !cur.command.includes(SL_MARK)) {
        // 你原本就有狀態列：記下來，撫子的腳本會照樣執行它，畫面不變
        console.log(`偵測到原本的狀態列：${cur.command}\n→ 會保留它的顯示，撫子只在背後讀用量。`);
        if (!DRY) bridge.writeJSON(chainFile, { command: cur.command, original: cur });
      }
      settings.statusLine = { type: 'command', command: slCmd, padding: (cur && cur.padding) || 0 };
    }
  }

  const after = JSON.stringify(settings, null, 2);
  if (before === after) {
    console.log('設定沒有變化。');
    return;
  }
  if (DRY) {
    console.log(`--dry-run：${settingsPath} 會變成：\n${after}`);
    return;
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  if (fs.existsSync(settingsPath)) {
    const bak = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(settingsPath, bak);
    console.log(`已備份原設定：${bak}`);
  }
  fs.writeFileSync(settingsPath, `${after}\n`);
  console.log(UNINSTALL ? '已移除撫子的 hooks 與狀態列。' : `已安裝！hooks 指令：${hookCmd}`);
  if (!UNINSTALL) console.log('重新開啟 Claude Code（或在裡面打 /hooks 檢查）就會生效。');
}

main();
