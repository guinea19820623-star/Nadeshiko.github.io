#!/usr/bin/env node
'use strict';
// 讓撫子（Claude）在回覆時叫桌寵做動作，例如：
//   node tools/act.js wave "嗨～"
//   node tools/act.js curtsy
//   node tools/act.js violin --song 第三樂章     （唱歌 sing／小提琴 violin／指揮 conduct：曲名含這幾個字的第一首）
// 能用的動作：yawn stretch wave cheer curious pose happy shy pray curtsy pirouette arabesque
//   （這些在 Claude 工作中也會先演完）；walk fly sit doze nap wake perch 也收，但 Claude 一忙就會被工作狀態蓋過
// 桌寵沒開的話什麼都不會發生；10 秒內沒被讀走的要求會作廢。
const bridge = require('../app/lib/bridge');
const args = process.argv.slice(2);
let song = '';
const si = args.indexOf('--song');
if (si >= 0) { song = args.slice(si + 1).join(' '); args.splice(si); }
const [action, ...rest] = args;
if (!action) {
  console.log('用法：node tools/act.js <動作> [頭上要顯示的字] [--song 曲名]');
  process.exit(1);
}
try {
  const d = bridge.requestAction(action, rest.join(' '), Date.now(), song);
  console.log(`已送出：${d.action}${d.say ? `「${d.say}」` : ''}${d.song ? ` ♪${d.song}` : ''}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
