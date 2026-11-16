/* raster.c — the PPU's drawing for a device with no browser: every OP into a frame of
 * RGB565 pixels, using integers only (no float, no division by anything but the frame size).
 *
 * It is written to be read and checked, not to be fast: each shape tests the pixels of its
 * own bounding box. Positions are kept in 1/16 of a console unit ("q"). The rules are the
 * same as in public/screen.js: slot order is layer order, a rectangle's outline stays
 * inside the rectangle, lines and outlines have round ends.
 */
#include "raster.h"
#include "../ppu/font.h"

typedef long long i64;
#define Q 16                                  /* q per console unit */

static u16 *frame;
static i32 N;
static u16 ink;

static i32 px_q(i32 i) { return (2 * i + 1) * 128 * Q / N; }      /* the center of pixel i, in q */
static i32 lo_px(i32 q) { i32 i = (q * N) / (256 * Q) - 1; return i < 0 ? 0 : i; }
static i32 hi_px(i32 q) { i32 i = (q * N) / (256 * Q) + 1; return i >= N ? N - 1 : i; }
static void dot(i32 x, i32 y) { frame[y * N + x] = ink; }

/* every pixel whose center is within r of the segment a-b */
static void stroke(i32 ax, i32 ay, i32 bx, i32 by, i32 r) {
  i32 x0 = lo_px((ax < bx ? ax : bx) - r), x1 = hi_px((ax > bx ? ax : bx) + r);
  i32 y0 = lo_px((ay < by ? ay : by) - r), y1 = hi_px((ay > by ? ay : by) + r);
  i64 ux = bx - ax, uy = by - ay, len2 = ux * ux + uy * uy, r2 = (i64)r * r;
  for (i32 y = y0; y <= y1; y++) for (i32 x = x0; x <= x1; x++) {
    i64 vx = px_q(x) - ax, vy = px_q(y) - ay, t = vx * ux + vy * uy, d2 = vx * vx + vy * vy;
    if (t <= 0) { if (d2 <= r2) dot(x, y); }
    else if (t >= len2) { i64 wx = px_q(x) - bx, wy = px_q(y) - by; if (wx * wx + wy * wy <= r2) dot(x, y); }
    else if (d2 * len2 - t * t <= r2 * len2) dot(x, y);
  }
}

static void box(i32 x, i32 y, i32 w, i32 h) {                      /* a filled rectangle, in q */
  if (w <= 0 || h <= 0) return;
  for (i32 py = lo_px(y); py <= hi_px(y + h); py++) for (i32 px = lo_px(x); px <= hi_px(x + w); px++) {
    i32 cx = px_q(px), cy = px_q(py);
    if (cx >= x && cx < x + w && cy >= y && cy < y + h) dot(px, py);
  }
}

static void disc(i32 cx, i32 cy, i32 r_out, i32 r_in) {            /* a filled circle, or a ring */
  i64 out2 = (i64)r_out * r_out, in2 = r_in > 0 ? (i64)r_in * r_in : -1;
  for (i32 y = lo_px(cy - r_out); y <= hi_px(cy + r_out); y++) for (i32 x = lo_px(cx - r_out); x <= hi_px(cx + r_out); x++) {
    i64 dx = px_q(x) - cx, dy = px_q(y) - cy, d2 = dx * dx + dy * dy;
    if (d2 <= out2 && d2 >= in2) dot(x, y);
  }
}

static i64 side(i32 ax, i32 ay, i32 bx, i32 by, i32 px, i32 py) { return (i64)(bx - ax) * (py - ay) - (i64)(by - ay) * (px - ax); }

static void triangle(const i32 *p) {                               /* filled, three points in q */
  i32 x0 = p[0], x1 = p[0], y0 = p[1], y1 = p[1];
  for (u8 i = 1; i < 3; i++) { if (p[i * 2] < x0) x0 = p[i * 2]; if (p[i * 2] > x1) x1 = p[i * 2]; if (p[i * 2 + 1] < y0) y0 = p[i * 2 + 1]; if (p[i * 2 + 1] > y1) y1 = p[i * 2 + 1]; }
  for (i32 y = lo_px(y0); y <= hi_px(y1); y++) for (i32 x = lo_px(x0); x <= hi_px(x1); x++) {
    i32 cx = px_q(x), cy = px_q(y);
    i64 a = side(p[0], p[1], p[2], p[3], cx, cy), b = side(p[2], p[3], p[4], p[5], cx, cy), c = side(p[4], p[5], p[0], p[1], cx, cy);
    if ((a >= 0 && b >= 0 && c >= 0) || (a <= 0 && b <= 0 && c <= 0)) dot(x, y);
  }
}

