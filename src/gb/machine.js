// One translated Game Boy instance, and the link cable between two of them.
// Used by the Match Durable Object (server build of a game) and by the dev test harness
// (either build). Plain ES module, no imports.
//
// The game's code is native WebAssembly produced ahead of time by the translator; this
// file only calls run_frame, moves link-cable bytes and packs finished frames.

export const FRAME_CYCLES = 70224;                 // 154 lines x 456 dots
export const FRAME_HZ = 4194304 / FRAME_CYCLES;    // 59.7275
export const FB_BYTES = 160 * 144 * 4;

// Control block offsets in the game's memory (Phase 1, section 3).
const FRAME_SEQ = 0x10000;
const FRONT = 0x10004;
const JOYPAD = 0x10008;
const SER_PENDING = 0x10010;
const SER_TX = 0x10014;
const SER_RX = 0x10018;
const SER_RX_READY = 0x1001c;
const TRAP_BANK = 0x10020;
const SOUND_LEN = 0x10024;
const SOUND_LOG = 0x14000;
const FB = 0x20000;

// Joypad bits, 1 = pressed.
export const BUTTONS = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };

// Shade index of each DMG colour the runtime writes, keyed by its red byte.
const SHADE_OF_RED = new Uint8Array(256);
SHADE_OF_RED[0xe0] = 0; SHADE_OF_RED[0x88] = 1; SHADE_OF_RED[0x34] = 2; SHADE_OF_RED[0x08] = 3;

// Page count of the shared memory a browser-build module imports (0 for a server build,
// which owns its memory). An imported shared memory must be created with exactly this size.
export function memoryPages(bytes) {
  const b = new Uint8Array(bytes);
  let p = 8;
  const leb = () => {
    let r = 0, s = 0, x;
    do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    return r >>> 0;
  };
  const skipName = () => { const n = leb(); p += n; };
  while (p < b.length) {
    const id = b[p++], size = leb(), end = p + size;
    if (id === 2) {
      for (let n = leb(); n > 0; n--) {
        skipName(); skipName();
        const kind = b[p++];
        if (kind === 2) { leb(); return leb(); }            // limits flags, then initial
        if (kind === 0) leb();
        else if (kind === 1) { p++; if (leb() & 1) leb(); leb(); }
        else if (kind === 3) p += 2;
        else if (kind === 4) { p++; leb(); }
      }
    }
    p = end;
  }
  return 0;
}

export class GameBoy {
  constructor(module, pages = 0) {
    if (pages) {
      const mem = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
      this.x = new WebAssembly.Instance(module, { env: { mem } }).exports;
      this.buffer = mem.buffer;
    } else {
      this.x = new WebAssembly.Instance(module, {}).exports;
      this.buffer = this.x.mem.buffer;
    }
    this.u8 = new Uint8Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
    this.trap = null;
    this.toSlave = null;              // link byte for the slave, due when our transfer ends
    this.clock = 0;                   // cycles run since reset
    this.sound = [];                  // sound register writes not yet taken: cycle, register, value
    this.x.reset();
  }

  // Runs `cycles` of game code. A jump to code the translator did not see traps; the
  // machine then stops and `trap` names the address to add to the hints file.
  run(cycles) {
    if (this.trap) return;
    try {
      this.x.run_frame(cycles);
      this.clock += cycles;
      this.drainSound();
    } catch (e) {
      const pc = this.x.PC.value, bank = Atomics.load(this.i32, TRAP_BANK >> 2);
      const at = pc >= 0x4000 && pc < 0x8000 ? `${hex(bank, 2)}:${hex(pc, 4)}` : hex(pc, 4);
      this.trap = { message: e.message, pc, bank, at };
    }
  }

  // The sound log holds each write's distance back from the end of the budget just run.
  drainSound() {
    const n = this.i32[SOUND_LEN >> 2];
    if (n === 0) return;
    for (let i = 0, p = SOUND_LOG; i < n; i++, p += 8) {
      this.sound.push(this.clock - this.i32[p >> 2], this.u8[p + 4], this.u8[p + 5]);
    }
    this.i32[SOUND_LEN >> 2] = 0;
  }

