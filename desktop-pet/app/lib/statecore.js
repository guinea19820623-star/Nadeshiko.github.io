// 狀態機核心：把「Claude 工作階段 + 用量 + 上限」算成桌寵現在該是什麼樣子。
// 純函式，瀏覽器與 Node 都能用（測試在 test/statecore.test.js）。
(function (root) {
  'use strict';

  const DEFAULTS = {
    tiredAt: 85,        // 5 小時或 7 天任一用量 ≥ 這個值 → 疲憊
    faintAt: 100,       // 7 天用量 ≥ 這個值 → 暈倒
    napAt: 100,         // 5 小時用量 ≥ 這個值 → 睡覺（等 5 小時額度恢復）
    staleWorkMs: 10 * 60 * 1000,   // 思考/工作超過這麼久沒新事件，視為中斷
    doneShowMs: 6000,              // 「完成」顯示多久
    helloShowMs: 4000,
    errorShowMs: 5000,
    waitingMaxMs: 30 * 60 * 1000,
    limitFallbackMs: 60 * 60 * 1000, // 撞上限但不知道何時恢復時，先算一小時
  };

  // 活動優先序：越前面越重要（多個 Claude Code 視窗同時開時取最高）
  const ACTIVITY_ORDER = ['working', 'thinking', 'waiting', 'done', 'error', 'hello', 'idle'];

  function freshActivity(s, now, o) {
    const age = now - (s.ts || 0);
    switch (s.activity) {
      case 'working':
      case 'thinking':
        return age < o.staleWorkMs ? s.activity : 'idle';
      case 'done':
        return age < o.doneShowMs ? 'done' : 'idle';
      case 'hello':
        return age < o.helloShowMs ? 'hello' : 'idle';
      case 'error':
        return age < o.errorShowMs ? 'error' : 'idle';
      case 'waiting':
        return age < o.waitingMaxMs ? 'waiting' : 'idle';
      default:
        return 'idle';
    }
  }

  function windowPct(w, nowSec) {
    if (!w || typeof w.used_percentage !== 'number') return null;
    // 過了重置時間，這個視窗的數字就作廢
    if (w.resets_at && w.resets_at <= nowSec) return null;
    return w.used_percentage;
  }

  function resolve(snapshot, now, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const nowSec = now / 1000;
    const snap = snapshot || {};

    // 1. 活動
    let activity = 'idle';
    let tool = null;
    for (const s of snap.sessions || []) {
      const a = freshActivity(s, now, o);
      if (ACTIVITY_ORDER.indexOf(a) < ACTIVITY_ORDER.indexOf(activity)) {
        activity = a;
        tool = s.tool || null;
      }
    }

    // 2. 用量
    const u = snap.usage || {};
    const five = windowPct(u.five_hour, nowSec);
    const week = windowPct(u.seven_day, nowSec);
    const usage = {
      five, week,
      fiveResets: five != null && u.five_hour ? u.five_hour.resets_at : null,
      weekResets: week != null && u.seven_day ? u.seven_day.resets_at : null,
    };

    // 3. 上限：StopFailure(rate_limit) 寫入的旗標，搭配用量判斷是哪一個視窗
    let limitKind = null; // 'week' | 'five'
    let limitUntil = null;
    const lim = snap.limit;
    if (lim && lim.hit) {
      if (week != null && week >= o.faintAt - 5) {
        limitKind = 'week'; limitUntil = usage.weekResets;
      } else if (five != null && five >= o.napAt - 5) {
        limitKind = 'five'; limitUntil = usage.fiveResets;
      } else if (week != null && five != null && week > five) {
        limitKind = 'week'; limitUntil = usage.weekResets;
      } else {
        limitKind = 'five'; limitUntil = usage.fiveResets;
      }
      const expire = limitUntil ? limitUntil * 1000 : (lim.ts || 0) + o.limitFallbackMs;
      if (now >= expire) limitKind = null;
    }

    // 4. 身體狀態：暈倒 > 睡覺(5h 用完) > 疲憊 > 工作中 > 思考 > 其餘
    let body;
    if ((week != null && week >= o.faintAt) || limitKind === 'week') {
      body = 'faint';
    } else if ((five != null && five >= o.napAt) || limitKind === 'five') {
      body = 'exhausted';
    } else if ((five != null && five >= o.tiredAt) || (week != null && week >= o.tiredAt)) {
      body = 'tired';
    } else if (activity !== 'idle') {
      body = activity;
    } else {
      body = 'free'; // 交給隨機行為
    }

    return { body, activity, tool, usage, limitKind };
  }

  function fmtReset(sec, now) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const sameDay = new Date(now).toDateString() === d.toDateString();
    if (sameDay) return `${hh}:${mm}`;
    const wd = '日一二三四五六'[d.getDay()];
    return `週${wd} ${hh}:${mm}`;
  }

  // 頭上小字
  function bubbleText(r, now) {
    const pct = (v) => `${Math.round(v)}%`;
    switch (r.body) {
      case 'faint':
        return r.usage.weekResets ? `週額度見底…${fmtReset(r.usage.weekResets, now)} 復活` : '週額度見底了…';
      case 'exhausted':
        return r.usage.fiveResets ? `休息一下，${fmtReset(r.usage.fiveResets, now)} 再戰` : '額度用完，休息中…';
      case 'tired': {
        // 跟體力條一致，顯示「剩下多少」
        const v = Math.max(r.usage.five || 0, r.usage.week || 0);
        const doing = r.activity === 'working' ? '還在工作…' : r.activity === 'thinking' ? '還在想…' : '有點累了…';
        return v ? `${doing}體力剩 ${pct(Math.max(0, 100 - v))}` : doing;
      }
      case 'working':
        return r.tool ? `工作中 · ${r.tool}` : '工作中…';
      case 'thinking':
        return '思考中…';
      case 'waiting':
        return '需要你確認一下～';
      case 'done':
        return '完成了！';
      case 'error':
        return '咦？出錯了…';
      case 'hello':
        return '嗨～我在這';
      default:
        return '';
    }
  }

  // 視窗版面：左右各留一段透明邊，讓頭上的泡泡有地方跟著頭移動、靠邊時往內閃
  const BUBBLE_H = 52;
  function layout(size) {
    const padX = Math.max(40, Math.round(size * 0.25));
    return { padX, bubbleH: BUBBLE_H, width: size + padX * 2, height: size + BUBBLE_H };
  }

  const api = { DEFAULTS, resolve, bubbleText, fmtReset, layout };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PetCore = api;
})(typeof self !== 'undefined' ? self : this);
