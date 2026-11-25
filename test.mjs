// node test.mjs — hum -> midi pipeline + exporters. Fails loudly (assert) if the logic breaks.
import assert from 'node:assert/strict';
import { analyze, analyzeRobust, segment, place, toMidi, toWav, hz, SCALES, snap, detectKey, tuneOffset, parseNotes, bassLine, estimateBpm, lowpass } from './dsp.js';

const sr = 48000;
// fake hum: C4 E4 G4(flat by 35 cents, with 5Hz vibrato) , 0.15s silence between, mic noise on top
function hum(notes) {
  const out = []; let ph = 0;
  for (const { m, dur } of notes) {
    const n = Math.floor(dur * sr);
    for (let i = 0; i < n; i++) {
      const f = m == null ? 0 : hz(m) * 2 ** ((25 * Math.sin((2 * Math.PI * 5 * i) / sr)) / 1200);
      ph += (2 * Math.PI * f) / sr;
      out.push(m == null ? 0 : 0.3 * (Math.sin(ph) + 0.4 * Math.sin(2 * ph) + 0.2 * Math.sin(3 * ph)) + 0.004 * (Math.random() - 0.5));
    }
  }
  return Float32Array.from(out);
}
const pcm = hum([{ m: null, dur: 0.3 }, { m: 60, dur: 0.5 }, { m: null, dur: 0.15 }, { m: 64, dur: 0.5 }, { m: null, dur: 0.15 }, { m: 66.65, dur: 0.5 }]);
const { frames, hop } = analyze(pcm, sr);
const segs = segment(frames, hop);
assert.equal(segs.length, 3, `expected 3 notes, got ${segs.length}: ${JSON.stringify(segs)}`);
assert.deepEqual(segs.map((s) => Math.round(s.pf)), [60, 64, 67]);
assert(Math.abs(segs[0].ts - 0.3) < 0.06 && Math.abs(segs[0].te - 0.8) < 0.06, 'note timing off');

// 120bpm -> 2 beats/s. flat G (66.65) must snap to G (67) in C major, quantised to 1/16
const { notes, root } = place(segs, { bpm: 120, grid: 0.25, loopBeats: 8, scale: 'major' });
assert.equal(root, 0, 'key should be C');
assert.deepEqual(notes.map((n) => n.p), [60, 64, 67]);
assert(notes.every((n) => Number.isInteger(n.b * 4) && n.d > 0), 'not on grid');
assert(notes[0].b + notes[0].d <= notes[1].b, 'overlap in mono track');

// a note that is really F# in a C-major hum gets pulled onto the scale
assert.equal(snap(65.6, SCALES.major, 0), 65);   // F# is off-key; F is nearer than G
assert.equal(snap(66.4, SCALES.major, 0), 67);
assert.equal(detectKey([{ pf: 62, ts: 0, te: 1 }, { pf: 65, ts: 1, te: 2 }, { pf: 69, ts: 2, te: 3 }, { pf: 62, ts: 3, te: 5 }], SCALES.minor), 2); // D minor

// silence -> nothing; a vibrato-only hold stays ONE note
assert.equal(segment(analyze(new Float32Array(sr), sr).frames, hop).length, 0);
assert.equal(segment(analyze(hum([{ m: 57, dur: 1.5 }]), sr).frames, hop).length, 1, 'vibrato shattered the note');

// midi: header, track count, and every note-on has a note-off
const mid = toMidi([{ name: 'lead', notes }, { name: 'drums', drum: true, notes: [{ b: 0, d: 0.25, p: 36 }] }], 120);
assert.equal(String.fromCharCode(...mid.slice(0, 4)), 'MThd');
assert.equal((mid[10] << 8) | mid[11], 2);
const on = [...mid].filter((b, i) => (b & 0xf0) === 0x90 && mid[i + 2] > 0).length;
assert(on >= 4);
assert.equal(String.fromCharCode(...toWav([new Float32Array(10), new Float32Array(10)], 44100).slice(0, 4)), 'RIFF');

