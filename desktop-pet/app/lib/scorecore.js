// 樂譜（祐 2026-11-13）：撫子自己演奏用的樂譜格式，純文字、好讀好改，也有測試。
//
// 一份樂譜是 JSON：
//   { "title": "給愛麗絲", "composer": "貝多芬（1810）", "note": "撫子改編", "tempo": 0.13,
//     "voices": [ "E5 D# | E D# E B4 D5 C | A4:2 r C4 E A | ...", "r:2 | r:6 | A2 E3 A3 r:3 | ..." ] }
//
// - tempo：一格（最小的拍子單位）幾秒，通常一格＝十六分音符
// - voices：每一個聲部一行字串（右手旋律、左手伴奏…），同時從 0 開始
// - 音：音名＋升降（# 或 b）＋八度，例如 C4、F#5、Bb3；八度省略就沿用上一個音的
// - 長度：後面接 :數字（幾格），省略就沿用上一個長度；r 是休止
// - 和弦：用 + 連起來，例如 A2+E3+A3:6
// - 「|」是小節線，只是方便看，不影響時間
(function (root) {
  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // 音名 → MIDI 編號（C4＝60、A4＝69）；lastOct 是沿用的八度
  function toMidi(name, lastOct) {
    const m = /^([A-Ga-g])([#b]?)(-?\d)?$/.exec(name);
    if (!m) throw new Error(`看不懂的音：${name}`);
    const oct = m[3] != null ? Number(m[3]) : lastOct;
    const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return { midi: 12 * (oct + 1) + STEP[m[1].toUpperCase()] + acc, oct };
  }

  // 一行聲部 → [{ at, len, midi }]，at／len 的單位是格；回傳 { notes, length }
  function parseVoice(text) {
    const notes = [];
    let at = 0, len = 1, oct = 4;
    for (const raw of text.split(/\s+/)) {
      const tok = raw.trim();
      if (!tok || tok === '|') continue;
      const [body, dur] = tok.split(':');
      if (dur != null) {
        len = Number(dur);
        if (!(len > 0)) throw new Error(`長度不對：${tok}`);
      }
      if (body !== 'r' && body !== 'R') {
        for (const part of body.split('+')) {
          const r = toMidi(part, oct);
          oct = r.oct;
          notes.push({ at, len, midi: r.midi });
        }
      }
      at += len;
    }
    return { notes, length: at };
  }

  // 整份樂譜 → { title, tempo, notes（按時間排好，at／len 已換成秒）, seconds }
  function compile(score) {
    if (!score || !Array.isArray(score.voices) || !score.voices.length) throw new Error('樂譜沒有聲部');
    const tempo = Number(score.tempo) > 0 ? Number(score.tempo) : 0.13;
    let all = [], length = 0;
    score.voices.forEach((v, vi) => {
      const r = parseVoice(v);
      length = Math.max(length, r.length);
      all = all.concat(r.notes.map((n) => ({ t: n.at * tempo, dur: n.len * tempo, midi: n.midi, voice: vi })));
    });
    all.sort((a, b) => a.t - b.t || a.midi - b.midi);
    return { title: score.title || '', tempo, notes: all, seconds: length * tempo };
  }

  const freq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

  const api = { toMidi, parseVoice, compile, freq };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoreCore = api;
})(typeof self !== 'undefined' ? self : this);
