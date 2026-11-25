import { SCALES, NOTE, name, analyze, analyzeRobust, segment, place, snap, features, dist, median, parseNotes, bassLine, estimateBpm, toMidi, toWav } from './dsp.js';
import { parseCommand, HELP } from './cmd.js';
import { PRESETS, voice, sampler, drum, click } from './synth.js';

const $ = (s) => document.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const TC = ['--pink', '--mint', '--lav', '--butter'];
const LANES = [{ p: 42, l: 'hat' }, { p: 39, l: 'clap' }, { p: 38, l: 'snare' }, { p: 36, l: 'kick' }];
const STORE = 'humdaw.v1';

// ---------- state ----------
function fresh() {
  const dr = [];
  for (let bar = 0; bar < 2; bar++) {
    const o = bar * 4;
    [0, 1.5, 2.5].forEach((b) => dr.push({ b: o + b, d: 0.25, p: 36, v: 0.9 }));
    [1, 3].forEach((b) => dr.push({ b: o + b, d: 0.25, p: 38, v: 0.8 }));
    for (let i = 0; i < 8; i++) dr.push({ b: o + i * 0.5, d: 0.25, p: 42, v: i % 2 ? 0.5 : 0.8 });
  }
  const bass = [[0, 1.5, 36], [2, 0.5, 36], [3, 0.75, 39], [4, 1.5, 34], [6, 0.5, 34], [7, 0.75, 36]].map(([b, d, p]) => ({ b, d, p, v: 0.8 }));
  const lead = [[0, 0.75, 64], [1, 0.5, 67], [1.5, 0.5, 69], [2, 1, 67], [3, 0.5, 64], [3.5, 0.5, 62], [4, 1.5, 60], [6, 0.5, 62], [6.5, 0.5, 64], [7, 0.75, 60]].map(([b, d, p]) => ({ b, d, p, v: 0.8 }));
  const T = (name, inst, c, notes = []) => ({ name, inst, c, notes, vol: 0.8, mute: 0, solo: 0 });
  return { bpm: 88, bars: 2, key: 'auto', scale: 'major', grid: 0.25, metro: false, lat: 80, sel: 0, rootUsed: 0,
    tracks: [T('lead', 'candy lead', 60, lead), T('bass', 'sub bass', 40, bass), T('keys', 'lofi keys', 60), { ...T('drums', '', 38, dr), drum: 1, vol: 0.9 }] };
}
let S; try { S = JSON.parse(localStorage[STORE]); if (!S?.tracks?.length) throw 0; } catch { S = fresh(); }
const samples = [];                       // {id, buf, root, loop}  (not persisted: AudioBuffers)
const kit = { 36: null, 38: null, 39: null, 42: null };
let hist = [], humN = 0, dirty = 1;
const bps = () => S.bpm / 60, L = () => S.bars * 4, gq = () => S.grid || 0.25;
const sel = () => S.tracks[S.sel];
const save = () => { try { localStorage[STORE] = JSON.stringify(S); } catch {} };
const log = (m) => { const l = $('#log'); l.textContent += `> ${m}\n`; l.scrollTop = l.scrollHeight; };

// ---------- audio graph ----------
let ctx, outs = [];
const level = (t) => ((S.tracks.some((x) => x.solo) ? t.solo : !t.mute) ? t.vol : 0);
function mix(c) {
  const m = c.createGain(), comp = c.createDynamicsCompressor();
  m.gain.value = 0.9; m.connect(comp); comp.connect(c.destination);
  const o = S.tracks.map((t) => { const g = c.createGain(); g.gain.value = level(t); g.connect(m); return g; });
  o.m = m; return o;
}
const syncMix = () => S.tracks.forEach((t, i) => outs[i] && (outs[i].gain.value = level(t)));
async function ensure() {
  if (!ctx) { ctx = new AudioContext({ latencyHint: 'interactive' }); outs = mix(ctx); }
  if (ctx.state !== 'running') await ctx.resume();
}
const instOf = (t) => samples.find((s) => s.id === t.inst) || PRESETS[t.inst] || PRESETS['candy lead'];
function play(c, out, t, n, when) {
  if (t.drum) {
    const s = samples.find((x) => x.id === kit[n.p]);
    s ? sampler(c, out, s, s.root, when, s.buf.duration, n.v) : drum(c, out, n.p, when, n.v);
  } else {
    const i = instOf(t), dur = n.d / bps();
    i.buf ? sampler(c, out, i, n.p, when, dur, n.v) : voice(c, out, i, n.p, when, dur, n.v);
  }
}
async function preview(t, p) { await ensure(); play(ctx, outs[S.tracks.indexOf(t)], t, { b: 0, d: 0.6, p, v: 0.8 }, ctx.currentTime + 0.02); }