// ---- v2: repeated notes ("hm hm hm" on one pitch) must split, via an amplitude dip or a short silence
function tone(parts) {
  const out = []; let ph = 0;
  for (const { m, dur, amp = 1, noise = 0 } of parts) for (let i = 0; i < Math.floor(dur * sr); i++) {
    ph += (2 * Math.PI * (m ? hz(m) : 0)) / sr;
    out.push(m == null ? 0 : amp * 0.3 * (Math.sin(ph) + 0.4 * Math.sin(2 * ph)) + noise * (Math.random() - 0.5));
  }
  return Float32Array.from(out);
}
{
  const a = analyzeRobust(tone([{ m: 64, dur: 0.3 }, { m: 64, dur: 0.08, amp: 0.15 }, { m: 64, dur: 0.3 }, { m: null, dur: 0.04 }, { m: 64, dur: 0.3 }]), sr);
  const r = segment(a.frames, a.hop);
  assert.deepEqual(r.map((x) => Math.round(x.pf)), [64, 64, 64], 'repeated notes merged');
}
// ---- consistent flat/sharp singer: tune offset recovers the bias; fold lands a bass hum in bass range
assert(Math.abs(tuneOffset([60.35, 62.45, 64.4, 65.38, 67.42].map((pf) => ({ pf, ts: 0, te: 1 }))) + 0.4) < 0.06, 'tune offset');
assert.equal(tuneOffset([{ pf: 60.3, ts: 0, te: 1 }]), 0, 'too few notes to tune');
{
  const sg = [55, 57, 59, 55].map((pf, i) => ({ pf, ts: i, te: i + 0.9 }));
  const hi = place(sg, { bpm: 60, grid: 1, loopBeats: 8, scale: 'off', center: 40 });
  assert.equal(hi.fold, -12); assert.deepEqual(hi.notes.map((n) => n.p), [43, 45, 47, 43]);
  assert.equal(place(sg, { bpm: 60, grid: 1, loopBeats: 8, scale: 'off', center: 60 }).fold, 0);
}
// ---- breathy hum: strict YIN finds nothing, the relaxed retry does
{
  const x = tone([{ m: 60, dur: 0.5, noise: 0.6 }, { m: 64, dur: 0.5, noise: 0.6 }, { m: 67, dur: 0.5, noise: 0.6 }]);
  const a = analyzeRobust(x, sr);
  assert(a.relaxed, 'should have retried relaxed');
  assert.deepEqual(segment(a.frames, a.hop).map((x) => Math.round(x.pf)), [60, 64, 67]);
}
// ---- typed notes
assert.deepEqual(parseNotes('e e g e d c b').notes.map((n) => n.p), [64, 64, 67, 64, 62, 60, 59], 'riff shape');
assert.deepEqual(parseNotes('e e g', { center: 40 }).notes.map((n) => n.p), [40, 40, 43]);
{
  const r = parseNotes('e:1.5 e:.5 g - . bb3 xyz be');
  assert.deepEqual(r.notes.map((n) => [n.p, n.b, n.d]), [[64, 0, 1.5], [64, 1.5, 0.5], [67, 2, 1], [58, 3.5, 0.5], [59, 4, 0.5]]);
  assert.deepEqual(r.bad, ['xyz']);
}
// ---- bass line out of a mix (lowpass + low-range YIN). Kick drums on the same beat can merge repeated notes (known limit, see issues)
{
  const T = 4, N = T * sr, pitches = [40, 40, 43, 40, 38, 36, 35, 35], mix = new Float32Array(N);
  pitches.forEach((m, k) => { let ph = 0; for (let i = 0; i < 0.45 * sr; i++) { ph += (2 * Math.PI * hz(m)) / sr; mix[k * 0.5 * sr + i] += 0.35 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph)); } });
  for (let k = 0; k < 16; k++) for (let i = 0; i < 0.03 * sr; i++) mix[k * 0.25 * sr + i] += 0.12 * (Math.random() * 2 - 1);     // hats
  let ph = 0; for (let i = 0; i < N; i++) { ph += (2 * Math.PI * (523 + 100 * Math.sin(i / sr))) / sr; mix[i] += 0.15 * Math.sin(ph); }  // melody on top
  assert.deepEqual(bassLine(mix, sr).segs.map((s) => Math.round(s.pf)), pitches, 'bass line');
  for (let k = 0; k < 8; k++) for (let i = 0; i < 0.15 * sr; i++) { const t = i / sr; mix[k * 0.5 * sr + i] += 0.5 * Math.exp(-t * 25) * Math.sin(2 * Math.PI * (50 * t + (70 * (1 - Math.exp(-t * 30))) / 30)); }
  const dedupe = (a) => a.filter((p, i) => p !== a[i - 1]);
  assert.deepEqual(dedupe(bassLine(mix, sr).segs.map((s) => Math.round(s.pf))), dedupe(pitches), 'with kick: right notes, repeats may merge');
}
// ---- tempo + beat phase from a 124 bpm click-ish track (a clip that starts 0.13s before the first beat)
{
  const bpm = 124, spb = 60 / bpm, N = 12 * sr, x = new Float32Array(N);
  for (let t = 0.13; t < 12; t += spb) for (let i = 0; i < 0.05 * sr && t * sr + i < N; i++) x[Math.floor(t * sr) + i] += Math.exp(-i / 800) * Math.sin(i * 0.3);
  const e = estimateBpm(x, sr);
  assert(Math.abs(e.bpm - bpm) < 1.5, `bpm ${e.bpm}`); assert(Math.abs(e.phase - 0.13) < 0.02 || Math.abs(e.phase - 0.13 - spb) < 0.02, `phase ${e.phase}`);
}
assert(lowpass(Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.9)), sr, 260).slice(2400).every((v) => Math.abs(v) < 0.02), 'lowpass attenuates highs');

console.log('ok — notes:', notes.map((n) => `${n.p}@${n.b}+${n.d}`).join(' '));
