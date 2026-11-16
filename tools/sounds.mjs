// sounds.mjs — hear and measure every sound of every cartridge without a phone.
//
//   node tools/sounds.mjs            print a table: what each sound should be, and what the chip plays
//   node tools/sounds.mjs out/       also write one .wav per sound and per music pattern into out/
//
// It runs the real client code (public/sound.js driving public/chip.js) with a stand-in for
// the browser's AudioContext, and takes each cartridge's sound bank from its own full dump.
// Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RATE = 48000;
const GAIN = 0.6;                                     // the master gain in sound.js

// A stand-in AudioContext with no AudioWorklet, so sound.js takes its on-the-page path
// (the same chip), and we pull the samples ourselves.
export async function makeSound() {
  let node = null, time = 0;
  class FakeContext {
    constructor() { this.sampleRate = RATE; this.state = 'running'; this.destination = {}; }
    get currentTime() { return time; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createScriptProcessor() { node = { connect() {} }; return node; }
    resume() { return Promise.resolve(); }
  }
  globalThis.window = { AudioContext: FakeContext };
  const { Sound } = await import(pathToFileURL(path.join(ROOT, 'public/sound.js')).href);
  const sound = new Sound();
  await sound.start();
  // render `seconds` of audio; returns the left channel after the master gain
  const render = (seconds) => {
    const n = Math.round(seconds * RATE), out = new Float32Array(n);
    for (let i = 0; i < n; i += 128) {
      const L = new Float32Array(Math.min(128, n - i)), R = new Float32Array(L.length);
      node.onaudioprocess({ outputBuffer: { getChannelData: (c) => (c ? R : L) } });
      for (let k = 0; k < L.length; k++) out[i + k] = L[k] * GAIN;
      time += L.length / RATE;
    }
    return out;
  };
  return { sound, render, advance: (s) => { time += s; } };
}

// The sound bank and music patterns a cartridge sends in its full dump.
export function bank(cartWasm) {
  const cart = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(cartWasm)), {}).exports;
  cart.con_init();
  const len = cart.con_flush(0, 1);
  const packet = new Uint8Array(cart.memory.buffer, cart.con_packet(), len).slice();
  const ppu = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(ROOT, 'public/ppu.wasm'))), {}).exports;
  new Uint8Array(ppu.memory.buffer, ppu.ppu_rx(), 4096).set(packet);
  ppu.ppu_apply(len);
  const sfx = new Uint8Array(ppu.memory.buffer, ppu.ppu_sfx(), 128).slice();
  const mus = new Uint8Array(ppu.memory.buffer, ppu.ppu_music(), 4 * 131).slice();
  const presets = [], patterns = [];
  for (let id = 0; id < 16; id++) if (sfx[id * 8 + 6]) presets.push({ id, bytes: sfx.subarray(id * 8, id * 8 + 8) });
  for (let id = 0; id < 4; id++) {
    const p = mus.subarray(id * 131, id * 131 + 131);
    if (p[1]) patterns.push({ id, song: { step: p[0] / 100, steps: p[1], vol: p[2], notes: p.slice(3, 3 + p[1] * 4) } });
  }
  return { presets, patterns };
}

// ---- measuring
// peak level, how long it sounds, and the pitch of the stretch [from, to] seconds
export function measure(samples, from = 0.004, to = 0.034) {
  let peak = 0, last = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; if (a > 0.004) last = i; }
  return { peak, seconds: last / RATE, hz: pitch(samples.subarray(Math.round(from * RATE), Math.round(to * RATE))) };
}
// The fundamental of a short stretch, by autocorrelation: the shortest lag that matches
// almost as well as the best one (longer lags are just several periods).
function pitch(x) {
  let mean = 0; for (const v of x) mean += v; mean /= x.length || 1;
  let power = 0; for (const v of x) power += (v - mean) ** 2;
  if (power / (x.length || 1) < 1e-7) return 0;
  const cor = (l) => { let s = 0; for (let i = 0; i + l < x.length; i++) s += (x[i] - mean) * (x[i + l] - mean); return s / (x.length - l); };
  const lo = Math.floor(RATE / 5000), hi = Math.min(x.length >> 1, Math.floor(RATE / 30));
  const c = []; let best = 0;
  for (let l = lo; l <= hi; l++) { c[l] = cor(l); if (c[l] > best) best = c[l]; }
  if (best <= 0) return 0;
  for (let l = lo + 1; l < hi; l++) {
    if (c[l] < best * 0.85 || c[l] < c[l - 1] || c[l] < c[l + 1]) continue;       // the first strong peak
    const shift = (c[l - 1] - c[l + 1]) / (2 * (c[l - 1] - 2 * c[l] + c[l + 1]) || 1);   // between two samples
    return RATE / (l + shift);
  }
  return 0;
}
export const noteHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

