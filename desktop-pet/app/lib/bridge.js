'use strict';
// Claude ⇄ 桌寵 的橋：hooks、狀態列腳本、模擬器都透過這裡讀寫狀態檔。
// 純 Node，不依賴 Electron，所以 hooks 可以直接 require。
//
// 狀態資料夾（預設 ~/.nadeshiko-pet，可用環境變數 NADESHIKO_PET_DIR 改）：
//   sessions/<session_id>.json  每個 Claude Code 工作階段目前在做什麼
//   usage.json                  狀態列收到的 5 小時 / 7 天用量
//   limit.json                  StopFailure(rate_limit) 時寫入：撞到上限了

const fs = require('fs');
const os = require('os');
const path = require('path');

function stateDir() {
  return process.env.NADESHIKO_PET_DIR || path.join(os.homedir(), '.nadeshiko-pet');
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 先寫暫存檔再改名，桌寵不會讀到寫一半的 JSON
function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows 上目標檔正被讀取時偶爾會 EPERM，退而直接覆寫
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeId(id) {
  return String(id || 'default').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

// Claude Code hook 事件 → 桌寵活動狀態
// 回傳 { activity, tool?, clearSession?, limit?, clearLimit? }
function mapHookEvent(input) {
  const ev = input.hook_event_name;
  switch (ev) {
    case 'SessionStart':
      return { activity: 'hello' };
    case 'UserPromptSubmit':
      return { activity: 'thinking' };
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'SubagentStart':
    case 'PreCompact':
      return { activity: 'working', tool: input.tool_name || (ev === 'PreCompact' ? '整理記憶' : input.agent_type) };
    case 'PermissionRequest':
      return { activity: 'waiting', tool: input.tool_name };
    case 'Notification': {
      const t = input.notification_type;
      if (t === 'permission_prompt' || t === 'elicitation_dialog' || t === 'elicitation_url_dialog' || t === 'agent_needs_input') {
        return { activity: 'waiting' };
      }
      if (t === 'quota_auto_resume_fired') return { activity: 'thinking', clearLimit: true };
      if (t === 'idle_prompt') return { activity: 'idle' };
      return null;
    }
    case 'Stop':
      return { activity: 'done', clearLimit: true };
    case 'StopFailure':
      if (input.error === 'rate_limit') return { activity: 'idle', limit: true };
      return { activity: 'error' };
    case 'SessionEnd':
      return { clearSession: true };
    default:
      return null;
  }
}

function applyHookEvent(input, now = Date.now()) {
  const dir = stateDir();
  const m = mapHookEvent(input);
  if (!m) return null;
  const file = path.join(dir, 'sessions', `${safeId(input.session_id)}.json`);
  if (m.clearSession) {
    try { fs.unlinkSync(file); } catch (_) {}
  } else {
    writeJSON(file, {
      activity: m.activity,
      tool: m.tool || null,
      event: input.hook_event_name,
      cwd: input.cwd || null,
      ts: now,
    });
  }
  if (m.limit) {
    writeJSON(path.join(dir, 'limit.json'), { hit: true, error: input.error, ts: now });
  }
  if (m.clearLimit) {
    try { fs.unlinkSync(path.join(dir, 'limit.json')); } catch (_) {}
  }
  return m;
}

// 狀態列 JSON → usage.json。rate_limits 只有 Pro/Max 訂閱、且第一次回應後才有。
function applyStatusline(input, now = Date.now()) {
  const rl = input && input.rate_limits;
  if (!rl) return null;
  const pick = (w) => (w && typeof w.used_percentage === 'number'
    ? { used_percentage: w.used_percentage, resets_at: w.resets_at || null } : null);
  const usage = {
    five_hour: pick(rl.five_hour),
    seven_day: pick(rl.seven_day),
    updated_at: now,
    source: 'statusline',
  };
  if (!usage.five_hour && !usage.seven_day) return null;
  // 只有一個視窗時，保留另一個舊值（文件說兩個視窗可能各自缺席）
  const old = readJSON(path.join(stateDir(), 'usage.json'));
  if (old) {
    if (!usage.five_hour && old.five_hour) usage.five_hour = old.five_hour;
    if (!usage.seven_day && old.seven_day) usage.seven_day = old.seven_day;
  }
  writeJSON(path.join(stateDir(), 'usage.json'), usage);
  return usage;
}

// 讀出目前整體快照（桌寵主程式輪詢用）
function readSnapshot() {
  const dir = stateDir();
  const sessions = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'sessions'))) {
      if (!f.endsWith('.json')) continue;
      const s = readJSON(path.join(dir, 'sessions', f));
      if (s) sessions.push({ id: f.slice(0, -5), ...s });
    }
  } catch (_) {}
  return {
    sessions,
    usage: readJSON(path.join(dir, 'usage.json')),
    limit: readJSON(path.join(dir, 'limit.json')),
  };
}

// 清掉超過一天沒動靜的工作階段檔（Claude 當掉沒送 SessionEnd 時）
function pruneSessions(maxAgeMs = 24 * 3600 * 1000, now = Date.now()) {
  const d = path.join(stateDir(), 'sessions');
  try {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const s = readJSON(p);
      if (!s || now - (s.ts || 0) > maxAgeMs) fs.unlinkSync(p);
    }
  } catch (_) {}
}

module.exports = {
  stateDir, writeJSON, readJSON, mapHookEvent, applyHookEvent, applyStatusline,
  readSnapshot, pruneSessions, safeId,
};
