// chip.js — the console's sound chip: the Game Boy APU from Challengeme (public/apu.js),
// unchanged. Two square-wave channels (the first with a frequency sweep), a wave channel
// playing 32 4-bit samples, and a noise channel, mixed to stereo.
//
// Only the player below it is new: here the chip is not fed by a server, it replays register
// writes that sound.js schedules. No imports: the file is loaded as an AudioWorklet module
// where the browser allows one (https or localhost) and imported by sound.js otherwise.

const CLOCK = 4194304;
const DUTY = [[0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 0]];
const WAVE_SHIFT = [4, 0, 1, 2];

function channel(kind) {
  return { kind, on: false, dac: false, length: 0, lengthOn: false, timer: 0, period: 4096, freq: 0,
           vol: 0, envInit: 0, envUp: false, envPeriod: 0, envTimer: 0, duty: 0, pos: 0, shift: 4, lfsr: 0x7fff, narrow: false,
           sweepPeriod: 0, sweepDown: false, sweepShift: 0, sweepTimer: 0, sweepOn: false, shadow: 0 };
}

class Apu {
  constructor() {
    this.reset();
  }

  reset() {
    this.regs = new Uint8Array(0x40);              // indexed by the register's low address byte
    this.power = true;
    this.regs[0x24] = 0x77;
    this.regs[0x25] = 0xf3;
    this.ch = [channel("square"), channel("square"), channel("wave"), channel("noise")];
    this.seqTimer = 8192;
    this.seqStep = 0;
  }

  write(r, v) {
    if (r >= 0x30) { this.regs[r] = v; return; }           // wave samples
    if (r === 0x26) {
      const was = this.power;
      this.power = (v & 0x80) !== 0;
      if (!this.power) {
        this.regs.fill(0, 0x10, 0x26);
        for (const c of this.ch) { c.on = false; c.dac = false; }
      } else if (!was) {
        this.seqStep = 0;
      }
      this.regs[r] = v & 0x80;
      return;
    }
    if (!this.power) return;
    this.regs[r] = v;
    const [c1, c2, c3, c4] = this.ch;
    switch (r) {
      case 0x10: c1.sweepPeriod = (v >> 4) & 7; c1.sweepDown = (v & 8) !== 0; c1.sweepShift = v & 7; break;
      case 0x11: case 0x16: { const c = r === 0x11 ? c1 : c2; c.duty = v >> 6; c.length = 64 - (v & 63); break; }
      case 0x12: case 0x17: envelope(r === 0x12 ? c1 : c2, v); break;
      case 0x13: case 0x18: { const c = r === 0x13 ? c1 : c2; setFreq(c, (c.freq & 0x700) | v, 4); break; }
      case 0x14: case 0x19: {
        const c = r === 0x14 ? c1 : c2;
        setFreq(c, (c.freq & 0xff) | ((v & 7) << 8), 4);
        c.lengthOn = (v & 0x40) !== 0;
        if (v & 0x80) this.trigger(c, 64);
        break;
      }
      case 0x1a: c3.dac = (v & 0x80) !== 0; if (!c3.dac) c3.on = false; break;
      case 0x1b: c3.length = 256 - v; break;
      case 0x1c: c3.shift = WAVE_SHIFT[(v >> 5) & 3]; break;
      case 0x1d: setFreq(c3, (c3.freq & 0x700) | v, 2); break;
      case 0x1e:
        setFreq(c3, (c3.freq & 0xff) | ((v & 7) << 8), 2);
        c3.lengthOn = (v & 0x40) !== 0;
        if (v & 0x80) this.trigger(c3, 256);
        break;
      case 0x20: c4.length = 64 - (v & 63); break;
      case 0x21: envelope(c4, v); break;
      case 0x22: c4.period = ((v & 7) ? (v & 7) * 16 : 8) << (v >> 4); c4.narrow = (v & 8) !== 0; break;
      case 0x23: c4.lengthOn = (v & 0x40) !== 0; if (v & 0x80) this.trigger(c4, 64); break;
    }
  }

  trigger(c, full) {
    c.on = c.dac;
    if (c.length === 0) c.length = full;
    c.timer = c.period;
    c.vol = c.envInit;
    c.envTimer = c.envPeriod || 8;
    if (c.kind === "wave") c.pos = 0;
    if (c.kind === "noise") c.lfsr = 0x7fff;
    if (c === this.ch[0]) {
      c.shadow = c.freq;
      c.sweepTimer = c.sweepPeriod || 8;
      c.sweepOn = c.sweepPeriod !== 0 || c.sweepShift !== 0;
      if (c.sweepShift && sweepNext(c) > 2047) c.on = false;
    }
  }

