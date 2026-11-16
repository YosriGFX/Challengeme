// sound.js — the client APU. It drives the Game Boy sound chip in chip.js.
//
// The contract with a cartridge is unchanged: an 8-byte preset
//   [channel][duty][note][volume][-][sweep][length][flags]
// and music patterns of 4 notes per step. This file turns them into the chip's register
// writes. Channels: 0 and 1 = the two pulse channels, 2 = the wave channel (loaded with a
// triangle wave), 3 = noise.

const REG = [0x10, 0x15, 0x1a, 0x1f];              // first register of each channel
const END = [0x14, 0x19, 0x1e, 0x23];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const hz = (note) => 440 * Math.pow(2, (note - 69) / 12);
const pulseFreq = (f) => clamp(2048 - 131072 / f, 0, 2047);
const waveFreq = (f) => clamp(2048 - 65536 / f, 0, 2047);

export class Sound {
  constructor() {
    this.ctx = null; this.post = null; this.starting = false;
    this.pending = null;                             // the context while the chip is still loading
    this.sound = true; this.musicOn = true;
    this.song = null; this.timer = null;
  }

  // Call from a tap or key handler: browsers allow audio to start only there.
  // Safari also stops the context ("interrupted") after a call, the lock screen or another
  // app's audio: any state but "running" gets a resume here.
  async start() {
    const now = this.ctx ?? this.pending;
    if (now) { if (now.state !== 'running') now.resume().catch(() => {}); return; }
    if (this.starting) return;
    this.starting = true;
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = new AC(); }
    this.pending = ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    gain.connect(ctx.destination);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    let post;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      await ctx.audioWorklet.addModule('chip.js');
      const node = new AudioWorkletNode(ctx, 'console-sound', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(gain);
      post = (msg) => node.port.postMessage(msg);
    } catch {
      // No AudioWorklet outside https and localhost: run the same chip on the page.
      const { Player } = await import('./chip.js');
      const player = new Player(ctx.sampleRate);
      const node = ctx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => player.render(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
      node.connect(gain);
      this.keep = node;                              // some browsers stop a processor nobody refers to
      post = (msg) => player.receive(msg);
    }
    // power on, full volume, every channel on both sides, and a triangle in the wave table
    const w = [0, 0x26, 0x80, 0, 0x24, 0x77, 0, 0x25, 0xff, 0, 0x1a, 0x00];
    for (let i = 0; i < 16; i++) {
      const a = i * 2 < 16 ? i * 2 : 31 - i * 2, b = i * 2 + 1 < 16 ? i * 2 + 1 : 30 - i * 2;
      w.push(0, 0x30 + i, (a << 4) | b);
    }
    post({ writes: w });
    this.ctx = ctx; this.post = post; this.pending = null;
    if (this.song && this.musicOn) this.#startTimer();
  }