// ---------- transport ----------
let T0 = 0, cursor = 0, playing = false, timer = 0, rec = null, chunks = [], mic, worklet;
const ring = new Float32Array(2048);
function start(countIn = 0) {
  T0 = ctx.currentTime + 0.08 + countIn / bps(); cursor = -countIn; playing = true;
  clearInterval(timer); timer = setInterval(tick, 25); ui();
}
function stop() {
  clearInterval(timer); playing = false; rec = null; chunks = [];
  outs.m.disconnect(); outs = mix(ctx);   // cut already-queued notes
  ui(); dirty = 1;
}
function tick() {
  const b = bps(), l = L(), end = (ctx.currentTime + 0.12 - T0) * b;
  if (end <= cursor) return;
  for (let k = Math.ceil(cursor); k < end; k++) if (k < 0 || S.metro || rec) click(ctx, ctx.destination, T0 + k / b, ((k % 4) + 4) % 4 === 0);
  S.tracks.forEach((t, i) => t.notes.forEach((n) => {
    for (let k = Math.max(0, Math.floor(cursor / l)); k <= Math.floor(end / l); k++) {
      const a = n.b + k * l;
      if (a >= cursor && a < end && a >= 0) play(ctx, outs[i], t, n, T0 + a / b);
    }
  }));
  cursor = end;
  if (rec?.active && end >= l + 0.5) finishRec();
}

