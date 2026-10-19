'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nadeshiko-test-'));
process.env.NADESHIKO_PET_DIR = path.join(tmp, 'state');
const bridge = require('../app/lib/bridge');
const ROOT = path.resolve(__dirname, '..');
const env = { ...process.env, NADESHIKO_PET_DIR: process.env.NADESHIKO_PET_DIR };

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('hook 事件對應', () => {
  const m = (input) => bridge.mapHookEvent(input);
  assert.strictEqual(m({ hook_event_name: 'UserPromptSubmit' }).activity, 'thinking');
  assert.deepStrictEqual(m({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), { activity: 'working', tool: 'Bash' });
  assert.strictEqual(m({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).activity, 'waiting');
  assert.strictEqual(m({ hook_event_name: 'Notification', notification_type: 'auth_success' }), null);
  assert.strictEqual(m({ hook_event_name: 'Stop' }).activity, 'done');
  assert.strictEqual(m({ hook_event_name: 'StopFailure', error: 'rate_limit' }).limit, true);
  assert.strictEqual(m({ hook_event_name: 'StopFailure', error: 'server_error' }).activity, 'error');
  assert.strictEqual(m({ hook_event_name: 'SessionEnd' }).clearSession, true);
  assert.strictEqual(m({ hook_event_name: 'CwdChanged' }), null);
});

test('hook 腳本：從 stdin 讀 JSON 寫狀態檔，結束時刪掉', () => {
  const run = (input) => execFileSync('node', [path.join(ROOT, 'hooks', 'pet-hook.js')], { input: JSON.stringify(input), env });
  run({ session_id: 'abc-123', hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/x' });
  let snap = bridge.readSnapshot();
  assert.strictEqual(snap.sessions.length, 1);
  assert.strictEqual(snap.sessions[0].activity, 'working');
  assert.strictEqual(snap.sessions[0].tool, 'Read');
  run({ session_id: 'abc-123', hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.strictEqual(bridge.readSnapshot().limit.hit, true);
  run({ session_id: 'abc-123', hook_event_name: 'Stop' });
  snap = bridge.readSnapshot();
  assert.strictEqual(snap.limit, null);
  assert.strictEqual(snap.sessions[0].activity, 'done');
  run({ session_id: 'abc-123', hook_event_name: 'SessionEnd', reason: 'other' });
  assert.strictEqual(bridge.readSnapshot().sessions.length, 0);
  // 壞掉的輸入也不會失敗（exit 0）
  execFileSync('node', [path.join(ROOT, 'hooks', 'pet-hook.js')], { input: 'not json', env });
});

test('狀態列腳本：寫入 usage.json 並印出一行字', () => {
  const now = Math.floor(Date.now() / 1000);
  const input = {
    model: { display_name: 'Opus' },
    context_window: { used_percentage: 12.3 },
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: now + 3600 }, seven_day: { used_percentage: 41.2, resets_at: now + 86400 * 2 } },
  };
  const out = execFileSync('node', [path.join(ROOT, 'hooks', 'pet-statusline.js')], { input: JSON.stringify(input), env }).toString();
  assert.match(out, /撫子 │ Opus │ ctx 12% │ 5h 24%/);
  const u = bridge.readSnapshot().usage;
  assert.strictEqual(u.five_hour.used_percentage, 23.5);
  assert.strictEqual(u.seven_day.used_percentage, 41.2);
  // 只有一個視窗時保留另一個
  execFileSync('node', [path.join(ROOT, 'hooks', 'pet-statusline.js')], {
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 50, resets_at: now + 10 } } }), env,
  });
  const u2 = bridge.readSnapshot().usage;
  assert.strictEqual(u2.five_hour.used_percentage, 50);
  assert.strictEqual(u2.seven_day.used_percentage, 41.2);
  // 沒有 rate_limits（API 帳號或第一次回應前）不會覆蓋
  execFileSync('node', [path.join(ROOT, 'hooks', 'pet-statusline.js')], { input: '{}', env });
  assert.strictEqual(bridge.readSnapshot().usage.five_hour.used_percentage, 50);
});

test('安裝腳本：保留原本設定、可移除、保留原狀態列', () => {
  const settingsPath = path.join(tmp, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const original = {
    model: 'opus',
    statusLine: { type: 'command', command: '~/.claude/my-status.sh', padding: 1 },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(original));
  const e2 = { ...env, CLAUDE_SETTINGS_PATH: settingsPath };
  const inst = (...a) => execFileSync('node', [path.join(ROOT, 'tools', 'install-claude.js'), ...a], { env: e2 }).toString();

  inst();
  let s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.Stop.length, 2, '原本的 Stop hook 還在');
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /^node ".*\/hooks\/pet-hook\.js"$/);
  assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].async, true);
  assert.match(s.statusLine.command, /pet-statusline\.js/);
  assert.strictEqual(bridge.readJSON(path.join(process.env.NADESHIKO_PET_DIR, 'statusline-chain.json')).command, '~/.claude/my-status.sh');

  inst(); // 重複安裝不會重複加
  s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(s.hooks.PreToolUse.length, 1);
  assert.strictEqual(s.hooks.Stop.length, 2);

  inst('--uninstall');
  s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepStrictEqual(s, original);
  assert.ok(fs.readdirSync(path.dirname(settingsPath)).some((f) => f.startsWith('settings.json.bak-')));
});
