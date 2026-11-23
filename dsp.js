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
export function analyze(pcm, sr, { win = 1024, hop = 256 } = {}) {
  const k = Math.max(1, Math.floor(sr / 20000)), len = Math.floor(pcm.length / k), s = sr / k;
  const d = new Float32Array(len);
  for (let i = 0; i < len; i++) { let a = 0; for (let j = 0; j < k; j++) a += pcm[i * k + j]; d[i] = a / k; }
  const rms = [];
  for (let i = 0; i + win <= len; i += hop) { let e = 0; for (let j = i; j < i + win; j++) e += d[j] * d[j]; rms.push(Math.sqrt(e / win)); }
  const gate = Math.max(0.006, 0.1 * Math.max(0, ...rms));   // adaptive: mic levels vary wildly
  const frames = rms.map((r, f) => {
    const i = f * hop, y = r < gate ? null : yin(d.subarray(i, i + win), s);
    return { t: (i + win / 2) / s, midi: y ? 69 + 12 * Math.log2(y.hz / 440) : null };
  });
  return { frames, hop: hop / s };
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

// frames -> [{ts, te, pf}] in seconds, pf = float midi pitch (median of the note)
export function segment(frames, hop, { minDur = 0.08, gapMax = 0.06 } = {}) {
  const m = frames.map((_, i) => {
    const w = []; for (let j = i - 2; j <= i + 2; j++) { const v = frames[j]?.midi; if (v != null) w.push(v); }
    return w.length >= 3 ? median(w) : null;               // 5-frame median kills octave glitches
  });
  const segs = []; let cur = null, gap = 0, off = [];
  const close = () => { if (cur) segs.push({ ts: cur.ts, te: cur.last + hop / 2, pf: median(cur.v) }); cur = null; off = []; gap = 0; };
  m.forEach((v, i) => {
    const t = frames[i].t;
    if (v == null) { if (cur && ++gap * hop > gapMax) close(); return; }
    gap = 0;
    if (!cur) { cur = { ts: t - hop / 2, last: t, v: [v], sum: v }; return; }
    const dev = Math.abs(v - cur.sum / cur.v.length);
    if (dev > 0.7) off.push({ v, t }); else off = [];
    if (off.length && splitRule(dev, off.length)) {
      const ts = off[0].t - hop / 2, vs = off.map((o) => o.v);
      close(); cur = { ts, last: t, v: vs, sum: vs.reduce((a, b) => a + b, 0) };
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
export function place(segs, { bpm, origin = 0, latency = 0, grid = 0.25, loopBeats, scale = 'off', root = 'auto', shift = 0 }) {
  const bps = bpm / 60, sc = SCALES[scale], r = root === 'auto' ? detectKey(segs, sc) : root, out = [];
  for (const s of segs) {
    let b = (s.ts - latency - origin) * bps, e = (s.te - latency - origin) * bps;
    if (grid) { b = Math.round(b / grid) * grid; e = Math.round(e / grid) * grid; }
    if (e <= b) e = b + (grid || 0.1);
    if (e <= 0 || b >= loopBeats) continue;
    b = Math.max(0, b);
    const n = { b, d: Math.min(e, loopBeats) - b, p: snap(s.pf, sc, r) + shift, v: 0.8 }, prev = out[out.length - 1];
    if (prev && n.b <= prev.b + 1e-6) { if (n.d > prev.d) out[out.length - 1] = n; continue; }   // collided after quantize
    if (prev && n.b < prev.b + prev.d) prev.d = n.b - prev.b;                                      // keep it monophonic
    out.push(n);
  }
  return { notes: out, root: r };
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
