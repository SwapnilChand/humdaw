// Pure functions only (no DOM / WebAudio) so node can test them. See test.mjs.

export const SCALES = {
  off: null,
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'pent maj': [0, 2, 4, 7, 9],
  'pent min': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
export const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const name = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
export const hz = (m) => 440 * 2 ** ((m - 69) / 12);
export const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length >> 1; return s.length % 2 ? s[n] : (s[n - 1] + s[n]) / 2; };

// ---------- pitch: YIN ----------
export function yin(x, sr, minHz = 70, maxHz = 1000, thr = 0.2) {
  const W = x.length >> 1, tMin = Math.floor(sr / maxHz), tMax = Math.min(W - 1, Math.ceil(sr / minHz));
  const d = new Float32Array(tMax + 2), n = new Float32Array(tMax + 2);
  for (let t = 1; t <= tMax; t++) { let s = 0; for (let i = 0; i < W; i++) { const e = x[i] - x[i + t]; s += e * e; } d[t] = s; }
  let run = 0; n[0] = 1;
  for (let t = 1; t <= tMax; t++) { run += d[t]; n[t] = run ? (d[t] * t) / run : 1; }
  let t = tMin;
  while (t <= tMax && n[t] >= thr) t++;
  if (t > tMax) return null;
  while (t + 1 <= tMax && n[t + 1] < n[t]) t++;          // walk to the local minimum
  let shift = 0;                                          // parabolic interpolation
  if (t > 1 && t < tMax) { const a = n[t - 1], b = n[t], c = n[t + 1], den = 2 * (a - 2 * b + c); if (den) shift = (a - c) / den; }
  return { hz: sr / (t + shift), clarity: 1 - n[t] };
}

// pcm -> [{t, midi|null}] ; decimates to ~24k first (4x cheaper, pitch < 1kHz is unaffected)
export function analyze(pcm, sr, { win = 1024, hop = 256, minHz = 70, maxHz = 1000, thr = 0.2, rate = 20000 } = {}) {
  const k = Math.max(1, Math.floor(sr / rate)), len = Math.floor(pcm.length / k), s = sr / k;
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) { let a = 0; for (let j = 0; j < k; j++) a += pcm[i * k + j]; d[i] = a / k; }
  // loudness over just the centre of each window (2 hops): a pitch window is ~43ms+, too blunt to see a 40ms gap between notes
  const rms = [], c = Math.min(win >> 1, hop);
  for (let i = 0; i + win <= len; i += hop) { let e = 0; for (let j = i + (win >> 1) - c; j < i + (win >> 1) + c; j++) e += d[j] * d[j]; rms.push(Math.sqrt(e / (2 * c))); }
  const gate = Math.max(0.006, 0.1 * Math.max(0, ...rms));   // adaptive: mic levels vary wildly
  let loud = 0, voiced = 0;
  const frames = rms.map((r, f) => {
    const i = f * hop, y = r < gate ? null : yin(d.subarray(i, i + win), s, minHz, maxHz, thr);
    if (r >= gate) { loud++; if (y) voiced++; }
    return { t: (i + win / 2) / s, midi: y ? 69 + 12 * Math.log2(y.hz / 440) : null, rms: r };
  });
  return { frames, hop: hop / s, voiced, loud };
}

// ---------- notes ----------
// TODO(human): decide when a wobbling hum becomes a NEW note.
//   dev  = how far (in semitones) this frame is from the running mean pitch of the current note
//   nOff = how many frames in a row have been "off" (dev > 0.7)
// Return true to start a new note. Trade-off: split fast = catches quick staccato changes but
// shatters vibrato/scoops into fragments; split slow = smooth but glues fast runs together.
export function splitRule(dev, nOff) {
  return dev > 0.7 && nOff >= 3;
}

// A breathy / nasal / noisy hum can defeat the strict YIN threshold. If most loud frames got no pitch, retry relaxed and keep the better run.
export function analyzeRobust(pcm, sr, opts = {}) {
  const a = analyze(pcm, sr, opts);
  if (a.loud && a.voiced / a.loud >= 0.6) return a;
  const b = analyze(pcm, sr, { ...opts, thr: 0.35 });
  return b.voiced > a.voiced ? { ...b, relaxed: true } : a;
}

