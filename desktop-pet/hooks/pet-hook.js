#!/usr/bin/env node
'use strict';
// Claude Code hook：把事件寫成撫子看得懂的狀態檔。
// 設定在 ~/.claude/settings.json（用 tools/install-claude.js 自動加）。
// 一律 exit 0、不輸出任何東西，所以絕不會擋到 Claude。
const path = require('path');
const bridge = require('../app/lib/bridge');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const m = bridge.applyHookEvent(input);
    // 撞到額度：對話紀錄那筆「額度用完」可能還沒寫完，晚 1.5 秒再讀一次，補上是哪個額度、幾點恢復
    if (m && m.limit) {
      const file = path.join(bridge.stateDir(), 'limit.json');
      const cur = bridge.readJSON(file);
      if (cur && !cur.kind) {
        setTimeout(() => {
          const q = bridge.readQuota(input.transcript_path);
          const now = bridge.readJSON(file);
          if (q && now && now.ts === cur.ts) bridge.writeJSON(file, Object.assign(now, q));
          process.exit(0);
        }, 1500);
        return;
      }
    }
  } catch (e) {
    if (process.env.NADESHIKO_PET_DEBUG) console.error('[nadeshiko-pet]', e);
  }
  process.exit(0);
});
// 保險：stdin 沒關也在 3 秒後離開
setTimeout(() => process.exit(0), 3000).unref();
