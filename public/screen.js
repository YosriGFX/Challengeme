// screen.js — the PPU on this device: the memory map (ppu.wasm), time, and drawing.
//
// It holds no game logic. A packet goes into the memory map whole or not at all; this
// file then decides WHEN each finished picture is shown and draws the 256 OP slots with
// Canvas2D at the device's own resolution.
//
// Time. Every packet carries the server tick it belongs to, so the client keeps a clock
// of server ticks. With that clock it can
//   - play frames back evenly, a little behind the newest one, gliding between two
//     frames (smooth playback, for games at 20 Hz or more);
//   - move Motion OPs by itself between packets, at any refresh rate;
//   - move the slots bound to the player's own stick at once, without the round trip.
// None of this decides anything about the game: the server's packets always win.

export const F = { DRAW: 1, TRANS: 2, EVENT: 4, RESET: 8, MID: 16, ERROR: 128 };
const OP = { RECT: 1, CIRC: 2, TRI: 3, DIAM: 4, LINE: 5, POINT: 6, TEXT: 7 };
const BIND_VEL = 1, BIND_STEP = 2;
const FONT = '"ConsoleFont", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const DX = [0, 1, 1, 1, 0, -1, -1, -1], DY = [-1, -1, 0, 1, 1, 1, 0, -1];

let ppu = null, R = null;                    // the memory map and typed views over its regions
let canvas = null, ctx = null, colors = [];
let settings = { bright: 3, warm: false, smooth: true };
let on = false, queued = false;

// ---- time
const shown = new Float32Array(2048);        // the picture for this very frame
let snaps = [];                              // received pictures, oldest first: { f, ops, mv, at, moving, ack }
let tickMs = 0, base = null, late = 0, bufMs = 0, lastF = null, glide = false;
let stalled = null, lastPf = 0, tickNow = 0, cur = null, lastDraw = 0;

// ---- the player's own stick, for bound slots
let stickX = 0, stickY = 0, sent = 0;        // sent: inputs sent since the socket opened (mod 256)
let steps = [];                              // cursor steps the server has not confirmed: { seq, dx, dy }
const local = [0, 1, 2, 3].map(() => ({ on: false, x: 0, y: 0 }));

export async function init(el) {
  canvas = el; ctx = canvas.getContext('2d');
  const bytes = await (await fetch('ppu.wasm')).arrayBuffer();
  ppu = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  const mem = ppu.memory.buffer, view = (ptr, n) => new Uint8Array(mem, ptr, n);
  R = {
    rx: view(ppu.ppu_rx(), 4096), ops: view(ppu.ppu_ops(), 2048), mv: view(ppu.ppu_moves(), 1536), t0: new Uint16Array(mem, ppu.ppu_t0(), 256),
    strs: view(ppu.ppu_strs(), 256), binds: view(ppu.ppu_binds(), 32), pal: view(ppu.ppu_pal(), 24), labels: view(ppu.ppu_labels(), 24),
    sfx: view(ppu.ppu_sfx(), 128), music: view(ppu.ppu_music(), 4 * 131), events: view(ppu.ppu_events(), 64),
  };
  buildColors();
  new ResizeObserver(resize).observe(canvas);
  resize();
  return R;
}

// The player changed a display setting. The clock is kept: only how frames are shown changes.
export function configure(s) {
  settings = s;
  if (!R) return;
  buildColors();
  pace();
  if (!glide && snaps.length > 1) snaps = [snaps[snaps.length - 1]];
  request();
}
// Glide between frames (games at 20 Hz or more, if the player wants it), one tick plus the
// measured lateness behind the newest; otherwise the newest picture at once.
function pace() {
  glide = settings.smooth && tickMs > 0 && tickMs <= 50;
  bufMs = glide ? tickMs + Math.min(100, late) : 0;
}
export function power(state) { on = state; restart(); steps = []; sent = 0; shown.fill(0); for (const l of local) l.on = false; request(); }
export const stats = () => ({ hz: ppu ? ppu.ppu_tick() : 0, bufMs: tickMs && glide ? bufMs : 0 });
export const tickOnScreen = () => Math.floor(tickNow) & 255;