// frames -> [{ts, te, pf}] in seconds, pf = float midi pitch (median of the note)
// A note ends on (a) real silence, (b) a pitch change (splitRule), (c) an amplitude dip then rise = "hm hm" on one pitch,
// (d) a sudden loudness jump = a re-attack on the same pitch.
export function segment(frames, hop, { minDur = 0.08, gapMax = 0.06 } = {}) {
  const m = frames.map((_, i) => {
    const w = []; for (let j = i - 2; j <= i + 2; j++) { const v = frames[j]?.midi; if (v != null) w.push(v); }
    return w.length >= 3 ? median(w) : null;               // 5-frame median kills octave glitches
  });
  const segs = []; let cur = null, gap = 0, quiet = 0, off = [];
  const open = (ts, t, v, r) => ({ ts, last: t, v, sum: v.reduce((a, b) => a + b, 0), pk: r, dip: null, rs: [r] });
  const close = () => { if (cur) segs.push({ ts: cur.ts, te: cur.last + hop / 2, pf: median(cur.v) }); cur = null; off = []; gap = quiet = 0; };
  m.forEach((v, i) => {
    const t = frames[i].t, r = frames[i].rms ?? 0;
    if (v == null) {
      if (!cur) return;
      quiet = r < 0.3 * cur.pk ? quiet + 1 : 0;            // silence between notes vs a pitch-tracker dropout
      if (quiet >= 2 || ++gap * hop > gapMax) close();
      return;
    }
    gap = quiet = 0;
    if (!cur) { cur = open(t - hop / 2, t, [v], r); return; }
    cur.pk = Math.max(cur.pk * 0.995, r);
    const prev = cur.rs.length >= 3 ? cur.rs.slice(-3).reduce((a, b) => a + b, 0) / 3 : null;
    cur.rs.push(r);
    if (prev != null && r > 1.8 * prev && r > 0.5 * cur.pk) { cur.last = t - hop; close(); cur = open(t - hop / 2, t, [v], r); return; }   // re-attack without a dip (plucked bass)
    if (r < 0.6 * cur.pk && (!cur.dip || r < cur.dip.r)) cur.dip = { r, t };
    else if (cur.dip && r > Math.max(1.4 * cur.dip.r, 0.8 * cur.pk)) {   // dipped, now recovered: new onset
      const ts = cur.dip.t; cur.last = ts - hop; close(); cur = open(ts, t, [v], r); return;
    }
    const dev = Math.abs(v - cur.sum / cur.v.length);
    if (dev > 0.7) off.push({ v, t }); else off = [];
    if (off.length && splitRule(dev, off.length)) {
      const ts = off[0].t - hop / 2, vs = off.map((o) => o.v);
      close(); cur = open(ts, t, vs, r);
    } else if (!off.length) { cur.v.push(v); cur.sum += v; cur.last = t; }
  });
  close();
  return segs.filter((s) => s.te - s.ts >= minDur);
}

export function detectKey(segs, sc) {
  if (!sc) return 0;
  let best = 0, bs = -1;
  for (let r = 0; r < 12; r++) {
    let s = 0;
    for (const g of segs) { const pc = (((Math.round(g.pf) - r) % 12) + 12) % 12, dur = g.te - g.ts; if (sc.includes(pc)) s += dur; if (pc === 0) s += 0.3 * dur; }
    if (s > bs) { bs = s; best = r; }
  }
  return best;
}