  // Sound register writes since the last call, as [cycle, register, value, ...].
  takeSound() {
    const out = this.sound;
    this.sound = [];
    return out;
  }

  // The whole machine between frames: memory, every exported global, and the link byte
  // owed to the other Game Boy. load() takes what save() returned on a machine built
  // from the same module.
  save() {
    const globals = {};
    for (const [name, g] of Object.entries(this.x)) if (g instanceof WebAssembly.Global) globals[name] = g.value;
    return { mem: this.u8.slice(), globals, toSlave: this.toSlave, trap: this.trap, clock: this.clock };
  }

  load(state) {
    this.u8.set(state.mem);
    for (const [name, v] of Object.entries(state.globals)) {
      try { this.x[name].value = v; } catch { /* immutable (cartridge constants) */ }
    }
    this.toSlave = state.toSlave;
    this.trap = state.trap;
    this.clock = state.clock ?? 0;
    this.sound = [];
  }

  set buttons(bits) { Atomics.store(this.i32, JOYPAD >> 2, bits & 0xff); }
  get frameSeq() { return Atomics.load(this.i32, FRAME_SEQ >> 2); }

  // The last finished frame, RGBA.
  get pixels() {
    return this.u8.subarray(FB + Atomics.load(this.i32, FRONT >> 2) * FB_BYTES).subarray(0, FB_BYTES);
  }

  // The last finished frame as shade indices 0-3, one byte per pixel (what the screen
  // updates in frames.js are computed from).
  shadesInto(out) {
    const px = this.pixels;
    for (let i = 0, o = 0; o < 160 * 144; o++, i += 4) out[o] = SHADE_OF_RED[px[i]];
    return out;
  }
}

// A master `m` started a transfer (FF02 = 0x81). If the other side `s` is waiting on
// its external clock (FF02 bit 7 set, bit 0 clear), the two bytes swap: the master's
// runtime finishes its transfer with `s`'s byte 4096 cycles after it started, and `s` gets
// its byte and its serial interrupt at that same moment, as on hardware (a slave that
// heard the byte early could still overwrite FF01 before taking the interrupt, and
// Dr. Mario then picks the wrong side). If both sides started as master at once, this
// cable still swaps the two bytes (real hardware would garble them; games then retry,
// and two players pressing together must not lock the link). If nobody answers, the
// master reads 0xFF.
function exchange(m, s) {
  if (m.toSlave !== null && Atomics.load(m.i32, SER_PENDING >> 2) === 0) {
    if ((s.u8[0xff02] & 0x81) === 0x80) {                // still listening
      s.u8[0xff01] = m.toSlave;
      s.u8[0xff02] &= 0x7f;
      s.u8[0xff0f] |= 0x08;
    }
    m.toSlave = null;
  }
  if (!pending(m)) return;
  const out = Atomics.load(m.i32, SER_TX >> 2);
  let back;
  if (pending(s)) {
    back = Atomics.load(s.i32, SER_TX >> 2);
    Atomics.store(s.i32, SER_RX >> 2, out);
    Atomics.store(s.i32, SER_RX_READY >> 2, 1);
  } else if ((s.u8[0xff02] & 0x81) === 0x80) {
    back = s.u8[0xff01];
    m.toSlave = out;
  } else {
    return;
  }
  Atomics.store(m.i32, SER_RX >> 2, back);
  Atomics.store(m.i32, SER_RX_READY >> 2, 1);
}

function pending(m) {
  return Atomics.load(m.i32, SER_PENDING >> 2) !== 0 && Atomics.load(m.i32, SER_RX_READY >> 2) === 0;
}

// Runs two machines connected by a link cable, in step, one scanline at a time.
// A transfer takes 4096 cycles, so a byte is never more than one slice late.
export function runLinked(a, b, cycles, slice = 456) {
  for (let done = 0; done < cycles; done += slice) {
    const n = Math.min(slice, cycles - done);
    a.run(n);
    b.run(n);
    exchange(a, b);
    exchange(b, a);
  }
}

function hex(v, w) {
  return v.toString(16).toUpperCase().padStart(w, "0");
}
