// Sound engine. Every function takes the ctx so it works on a live AudioContext AND an OfflineAudioContext
// (used for .wav export and for rendering presets to compare against a sample).
import { hz } from './dsp.js';

// osc: [{t type, n semitone offset, d cents, g gain}]  f: lowpass {hz,q,env}  fm: {r ratio,i index,dec s}
// a/dd/s/r = attack, decay time, sustain level, release
export const PRESETS = {
  'candy lead': { osc: [{ t: 'sawtooth', d: -9 }, { t: 'sawtooth', d: 9 }], f: { hz: 3000, q: 1, env: 2500 }, a: 0.01, dd: 0.2, s: 0.55, r: 0.25, gain: 0.14 },
  'chip square': { osc: [{ t: 'square' }], a: 0.005, dd: 0.05, s: 0.7, r: 0.05, gain: 0.1 },
  'sub bass': { osc: [{ t: 'sine' }, { t: 'sawtooth', g: 0.25 }], f: { hz: 450, q: 1, env: 0 }, a: 0.01, dd: 0.3, s: 0.8, r: 0.1, gain: 0.5 },
  'acid bass': { osc: [{ t: 'sawtooth' }], f: { hz: 500, q: 12, env: 3500 }, a: 0.005, dd: 0.18, s: 0.3, r: 0.08, gain: 0.28 },
  'fm bell': { osc: [{ t: 'sine' }], fm: { r: 3.5, i: 2.5, dec: 0.4 }, a: 0.002, dd: 1.2, s: 0.05, r: 0.6, gain: 0.22 },
  pluck: { osc: [{ t: 'sawtooth' }, { t: 'square', n: 12, g: 0.4 }], f: { hz: 1500, q: 2, env: 4500 }, a: 0.002, dd: 0.12, s: 0.04, r: 0.1, gain: 0.22 },
  'lofi keys': { osc: [{ t: 'triangle' }, { t: 'sine', n: 12, g: 0.3 }, { t: 'sine', d: 7, g: 0.4 }], f: { hz: 2200, q: 0.7, env: 1500 }, a: 0.005, dd: 0.6, s: 0.25, r: 0.35, gain: 0.3 },
  'warm pad': { osc: [{ t: 'sawtooth', d: -14 }, { t: 'sawtooth' }, { t: 'sawtooth', d: 14 }], f: { hz: 1200, q: 0.5, env: 0 }, a: 0.5, dd: 0.5, s: 0.8, r: 0.8, gain: 0.1 },
  organ: { osc: [{ t: 'sine' }, { t: 'sine', n: 12, g: 0.5 }, { t: 'sine', n: 19, g: 0.3 }, { t: 'sine', n: 24, g: 0.2 }], a: 0.01, dd: 0.01, s: 1, r: 0.05, gain: 0.16 },
};

export function voice(ctx, out, p, m, t, dur, vel = 0.8) {
  const f = hz(m), end = Math.max(t + dur, t + p.a + 0.02), pk = p.gain * vel, g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(pk, t + p.a);
  g.gain.setTargetAtTime(pk * p.s, t + p.a, p.dd / 3);
  g.gain.setTargetAtTime(0, end, p.r / 3);
  g.connect(out);
  let node = g;
  if (p.f) {
    const b = ctx.createBiquadFilter();
    b.type = 'lowpass'; b.Q.value = p.f.q;
    b.frequency.setValueAtTime(p.f.hz + p.f.env, t);
    b.frequency.setTargetAtTime(p.f.hz, t, p.dd / 2);
    b.connect(g); node = b;
  }
  const stop = end + p.r * 2 + 0.1;       // 2x release so the exp tail is inaudible when the osc stops (no click)
  let mod;
  if (p.fm) {
    const o = ctx.createOscillator(); mod = ctx.createGain();
    o.frequency.value = f * p.fm.r;
    mod.gain.setValueAtTime(f * p.fm.r * p.fm.i, t); mod.gain.setTargetAtTime(0, t, p.fm.dec);
    o.connect(mod); o.start(t); o.stop(stop);
  }
  for (const s of p.osc) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = s.t; o.frequency.value = f * 2 ** ((s.n || 0) / 12); o.detune.value = s.d || 0; og.gain.value = s.g ?? 1;
    if (mod) mod.connect(o.frequency);
    o.connect(og).connect(node); o.start(t); o.stop(stop);
  }
}

// s = {buf, root (float midi), loop}. Pitch = resample speed, so formants shift too (chipmunk at big jumps).
export function sampler(ctx, out, s, m, t, dur, vel = 0.8) {
  const src = ctx.createBufferSource(), g = ctx.createGain(), end = Math.max(t + dur, t + 0.03);
  src.buffer = s.buf; src.playbackRate.value = 2 ** ((m - s.root) / 12);
  if (s.loop) { src.loop = true; src.loopStart = 0.02; src.loopEnd = Math.max(0.05, s.buf.duration - 0.02); }
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.8, t + 0.01);
  g.gain.setValueAtTime(vel * 0.8, end); g.gain.linearRampToValueAtTime(0, end + 0.08);
  src.connect(g).connect(out); src.start(t); src.stop(end + 0.1);
}

export const DRUMS = { 36: 'kick', 38: 'snare', 39: 'clap', 42: 'hat' };
const noises = new WeakMap();
const noise = (c) => {
  if (!noises.has(c)) { const b = c.createBuffer(1, c.sampleRate, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; noises.set(c, b); }
  return noises.get(c);
};
export function drum(c, out, p, t, v = 0.8) {
  const decay = (g, peak, dec) => { g.gain.setValueAtTime(peak * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + dec); };
  const N = (type, freq, q = 1) => {
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = noise(c); f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + 0.5); return g;
  };
  const tone = (type, f0, f1, peak, dec) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + 0.14);
    decay(g, peak, dec); o.connect(g).connect(out); o.start(t); o.stop(t + dec + 0.05);
  };
  if (p === 36) tone('sine', 150, 42, 0.8, 0.45);
  else if (p === 38) { decay(N('highpass', 1500), 0.5, 0.18); tone('triangle', 190, 150, 0.35, 0.1); }
  else if (p === 39) {
    const g = N('bandpass', 1400, 1.5);
    for (const d of [0, 0.012, 0.024]) { g.gain.setValueAtTime(0.5 * v, t + d); g.gain.exponentialRampToValueAtTime(0.05, t + d + 0.01); }
    g.gain.setValueAtTime(0.4 * v, t + 0.036); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  } else decay(N('highpass', 7500), 0.25, 0.05);
}

export function click(c, out, t, hi) {
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = hi ? 1500 : 1000; g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  o.connect(g).connect(out); o.start(t); o.stop(t + 0.05);
}