export function snap(pf, sc, root) {
  if (!sc) return Math.round(pf);
  let best = Math.round(pf), bd = 99;
  for (let p = Math.floor(pf) - 2; p <= Math.ceil(pf) + 2; p++) {
    if (!sc.includes((((p - root) % 12) + 12) % 12)) continue;
    const d = Math.abs(p - pf); if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// segs (seconds) -> mono notes on a beat grid.  origin = pcm time of beat 0, latency = mic round trip
// How far (semitones) to nudge a take so its notes sit closest to the semitone grid: fixes a singer who is
// consistently 30 cents flat/sharp. Needs 3+ notes; prefers the smallest correction on ties.
export function tuneOffset(segs) {
  if (segs.length < 3) return 0;
  let best = 0, bs = Infinity;
  for (let i = 0; i <= 20; i++) for (const sgn of i ? [1, -1] : [1]) {
    const o = sgn * i * 0.025; let s = 0;
    for (const g of segs) { const x = g.pf + o; s += (g.te - g.ts) * Math.abs(x - Math.round(x)); }
    if (s < bs - 1e-9) { bs = s; best = o; }
  }
  return best;
}

export function place(segs, { bpm, origin = 0, latency = 0, grid = 0.25, loopBeats, scale = 'off', root = 'auto', shift = 0, tune = true, center = null }) {
  const off = tune ? tuneOffset(segs) : 0;
  segs = segs.map((s) => ({ ...s, pf: s.pf + off }));
  const fold = center != null && segs.length ? 12 * Math.round((center - median(segs.map((s) => s.pf))) / 12) : 0;   // sing anywhere, land in the track's range
  const bps = bpm / 60, sc = SCALES[scale], r = root === 'auto' ? detectKey(segs, sc) : root, out = [];
  for (const s of segs) {
    let b = (s.ts - latency - origin) * bps, e = (s.te - latency - origin) * bps;
    if (grid) { b = Math.round(b / grid) * grid; e = Math.round(e / grid) * grid; }
    if (e <= b) e = b + (grid || 0.1);
    if (e <= 0 || b >= loopBeats) continue;
    b = Math.max(0, b);
    const n = { b, d: Math.min(e, loopBeats) - b, p: snap(s.pf, sc, r) + shift + fold, v: 0.8 }, prev = out[out.length - 1];
    if (prev && n.b <= prev.b + 1e-6) { if (n.d > prev.d) out[out.length - 1] = n; continue; }   // collided after quantize
    if (prev && n.b < prev.b + prev.d) prev.d = n.b - prev.b;                                      // keep it monophonic
    out.push(n);
  }
  return { notes: out, root: r, tune: off, fold };
}

// ---------- timbre matching ----------
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(a * k), wi = Math.sin(a * k), u = i + k, v = u + len / 2;
      const xr = re[v] * wr - im[v] * wi, xi = re[v] * wi + im[v] * wr;
      re[v] = re[u] - xr; im[v] = im[u] - xi; re[u] += xr; im[u] += xi;
    }
  }
}

// {att ms, sus 0..1, cr = spectral centroid / fundamental}: brightness, punch, how long it holds
export function features(x, sr, f0) {
  const step = Math.floor(sr * 0.01), env = [];
  for (let i = 0; i + step <= x.length; i += step) { let e = 0; for (let j = i; j < i + step; j++) e += x[j] * x[j]; env.push(Math.sqrt(e / step)); }
  const pk = Math.max(1e-9, ...env), ai = Math.max(0, env.findIndex((v) => v >= 0.9 * pk));
  const sus = env[Math.min(env.length - 1, ai + 40)] / pk;
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N), s0 = Math.min((ai + 5) * step, Math.max(0, x.length - N));
  for (let i = 0; i < N && s0 + i < x.length; i++) re[i] = x[s0 + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  fft(re, im);
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); num += (k * sr / N) * m; den += m; }
  return { att: ai * 10, sus, cr: den ? num / den / f0 : 1 };
}
export const dist = (a, b) =>
  (Math.log2(a.cr / b.cr) / 1.5) ** 2 + (Math.log2((a.att + 5) / (b.att + 5)) / 2) ** 2 + ((a.sus - b.sus) * 1.5) ** 2;

// ---------- export ----------
const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
export function toMidi(tracks, bpm, PPQ = 480) {
  const u32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255], u16 = (n) => [(n >> 8) & 255, n & 255];
  const chunk = (id, body) => [...[...id].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body];
  const us = Math.round(6e7 / bpm);
  const trks = tracks.map((t, i) => {
    const ch = t.drum ? 9 : Math.min(i, 8), ev = [];
    for (const n of t.notes) {
      const on = Math.round(n.b * PPQ);
      ev.push([on, 1, n.p, Math.round((n.v ?? 0.8) * 127)], [Math.max(on + 1, Math.round((n.b + n.d) * PPQ)), 0, n.p, 0]);
    }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);          // note-offs before note-ons at the same tick
    const nm = [...t.name].map((c) => c.charCodeAt(0) & 127), body = [];
    if (i === 0) body.push(0, 0xff, 0x51, 3, ...u32(us).slice(1));
    body.push(0, 0xff, 3, nm.length, ...nm);
    let last = 0;
    for (const [tk, on, p, v] of ev) { body.push(...vlq(tk - last), (on ? 0x90 : 0x80) | ch, p, v); last = tk; }
    body.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', body);
  });
  return new Uint8Array([...chunk('MThd', [...u16(1), ...u16(trks.length), ...u16(PPQ)]), ...trks.flat()]);
}

