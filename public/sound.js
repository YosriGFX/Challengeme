// sound.js — the APU on this device. It turns the console's sound contract into register
// writes for the Game Boy chip in chip.js.
//
// The contract a cartridge sees:
//   a preset is 8 bytes  [channel][duty][note][volume][-][sweep][length][flags]
//   a music pattern is up to 32 steps of 4 notes (pulse 1, pulse 2, triangle, noise)
// Channels 0 and 1 are the chip's two pulse channels, 2 is its wave channel loaded with a
// triangle, 3 is its noise channel.

const FIRST = [0x10, 0x15, 0x1a, 0x1f], LAST = [0x14, 0x19, 0x1e, 0x23];      // each channel's registers
const round = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const hertz = (note) => 440 * Math.pow(2, (note - 69) / 12);
const pulse = (hz) => round(2048 - 131072 / hz, 0, 2047);                     // the chip's frequency values
const wave = (hz) => round(2048 - 65536 / hz, 0, 2047);

export class Sound {
  constructor() {
    this.ctx = null;                // the running AudioContext
    this.pending = null;            // the same, while the chip is still loading
    this.post = null;               // hands messages to the chip
    this.sound = true; this.music = true;
    this.song = null; this.step = 0; this.next = 0; this.timer = null;
  }

  // Call from every tap, release and key press. Browsers start audio only there, and
  // Safari counts the end of a touch, not its start. Safari also stops a running context
  // ("interrupted") after a call or the lock screen: any state but "running" is resumed.
  async start() {
    const have = this.ctx ?? this.pending;
    if (have) { if (have.state !== 'running') have.resume().catch(() => {}); return; }
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { ctx = new AC(); }
    this.pending = ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0.6;
    gain.connect(ctx.destination);
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    let post;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      await ctx.audioWorklet.addModule('chip.js');
      const node = new AudioWorkletNode(ctx, 'console-sound', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(gain);
      post = (msg) => node.port.postMessage(msg);
    } catch {
      // No AudioWorklet outside https and localhost (a phone on a LAN address): the same
      // chip runs on the page instead.
      try {
        const { Player } = await import('./chip.js');
        const player = new Player(ctx.sampleRate);
        const node = ctx.createScriptProcessor(1024, 0, 2);
        node.onaudioprocess = (e) => player.render(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
        node.connect(gain);
        this.keep = node;           // some browsers stop a processor nobody refers to
        post = (msg) => player.receive(msg);
      } catch { this.pending = null; return; }                                // no sound on this device
    }
    // power on, full volume, every channel on both sides, a triangle in the wave table
    const w = [0, 0x26, 0x80, 0, 0x24, 0x77, 0, 0x25, 0xff, 0, 0x1a, 0x00];
    for (let i = 0; i < 16; i++) {
      const a = i < 8 ? i * 2 : 31 - i * 2, b = i < 8 ? i * 2 + 1 : 30 - i * 2;
      w.push(0, 0x30 + i, (a << 4) | b);
    }
    post({ writes: w });
    this.ctx = ctx; this.post = post; this.pending = null;
    if (this.song && this.music) this.#run();
  }

  setSound(on) { this.sound = on; }
  setMusic(on) { this.music = on; if (!on) this.#halt(); else if (this.song) this.#run(); }

  // One voice, `delay` seconds from now. replace: it takes its channel over from what plays there.
  voice(ch, duty, note, vol, sweep, len10, flags, delay = 0, replace = true) {
    if (!this.post || this.ctx.state !== 'running') return;
    ch &= 3;
    const dur = Math.max(0.03, len10 / 100), fade = flags & 1;
    const semis = sweep > 127 ? sweep - 256 : sweep;                          // signed semitones over the length
    const v = round(vol, 1, 15), hz = hertz(note), r = FIRST[ch], w = [];
    const at = (t, reg, val) => w.push(delay + t, reg, val & 0xff);
    const slides = semis ? 6 : 0;
    let sounds = dur;

    if (ch < 2) {                                    // pulse: the chip's volume envelope, or its length counter
      const pace = round(dur * 64 / v, 1, 7), ticks = round(dur * 256, 1, 64), cut = fade ? 0 : 0x40;
      if (fade) sounds = v * pace / 64;
      const x = pulse(hz);
      if (ch === 0) at(0, 0x10, 0);                  // the chip's own sweep stays off: slides are written below
      at(0, r + 1, ((duty & 3) << 6) | (fade ? 0 : 64 - ticks));
      at(0, r + 2, (v << 4) | (fade ? pace : 0));
      at(0, r + 3, x); at(0, r + 4, 0x80 | cut | (x >> 8));
      for (let i = 1; i <= slides; i++) {
        const xi = pulse(hz * Math.pow(2, semis * i / slides / 12)), t = sounds * i / (slides + 1);
        at(t, r + 3, xi); at(t, r + 4, cut | (xi >> 8));
      }
    } else if (ch === 2) {                           // wave (triangle): 3 volume levels, always a fixed length
      const ticks = round(dur * 256, 1, 256), x = wave(hz);
      let level = v >= 10 ? 1 : v >= 5 ? 2 : 3;
      at(0, 0x1a, 0x80); at(0, 0x1b, 256 - ticks); at(0, 0x1c, level << 5);
      at(0, 0x1d, x); at(0, 0x1e, 0xc0 | (x >> 8));
      if (fade) for (const t of [0.45, 0.75]) if (level < 3) at(dur * t, 0x1c, ++level << 5);
      for (let i = 1; i <= slides; i++) {
        const xi = wave(hz * Math.pow(2, semis * i / slides / 12)), t = dur * i / (slides + 1);
        at(t, 0x1d, xi); at(t, 0x1e, 0x40 | (xi >> 8));
      }
    } else {                                         // noise: a higher note is a brighter hiss
      const pace = round(dur * 64 / v, 1, 7), ticks = round(dur * 256, 1, 64);
      if (fade) sounds = v * pace / 64;
      const shift = round((100 - note) / 7, 0, 13), slide = round(-semis / 6, -4, 4);
      at(0, 0x20, fade ? 0 : 64 - ticks);
      at(0, 0x21, (v << 4) | (fade ? pace : 0));
      at(0, 0x22, (shift << 4) | 1); at(0, 0x23, 0x80 | (fade ? 0 : 0x40));
      for (let i = 1; i <= Math.abs(slide); i++)
        at(sounds * i / (Math.abs(slide) + 1), 0x22, (round(shift + Math.sign(slide) * i, 0, 13) << 4) | 1);
    }
    this.post(replace ? { cancel: [r, LAST[ch]], writes: w } : { writes: w });
  }

  // A preset from the sound bank, triggered by the server.
  sfx(p) { if (this.sound && p[6]) this.voice(p[0], p[1], p[2], p[3], p[5], p[6], p[7]); }

  // The player's own button press: played here at once, never sent by the server.
  click() { if (this.sound) this.voice(1, 0, 84, 4, 0, 3, 0); }

  // song: { step: seconds, steps, vol, notes: Uint8Array(steps * 4) }, looped on this device's clock.
  // keep: the same song already playing plays on (a full dump after a resync repeats the command).
  play(song, keep = false) {
    const s = this.song;
    if (keep && s && s.step === song.step && s.steps === song.steps && s.vol === song.vol && s.notes.join() === song.notes.join()) return;
    this.song = song; this.step = 0;
    this.#halt();
    if (this.music) this.#run();
  }
  stop() { this.song = null; this.#halt(); }

  #run() {
    if (this.timer || !this.song || !this.ctx) return;
    this.next = 0;
    this.timer = setInterval(() => {                 // schedule a quarter of a second ahead
      const ctx = this.ctx, s = this.song;
      if (!s || ctx.state !== 'running') return;
      if (this.next < ctx.currentTime) this.next = ctx.currentTime + 0.05;
      while (this.next < ctx.currentTime + 0.25) {
        for (let ch = 0; ch < 4; ch++) {
          const n = s.notes[this.step * 4 + ch];
          if (n) this.voice(ch, 1, n, ch === 2 ? s.vol * 2 : s.vol, 0, Math.max(3, Math.round(s.step * 90)), 1, this.next - ctx.currentTime, false);
        }
        this.step = (this.step + 1) % s.steps;
        this.next += s.step;
      }
    }, 60);
  }
  #halt() { clearInterval(this.timer); this.timer = null; }
}
