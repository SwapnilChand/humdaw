# hum.fm

Hum a melody → get MIDI → make it sound like anything. A tiny browser DAW, no build step, no backend.

**Live:** https://humdaw.vercel.app

- `dsp.js` – pure DSP: YIN pitch detection, note segmentation, key detection/snap, timbre features, `.mid`/`.wav` encoders
- `synth.js` – synth presets (data), sampler, drums; works on live and offline AudioContexts
- `app.js` / `index.html` – the UI
- `node test.mjs` – tests the hum → MIDI pipeline on a synthetic wobbly hum

Run locally: `python3 -m http.server` and open http://localhost:8000 (mic needs localhost or https).