export function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

// ---- the report
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (out) fs.mkdirSync(out, { recursive: true });
  const CH = ['pulse 1', 'pulse 2', 'wave', 'noise'];
  const { sound, render } = await makeSound();
  console.log('cart  id  channel  note  wanted Hz  played Hz   wanted s  played s   peak');
  console.log('(played Hz is measured at the start of the sound)');
  for (const cart of fs.readdirSync(path.join(ROOT, 'carts')).sort()) {
    const file = path.join(ROOT, 'dist', cart + '.wasm');
    if (!fs.existsSync(file)) continue;
    const { presets, patterns } = bank(file);
    for (const { id, bytes } of presets) {
      render(0.3);                                                    // silence between sounds
      sound.sfx(bytes);
      const s = render(Math.max(0.5, bytes[6] / 100 + 0.4));
      const tonal = bytes[0] !== 3, semis = bytes[5] > 127 ? bytes[5] - 256 : bytes[5];
      const m = measure(s, 0.003, semis ? Math.min(0.034, 0.003 + bytes[6] / 100 / 8) : 0.034);    // a slide: only its first step
      console.log([cart.padEnd(5), String(id).padStart(2), ' ' + CH[bytes[0] & 3].padEnd(8), String(bytes[2]).padStart(4),
        (tonal ? noteHz(bytes[2]).toFixed(1) : '-').padStart(10), (tonal && m.hz ? m.hz.toFixed(1) : '-').padStart(10),
        (bytes[6] / 100).toFixed(2).padStart(10), m.seconds.toFixed(2).padStart(9), m.peak.toFixed(3).padStart(7),
        semis ? `  slides ${semis > 0 ? '+' : ''}${semis} semitones` : ''].join(' '));
      if (out) fs.writeFileSync(path.join(out, `${cart}-sfx-${String(id).padStart(2, '0')}.wav`), wav(s));
    }
    for (const { id, song } of patterns) {
      // music: step the song the way sound.js does on its timer, one step at a time
      render(0.3);
      const parts = [];
      for (let lap = 0; lap < 2; lap++) for (let step = 0; step < song.steps; step++) {
        for (let ch = 0; ch < 4; ch++) { const n = song.notes[step * 4 + ch]; if (n) sound.voice(ch, 1, n, ch === 2 ? song.vol * 2 : song.vol, 0, Math.max(3, Math.round(song.step * 100 * 0.9)), 1, 0, false); }
        parts.push(render(song.step));
      }
      const s = Float32Array.from(parts.flatMap((p) => [...p])), m = measure(s);
      console.log(`${cart.padEnd(5)} music pattern ${id}: ${song.steps} steps of ${song.step}s, two laps = ${(s.length / RATE).toFixed(1)} s, peak ${m.peak.toFixed(3)}`);
      if (out) fs.writeFileSync(path.join(out, `${cart}-music-${id}.wav`), wav(s));
    }
  }
  { render(0.3); sound.click(); const s = render(0.3), m = measure(s);
    console.log(`the local button click: ${m.hz.toFixed(0)} Hz, ${m.seconds.toFixed(2)} s, peak ${m.peak.toFixed(3)}`);
    if (out) fs.writeFileSync(path.join(out, 'click.wav'), wav(s)); }
  if (out) console.log('\n.wav files written to ' + out);
}
