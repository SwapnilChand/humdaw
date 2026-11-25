# hum.fm

Hum a melody → get MIDI → make it sound like anything. A tiny browser DAW with a producer-style assistant. No build step, no backend.

**Live:** https://humdaw.vercel.app

## What it does
- **Hum to MIDI** – pitch tracking (YIN), key detection and snap, grid quantise. Repeated notes ("hm hm hm") split on loudness dips; a consistently flat/sharp singer is corrected; a take is folded into the track's octave range; breathy hums get a relaxed second pass. *Layer* adds a hum to what is already on the track.
- **Assistant bar** – type (or tap 🎙 in Chrome) things like:
  `notes e e g e d c b` · `bpm 124` · `key e minor` · `bass acid` · `use pluck on keys` · `mute drums` · `search seven nation army` · `bass of this track`
  Note syntax: `e:1.5` longer, `-` hold, `.` rest, `f#3` explicit octave.
- **Song search** – Apple's public iTunes Search API (title/artist, 30 s previews, for sketching). *use* loads a preview into the lab.
- **Bass of this track** – lowpass + low-range pitch tracking on the loaded clip gives a bass line (placed at the clip's estimated tempo) and turns one of its bass notes into the bass instrument. It is a heuristic, not stem separation.
- **Timbre lab** – 9 synth presets, your own hum as an instrument, any audio clip as a sampler, per-hit drum swaps, and *closest preset* matching.
- **Export** – `.mid` (drums on channel 10) and `.wav`.

## Not possible yet
See the open issues: hum-based song recognition, lyric search, real stem separation, robust pitch tracking for very noisy hums, voice → instrument timbre transfer, identifying a source synth/sample, and MIDI out to a DAW/VST.

## Develop
```
npm test                       # DSP + command-grammar tests (node)
python3 -m http.server         # then open http://localhost:8000 (mic needs localhost or https)
```
- `dsp.js` – pure DSP (pitch, segmentation, key/tuning, bass line, tempo, MIDI/WAV encoders)
- `cmd.js` – assistant command grammar (pure)
- `synth.js` – presets, sampler, drums (live and offline contexts)
- `app.js` / `index.html` – UI

Song previews are for personal sketching; clear any sample before you release it.
