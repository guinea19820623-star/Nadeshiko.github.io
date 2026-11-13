// 撫子自己演奏的樂器（祐 2026-11-13）：用 Web Audio 即時合成，不需要錄音檔，也就沒有錄音的版權問題。
//   harp：凱爾特豎琴，撥弦泛音（在弦長 15% 處撥，泛音強度 |sin(πkp)|/k^1.6），高泛音衰減快、低音留得久；比試聽版亮一點、餘音短一點
//   piano：電子琴（鋼琴音色），8 個帶一點不和諧的泛音，放開琴鍵時 0.3 秒收尾，加一點槌擊雜訊
// 兩種都會先把每個音的波形算好（同一個音只算一次），播放時排程，最後加一點殘響。
(function (root) {
  const SR_HINT = 44100;

  function makePlayer(ctx, kind, volume) {
    const sr = ctx.sampleRate || SR_HINT;
    const cache = new Map();
    const out = ctx.createGain();
    out.gain.value = volume;
    // 殘響：一段衰減的雜訊當脈衝響應
    const conv = ctx.createConvolver();
    const irLen = Math.floor(sr * 1.6);
    const ir = ctx.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = Math.floor(sr * 0.012); i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.27));
    }
    conv.buffer = ir;
    const wet = ctx.createGain(); wet.gain.value = kind === 'harp' ? 0.22 : 0.16;
    out.connect(ctx.destination);
    out.connect(conv); conv.connect(wet); wet.connect(ctx.destination);

    function harpWave(midi) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const ring = Math.min(2.6, 0.9 + 1.7 * (60 / Math.max(midi, 40)));     // 凱爾特豎琴：餘音比大豎琴短
      const n = Math.floor(sr * ring);
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      const p = 0.15;
      for (let k = 1; k <= 14; k++) {
        const fk = k * f * (1 + 0.0002 * k * k);
        if (fk > sr / 2 - 500) break;
        const amp = Math.abs(Math.sin(Math.PI * k * p)) / Math.pow(k, 1.45);  // 1.45（試聽版 1.6）：高泛音多一點，比較亮
        const tau = (1.2 + 0.9 * (60 / Math.max(midi, 40))) / (1 + 0.9 * (k - 1));
        const ph = Math.random() * 6.28;
        const w = 2 * Math.PI * fk / sr;
        for (let i = 0; i < n; i++) d[i] += amp * Math.sin(w * i + ph) * Math.exp(-i / (sr * tau));
      }
      const att = Math.floor(sr * 0.0015);
      for (let i = 0; i < att; i++) d[i] *= i / att;
      const pl = Math.floor(sr * 0.006);
      for (let i = 0; i < pl; i++) d[i] += (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.0015)) * 0.1;
      return buf;
    }

    function pianoWave(midi, hold) {
      const f = 440 * Math.pow(2, (midi - 69) / 12);
      const n = Math.floor(sr * (hold + 1.0));
      const buf = ctx.createBuffer(1, n, sr);
      const d = buf.getChannelData(0);
      const B = 0.0004;
      for (let k = 1; k <= 8; k++) {
        const fk = k * f * Math.sqrt(1 + B * k * k);
        if (fk > sr / 2) break;
        const amp = Math.pow(1 / k, 1.3) * (k === 1 ? 1.2 : 1);
        const tau = 2.6 / (1 + 0.6 * k) * Math.pow(440 / f, 0.35);
        const ph = Math.random() * 6.28;
        const w = 2 * Math.PI * fk / sr;
        for (let i = 0; i < n; i++) d[i] += amp * Math.sin(w * i + ph) * Math.exp(-i / (sr * tau));
      }
      const relStart = Math.floor(sr * hold), relLen = Math.floor(sr * 0.3);
      for (let i = relStart; i < n; i++) d[i] *= Math.max(0, 1 - (i - relStart) / relLen);
      const att = Math.floor(sr * 0.003);
      for (let i = 0; i < att; i++) d[i] *= i / att;
      const hm = Math.floor(sr * 0.012);
      for (let i = 0; i < hm; i++) d[i] += (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.003)) * 0.15;
      return buf;
    }

    function wave(midi, dur) {
      const hold = kind === 'piano' ? Math.round((dur + 0.25) * 20) / 20 : 0;   // 鋼琴依按住的長度分組快取（0.05 秒一格）
      const key = `${midi}:${hold}`;
      if (!cache.has(key)) cache.set(key, kind === 'harp' ? harpWave(midi) : pianoWave(midi, hold));
      return cache.get(key);
    }

    const playing = [];
    return {
      // 把整首排進時間軸；回傳整首結束的時間（秒，ctx.currentTime 為準）
      play(compiled, delay = 0.15) {
        const t0 = ctx.currentTime + delay;
        let end = t0;
        for (const n of compiled.notes) {
          const src = ctx.createBufferSource();
          src.buffer = wave(n.midi, n.dur);
          const g = ctx.createGain();
          g.gain.value = (n.midi < 60 ? 0.5 : 0.9) * 0.22;   // 左手（低音）小聲一點
          src.connect(g); g.connect(out);
          src.start(t0 + n.t);
          playing.push(src);
          end = Math.max(end, t0 + n.t + src.buffer.duration);
        }
        return { start: t0, end: t0 + compiled.seconds, ring: end };
      },
      // 停下來：0.4 秒淡出，免得硬切
      stop() {
        const now = ctx.currentTime;
        out.gain.cancelScheduledValues(now);
        out.gain.setValueAtTime(out.gain.value, now);
        out.gain.linearRampToValueAtTime(0, now + 0.4);
        for (const s of playing) { try { s.stop(now + 0.45); } catch (_) { /* 已經停了 */ } }
      },
    };
  }

  const api = { makePlayer };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Instrument = api;
})(typeof self !== 'undefined' ? self : this);
