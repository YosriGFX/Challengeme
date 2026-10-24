// One translated Game Boy instance, and the link cable between two of them.
// Shared by the browser worker and the dev test harness. Plain ES module, no imports.
//
// The game's code is native WebAssembly produced ahead of time by the translator; this
// file only creates the shared memory, calls run_frame, and moves link-cable bytes.

export const FRAME_CYCLES = 70224;                 // 154 lines x 456 dots
export const FRAME_HZ = 4194304 / FRAME_CYCLES;    // 59.7275
export const FB_BYTES = 160 * 144 * 4;

// Control block offsets in the shared memory (Phase 1, section 3).
const FRAME_SEQ = 0x10000;
const FRONT = 0x10004;
const JOYPAD = 0x10008;
const SER_PENDING = 0x10010;
const SER_TX = 0x10014;
const SER_RX = 0x10018;
const SER_RX_READY = 0x1001c;
const TRAP_BANK = 0x10020;
const FB = 0x20000;

// Joypad bits, 1 = pressed.
export const BUTTONS = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };

// Reads the page count of the shared memory the module imports, so it can be created
// with exactly the declared size (an imported shared memory must match it).
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
  throw new Error("the module imports no memory");
}

// Views on a machine's shared buffer, usable from any thread that holds it.
export function frontPixels(buffer) {
  const front = Atomics.load(new Int32Array(buffer, FRONT, 1), 0);
  return new Uint8Array(buffer, FB + front * FB_BYTES, FB_BYTES);
}

export function frameSeq(buffer) {
  return Atomics.load(new Int32Array(buffer, FRAME_SEQ, 1), 0);
}

export function setButtons(buffer, bits) {
  Atomics.store(new Int32Array(buffer, JOYPAD, 1), 0, bits & 0xff);
}

export class GameBoy {
  constructor(module, pages) {
    this.memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    this.x = new WebAssembly.Instance(module, { env: { mem: this.memory } }).exports;
    this.buffer = this.memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
    this.trap = null;
    this.x.reset();
  }

  // Runs `cycles` of game code. A jump to code the translator did not see traps; the
  // machine then stops and `trap` names the address to add to the hints file.
  run(cycles) {
    if (this.trap) return;
    try {
      this.x.run_frame(cycles);
    } catch (e) {
      const pc = this.x.PC.value, bank = Atomics.load(this.i32, TRAP_BANK >> 2);
      const at = pc >= 0x4000 && pc < 0x8000
        ? `${hex(bank, 2)}:${hex(pc, 4)}` : hex(pc, 4);
      this.trap = { message: e.message, pc, bank, at };
    }
  }

  set buttons(bits) { setButtons(this.buffer, bits); }
  get frameSeq() { return frameSeq(this.buffer); }
  get pixels() { return frontPixels(this.buffer); }
}

// A master `m` started a transfer (FF02 = 0x81). If the other side `s` is waiting on
// its external clock (FF02 bit 7 set, bit 0 clear), the two bytes swap: the master's
// runtime finishes its transfer with `s`'s byte, and the slave gets its byte and its
// serial interrupt now. If both sides started as master at once, this cable still swaps
// the two bytes (real hardware would garble them; games then retry, and two players
// pressing together must not lock the link). If nobody answers, the master reads 0xFF.
function exchange(m, s) {
  if (!pending(m)) return;
  const out = Atomics.load(m.i32, SER_TX >> 2);
  let back;
  if (pending(s)) {
    back = Atomics.load(s.i32, SER_TX >> 2);
    Atomics.store(s.i32, SER_RX >> 2, out);
    Atomics.store(s.i32, SER_RX_READY >> 2, 1);
  } else if ((s.u8[0xff02] & 0x81) === 0x80) {
    back = s.u8[0xff01];
    s.u8[0xff01] = out;
    s.u8[0xff02] &= 0x7f;
    s.u8[0xff0f] |= 0x08;
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
