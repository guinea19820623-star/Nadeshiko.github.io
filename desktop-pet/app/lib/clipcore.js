// 動畫片段（clip）的播放時間運算：祐用「動畫轉精靈幀」做的動作，一組 16 格。
// 純函式／純資料，瀏覽器與 Node 都能用（測試在 test/clipcore.test.js）。
//
// 片段資料（manifest.clips[name]，由 tools/build_clips.py 產生）：
//   frames    各格檔名            durations 各格秒數
//   mode      'once'：整段播一次，之後停在最後一格
//             'loop'：先播 intro（只播一次，可省略），再反覆播 loop；格序都是 0 起算、含頭尾
//   xfade     循環接縫的交叉淡化秒數（loop 最後一段慢慢淡入下一輪的第一格，接縫就看不出來）
(function (root) {
  'use strict';

  const sum = (d, a, b) => { let s = 0; for (let k = a; k <= b; k++) s += d[k]; return s; };

  // 某一段格序在 t 秒時是第幾格；回傳 { i, end }（end：這一段已經播完）
  function walk(d, a, b, t) {
    let acc = 0;
    for (let k = a; k <= b; k++) {
      if (t < acc + d[k]) return { i: k, end: false };
      acc += d[k];
    }
    return { i: b, end: true };
  }

  // 整段「只播一次」要幾秒（loop 片段回傳 intro 的長度）
  function playLength(def) {
    const d = def.durations;
    if (def.mode === 'once') return sum(d, 0, d.length - 1);
    return def.intro ? sum(d, def.intro[0], def.intro[1]) : 0;
  }

  // 一輪循環幾秒（once 片段回傳 0）
  function loopLength(def) {
    return def.mode === 'loop' ? sum(def.durations, def.loop[0], def.loop[1]) : 0;
  }

  // t 秒時要畫哪一格：{ i, next, a }；next >= 0 代表要把第 next 格以 a（0~1）的透明度疊上去
  function frameAt(def, t) {
    const d = def.durations;
    if (t < 0) t = 0;
    if (def.mode === 'once') {
      const w = walk(d, 0, d.length - 1, t);
      return { i: w.i, next: -1, a: 0, done: w.end };
    }
    const intro = def.intro && def.intro[1] >= def.intro[0] ? def.intro : null;
    const introLen = intro ? sum(d, intro[0], intro[1]) : 0;
    if (intro && t < introLen) return { i: walk(d, intro[0], intro[1], t).i, next: -1, a: 0, done: false };
    const [l0, l1] = def.loop;
    const len = sum(d, l0, l1);
    const tl = (t - introLen) % len;
    const i = walk(d, l0, l1, tl).i;
    const xf = Math.min(def.xfade || 0, len / 3);
    if (xf > 0 && tl > len - xf) return { i, next: l0, a: (tl - (len - xf)) / xf, done: false };
    return { i, next: -1, a: 0, done: false };
  }

  // 淡入淡出：開頭 fadeIn 秒從 base 圖慢慢換成片段、結尾 fadeOut 秒慢慢換回 base 圖
  // 回傳 { sprite, blend }：sprite 是底圖、blend 是疊上去的圖與透明度（沒有就是 null）
  function compose(f, keyOf, t, opts) {
    const o = opts || {};
    const base = o.base || 'idle';
    const cur = keyOf(f.i);
    let sprite = cur;
    let blend = f.next >= 0 ? { sprite: keyOf(f.next), a: f.a } : null;
    const fin = o.fadeIn || 0;
    const fout = o.fadeOut || 0;
    if (fin > 0 && t < fin) {
      sprite = base;
      blend = { sprite: cur, a: t / fin };
    } else if (fout > 0 && o.dur != null && t > o.dur - fout) {
      blend = { sprite: base, a: Math.min(1, (t - (o.dur - fout)) / fout) };
    }
    return { sprite, blend };
  }

  const api = { sum, walk, playLength, loopLength, frameAt, compose };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClipCore = api;
})(typeof self !== 'undefined' ? self : this);