// The socket opened (count inputs from zero) or closed (time stands still).
export function link(open, resent) {
  if (open) { sent = resent ? 1 : 0; steps = []; stalled = null; }
  else if (tickMs && base !== null) stalled = lastPf;
  request();
}

// 7 roles x 4 brightness levels. The player's display settings touch these entries only,
// and black is never lifted.
function buildColors() {
  const gain = [0.4, 0.6, 0.8, 1][settings.bright] ?? 1;
  const warm = settings.warm ? [1, 0.9, 0.68] : [1, 1, 1];
  colors = [];
  for (let role = 0; role < 8; role++) for (let lvl = 0; lvl < 4; lvl++) {
    const k = role === 0 ? 0 : gain * (lvl + 1) / 4;
    const c = [0, 1, 2].map((i) => Math.round(R.pal[role * 3 + i] * k * warm[i]));
    colors.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
}

function resize() {
  const px = Math.max(256, Math.round(canvas.clientWidth * (window.devicePixelRatio || 1)));
  if (canvas.width !== px) canvas.width = canvas.height = px;
  request();
}

function request() { if (!queued) { queued = true; requestAnimationFrame(frame); } }
function restart() { snaps = []; base = null; late = 0; lastF = null; stalled = null; }

// ---- packets
// Put one packet into the memory map. Returns the flags and the sound events it carried.
export function apply(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length > R.rx.length) return { flags: F.ERROR, events: [] };
  R.rx.set(bytes);
  const flags = ppu.ppu_apply(bytes.length);            // atomic: all of it, or nothing
  if (flags & F.ERROR) return { flags, events: [] };
  if (flags & F.TRANS) buildColors();
  take(flags);
  const events = [];
  if (flags & F.EVENT) for (let i = 0, n = ppu.ppu_events_n(); i < n; i++) events.push([R.events[i * 3], R.events[i * 3 + 1], R.events[i * 3 + 2]]);
  request();
  return { flags, events };
}

// Keep the picture the memory map holds now, with the tick it belongs to.
function take(flags) {
  const hz = ppu.ppu_tick(), now = performance.now();
  if (flags & (F.RESET | F.TRANS)) restart();
  if (flags & F.RESET) { steps = []; for (const l of local) l.on = false; }
  tickMs = hz ? 1000 / hz : 0;
  let f = ppu.ppu_frame();
  if (lastF !== null) f = lastF + (((f - lastF) << 16) >> 16);       // the counter is 16 bits: unwrap it
  lastF = f;

  const snap = { f, ops: R.ops.slice(), mv: R.mv.slice(), at: new Int32Array(256), moving: false, ack: ppu.ppu_ack() };
  for (let s = 0, j = 0; s < 256; s++, j += 6) {
    if (!(snap.mv[j + 2] | snap.mv[j + 3] | snap.mv[j + 4] | snap.mv[j + 5])) continue;
    snap.moving = true;
    snap.at[s] = f - ((f - R.t0[s]) & 0xFFFF);                       // the tick this slot's motion counts from
  }

  // The clock: local time of tick 0, read from the fastest tick packets. A packet made
  // between two ticks (an answer to an input) arrives at any moment and is not a beat.
  // Until the first beat comes, any packet gives a first guess; it can only be late, and
  // the first beat corrects it.
  const beat = !(flags & F.MID);
  if (tickMs && (beat || base === null)) {
    const off = now - f * tickMs;
    if (base === null || off < base) base = off; else base += 0.01;   // follow slow drift
    if (beat) late = Math.max(late * 0.99, off - base);               // how late packets get
  }
  pace();
  const tail = snaps[snaps.length - 1];
  if (!glide) snaps = [snap];                                         // slow games: the newest picture, at once
  else if (tail && tail.f === f) snaps[snaps.length - 1] = snap;      // more from the same tick
  else { snaps.push(snap); if (snaps.length > 16) snaps.shift(); }
}

