// Command bar grammar: typed or spoken text -> one action object. Pure (no DOM) so node can test it. See test-cmd.mjs.
import { NOTE_TOKEN } from './dsp.js';

const TRACKS = 'lead|bass|keys|drums';
const FLAT = { db: 'C#', eb: 'D#', gb: 'F#', ab: 'G#', bb: 'A#' };
const FILLER = /^(h?m+|u[hm]+|la+|na+|ah+|oh+|ba+)$/;       // hums and scat in a spoken "lyric"
const pick = (txt, list) => {                              // "acid" -> "acid bass", "my hum" -> "my hum #2"
  const t = txt.trim(), ws = t.split(/\s+/).filter((w) => w.length > 2);
  return list.find((n) => n === t) || list.find((n) => n.includes(t)) || list.find((n) => ws.length && ws.every((w) => n.includes(w))) || list.find((n) => ws.some((w) => n.includes(w))) || null;
};
export const HELP = 'try: notes e e g e d c b · bpm 124 · key e minor · bass acid · search seven nation army · bass of this track · hum';

export function parseCommand(raw, { sounds = [] } = {}) {
  const t = raw.toLowerCase().trim().replace(/^(hey|ok|okay|please|assistant)[ ,]+/, '').replace(/[?!]+$/, '');
  let m;
  if (!t) return { a: '?' };
  if ((m = t.match(/^(?:search|find|look up|shazam|identify)\b[ ,:]*(?:for )?(?:what )?(?:(?:this|the) )?(?:song )?(?:(?:was|is|called) )?(.*)$/))) {
    const q = m[1].split(/\s+/).filter((w) => w && !FILLER.test(w)).join(' ');
    return q ? { a: 'search', q } : { a: '?' };
  }
  if ((m = t.match(/\b(bass|lead|melody|vocals?|drums?|guitar|piano|keys)\b.*\b(?:of|from|in|out of)\s+(?:this|that|the)\s+(?:track|song|clip|loaded|source|sample)/))) return { a: 'extract', what: m[1] };
  if (/^(play|stop|hum|record|undo|clear|snap|help)$/.test(t)) return { a: t === 'record' ? 'hum' : t };
  if ((m = t.match(/\b(?:bpm|tempo)\s*(?:to |of |at )?(\d{2,3})/) || t.match(/^(\d{2,3})\s*bpm/))) return { a: 'bpm', v: +m[1] };
  if ((m = t.match(/\bkey\s*(?:to |of |is )?([a-g])(?:\s*(#|sharp)|\s*(flat)|(b)\b)?\s*(major|minor)?/))) {
    const k = m[1] + (m[2] ? '#' : m[3] || m[4] ? 'b' : '');
    return { a: 'key', key: FLAT[k] || k.toUpperCase(), scale: m[5] };
  }
  if ((m = t.match(/\bscale\s*(?:to |is )?(off|major|minor|blues|pent\w*\s*(?:maj|min)\w*)/))) {
    const s = m[1].replace(/pent\w*\s*maj\w*/, 'pent maj').replace(/pent\w*\s*min\w*/, 'pent min');
    return { a: 'scale', v: s };
  }
  if ((m = t.match(/\b(\d)\s*bars?\b/))) return { a: 'bars', v: +m[1] };
  if ((m = t.match(new RegExp(`^(mute|unmute|solo)\\s+(?:the\\s+)?(${TRACKS})$`)))) return { a: m[1], track: m[2] };
  if ((m = t.match(new RegExp(`^(?:select|edit|go to)\\s+(?:the\\s+)?(${TRACKS})$`)))) return { a: 'select', track: m[1] };
  if (/\b(?:octave|8va)\s*up\b|\bup an octave\b/.test(t)) return { a: 'octave', v: 12 };
  if (/\b(?:octave|8va)\s*down\b|\bdown an octave\b/.test(t)) return { a: 'octave', v: -12 };
  if ((m = t.match(/^(?:notes?|play notes?|enter|type)\s+(.+)$/))) return { a: 'notes', text: m[1] };
  if ((m = t.match(new RegExp(`^use\\s+(.+?)\\s+(?:on|for)\\s+(?:the\\s+)?(${TRACKS})$`)))) return { a: 'inst', track: m[2], inst: pick(m[1], sounds), asked: m[1] };
  if ((m = t.match(new RegExp(`^(?:make |use |set |switch )?(?:the )?(${TRACKS})\\s*(?:to |as |= |sound like |like )?(.+)$`)))) return { a: 'inst', track: m[1], inst: pick(m[2], sounds), asked: m[2] };
  const toks = t.split(/\s+/);                              // bare "e e g e d c b"
  if (toks.length >= 2 && toks.every((x) => NOTE_TOKEN.test(x))) return { a: 'notes', text: t };
  return { a: '?' };
}
