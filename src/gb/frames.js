// Screen updates in the spirit of VNC's RFB protocol: a phone is sent only what changed
// on a Game Boy's screen since the last update of that screen it was sent. Each phone
// follows both Game Boys of its match, so nobody plays against a black box.
//
//   [2 + screen][seq u16 LE][dx i8][dy i8][45-byte tile mask][tile, tile, ...]
//
// screen is 0 for player 1's Game Boy, 1 for player 2's. seq counts all updates sent to
// one phone, both screens together; the phone acknowledges the last one it drew.
//
// 1. Move (like RFB's CopyRect): when the picture scrolled, the phone first shifts what
//    it has by (dx, dy). Pixel (x, y) becomes old (x - dx, y - dy); pixels whose source is
//    off screen keep their old value.
// 2. Tiles (like RFB's Hextile): the screen is 20 x 18 tiles of 8 x 8 pixels; bit t of the
//    mask (t = row * 20 + col, low bit first) says tile t follows. Each tile is one of:
//      0b000000ss            solid, shade s                            1 byte
//      0b0001ffbb + 8 bytes  two shades: bit set = shade f, else b     9 bytes
//      0b00100000 + 16 bytes 2 bits per pixel, leftmost in high bits  17 bytes
// Pixels are shade indices 0-3 (lightest to darkest), one byte each, row by row.
// public/frames.js decodes this format; keep the two in step.

export const W = 160, H = 144;
const COLS = 20, ROWS = 18, MASK_BYTES = 45;
const MSG_UPDATE = 2;              // + screen
const SAMPLE_FROM = 24;            // dirty tiles before a scroll is worth looking for
const MAX_DX = 8, MAX_DY = 16;     // scroll distances looked for, per frame

// Shift `src` into `dst` by (dx, dy), keeping pixels whose source is off screen.
export function move(src, dst, dx, dy) {
  for (let y = 0; y < H; y++) {
    const sy = y - dy;
    const row = y * W;
    if (sy < 0 || sy >= H) { dst.set(src.subarray(row, row + W), row); continue; }
    for (let x = 0; x < W; x++) {
      const sx = x - dx;
      dst[row + x] = sx < 0 || sx >= W ? src[row + x] : src[sy * W + sx];
    }
  }
}

function tileDirty(a, b, t) {
  const o = ((t / COLS) | 0) * 8 * W + (t % COLS) * 8;
  for (let r = 0; r < 8; r++) {
    for (let i = o + r * W, end = i + 8; i < end; i++) if (a[i] !== b[i]) return true;
  }
  return false;
}

function countDirty(a, b) {
  let n = 0;
  for (let t = 0; t < COLS * ROWS; t++) if (tileDirty(a, b, t)) n++;
  return n;
}

// Mismatches between `cur` and `prev` moved by (dx, dy), on a sparse grid of pixels.
function sampleScore(prev, cur, dx, dy, limit) {
  let bad = 0;
  for (let y = Math.max(0, dy) + 1; y < Math.min(H, H + dy); y += 3) {
    for (let x = Math.max(0, dx) + 1; x < Math.min(W, W + dx); x += 3) {
      if (cur[y * W + x] !== prev[(y - dy) * W + (x - dx)] && ++bad >= limit) return bad;
    }
  }
  return bad;
}

export class FrameEncoder {
  constructor(screen = 0) {
    this.kind = MSG_UPDATE + screen;
    this.prev = new Uint8Array(W * H);     // what the phone shows (it starts all shade 0)
    this.base = new Uint8Array(W * H);
    this.out = new Uint8Array(5 + MASK_BYTES + COLS * ROWS * 17);
  }

  // Message taking the phone from its current picture to `cur`, or null if equal.
  // Assumes the phone will receive it: call only when it is sent.
  encode(cur, seq) {
    let dirty = countDirty(this.prev, cur);
    if (dirty === 0) return null;
    let dx = 0, dy = 0, base = this.prev;
    if (dirty >= SAMPLE_FROM) {
      let best = sampleScore(this.prev, cur, 0, 0, Infinity), bx = 0, by = 0;
      const tryMove = (x, y) => {
        const s = sampleScore(this.prev, cur, x, y, best);
        if (s < best) { best = s; bx = x; by = y; }
      };
      for (let x = -MAX_DX; x <= MAX_DX; x++) if (x) tryMove(x, 0);
      for (let y = -MAX_DY; y <= MAX_DY; y++) if (y) tryMove(0, y);
      if (bx || by) {
        move(this.prev, this.base, bx, by);
        const moved = countDirty(this.base, cur);
        if (moved < dirty) { dirty = moved; dx = bx; dy = by; base = this.base; }
      }
    }

    const out = this.out;
    out[0] = this.kind;
    out[1] = seq & 0xff;
    out[2] = (seq >> 8) & 0xff;
    out[3] = dx & 0xff;
    out[4] = dy & 0xff;
    out.fill(0, 5, 5 + MASK_BYTES);
    let p = 5 + MASK_BYTES;
    for (let t = 0; t < COLS * ROWS; t++) {
      if (!tileDirty(base, cur, t)) continue;
      out[5 + (t >> 3)] |= 1 << (t & 7);
      p = encodeTile(cur, t, out, p);
    }
    this.prev.set(cur);
    return out.slice(0, p);
  }
}

function encodeTile(px, t, out, p) {
  const o = ((t / COLS) | 0) * 8 * W + (t % COLS) * 8;
  const bg = px[o];
  let fg = -1, solid = true, two = true;
  for (let r = 0; r < 8 && two; r++) {
    for (let i = o + r * W, end = i + 8; i < end; i++) {
      const s = px[i];
      if (s === bg) continue;
      solid = false;
      if (fg === -1) fg = s;
      else if (s !== fg) { two = false; break; }
    }
  }
  if (solid) {
    out[p++] = bg;
  } else if (two) {
    out[p++] = 0x10 | (fg << 2) | bg;
    for (let r = 0; r < 8; r++) {
      let bits = 0;
      for (let c = 0, i = o + r * W; c < 8; c++, i++) bits = (bits << 1) | (px[i] === fg ? 1 : 0);
      out[p++] = bits;
    }
  } else {
    out[p++] = 0x20;
    for (let r = 0; r < 8; r++) {
      for (let half = 0; half < 2; half++) {
        const i = o + r * W + half * 4;
        out[p++] = (px[i] << 6) | (px[i + 1] << 4) | (px[i + 2] << 2) | px[i + 3];
      }
    }
  }
  return p;
}