  // The frame sequencer, 512 times a second: lengths, sweep, envelopes.
  sequence() {
    const s = this.seqStep;
    this.seqStep = (s + 1) & 7;
    if ((s & 1) === 0) {
      for (const c of this.ch) if (c.lengthOn && c.length > 0 && --c.length === 0) c.on = false;
    }
    if (s === 2 || s === 6) {
      const c = this.ch[0];
      if (--c.sweepTimer <= 0) {
        c.sweepTimer = c.sweepPeriod || 8;
        if (c.sweepOn && c.sweepPeriod) {
          const f = sweepNext(c);
          if (f > 2047) c.on = false;
          else if (c.sweepShift) {
            c.shadow = f;
            setFreq(c, f, 4);
            if (sweepNext(c) > 2047) c.on = false;
          }
        }
      }
    }
    if (s === 7) {
      for (const c of [this.ch[0], this.ch[1], this.ch[3]]) {
        if (c.envPeriod && --c.envTimer <= 0) {
          c.envTimer = c.envPeriod;
          if (c.envUp && c.vol < 15) c.vol++;
          else if (!c.envUp && c.vol > 0) c.vol--;
        }
      }
    }
  }

  level(c) {
    if (!c.dac) return 0;
    let d = 0;
    if (c.on) {
      if (c.kind === "square") d = DUTY[c.duty][c.pos] ? c.vol : 0;
      else if (c.kind === "wave") d = (((this.regs[0x30 + (c.pos >> 1)] >> (c.pos & 1 ? 0 : 4)) & 15) >> c.shift);
      else d = c.lfsr & 1 ? 0 : c.vol;
    }
    return d / 7.5 - 1;
  }

  // Average output of channel `c` over the next `dt` cycles (a box filter, so fast
  // waves and noise don't alias into whistles).
  advance(c, dt) {
    let sum = 0, left = dt;
    while (c.timer <= left) {
      sum += this.level(c) * c.timer;
      left -= c.timer;
      c.timer = c.period;
      if (c.kind === "noise") {
        const x = (c.lfsr ^ (c.lfsr >> 1)) & 1;
        c.lfsr = (c.lfsr >> 1) | (x << 14);
        if (c.narrow) c.lfsr = (c.lfsr & ~0x40) | (x << 6);
      } else {
        c.pos = (c.pos + 1) & (c.kind === "wave" ? 31 : 7);
      }
    }
    c.timer -= left;
    return (sum + this.level(c) * left) / dt;
  }

  // One output sample covering `dt` cycles, as [left, right] before filtering.
  sample(dt, out) {
    this.seqTimer -= dt;
    while (this.seqTimer <= 0) { this.seqTimer += 8192; this.sequence(); }
    let l = 0, r = 0;
    const pan = this.regs[0x25];
    for (let i = 0; i < 4; i++) {
      const a = this.advance(this.ch[i], dt);
      if (pan & (0x10 << i)) l += a;
      if (pan & (1 << i)) r += a;
    }
    if (!this.power) l = r = 0;
    const vol = this.regs[0x24];
    out[0] = (l * (((vol >> 4) & 7) + 1)) / 32;
    out[1] = (r * ((vol & 7) + 1)) / 32;
  }
}

function envelope(c, v) {
  c.envInit = v >> 4;
  c.envUp = (v & 8) !== 0;
  c.envPeriod = v & 7;
  c.dac = (v & 0xf8) !== 0;
  if (!c.dac) c.on = false;
}

function setFreq(c, f, mul) {
  c.freq = f;
  c.period = (2048 - f) * mul;
}

function sweepNext(c) {
  const d = c.shadow >> c.sweepShift;
  return c.sweepDown ? c.shadow - d : c.shadow + d;
}

// Plays scheduled register writes: render() fills output buffers.
//   { writes: [seconds, register, value, ...] }  each write happens that many seconds from now
//   { cancel: [lowRegister, highRegister] }      first drop what is still queued for those registers
export class Player {
  constructor(rate) {
    this.rate = rate;
    this.apu = new Apu();
    this.queue = [];             // [cycle, register, value], in time order
    this.now = 0;                // the cycle being played
    this.capL = 0;
    this.capR = 0;
    this.lr = [0, 0];
  }

  receive(msg) {
    if (msg.cancel) this.queue = this.queue.filter((w) => w[1] < msg.cancel[0] || w[1] > msg.cancel[1]);
    const w = msg.writes;
    if (!w) return;
    for (let i = 0; i < w.length; i += 3) this.queue.push([this.now + w[i] * CLOCK, w[i + 1], w[i + 2]]);
    this.queue.sort((a, b) => a[0] - b[0]);      // stable: writes for the same moment keep their order
  }

  render(left, right) {
    const dt = CLOCK / this.rate, q = this.queue;
    const charge = Math.pow(0.999958, dt);
    for (let i = 0; i < left.length; i++) {
      while (q.length && q[0][0] <= this.now) { const w = q.shift(); this.apu.write(w[1], w[2]); }
      this.apu.sample(dt, this.lr);
      this.now += dt;
      // The Game Boy's output capacitor: removes the DC offset of the channels.
      const l = this.lr[0] - this.capL, r = this.lr[1] - this.capR;
      this.capL = this.lr[0] - l * charge;
      this.capR = this.lr[1] - r * charge;
      left[i] = l;
      right[i] = r;
    }
  }
}

if (typeof AudioWorkletProcessor === "function") {
  class ConsoleSound extends AudioWorkletProcessor {
    constructor() {
      super();
      this.player = new Player(sampleRate);
      this.port.onmessage = (e) => this.player.receive(e.data);
    }

    process(inputs, outputs) {
      const [left, right = left] = outputs[0];
      if (left) this.player.render(left, right);
      return true;
    }
  }
  registerProcessor("console-sound", ConsoleSound);
}
