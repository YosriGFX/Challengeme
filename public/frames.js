// Applies the server's screen updates (format: src/gb/frames.js) to one screen; the
// phone keeps one decoder per Game Boy (screen(buf) says which). It keeps one
// shade index (0-3) per pixel; an update first moves the picture if it scrolled, then
// replaces the 8 x 8 tiles that changed.
export const W = 160, H = 144;
const COLS = 20, ROWS = 18, MASK_BYTES = 45;

// Which Game Boy an update is for: 0 = player 1, 1 = player 2, -1 = not an update.
export function screen(buf) {
  return buf.length >= 5 + MASK_BYTES && (buf[0] === 2 || buf[0] === 3) ? buf[0] - 2 : -1;
}

export class FrameDecoder {
  constructor() {
    this.px = new Uint8Array(W * H);
    this.tmp = new Uint8Array(W * H);
  }

  // `buf` is one update message; returns false if it is not one.
  apply(buf) {
    if (screen(buf) < 0) return false;
    const dx = (buf[3] << 24) >> 24, dy = (buf[4] << 24) >> 24;
    if (dx || dy) {
      move(this.px, this.tmp, dx, dy);
      [this.px, this.tmp] = [this.tmp, this.px];
    }
    const px = this.px;
    let p = 5 + MASK_BYTES;
    for (let t = 0; t < COLS * ROWS; t++) {
      if (!(buf[5 + (t >> 3)] & (1 << (t & 7)))) continue;
      const o = ((t / COLS) | 0) * 8 * W + (t % COLS) * 8;
      const head = buf[p++];
      if (head < 0x10) {
        for (let r = 0; r < 8; r++) px.fill(head, o + r * W, o + r * W + 8);
      } else if (head < 0x20) {
        const fg = (head >> 2) & 3, bg = head & 3;
        for (let r = 0; r < 8; r++) {
          const bits = buf[p++];
          for (let c = 0; c < 8; c++) px[o + r * W + c] = bits & (0x80 >> c) ? fg : bg;
        }
      } else {
        for (let r = 0; r < 8; r++) {
          for (let half = 0; half < 2; half++) {
            const b = buf[p++], i = o + r * W + half * 4;
            px[i] = b >> 6; px[i + 1] = (b >> 4) & 3; px[i + 2] = (b >> 2) & 3; px[i + 3] = b & 3;
          }
        }
      }
    }
    return true;
  }
}

function move(src, dst, dx, dy) {
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
