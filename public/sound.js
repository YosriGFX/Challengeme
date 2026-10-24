// This phone's Game Boy sound. The server sends its game's sound register writes
// (src/gb/sound.js); the sound chip itself runs in an AudioWorklet (apu.js). Browsers
// start audio only after a tap or a key press, so until then this keeps the registers'
// latest values and hands them over when the sound starts.

const MSG_SOUND = 4;
const TRIGGERS = new Set([0x14, 0x19, 0x1e, 0x23]);

export class Sound {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.regs = new Uint8Array(0x40);
    this.last = null;                   // newest server cycle, unwrapped
    this.muted = false;
    try { this.muted = localStorage.getItem("mute") === "1"; } catch { /* default */ }
  }

  static is(buf) {
    return buf[0] === MSG_SOUND;
  }

  // Call from a tap or key handler: browsers allow audio to start only there.
  async unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      return;
    }
    if (!window.AudioWorkletNode) return;
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    try {
      await this.ctx.audioWorklet.addModule("/apu.js");
    } catch {
      return;
    }
    this.node = new AudioWorkletNode(this.ctx, "gameboy-sound", { outputChannelCount: [2] });
    this.gain = new GainNode(this.ctx, { gain: this.muted ? 0 : 0.6 });
    this.node.connect(this.gain).connect(this.ctx.destination);
    const state = [0x26, this.regs[0x26]];
    for (let r = 0x10; r < 0x40; r++) {
      if (r !== 0x26) state.push(r, TRIGGERS.has(r) ? this.regs[r] & 0x7f : this.regs[r]);
    }
    this.node.port.postMessage({ state });
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 0.6;
    try { localStorage.setItem("mute", muted ? "1" : "0"); } catch { /* not kept */ }
  }

  // The server starts over (a new seat): forget the old timeline.
  reset() {
    this.last = null;
    this.node?.port.postMessage("reset");
  }

  feed(buf) {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 5 || (buf.length - 5) % 6 !== 0) return;
    const writes = [];
    for (let p = 5; p < buf.length; p += 6) {
      const r = buf[p + 4], val = buf[p + 5];
      if (r < 0x10 || r > 0x3f) continue;
      writes.push(this.unwrap(v.getUint32(p, true)), r, val);
      if (r === 0x26 && !(val & 0x80)) this.regs.fill(0, 0x10, 0x26);
      this.regs[r] = val;
    }
    const end = this.unwrap(v.getUint32(1, true));
    this.node?.port.postMessage({ writes, end });
  }

  // Server cycles arrive modulo 2^32; count on from the newest one.
  unwrap(t) {
    if (this.last === null) { this.last = t; return t; }
    const t2 = this.last + ((t - (this.last >>> 0)) | 0);
    if (t2 > this.last) this.last = t2;
    return t2;
  }
}