const vel = (m, j) => ((m[j] | (m[j + 1] << 8)) << 16) >> 16;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Fill `shown` for this moment. Returns true while the picture is still moving.
function play(now) {
  if (!snaps.length) { shown.fill(0); cur = null; return false; }
  let pf = snaps[snaps.length - 1].f;
  if (tickMs && base !== null) {
    pf = (now - base - bufMs) / tickMs;                               // the tick to show now, with a fraction
    if (stalled !== null) pf = Math.min(pf, stalled); else lastPf = pf;
  }
  while (snaps.length > 1 && snaps[1].f <= pf) snaps.shift();
  const a = snaps[0], b = snaps[1];
  const t = Math.max(pf, a.f);                                        // a picture is never shown before its tick
  cur = a; tickNow = t;
  let k = 0;                                                          // how far the glide toward b has come
  if (b && glide) { const start = Math.max(a.f, b.f - 1); k = t <= start ? 0 : Math.min(1, (t - start) / (b.f - start)); }

  const p = a.ops, q = b ? b.ops : null, m = a.mv;
  for (let s = 0, i = 0, j = 0; s < 256; s++, i += 8, j += 6) {
    const op = p[i];
    for (let n = 0; n < 8; n++) shown[i + n] = p[i + n];
    if (!op) continue;
    if (m[j + 2] | m[j + 3] | m[j + 4] | m[j + 5]) {                  // a Motion OP: the same sum as con_at, with a fraction of a tick
      const n = t - a.at[s];
      const dx = (m[j] + vel(m, j + 2) * n) / 256, dy = (m[j + 1] + vel(m, j + 4) * n) / 256;
      const points = op === OP.TRI ? 3 : op === OP.LINE ? 2 : 1;
      for (let pt = 0; pt < points; pt++) {
        shown[i + 2 + pt * 2] = clamp(p[i + 2 + pt * 2] + dx, 0, 255);
        shown[i + 3 + pt * 2] = clamp(p[i + 3 + pt * 2] + dy, 0, 255);
      }
    } else if (k > 0 && op !== OP.TEXT && q[i] === op && q[i + 1] === p[i + 1]) {
      let near = true;                                                // glide only what is the same thing and moved a little
      for (let n = 2; n < 8; n++) if (Math.abs(q[i + n] - p[i + n]) > 24) { near = false; break; }
      if (near) for (let n = 2; n < 8; n++) shown[i + n] = p[i + n] + (q[i + n] - p[i + n]) * k;
    }
  }
  return stalled === null && tickMs > 0 && (b !== undefined || pf < a.f || a.moving);
}

// The input byte changed. `seq` is the number of this input since the socket opened (the
// server counts the same way, mod 256), or -1 if it could not be sent.
export function input(byte, prev, seq) {
  const act = byte & 8, was = prev & 8;
  stickX = act ? DX[byte & 7] : 0; stickY = act ? DY[byte & 7] : 0;
  if (seq >= 0) {
    sent = seq;
    let stepping = false;
    for (let id = 0; id < 4; id++) if (R.binds[id * 8 + 1] === BIND_STEP) stepping = true;
    if (stepping && act && (!was || (byte & 7) !== (prev & 7))) steps.push({ seq, dx: stickX, dy: stickY });   // the cartridge's own rule
  }
  request();
}

