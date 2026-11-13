#!/usr/bin/env node
'use strict';
// 手動（或由撫子）告訴桌寵目前的用量（祐 2026-11-13）。
// 為什麼需要：用量原本靠 Claude Code 的狀態列腳本（hooks/pet-statusline.js）寫進 usage.json，
// 但 Claude 桌面版的 Code 分頁不會執行狀態列，所以桌面版用量永遠傳不到桌寵，85% 也不會累。
//   node tools/usage.js <5小時%> <每週%> [5小時重置時間 ISO] [每週重置時間 ISO]
//   例：node tools/usage.js 88 36 2026-11-13T15:40:00Z 2026-11-16T12:00:00Z
// 重置時間過了，這筆用量就自動失效（不會一直累下去）。
const bridge = require('../app/lib/bridge');
const [five, week, fr, wr] = process.argv.slice(2);
const sec = (s) => (s ? Math.round(Date.parse(s) / 1000) : null);
const win = (p, r) => (p != null && p !== '-' && !Number.isNaN(Number(p)) ? { used_percentage: Number(p), resets_at: sec(r) } : undefined);
if (five == null) { console.log('用法：node tools/usage.js <5小時%> <每週%> [5小時重置 ISO] [每週重置 ISO]'); process.exit(1); }
const u = bridge.applyStatusline({ rate_limits: { five_hour: win(five, fr), seven_day: win(week, wr) } });
console.log(u ? `已更新：5 小時 ${five}%、每週 ${week ?? '-'}%` : '沒有寫入（數字不對？）');