// ---------- hum -> midi ----------
async function initMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const url = URL.createObjectURL(new Blob([`registerProcessor('rec',class extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage({t:currentTime,d:c.slice()});return true}})`], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  worklet = new AudioWorkletNode(ctx, 'rec');
  const z = ctx.createGain(); z.gain.value = 0;               // keep the node pulled by the graph, but silent
  ctx.createMediaStreamSource(s).connect(worklet); worklet.connect(z).connect(ctx.destination);
  worklet.port.onmessage = (e) => { ring.copyWithin(0, 128); ring.set(e.data.d, 1920); if (rec?.active) chunks.push(e.data); };
  mic = s;
}
async function startRec() {
  if (rec) return stop();
  if (sel().drum) return log('pick a melodic track (lead / bass / keys) to hum into');
  await ensure();
  try { if (!mic) await initMic(); } catch (e) { return log(`mic unavailable: ${e.message}`); }
  if (playing) stop();
  chunks = []; rec = { active: true };
  start(4);
  log(`count-in… then hum for ${S.bars} bar${S.bars > 1 ? 's' : ''} into “${sel().name}”`);
}
function finishRec() {
  rec.active = false;
  const sr = ctx.sampleRate, off = chunks[0].t, pcm = new Float32Array(chunks.length * 128);
  chunks.forEach((c, i) => pcm.set(c.d, i * 128)); chunks = []; rec = null;
  const run1 = analyzeRobust(pcm, sr), segs = segment(run1.frames, run1.hop);
  ui();
  if (!segs.length) return log('heard nothing :( hum louder, or check your mic');
  if (run1.relaxed) log('weak pitch (breathy or noisy?): used relaxed detection, check the notes');
  snapshot();
  const r = place(segs, { bpm: S.bpm, origin: T0 - off, latency: S.lat / 1000, grid: S.grid, loopBeats: L(), scale: S.scale,
    root: S.key === 'auto' ? 'auto' : NOTE.indexOf(S.key), center: sel().c });
  sel().notes = $('#layer').checked ? [...sel().notes, ...r.notes] : r.notes; S.rootUsed = r.root;
  log(`heard ${segs.length} notes, kept ${r.notes.length} · key ${NOTE[r.root]} ${S.scale}`
    + (Math.abs(r.tune) > 0.05 ? ` · you were ~${Math.round(Math.abs(r.tune) * 100)}c ${r.tune < 0 ? 'sharp' : 'flat'}, corrected` : '')
    + (r.fold ? ` · moved ${Math.abs(r.fold / 12)} octave${Math.abs(r.fold) > 12 ? 's' : ''} ${r.fold < 0 ? 'down' : 'up'} into ${sel().name}'s range` : '')
    + '  (late/early? tweak “lat”)');
  const best = segs.reduce((a, b) => (b.te - b.ts > a.te - a.ts ? b : a));    // longest hum note becomes an instrument
  addSample(`my hum #${++humN}`, cut(pcm, sr, best.ts, best.te), best.pf, true);
  log(`your voice is now an instrument: pick “◉ my hum #${humN}” in the timbre lab`);
  changed();
}

// ---------- samples ----------
function cut(x, sr, s, e) {
  const y = x.slice(Math.floor(s * sr), Math.min(x.length, Math.floor(e * sr)));
  let pk = 1e-6; for (const v of y) pk = Math.max(pk, Math.abs(v));
  const buf = ctx.createBuffer(1, y.length, sr); buf.copyToChannel(y.map((v) => (v * 0.9) / pk), 0); return buf;
}
const mono = (b) => { const o = new Float32Array(b.length); for (let c = 0; c < b.numberOfChannels; c++) b.getChannelData(c).forEach((v, i) => (o[i] += v / b.numberOfChannels)); return o; };
function addSample(id, buf, root, loop) { samples.push({ id, buf, root, loop }); renderLab(); }

let loaded = null;
function setLoaded(buf, label, whole) {
  loaded = { buf, x: mono(buf), name: label, sel: [0, whole ? buf.duration : Math.min(buf.duration, 2)] };
  $('#q').value = label; $('#wv').hidden = $('#smp').hidden = false;
  drawWave(); detectRoot(); huntLinks();
}
$('#file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  await ensure();
  try { setLoaded(await ctx.decodeAudioData(await f.arrayBuffer()), f.name.replace(/\.[^.]+$/, ''), false); } catch { return log("couldn't decode that file"); }
  log(`loaded “${f.name}” ${loaded.buf.duration.toFixed(1)}s · drag on the waveform to pick the bit you want`);
};
function drawWave() {
  const c = $('#wv'), w = (c.width = c.clientWidth * 2), h = (c.height = 112), g = c.getContext('2d'), x = loaded.x, per = x.length / w;
  g.fillStyle = css('--ink');
  for (let i = 0; i < w; i += 2) {
    let lo = 0, hi = 0; for (let j = Math.floor(i * per); j < (i + 2) * per && j < x.length; j += Math.ceil(per / 8)) { lo = Math.min(lo, x[j]); hi = Math.max(hi, x[j]); }
    g.fillRect(i, h / 2 + lo * h / 2, 2, Math.max(2, (hi - lo) * h / 2));
  }
  const [s, e] = loaded.sel, d = loaded.buf.duration;
  g.fillStyle = 'rgba(255,126,182,.4)'; g.fillRect((s / d) * w, 0, ((e - s) / d) * w, h);
}
function detectRoot() {
  const sr = loaded.buf.sampleRate, [s, e] = loaded.sel, x = loaded.x.subarray(Math.floor(s * sr), Math.floor(Math.min(e, s + 3) * sr));
  const v = analyze(x, sr).frames.filter((f) => f.midi != null).map((f) => f.midi);
  $('#root').value = v.length > 3 ? median(v).toFixed(2) : 60;
  $('#rootn').textContent = v.length > 3 ? ` ${name(median(v))}` : loaded.buf.duration > 6 ? ' (full mix: n/a)' : ' unpitched? set by ear';
}
{
  let d = null;
  const at = (e) => { const r = $('#wv').getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * loaded.buf.duration; };
  $('#wv').onpointerdown = (e) => { d = at(e); loaded.sel = [d, d + 0.05]; $('#wv').setPointerCapture(e.pointerId); drawWave(); };
  $('#wv').onpointermove = (e) => { if (d == null) return; const t = at(e); loaded.sel = [Math.min(d, t), Math.max(d, t) + 0.05]; drawWave(); };
  $('#wv').onpointerup = () => { d = null; detectRoot(); };
}
$('#add').onclick = () => {
  const sr = loaded.buf.sampleRate, [s, e] = loaded.sel, id = `${loaded.name} #${samples.length + 1}`;
  addSample(id, cut(loaded.x, sr, s, e), +$('#root').value, $('#loop').checked);
  if (!sel().drum) { sel().inst = id; changed(); preview(sel(), sel().c); }
  log(`added “${id}” — it's on “${sel().name}” now. for drums, use the hit-swap row`);
};
$('#match').onclick = async () => {
  const sr = loaded.buf.sampleRate, [s, e] = loaded.sel, root = +$('#root').value, f0 = 440 * 2 ** ((root - 69) / 12);
  const x = loaded.x.subarray(Math.floor(s * sr), Math.floor(e * sr)), target = features(x, sr, f0), res = [];
  for (const [k, p] of Object.entries(PRESETS)) {
    const oc = new OfflineAudioContext(1, Math.floor(sr * 1.4), sr), o = oc.createGain(); o.connect(oc.destination);
    voice(oc, o, p, root, 0, 1.2, 0.8);
    res.push([k, dist(target, features((await oc.startRendering()).getChannelData(0), sr, f0))]);
  }
  res.sort((a, b) => a[1] - b[1]);
  log(`closest presets: ${res.slice(0, 3).map(([k, d]) => `${k} (${d.toFixed(2)})`).join(', ')} — applied #1, click others in the lab`);
  if (!sel().drum) { sel().inst = res[0][0]; changed(); preview(sel(), sel().c); }
};

// "use the bass of this track": lowpass + low-range pitch tracking on the selected region, then the clip's own bass note becomes the sound.
// Heuristic, not stem separation: a kick on the same beat can blur repeated notes.
async function extractBass() {
  if (!loaded) return log('load a clip first: search a song (source hunt), or drop an audio file in the lab');
  const sr = loaded.buf.sampleRate, [s, e] = loaded.sel, x = loaded.x.subarray(Math.floor(s * sr), Math.floor(e * sr));
  log(`listening for bass in ${s.toFixed(1)}–${e.toFixed(1)}s of “${loaded.name}”…`);
  await new Promise((r) => setTimeout(r));                   // let the log paint before the ~0.2s analysis
  const { lp, segs } = bassLine(x, sr), tempo = estimateBpm(x, sr);
  if (!segs.length) return log('no clear bass line there. Pick a region where the bass is exposed.');
  snapshot();
  S.bpm = Math.round(tempo.bpm); $('#bpm').value = S.bpm;
  const ti = S.tracks.findIndex((t) => t.name === 'bass'), bt = S.tracks[ti];
  const r = place(segs, { bpm: S.bpm, origin: tempo.phase, grid: S.grid, loopBeats: L(), scale: S.scale, root: S.key === 'auto' ? 'auto' : NOTE.indexOf(S.key), tune: false });
  const best = segs.reduce((a, b) => (b.te - b.ts > a.te - a.ts ? b : a)), id = `${loaded.name.slice(0, 24)} bass #${samples.length + 1}`;
  addSample(id, cut(lp, sr, best.ts, best.te), best.pf, true);
  bt.notes = r.notes; bt.inst = id; S.sel = ti; S.rootUsed = r.root;
  changed();
  log(`bass track: ${r.notes.length} notes @ ${S.bpm} bpm (the clip's tempo; wrong? say “bpm 120”), key ${NOTE[r.root]} ${S.scale}. Its bass sound is now the bass instrument.`);
  await ensure(); if (!playing) start();
}

// ---------- assistant: song search ----------
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let songs = [], audio = null;
async function songSearch(q) {
  const ws = q.split(/\s+/).filter(Boolean), tries = [ws.join(' ')];
  for (const n of [4, 3, 2]) for (let i = 0; ws.length > n && i + n <= ws.length; i++) tries.push(ws.slice(i, i + n).join(' '));   // lyric-ish text: try shorter phrases
  log(`searching songs for “${q}”…`);
  for (const term of [...new Set(tries)].slice(0, 8)) {
    let r; try { r = await (await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(term)}`)).json(); } catch { return log('song search unreachable (offline?)'); }
    if (!r.results?.length) continue;
    songs = r.results;
    $('#songs').innerHTML = songs.map((x, i) => `<div class="song"><img src="${esc(x.artworkUrl60)}" alt=""><span><b>${esc(x.trackName)}</b><br>${esc(x.artistName)}</span><button data-p="${i}" title="hear the 30s preview">▶</button><button data-u="${i}" title="load the 30s preview into the lab">use</button></div>`).join('');
    return log(`${songs.length} matches${term === q ? '' : ` for “${term}”`}. ▶ to hear it, “use” to load the 30s preview as a source (then say “bass of this track”).`);
  }
  log('no matches. Title/artist search only for now; lyric and hum search need a backend (see GitHub issues).');
}
$('#songs').onclick = async (e) => {
  const p = e.target.dataset.p, u = e.target.dataset.u;
  if (p != null) { const url = songs[p].previewUrl; if (audio && !audio.paused && audio.src === url) return audio.pause(); audio?.pause(); audio = new Audio(url); audio.play(); }
  if (u != null) {
    const x = songs[u]; await ensure(); log(`fetching the 30s preview of “${x.trackName}”…`);
    try { setLoaded(await ctx.decodeAudioData(await (await fetch(x.previewUrl)).arrayBuffer()), `${x.trackName} - ${x.artistName}`, true); log('loaded. Say or type “bass of this track”, or drag a region on the waveform first.'); }
    catch (err) { log(`couldn't fetch/decode that preview: ${err.message}`); }
  }
};
$('#find').onclick = () => songSearch($('#q').value.trim());
$('#q').onkeydown = (e) => { if (e.key === 'Enter') $('#find').click(); };

// ---------- ui: tracks / lab ----------
function renderTracks() {
  $('#tracks').innerHTML = S.tracks.map((t, i) => `<div class="trk ${i === S.sel ? 'sel' : ''}" data-i="${i}" style="--c:var(${TC[i]})">
    <b>${t.name}</b><button data-m="${i}" class="${t.mute ? 'on' : ''}">M</button><button data-s="${i}" class="${t.solo ? 'on' : ''}">S</button>
    <small>${t.drum ? 'drum kit' : t.inst}</small><input type="range" min="0" max="1" step=".01" value="${t.vol}" data-v="${i}"></div>`).join('');
}
$('#tracks').onclick = (e) => {
  if (e.target.tagName === 'INPUT') return;
  const m = e.target.dataset.m, s = e.target.dataset.s;
  if (m != null) S.tracks[m].mute ^= 1;
  else if (s != null) S.tracks[s].solo ^= 1;
  else S.sel = +e.target.closest('.trk').dataset.i;
  syncMix(); changed();
};
$('#tracks').oninput = (e) => { S.tracks[e.target.dataset.v].vol = +e.target.value; syncMix(); save(); };

function renderLab() {
  const t = sel(), c = `var(${TC[S.sel]})`;
  const chip = (id, label) => `<button class="chip ${t.inst === id ? 'on' : ''}" style="--c:${c}" data-i="${id}">${label}</button>`;
  $('#chips').innerHTML = t.drum ? '<i>drum track — swap individual hits below</i>'
    : Object.keys(PRESETS).map((k) => chip(k, k)).join('') + samples.map((s) => chip(s.id, '◉ ' + s.id)).join('');
  $('#hits').innerHTML = '';
  $('#kit').innerHTML = LANES.slice().reverse().map((l) => `<label>${l.l} <select data-p="${l.p}"><option value="">synth</option>${samples.map((s) => `<option ${kit[l.p] === s.id ? 'selected' : ''}>${s.id}</option>`).join('')}</select></label>`).join('');
}
$('#chips').onclick = (e) => { const i = e.target.dataset.i; if (!i) return; sel().inst = i; changed(); preview(sel(), sel().c); };
$('#kit').onchange = (e) => { const p = +e.target.dataset.p; kit[p] = e.target.value || null; preview(S.tracks.find((t) => t.drum), p); };

const hunts = { freesound: (q) => `https://freesound.org/search/?q=${q}`, 'youtube patch': (q) => `https://www.youtube.com/results?search_query=${q}+synth+patch+how+to+make`,
  whosampled: (q) => `https://www.whosampled.com/search/?q=${q}`, 'google presets': (q) => `https://www.google.com/search?q=${q}+vst+preset+OR+sample+pack` };
function huntLinks() { const q = encodeURIComponent($('#q').value.trim()); $('#hunt').innerHTML = Object.entries(hunts).map(([k, f]) => `<a class="btn" target="_blank" rel="noopener" href="${f(q)}">${k} ↗</a>`).join(''); }
$('#q').oninput = huntLinks;

// ---------- piano roll ----------
const cv = $('#cv'), g = cv.getContext('2d'), KW = 46;
const rowsOf = (t) => {
  if (t.drum) return LANES;
  const ps = t.notes.map((n) => n.p), lo = Math.min(t.c - 12, ...ps) - 1, hi = Math.max(t.c + 12, ...ps) + 1, r = [];
  for (let p = hi; p >= lo; p--) r.push({ p, l: name(p) });
  return r;
};
const rowH = (t) => (t.drum ? 90 : 15);
const bw = () => (cv.clientWidth - KW) / L();
let drag = null, lastSel = -1;
function draw() {
  dirty = 0;
  const t = sel(), rs = rowsOf(t), RH = rowH(t), W = $('#roll').clientWidth, H = rs.length * RH, dpr = devicePixelRatio || 1;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
  if (lastSel !== S.sel) { lastSel = S.sel; $('#roll').scrollTop = (H - 360) / 2; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = css('--ink'), alt = css('--alt'), tint = css('--tint'), panel = css('--panel'), col = css(TC[S.sel]), B = bw();
  const sr = S.key === 'auto' ? S.rootUsed : NOTE.indexOf(S.key), sc = SCALES[S.scale];
  g.fillStyle = panel; g.fillRect(0, 0, W, H);
  rs.forEach((r, i) => {
    const y = i * RH, pc = ((r.p % 12) + 12) % 12, ins = sc?.includes(((r.p - sr) % 12 + 12) % 12);
    g.fillStyle = t.drum ? (i % 2 ? alt : panel) : ins ? tint : [1, 3, 6, 8, 10].includes(pc) ? alt : panel;
    g.fillRect(KW, y, W - KW, RH);
    g.fillStyle = alt; g.fillRect(0, y, KW, RH);
    g.fillStyle = ink; g.globalAlpha = 0.7; g.font = '11px ui-monospace,monospace'; g.fillText(r.l, 6, y + RH / 2 + 4); g.globalAlpha = 0.12; g.fillRect(0, y, W, 1); g.globalAlpha = 1;
  });
  for (let b = 0; b <= L() + 1e-9; b += gq()) {
    g.globalAlpha = b % 4 === 0 ? 0.6 : b % 1 === 0 ? 0.28 : 0.1; g.fillStyle = ink; g.fillRect(KW + b * B, 0, b % 4 === 0 ? 2 : 1, H);
  }
  g.globalAlpha = 1;
  const note = (n, a) => { g.globalAlpha = a; g.fillStyle = col; g.strokeStyle = ink; g.lineWidth = 2; const i = rs.findIndex((r) => r.p === n.p); if (i < 0) return;
    g.beginPath(); g.roundRect(KW + n.b * B + 1, i * RH + 1, Math.max(4, n.d * B - 2), RH - 2, t.drum ? 8 : 4); g.fill(); g.stroke(); g.globalAlpha = 1; };
  t.notes.forEach((n) => note(n, 1));
  if (drag) note({ b: drag.b, d: drag.e - drag.b, p: drag.p }, 0.5);
  if (playing && ctx) {
    const pb = (ctx.currentTime - T0) * bps();
    if (pb >= 0) { g.fillStyle = ink; g.fillRect(KW + (pb % L()) * B - 1, 0, 3, H); }
    if (rec) {
      g.fillStyle = ink; g.font = 'bold 20px ui-monospace,monospace';
      const msg = pb < 0 ? `get ready… ${Math.ceil(-pb)}` : '● hum now!';
      g.fillText(msg, KW + 14, 28 + $('#roll').scrollTop);
    }
  }
}
const pos = (e) => { const r = cv.getBoundingClientRect(), t = sel(), rs = rowsOf(t); return { beat: (e.clientX - r.left - KW) / bw(), row: rs[Math.floor((e.clientY - r.top) / rowH(t))] }; };
cv.onpointerdown = (e) => {
  const { beat, row } = pos(e), t = sel(); if (!row || beat < 0 || beat >= L()) return;
  const hit = t.notes.findIndex((n) => n.p === row.p && beat >= n.b && beat < n.b + n.d);
  if (hit >= 0) { snapshot(); t.notes.splice(hit, 1); return changed(); }
  const b = Math.floor(beat / gq()) * gq();
  drag = { p: row.p, b, e: b + gq() }; cv.setPointerCapture(e.pointerId); preview(t, row.p); dirty = 1;
};
cv.onpointermove = (e) => { if (!drag) return; drag.e = Math.min(L(), Math.max(drag.b + gq(), Math.ceil(pos(e).beat / gq()) * gq())); dirty = 1; };
cv.onpointerup = () => {
  if (!drag) return;
  snapshot(); sel().notes.push({ b: drag.b, d: sel().drum ? 0.25 : drag.e - drag.b, p: drag.p, v: 0.8 }); drag = null; changed();
};

// ---------- controls ----------
function snapshot() { hist.push(JSON.stringify(S.tracks.map((t) => t.notes))); if (hist.length > 40) hist.shift(); }
function changed() { save(); renderTracks(); renderLab(); dirty = 1; }
function ui() { $('#play').textContent = playing && !rec ? '■ stop' : '▶ play'; $('#rec').classList.toggle('live', !!rec); $('#rec').textContent = rec ? '■ cancel' : '● hum'; }

$('#bpm').value = S.bpm; $('#lat').value = S.lat; $('#bars').value = S.bars; $('#grid').value = S.grid; $('#metro').checked = S.metro;
$('#key').innerHTML = ['auto', ...NOTE].map((k) => `<option>${k}</option>`).join(''); $('#key').value = S.key;
$('#scale').innerHTML = Object.keys(SCALES).map((k) => `<option>${k}</option>`).join(''); $('#scale').value = S.scale;

function setBpm(raw) {
  const v = Math.max(50, Math.min(200, +raw || 90));
  if (playing) { const cur = (ctx.currentTime - T0) * bps(); S.bpm = v; T0 = ctx.currentTime - cur / bps(); } else S.bpm = v;
  $('#bpm').value = v; changed();
}
$('#bpm').onchange = (e) => setBpm(e.target.value);
$('#bars').onchange = (e) => { S.bars = +e.target.value; changed(); };
$('#key').onchange = (e) => { S.key = e.target.value; changed(); };
$('#scale').onchange = (e) => { S.scale = e.target.value; changed(); };
$('#grid').onchange = (e) => { S.grid = +e.target.value; changed(); };
$('#lat').onchange = (e) => { S.lat = +e.target.value || 0; save(); };
$('#metro').onchange = (e) => { S.metro = e.target.checked; save(); };
$('#play').onclick = async () => { await ensure(); playing ? stop() : start(); };
$('#rec').onclick = startRec;
$('#undo').onclick = () => { const h = hist.pop(); if (!h) return; JSON.parse(h).forEach((n, i) => (S.tracks[i].notes = n)); changed(); };
$('#clr').onclick = () => { snapshot(); sel().notes = []; changed(); };
const shift = (d) => { if (sel().drum) return; snapshot(); sel().notes.forEach((n) => (n.p += d)); changed(); };
$('#up').onclick = () => shift(12); $('#dn').onclick = () => shift(-12);
$('#snapk').onclick = () => {
  const sc = SCALES[S.scale]; if (!sc || sel().drum) return log('pick a scale (not “off”) first');
  snapshot(); const r = S.key === 'auto' ? S.rootUsed : NOTE.indexOf(S.key); sel().notes.forEach((n) => (n.p = snap(n.p, sc, r))); changed();
};
const dl = (data, name, type) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); };
$('#mid').onclick = () => { dl(toMidi(S.tracks.map((t) => ({ name: t.name, drum: t.drum, notes: t.notes })), S.bpm), 'humfm.mid', 'audio/midi'); log('exported humfm.mid (drums on channel 10)'); };
$('#wav').onclick = async () => {
  await ensure();
  const sr = ctx.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(sr * (L() / bps() + 2)), sr), o = mix(oc);
  S.tracks.forEach((t, i) => t.notes.forEach((n) => play(oc, o[i], t, n, n.b / bps())));
  const b = await oc.startRendering();
  dl(toWav([b.getChannelData(0), b.getChannelData(1)], sr), 'humfm.wav', 'audio/wav'); log('rendered humfm.wav (one loop + tail)');
};
// ---------- assistant: command bar (typed or spoken) ----------
const soundNames = () => [...Object.keys(PRESETS), ...samples.map((x) => x.id)];
const trackIdx = (n) => S.tracks.findIndex((t) => t.name === n);
async function runCmd(a) {
  switch (a.a) {
    case 'play': await ensure(); if (!playing) start(); break;
    case 'stop': if (ctx && playing) stop(); break;
    case 'hum': return startRec();
    case 'undo': case 'clear': case 'snap': $({ undo: '#undo', clear: '#clr', snap: '#snapk' }[a.a]).click(); break;
    case 'help': log(HELP); break;
    case 'bpm': setBpm(a.v); log(`bpm ${S.bpm}`); break;
    case 'key':
      if (!NOTE.includes(a.key)) return log(`unknown key “${a.key}”`);
      S.key = a.key; if (a.scale) S.scale = a.scale; else if (S.scale === 'off') S.scale = 'major';
      $('#key').value = S.key; $('#scale').value = S.scale; changed(); log(`key ${S.key} ${S.scale}`); break;
    case 'scale': S.scale = a.v; $('#scale').value = a.v; changed(); break;
    case 'bars': if (![1, 2, 4, 8].includes(a.v)) return log('bars: 1, 2, 4 or 8'); S.bars = a.v; $('#bars').value = a.v; changed(); break;
    case 'select': S.sel = trackIdx(a.track); changed(); break;
    case 'mute': case 'unmute': case 'solo': { const t = S.tracks[trackIdx(a.track)]; if (a.a === 'solo') t.solo ^= 1; else t.mute = +(a.a === 'mute'); syncMix(); changed(); break; }
    case 'octave': shift(a.v); break;
    case 'inst': {
      const i = trackIdx(a.track), t = S.tracks[i];
      if (t.drum) return log('drums: swap individual hits in the lab');
      if (!a.inst) return log(`no sound like “${a.asked}”. have: ${soundNames().join(', ')}`);
      t.inst = a.inst; S.sel = i; changed(); preview(t, t.c); break;
    }
    case 'notes': {
      const t = sel(); if (t.drum) return log('select a melodic track first (lead / bass / keys)');
      const r = parseNotes(a.text, { center: t.c });
      if (!r.notes.length) return log(`no notes in “${a.text}”. e.g. notes e e g e d c b  (e:1.5 longer · - hold · . rest)`);
      snapshot();
      const need = [1, 2, 4, 8].find((b) => b * 4 >= r.end) ?? 8;
      if (need > S.bars) { S.bars = need; $('#bars').value = need; }
      t.notes = r.notes.filter((n) => n.b < L()).map((n) => ({ ...n, d: Math.min(n.d, L() - n.b) }));
      changed(); log(`${t.name}: ${t.notes.map((n) => name(n.p)).join(' ')}${r.bad.length ? `  (skipped: ${r.bad.join(' ')})` : ''}`); break;
    }
    case 'search': return songSearch(a.q);
    case 'extract':
      return a.what === 'bass' ? extractBass() : log(`only the bass can be pulled out for now (splitting other parts needs real stem separation, see GitHub issues). Try “bass of this track”.`);
    default: log(`didn't get that. ${HELP}`);
  }
}
$('#cmdbar').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#cmd').value.trim(); if (!text) return;
  $('#cmd').value = ''; log(`$ ${text}`);
  runCmd(parseCommand(text, { sounds: soundNames() }));
};
const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
$('#say').hidden = !Speech;
$('#say').onclick = () => {
  const r = new Speech(); r.lang = 'en-US'; r.interimResults = false;
  r.onstart = () => log('listening… say a command (Chrome sends this audio to its speech service)');
  r.onresult = (e) => { $('#cmd').value = e.results[0][0].transcript; $('#cmdbar').requestSubmit(); };
  r.onerror = (e) => log(`speech: ${e.error}`);
  r.start();
};
addEventListener('keydown', (e) => {
  if (e.target.matches('input,select')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) $('#undo').click();
});
addEventListener('resize', () => { dirty = 1; if (loaded) drawWave(); });

// ---------- live meter + tuner while recording, redraw loop ----------
let fr = 0;
(function frame() {
  if (rec && ++fr % 2 === 0) {
    let e = 0; for (let i = 1024; i < 2048; i++) e += ring[i] * ring[i];
    $('#lvl').style.width = Math.min(60, Math.sqrt(e / 1024) * 400) + 'px';
    const m = analyze(ring, ctx.sampleRate).frames[0]?.midi;
    $('#live').firstChild.textContent = m == null ? 'listening…' : `♪ ${name(m)} ${(m - Math.round(m)) * 100 > 0 ? '+' : ''}${Math.round((m - Math.round(m)) * 100)}c`;
  } else if (!rec && fr % 30 === 0) { $('#live').firstChild.textContent = 'mic idle'; $('#lvl').style.width = 0; }
  if (playing || dirty) draw();
  requestAnimationFrame(frame);
})();

renderTracks(); renderLab(); huntLinks(); ui();
log('hi. pick a track, hit ● hum, wait out the count-in, hum a tune. headphones help.');
log('then try timbres in the lab, or drop an audio clip to steal its sound.');
log(`or just type to the assistant. ${HELP}`);