// Move the slots bound to the player's own stick. Returns true while one is still settling.
function bound(now) {
  const dt = tickMs ? Math.min(4, (now - lastDraw) / tickMs) : 0;     // ticks since the last frame drawn
  const ack = cur ? cur.ack : 0;
  steps = steps.filter((e) => ((ack - e.seq) & 255) >= 128);          // the server has seen the rest: they are in its picture
  let busy = false;
  for (let id = 0; id < 4; id++) {
    const b = id * 8, kind = R.binds[b + 1], i = R.binds[b] * 8, L = local[id];
    if (!kind || !shown[i]) { L.on = false; continue; }
    const sx = (R.binds[b + 2] << 24) >> 24, sy = (R.binds[b + 3] << 24) >> 24;
    const x0 = R.binds[b + 4], x1 = R.binds[b + 5], y0 = R.binds[b + 6], y1 = R.binds[b + 7];
    let x = shown[i + 2], y = shown[i + 3];                           // where the server has it
    if (kind === BIND_STEP) {
      for (const e of steps) {                                        // one step per push; a step off the edge is not made
        const nx = x + e.dx * sx, ny = y + e.dy * sy;
        if (nx >= x0 && nx <= x1) x = nx;
        if (ny >= y0 && ny <= y1) y = ny;
      }
    } else if (kind === BIND_VEL && tickMs) {
      if (!L.on) { L.x = x; L.y = y; L.on = true; }
      const mx = stickX * sx, my = stickY * sy;
      if (mx || my) {                                                 // moving: follow the stick now, the server follows a moment later
        L.x = clamp(L.x + mx * dt, x0, x1); L.y = clamp(L.y + my * dt, y0, y1);
        if (Math.abs(L.x - x) > 60 || Math.abs(L.y - y) > 60) { L.x = x; L.y = y; }      // far apart: the server is right
        busy = true;
      } else if (sent === ack) {                                      // at rest and all confirmed: settle on the server's place
        const ease = Math.min(1, dt * 0.5);
        L.x += (x - L.x) * ease; L.y += (y - L.y) * ease;
        if (Math.abs(x - L.x) < 0.5) L.x = x;
        if (Math.abs(y - L.y) < 0.5) L.y = y;
        if (L.x !== x || L.y !== y) busy = true;
      } else busy = true;
      x = L.x; y = L.y;
    }
    shown[i + 2] = x; shown[i + 3] = y;
  }
  return busy;
}

const text = (id) => { let s = ''; for (let i = 0; i < 16 && R.strs[id * 16 + i]; i++) s += String.fromCharCode(R.strs[id * 16 + i]); return s; };

function frame(now) {
  queued = false;
  const k = canvas.width / 256;                         // 256 units -> real pixels
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 256);
  if (!R || !on) return;
  const moving = play(now), settling = bound(now);
  lastDraw = now;
  if (moving || settling) request();

  const o = shown;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.textBaseline = 'alphabetic';
  for (let s = 0; s < 256; s++) {                       // slot order = layer order
    const i = s * 8, op = o[i];
    if (!op) continue;
    const col = o[i + 1] | 0, fill = col & 0x20, width = ((col >> 6) & 3) + 1;
    const a = o[i + 2], b = o[i + 3], c = o[i + 4], d = o[i + 5], e = o[i + 6], f = o[i + 7];
    ctx.fillStyle = ctx.strokeStyle = colors[(col & 7) * 4 + ((col >> 3) & 3)];
    ctx.lineWidth = width;
    switch (op) {
      case OP.RECT:
        if (fill) ctx.fillRect(a, b, c, d);
        else ctx.strokeRect(a + width / 2, b + width / 2, Math.max(0, c - width), Math.max(0, d - width));   // the stroke stays inside
        break;
      case OP.CIRC: ctx.beginPath(); ctx.arc(a, b, c, 0, Math.PI * 2); fill ? ctx.fill() : ctx.stroke(); break;
      case OP.TRI: ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.lineTo(e, f); ctx.closePath(); fill ? ctx.fill() : ctx.stroke(); break;
      case OP.DIAM:
        ctx.beginPath(); ctx.moveTo(a, b - d / 2); ctx.lineTo(a + c / 2, b); ctx.lineTo(a, b + d / 2); ctx.lineTo(a - c / 2, b); ctx.closePath();
        fill ? ctx.fill() : ctx.stroke(); break;
      case OP.LINE: ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); break;
      case OP.POINT: ctx.beginPath(); ctx.arc(a, b, width / 2, 0, Math.PI * 2); ctx.fill(); break;
      case OP.TEXT:
        ctx.font = `700 ${c}px ${FONT}`;
        ctx.textAlign = d === 1 ? 'center' : d === 2 ? 'right' : 'left';
        ctx.fillText(text((e | 0) & 15), a, b);
        break;
    }
  }
}
