// node test.mjs — hum -> midi pipeline + exporters. Fails loudly (assert) if the logic breaks.
import assert from 'node:assert/strict';
import { analyze, segment, place, toMidi, toWav, hz, SCALES, snap, detectKey } from './dsp.js';

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
console.log('ok — notes:', notes.map((n) => `${n.p}@${n.b}+${n.d}`).join(' '));
