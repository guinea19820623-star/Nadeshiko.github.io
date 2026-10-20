// 語音台詞挑選：每個狀態 2~3 句隨機挑一句，不連續重複，並有冷卻時間避免吵。
// 純函式／純資料，瀏覽器與 Node 都能用（測試在 test/voicecore.test.js）。
(function (root) {
  'use strict';

  // 音檔命名：<key>_<序號從 1 開始>.<副檔名>
  const EXTS = ['mp3', 'ogg', 'wav'];
  const fileBase = (key, i) => `${key}_${i + 1}`;

  // 把台詞表跟實際存在的音檔對起來 → { key: [{ text, file|null }] }
  function build(lines, files) {
    const have = new Set(files || []);
    const out = {};
    for (const [key, arr] of Object.entries(lines || {})) {
      if (key.startsWith('_') || !Array.isArray(arr) || !arr.length) continue;
      out[key] = arr.map((l, i) => {
        const base = fileBase(key, i);
        const ext = EXTS.find((e) => have.has(`${base}.${e}`));
        return { text: l.text, file: ext ? `${base}.${ext}` : null };
      });
    }
    return out;
  }

  // 挑一句；有 2 句以上時不連續選到同一句
  function pickIndex(n, last, rnd) {
    if (n <= 1) return 0;
    let i = Math.floor((rnd || Math.random)() * n);
    if (i === last) i = (i + 1) % n;
    return i;
  }

  const api = { EXTS, fileBase, build, pickIndex };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VoiceCore = api;
})(typeof self !== 'undefined' ? self : this);