static void text(i32 x, i32 y, i32 size, u8 align, const u8 *s) {
  i32 len = 0;
  while (len < CON_STR_LEN && s[len]) len++;
  i32 advance = size * Q * 6 / 10, cell = size * Q * 7 / 60;      /* 0.6 em per glyph; the grid is 0.7 em / 6 */
  i32 pen = size * Q / 20 > 4 ? size * Q / 20 : 4;                 /* half of a 0.1 em pen, at least a quarter unit */
  x -= align == ALIGN_CENTER ? len * advance / 2 : align == ALIGN_RIGHT ? len * advance : 0;
  x += (advance - 4 * cell) / 2;
  for (i32 i = 0; i < len; i++, x += advance) {
    u8 c = s[i] >= 'a' && s[i] <= 'z' ? (u8)(s[i] - 32) : s[i];
    if (c < 0x20 || c > 0x7E) c = '?';
    const unsigned char *g = &FONT_STROKES[FONT_AT[c - 0x20][0] * 2];
    for (u32 k = 0; k < FONT_AT[c - 0x20][1]; k++, g += 2)
      stroke(x + (g[0] >> 4) * cell, y - ((g[0] & 15) - 1) * cell, x + (g[1] >> 4) * cell, y - ((g[1] & 15) - 1) * cell, pen);
  }
}

void raster_frame(u16 *px, u32 n, const u8 *ops, const u8 *strs, const u8 *pal) {
  frame = px; N = (i32)n;
  for (u32 i = 0; i < n * n; i++) px[i] = 0;                       /* black */
  for (u32 s = 0; s < CON_SLOTS; s++) {
    const u8 *o = &ops[s * CON_OP_SIZE];
    if (!o[0]) continue;
    u8 role = o[1] & 7, level = (o[1] >> 3) & 3, fill = o[1] & 0x20;
    i32 w = (((o[1] >> 6) & 3) + 1) * Q, half = w / 2;             /* the pen, in q */
    u32 r = pal[role * 3] * (level + 1u) / 4, g = pal[role * 3 + 1] * (level + 1u) / 4, b = pal[role * 3 + 2] * (level + 1u) / 4;
    ink = role ? (u16)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)) : 0;
    i32 a = o[2] * Q, bq = o[3] * Q, c = o[4] * Q, d = o[5] * Q, e = o[6] * Q, f = o[7] * Q;
    switch (o[0]) {
    case OP_RECT:
      if (fill) box(a, bq, c, d);
      else { box(a, bq, c, w); box(a, bq + d - w, c, w); box(a, bq, w, d); box(a + c - w, bq, w, d); }      /* the outline stays inside */
      break;
    case OP_CIRC:
      if (fill) disc(a, bq, c, 0); else disc(a, bq, c + half, c - half);
      break;
    case OP_TRI: {
      i32 p[6] = {a, bq, c, d, e, f};
      if (fill) triangle(p);
      else { stroke(a, bq, c, d, half); stroke(c, d, e, f, half); stroke(e, f, a, bq, half); }
      break; }
    case OP_DIAM: {
      i32 p[8] = {a, bq - d / 2, a + c / 2, bq, a, bq + d / 2, a - c / 2, bq};
      if (fill) { i32 t1[6] = {p[0], p[1], p[2], p[3], p[4], p[5]}, t2[6] = {p[0], p[1], p[4], p[5], p[6], p[7]}; triangle(t1); triangle(t2); }
      else for (u8 i = 0; i < 4; i++) stroke(p[i * 2], p[i * 2 + 1], p[((i + 1) & 3) * 2], p[((i + 1) & 3) * 2 + 1], half);
      break; }
    case OP_LINE: stroke(a, bq, c, d, half); break;
    case OP_POINT: disc(a, bq, half, 0); break;
    case OP_TEXT: text(a, bq, o[4], o[5], &strs[(o[6] & 15) * CON_STR_LEN]); break;
    default: break;
    }
  }
}