export function toWav(chs, sr) {
  const n = chs[0].length, nc = chs.length, v = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true);
  v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * nc * 2, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) v.setInt16(44 + (i * nc + c) * 2, Math.max(-1, Math.min(1, chs[c][i])) * 32767, true);
  return new Uint8Array(v.buffer);
}

// ---------- typed notes: "e e g e d c b", "e2:1.5 f#3 - . bb" ----------
const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ALIAS = { be: 'b', bee: 'b', see: 'c', sea: 'c', dee: 'd', gee: 'g' };   // what speech recognisers hear for letter names
export const NOTE_TOKEN = /^([a-g][#b]?(-?\d)?(:\d*\.?\d+)?|[._-]|r)$/;
// no octave given -> the octave nearest the previous note, so "e e g e d c b" keeps the riff's shape
export function parseNotes(text, { center = 60, step = 0.5, at = 0 } = {}) {
  const notes = [], bad = []; let b = at, prev = center, last = null;
  for (let tok of text.toLowerCase().replace(/[,;]/g, ' ').split(/\s+/).filter(Boolean)) {
    tok = ALIAS[tok] ?? tok;
    if (tok === '-') { if (last) last.d += step; b += step; continue; }          // hold
    if (tok === '.' || tok === '_' || tok === 'r') { b += step; last = null; continue; }   // rest
    const m = tok.match(/^([a-g])([#b]?)(-?\d)?(?::(\d*\.?\d+))?$/);
    if (!m) { bad.push(tok); continue; }
    const pc = PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0), d = m[4] ? +m[4] : step;
    const p = m[3] != null ? pc + 12 * (+m[3] + 1) : pc + 12 * Math.round((prev - pc) / 12);
    last = { b, d, p, v: 0.8 }; notes.push(last); b += d; prev = p;
  }
  return { notes, bad, end: b };
}

// ---------- pulling a bass line out of a full mix (heuristic; real stem separation is a GitHub issue) ----------
export function lowpass(x, sr, fc, passes = 2) {                                  // RBJ biquad, Q=.707, cascaded
  const w = (2 * Math.PI * fc) / sr, c = Math.cos(w), a = Math.sin(w) / (2 * 0.7071), a0 = 1 + a;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = (-2 * c) / a0, a2 = (1 - a) / a0;
  let y = x;
  for (let p = 0; p < passes; p++) {
    const o = new Float32Array(y.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i], r = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; o[i] = r; x2 = x1; x1 = v; y2 = y1; y1 = r; }
    y = o;
  }
  return y;
}

export function bassLine(x, sr) {
  const lp = lowpass(x, sr, 260), { frames, hop } = analyze(lp, sr, { win: 768, hop: 192, minHz: 38, maxHz: 260, thr: 0.25, rate: 6000 });
  return { lp, segs: segment(frames, hop, { minDur: 0.1 }) };
}

// onset-strength autocorrelation, 70-180 bpm (soft pull toward 120 to avoid half/double-time picks) + beat phase
export function estimateBpm(x, sr) {
  const H = 0.005, hop = Math.floor(sr * H), env = []; let prev = 0;
  for (let i = 0; i + hop <= x.length; i += hop) {
    let e = 0; for (let j = i; j < i + hop; j++) e += x[j] * x[j];
    e = Math.sqrt(e / hop); env.push(Math.max(0, e - prev)); prev = e;
  }
  const lo = Math.round(60 / 180 / H), hi = Math.round(60 / 70 / H), sc = [];
  for (let lag = lo - 1; lag <= hi + 1; lag++) {
    let s = 0; for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    sc[lag] = s * Math.exp(-0.5 * (Math.log2(60 / (lag * H) / 120) / 0.8) ** 2);
  }
  let lag = lo; for (let l = lo; l <= hi; l++) if (sc[l] > sc[lag]) lag = l;
  const a = sc[lag - 1], b = sc[lag], c = sc[lag + 1], den = a - 2 * b + c, P = lag + (den ? (0.5 * (a - c)) / den : 0);
  let ph = 0, bs = -1;
  for (let f = 0; f < Math.round(P); f++) { let s = 0; for (let k = 0; Math.round(f + k * P) < env.length; k++) s += env[Math.round(f + k * P)]; if (s > bs) { bs = s; ph = f; } }
  return { bpm: 60 / (P * H), phase: ph * H };
}
