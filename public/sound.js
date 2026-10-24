// This phone's Game Boy sound. The server sends its game's sound register writes
// (src/gb/sound.js); the sound chip itself runs in an AudioWorklet (apu.js). Browsers
// start audio only after a tap or a key press, so until then this keeps the registers'
// latest values and hands them over when the sound starts.

const MSG_SOUND = 8;
const TRIGGERS = new Set([0x14, 0x19, 0x1e, 0x23]);

export class Sound {
  constructor() {
    this.ctx = null;
    this.post = null;                   // hands messages to the sound chip once it runs
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
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;
    this.ctx = new Context({ latencyHint: "interactive" });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : 0.6;
    this.gain.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    let post;
    if (this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule("/apu.js");
      const node = new AudioWorkletNode(this.ctx, "gameboy-sound", { outputChannelCount: [2] });
      node.connect(this.gain);
      post = (msg) => node.port.postMessage(msg);
    } else {
      // No AudioWorklet outside https and localhost: run the same chip on the page.
      const { Player } = await import("/apu.js");
      const player = new Player(this.ctx.sampleRate);
      const node = this.ctx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => player.render(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
      node.connect(this.gain);
      this.keep = node;                   // some browsers stop a processor nobody refers to
      post = (msg) => player.receive(msg);
    }
    const state = [0x26, this.regs[0x26]];
    for (let r = 0x10; r < 0x40; r++) {
      if (r !== 0x26) state.push(r, TRIGGERS.has(r) ? this.regs[r] & 0x7f : this.regs[r]);
    }
    post({ state });
    this.post = post;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 0.6;
    try { localStorage.setItem("mute", muted ? "1" : "0"); } catch { /* not kept */ }
  }

  // The server starts over (a new seat): forget the old timeline.
  reset() {
    this.last = null;
    this.post?.("reset");
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
    this.post?.({ writes, end });
  }

  // Server cycles arrive modulo 2^32; count on from the newest one.
  unwrap(t) {
    if (this.last === null) { this.last = t; return t; }
    const t2 = this.last + ((t - (this.last >>> 0)) | 0);
    if (t2 > this.last) this.last = t2;
    return t2;
  }
}