  setSound(on) { this.sound = on; }
  setMusic(on) { this.musicOn = on; if (!on) this.#stopTimer(); else if (this.song) this.#startTimer(); }

  // One voice, `delay` seconds from now. replace = a new sound takes the channel over.
  voice(ch, duty, note, vol, sweep, len10, flags, delay = 0, replace = true) {
    if (!this.post || this.ctx.state !== 'running') return;
    ch &= 3;
    const dur = Math.max(0.03, len10 / 100), decay = flags & 1;
    const semis = sweep > 127 ? sweep - 256 : sweep;
    const v = clamp(vol, 1, 15), f = hz(note), r = REG[ch], w = [];
    const at = (t, reg, val) => w.push(delay + t, reg, val & 0xff);
    const steps = semis ? 6 : 0;
    let sounding = dur;

    if (ch < 2) {                                    // pulse: volume envelope, or a fixed length
      const p = clamp(dur * 64 / v, 1, 7), L = clamp(dur * 256, 1, 64), len = decay ? 0 : 0x40;
      if (decay) sounding = v * p / 64;
      const x = pulseFreq(f);
      if (ch === 0) at(0, 0x10, 0);
      at(0, r + 1, ((duty & 3) << 6) | (decay ? 0 : 64 - L));
      at(0, r + 2, (v << 4) | (decay ? p : 0));
      at(0, r + 3, x); at(0, r + 4, 0x80 | len | (x >> 8));
      for (let i = 1; i <= steps; i++) {             // pitch slide
        const xi = pulseFreq(f * Math.pow(2, semis * i / steps / 12));
        at(sounding * i / (steps + 1), r + 3, xi); at(sounding * i / (steps + 1), r + 4, len | (xi >> 8));
      }
    } else if (ch === 2) {                           // wave (triangle): 3 volume levels, fixed length
      const L = clamp(dur * 256, 1, 256), x = waveFreq(f);
      let level = v >= 10 ? 1 : v >= 5 ? 2 : 3;
      at(0, 0x1a, 0x80); at(0, 0x1b, 256 - L); at(0, 0x1c, level << 5);
      at(0, 0x1d, x); at(0, 0x1e, 0xc0 | (x >> 8));
      if (decay) for (const t of [0.45, 0.75]) if (level < 3) at(dur * t, 0x1c, ++level << 5);
      for (let i = 1; i <= steps; i++) {
        const xi = waveFreq(f * Math.pow(2, semis * i / steps / 12));
        at(dur * i / (steps + 1), 0x1d, xi); at(dur * i / (steps + 1), 0x1e, 0x40 | (xi >> 8));
      }
    } else {                                         // noise: higher note = brighter hiss
      const p = clamp(dur * 64 / v, 1, 7), L = clamp(dur * 256, 1, 64);
      if (decay) sounding = v * p / 64;
      const s = clamp((100 - note) / 7, 0, 13), slide = clamp(-semis / 6, -4, 4);
      at(0, 0x20, decay ? 0 : 64 - L);
      at(0, 0x21, (v << 4) | (decay ? p : 0));
      at(0, 0x22, (s << 4) | 1); at(0, 0x23, 0x80 | (decay ? 0 : 0x40));
      for (let i = 1; i <= Math.abs(slide); i++)
        at(sounding * i / (Math.abs(slide) + 1), 0x22, (clamp(s + Math.sign(slide) * i, 0, 13) << 4) | 1);
    }
    this.post(replace ? { cancel: [r, END[ch]], writes: w } : { writes: w });
  }

  // A preset from the sound bank (8 bytes), triggered by the server.
  sfx(p) { if (this.sound && p[6]) this.voice(p[0], p[1], p[2], p[3], p[5], p[6], p[7]); }

  // Local, instant feedback for the player's own presses (never sent by the server).
  click() { if (this.sound) this.voice(1, 0, 84, 4, 0, 3, 0); }

  // song: { step: seconds, steps, vol, notes: Uint8Array(steps * 4) }, looped on the client's own clock
  // keep = true: if this very song is already playing, let it play on (a full dump after
  // a resync repeats the music command; the player must not hear the song start over).
  playMusic(song, keep = false) {
    const s = this.song;
    if (keep && s && s.step === song.step && s.steps === song.steps && s.vol === song.vol && s.notes.join() === song.notes.join()) return;
    this.song = song; this.step = 0;
    this.#stopTimer();
    if (this.musicOn) this.#startTimer();
  }
  stopMusic() { this.song = null; this.#stopTimer(); }

  #startTimer() {
    if (this.timer || !this.song || !this.ctx) return;
    this.next = 0;
    this.timer = setInterval(() => {
      const ctx = this.ctx, s = this.song;
      if (!ctx || !s || ctx.state !== 'running') return;
      if (this.next < ctx.currentTime) this.next = ctx.currentTime + 0.05;
      while (this.next < ctx.currentTime + 0.25) {
        for (let ch = 0; ch < 4; ch++) {
          const n = s.notes[this.step * 4 + ch];
          if (n) this.voice(ch, 1, n, ch === 2 ? s.vol * 2 : s.vol, 0, Math.max(3, Math.round(s.step * 100 * 0.9)), 1, this.next - ctx.currentTime, false);
        }
        this.step = (this.step + 1) % s.steps;
        this.next += s.step;
      }
    }, 60);
  }
  #stopTimer() { clearInterval(this.timer); this.timer = null; }
}
