// Sound for the phones, as the Game Boy's own sound register writes. The game runs here;
// a phone gets what its game wrote to FF10-FF3F and when, and plays it on its own copy of
// the sound chip (public/apu.js). Like the screen updates, this is output only: a few
// bytes per frame, and nothing a phone could use to change the game.
//
// Message: u8 8, u32 LE `end`, then per write: u32 LE cycle, u8 register (low byte of
// its address), u8 value. Cycles count from the machine's reset, modulo 2^32; `end` is
// how far the machine has run, so the phone can keep its playback a fixed delay behind.

export const MSG_SOUND = 8;

const TRIGGERS = new Set([0x14, 0x19, 0x1e, 0x23]);

export function encodeSound(writes, end) {
  const n = writes.length / 3;
  const out = new Uint8Array(5 + n * 6);
  const v = new DataView(out.buffer);
  out[0] = MSG_SOUND;
  v.setUint32(1, end >>> 0, true);
  for (let i = 0, p = 5; i < writes.length; i += 3, p += 6) {
    v.setUint32(p, writes[i] >>> 0, true);
    out[p + 4] = writes[i + 1];
    out[p + 5] = writes[i + 2];
  }
  return out;
}

// The sound registers as they are now, as writes at cycle `at`, for a phone that just
// joined: power first, then the rest, without retriggering notes.
export function soundState(u8, at) {
  const writes = [at, 0x26, u8[0xff26]];
  for (let r = 0x10; r < 0x40; r++) {
    if (r === 0x26 || (r > 0x26 && r < 0x30)) continue;
    writes.push(at, r, TRIGGERS.has(r) ? u8[0xff00 + r] & 0x7f : u8[0xff00 + r]);
  }
  return writes;
}
