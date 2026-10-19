#!/usr/bin/env node
'use strict';
// Claude Code hook：把事件寫成撫子看得懂的狀態檔。
// 設定在 ~/.claude/settings.json（用 tools/install-claude.js 自動加）。
// 一律 exit 0、不輸出任何東西，所以絕不會擋到 Claude。
const bridge = require('../app/lib/bridge');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    bridge.applyHookEvent(input);
  } catch (e) {
    if (process.env.NADESHIKO_PET_DEBUG) console.error('[nadeshiko-pet]', e);
  }
  process.exit(0);
});
// 保險：stdin 沒關也在 3 秒後離開
setTimeout(() => process.exit(0), 3000).unref();
