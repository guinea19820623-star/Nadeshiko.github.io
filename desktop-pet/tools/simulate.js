#!/usr/bin/env node
'use strict';
// 命令列模擬器：不用開 Claude，也能讓桌寵切換狀態（走跟真正 hooks 一樣的寫檔路徑）。
//
//   node tools/simulate.js hello | think | work [工具名] | wait | done | error
//   node tools/simulate.js usage <5h%> <7d%>     例：usage 90 40 → 疲憊
//   node tools/simulate.js limit                 撞到用量上限
//   node tools/simulate.js resume                額度恢復
//   node tools/simulate.js end                   結束工作階段
//   node tools/simulate.js clear                 清掉所有模擬資料
//   node tools/simulate.js demo                  自動跑一輪全部狀態（約 1 分鐘）
const fs = require('fs');
const path = require('path');
const bridge = require('../app/lib/bridge');

const SID = 'simulator';
const hook = (input) => bridge.applyHookEvent({ session_id: SID, cwd: 'simulator', ...input });
const usage = (five, week) => {
  const now = Math.floor(Date.now() / 1000);
  bridge.applyStatusline({
    rate_limits: {
      five_hour: { used_percentage: Number(five), resets_at: now + 2 * 3600 },
      seven_day: { used_percentage: Number(week), resets_at: now + 3 * 86400 },
    },
  });
};
const clear = () => {
  const d = bridge.stateDir();
  for (const f of ['usage.json', 'limit.json', path.join('sessions', `${SID}.json`)]) {
    try { fs.unlinkSync(path.join(d, f)); } catch (_) {}
  }
};

const COMMANDS = {
  hello: () => hook({ hook_event_name: 'SessionStart', source: 'startup' }),
  think: () => hook({ hook_event_name: 'UserPromptSubmit', prompt: '模擬' }),
  work: (tool = 'Bash') => hook({ hook_event_name: 'PreToolUse', tool_name: tool }),
  wait: () => hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '模擬' }),
  done: () => hook({ hook_event_name: 'Stop' }),
  error: () => hook({ hook_event_name: 'StopFailure', error: 'server_error' }),
  limit: () => hook({ hook_event_name: 'StopFailure', error: 'rate_limit' }),
  resume: () => hook({ hook_event_name: 'Notification', notification_type: 'quota_auto_resume_fired' }),
  end: () => hook({ hook_event_name: 'SessionEnd', reason: 'other' }),
  usage,
  clear,
  demo: async () => {
    const steps = [
      ['打招呼', () => COMMANDS.hello()], ['思考', () => COMMANDS.think()], ['工作中 Bash', () => COMMANDS.work('Bash')],
      ['工作中 Edit', () => COMMANDS.work('Edit')], ['等你確認', () => COMMANDS.wait()], ['完成', () => COMMANDS.done()],
      ['用量 88%：疲憊', () => usage(88, 40)], ['疲憊中工作', () => COMMANDS.work('Read')],
      ['5h 用完：睡覺', () => usage(100, 60)], ['週上限：暈倒', () => usage(70, 100)],
      ['恢復', () => { clear(); }],
    ];
    for (const [label, fn] of steps) {
      console.log(`→ ${label}`);
      fn();
      await new Promise((r) => setTimeout(r, 5000));
    }
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !COMMANDS[cmd]) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 13).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(COMMANDS[cmd](...rest)).then(() => {
  if (cmd !== 'demo') console.log(`已送出：${cmd} ${rest.join(' ')}（狀態資料夾：${bridge.stateDir()}）`);
});
