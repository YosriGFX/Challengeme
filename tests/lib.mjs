// lib.mjs — helpers shared by the tests. Zero dependencies (Node.js 18+ built-ins only).
//
// Packets are always decoded by the real client PPU (public/ppu.wasm), so every test
// also checks that the encoder in sdk/runtime.c and the parser in ppu/ppu.c agree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

export const F = { DRAW: 1, TRANS: 2, EVENT: 4, RESET: 8, ERROR: 128 };
export const OP = { NOP: 0, RECT: 1, CIRC: 2, TRI: 3, DIAM: 4, LINE: 5, POINT: 6, TEXT: 7 };
export const IN = { ACTIVE: 8, A: 0x10, B: 0x20, U: 8 | 0, UR: 8 | 1, R: 8 | 2, DR: 8 | 3, D: 8 | 4, DL: 8 | 5, L: 8 | 6, UL: 8 | 7, act: (n) => (n - 1) << 6 };
export const W = { RESET: 0x01, FRAME: 0x02, OPS_LIST: 0x10, OPS_MASK: 0x11, STR: 0x20, BEGIN: 0x30, END: 0x31, PAL: 0x32, LABEL: 0x33, TICK: 0x34, SFXDEF: 0x35, MUSDEF: 0x36, SFX: 0x40, MUSIC: 0x41 };

const ppuModule = new WebAssembly.Module(read('public/ppu.wasm'));

// One client memory map: what one player's device holds.
export class PPU {
  constructor() {
    this.x = new WebAssembly.Instance(ppuModule, {}).exports;
    this.sfx = [];            // ids of every sound the server triggered
    this.music = null;        // last [cmd, pattern]
    this.bytes = 0; this.packets = 0;
  }
  mem(ptr, n) { return new Uint8Array(this.x.memory.buffer, ptr, n); }
  apply(packet) {
    this.bytes += packet.length; this.packets++;
    if (packet.length > 4096) return F.ERROR;
    this.mem(this.x.ppu_rx(), 4096).set(packet);
    const flags = this.x.ppu_apply(packet.length);
    if (!(flags & F.ERROR) && (flags & F.EVENT)) {
      const ev = this.mem(this.x.ppu_events(), 64);
      for (let i = 0; i < this.x.ppu_events_n(); i++) {
        if (ev[i * 3] === W.SFX) this.sfx.push(ev[i * 3 + 1]); else this.music = [ev[i * 3 + 1], ev[i * 3 + 2]];
      }
    }
    return flags;
  }
  get ops() { return this.mem(this.x.ppu_ops(), 2048); }
  op(slot) { return Array.from(this.ops.subarray(slot * 8, slot * 8 + 8)); }
  str(id) { const b = this.mem(this.x.ppu_strs(), 256); let s = ''; for (let i = 0; i < 16 && b[id * 16 + i]; i++) s += String.fromCharCode(b[id * 16 + i]); return s; }
  label(button) { const b = this.mem(this.x.ppu_labels(), 24); let s = ''; for (let i = 0; i < 8 && b[(button - 2) * 8 + i]; i++) s += String.fromCharCode(b[(button - 2) * 8 + i]); return s; }
  get tick() { return this.x.ppu_tick(); }
  get frame() { return this.x.ppu_frame(); }
  get pal() { return Array.from(this.mem(this.x.ppu_pal(), 24)); }
  // every string that a TEXT op on screen points to
  texts() { const out = []; for (let s = 0; s < 256; s++) { const o = this.op(s); if (o[0] === OP.TEXT) out.push(this.str(o[6] & 15)); } return out; }
  count(opcode) { let n = 0; for (let s = 0; s < 256; s++) if (this.ops[s * 8] === opcode) n++; return n; }
}

// A cartridge driven directly through its host exports (no sockets, no timers):
// one PPU per view, flushed after every call exactly as host/match.mjs does.
export class Cart {
  constructor(wasm) {
    const bytes = typeof wasm === 'string' ? read(wasm) : wasm;
    this.x = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
    this.x.con_init();
    this.players = this.x.con_players();
    this.views = [];
    for (let v = 0; v <= this.players; v++) this.views.push(new PPU());
    this.joined = new Set();
    this.errors = 0;
  }
  packet(view, full = 0) {
    const len = this.x.con_flush(view, full);
    return len ? new Uint8Array(this.x.memory.buffer, this.x.con_packet(), len).slice() : null;
  }
  flush(full = -1) {
    const sizes = [];
    for (const v of this.joined) {
      const p = this.packet(v, v === full ? 1 : 0);
      sizes[v] = p ? p.length : 0;
      if (p && (this.views[v].apply(p) & F.ERROR)) this.errors++;
    }
    return sizes;
  }
  join(v) { this.joined.add(v); if (v < this.players) this.x.con_presence(v, 1); return this.flush(v); }
  leave(v) { this.joined.delete(v); if (v < this.players) this.x.con_presence(v, 0); return this.flush(); }
  input(p, byte) { this.x.con_input(p, byte); return this.flush(); }
  tap(p, byte) { this.input(p, byte); return this.input(p, 0); }       // press and release
  sys(p, code) { this.x.con_sys(p, code); return this.flush(); }
  tick(n = 1) { let last; for (let i = 0; i < n; i++) { this.x.con_tick(); last = this.flush(); } return last; }
  get hz() { return this.x.con_tick_hz(); }
}

// A fake socket for host/match.mjs.
export function conn() {
  const c = { view: -1, ppu: new PPU(), packets: [], closed: false, errors: 0 };
  c.send = (bytes) => { c.packets.push(bytes); if (c.ppu.apply(bytes) & F.ERROR) c.errors++; };
  c.close = () => { c.closed = true; };
  return c;
}
