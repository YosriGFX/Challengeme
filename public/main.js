// main.js — the client terminal: PPU drawing, controller, lobby and HOME overlay.
//
// The PPU memory lives in ppu.wasm (C). This file only:
//   - copies packets from the input worker into the PPU and asks it to apply them
//   - draws the 256 OP slots with Canvas2D, crisp at the device's resolution
//   - plays sound events through the APU
//   - turns the controller into the 1-byte input register
import { Sound } from './sound.js';

const $ = (id) => document.getElementById(id);
const FONT = '"ConsoleFont", ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const OP = { RECT: 1, CIRC: 2, TRI: 3, DIAM: 4, LINE: 5, POINT: 6, TEXT: 7 };
const F_DRAW = 1, F_TRANS = 2, F_EVENT = 4, F_RESET = 8, F_ERROR = 128;
const W_SFX = 0x40, SYS_RESIGN = 1;
const STR_LEN = 16, LABEL_LEN = 8, PATTERN_SIZE = 3 + 32 * 4;

// ---------------------------------------------------------------- settings
// Display and sound settings belong to the player, like a monitor's menu.
const settings = { sound: true, music: true, bright: 3, warm: false, smooth: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('op-console') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('op-console', JSON.stringify(settings)); } catch {} };

const apu = new Sound();
apu.setSound(settings.sound); apu.setMusic(settings.music);

// ---------------------------------------------------------------- PPU
let ppu = null, mem = null, R = null;       // R = views over the PPU memory regions
async function loadPPU() {
  const bytes = await (await fetch('ppu.wasm')).arrayBuffer();
  ppu = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  mem = ppu.memory.buffer;
  const view = (ptr, n) => new Uint8Array(mem, ptr, n);
  R = {
    rx: view(ppu.ppu_rx(), 4096), ops: view(ppu.ppu_ops(), 2048), strs: view(ppu.ppu_strs(), 256),
    pal: view(ppu.ppu_pal(), 24), labels: view(ppu.ppu_labels(), 24), sfx: view(ppu.ppu_sfx(), 128),
    music: view(ppu.ppu_music(), 4 * PATTERN_SIZE), events: view(ppu.ppu_events(), 64),
  };
}

const ascii = (bytes, off, max) => { let s = ''; for (let i = 0; i < max && bytes[off + i]; i++) s += String.fromCharCode(bytes[off + i]); return s; };

// ---------------------------------------------------------------- drawing
const canvas = $('lcd'), ctx = canvas.getContext('2d');
let colors = [], dirty = false, inMatch = false;

// 7 roles x 4 brightness levels. The player's filters touch these entries only,
// and black is never lifted.
function buildColors() {
  const gain = [0.4, 0.6, 0.8, 1][settings.bright];
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
  if (canvas.width !== px) { canvas.width = canvas.height = px; }
  requestDraw();
}

function requestDraw() { if (!dirty) { dirty = true; requestAnimationFrame(draw); } }

// Smooth playback. A fast game sends a frame every tick, and every packet carries the
// number of the tick it belongs to. The network delivers packets unevenly, so drawing each
// one when it arrives stutters. Instead the client plays the frames back on its own steady
// clock, a little behind the newest one, and glides between two frames. The game itself
// still runs only on the server: this decides when a finished frame is shown, nothing else.
const shown = new Float32Array(2048);
let snaps = [];                 // { f: tick number, ops: Uint8Array(2048) }, oldest first
let base = null;                // local time of tick 0, estimated from the fastest packets
let jitter = 0, tickMs = 0, bufferMs = 0, lastFrame = null;

function resetTimeline() { snaps = []; base = null; jitter = 0; lastFrame = null; bufferMs = 0; }

function onOpsChanged(flags) {
  const rate = ppu.ppu_tick();
  if (flags & (F_RESET | F_TRANS)) resetTimeline();
  if (!settings.smooth || rate < 20) { resetTimeline(); tickMs = 0; shown.set(R.ops); return; }   // slow games: show at once
  tickMs = 1000 / rate;
  const now = performance.now();
  let f = ppu.ppu_frame();
  if (lastFrame !== null) f = lastFrame + (((f - lastFrame) << 16) >> 16);     // the number is 16 bits: unwrap it
  const tail = snaps[snaps.length - 1];
  if (tail && f < tail.f) return;
  if (tail && f === tail.f) { tail.ops = R.ops.slice(); return; }              // an update inside the same tick
  lastFrame = f;
  snaps.push({ f, ops: R.ops.slice() });
  if (snaps.length > 16) snaps.shift();
  const offset = now - f * tickMs;
  if (base === null || offset < base) base = offset; else base += 0.01;        // follow slow clock drift
  jitter = Math.max(jitter * 0.99, now - (base + f * tickMs));                 // how late packets get
  bufferMs = tickMs + Math.min(100, jitter);
}

// Fill `shown` for this moment. Returns true while there is more motion to play.
function play() {
  if (!tickMs || base === null || !snaps.length) return false;
  const pf = (performance.now() - base - bufferMs) / tickMs;                   // the tick to show now, with a fraction
  while (snaps.length > 1 && snaps[1].f <= pf) snaps.shift();
  const s0 = snaps[0], s1 = snaps[1];
  if (!s1 || pf <= s0.f) { shown.set(s0.ops); return !!s1 || pf < s0.f; }
  const start = Math.max(s0.f, s1.f - 1);                                      // a gap means nothing moved until the last tick
  const a = pf <= start ? 0 : (pf - start) / (s1.f - start);
  const p = s0.ops, q = s1.ops;
  for (let i = 0; i < 2048; i += 8) {
    // glide only what is the same thing in both frames and moved a little
    let ok = p[i] !== 0 && p[i] !== OP.TEXT && p[i] === q[i] && p[i + 1] === q[i + 1];
    if (ok) for (let k = 2; k < 8; k++) if (Math.abs(q[i + k] - p[i + k]) > 24) { ok = false; break; }
    shown[i] = p[i]; shown[i + 1] = p[i + 1];
    for (let k = 2; k < 8; k++) shown[i + k] = ok ? p[i + k] + (q[i + k] - p[i + k]) * a : p[i + k];
  }
  return true;
}

function draw() {
  dirty = false;
  const k = canvas.width / 256;                       // 256 units -> real pixels
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 256, 256);
  if (!R || !inMatch) return;
  if (play()) requestDraw();                           // keep going while there is motion to play
  const o = shown;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.textBaseline = 'alphabetic';
  for (let s = 0; s < 256; s++) {                     // slot order = layer order
    const i = s * 8, op = o[i];
    if (!op) continue;
    const col = o[i + 1] | 0, fill = col & 0x20, width = ((col >> 6) & 3) + 1;
    const color = colors[(col & 7) * 4 + ((col >> 3) & 3)];
    const a = o[i + 2], b = o[i + 3], c = o[i + 4], d = o[i + 5], e = o[i + 6], f = o[i + 7];
    ctx.fillStyle = ctx.strokeStyle = color; ctx.lineWidth = width;
    switch (op) {
      case OP.RECT:
        if (fill) ctx.fillRect(a, b, c, d);
        else ctx.strokeRect(a + width / 2, b + width / 2, Math.max(0, c - width), Math.max(0, d - width));   // stroke stays inside
        break;
      case OP.CIRC:
        ctx.beginPath(); ctx.arc(a, b, c, 0, Math.PI * 2); fill ? ctx.fill() : ctx.stroke(); break;
      case OP.TRI:
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.lineTo(e, f); ctx.closePath(); fill ? ctx.fill() : ctx.stroke(); break;
      case OP.DIAM:
        ctx.beginPath(); ctx.moveTo(a, b - d / 2); ctx.lineTo(a + c / 2, b); ctx.lineTo(a, b + d / 2); ctx.lineTo(a - c / 2, b); ctx.closePath();
        fill ? ctx.fill() : ctx.stroke(); break;
      case OP.LINE:
        ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, d); ctx.stroke(); break;
      case OP.POINT:
        ctx.beginPath(); ctx.arc(a, b, width / 2, 0, Math.PI * 2); ctx.fill(); break;
      case OP.TEXT:
        ctx.font = `700 ${c}px ${FONT}`;
        ctx.textAlign = d === 1 ? 'center' : d === 2 ? 'right' : 'left';
        ctx.fillText(ascii(R.strs, ((e | 0) & 15) * STR_LEN, STR_LEN), a, b);
        break;
    }
  }
}

// ---------------------------------------------------------------- packets
let lastResync = 0, statBytes = 0, statPkts = 0;

function onPacket(buf) {
  const bytes = new Uint8Array(buf);
  statBytes += bytes.length; statPkts++;
  if (bytes.length > R.rx.length) return;
  R.rx.set(bytes);
  const flags = ppu.ppu_apply(bytes.length);          // atomic: all of it, or nothing
  if (flags & F_ERROR) {
    if (Date.now() - lastResync > 1000) { lastResync = Date.now(); worker.postMessage({ t: 'resync' }); }
    return;
  }
  if (flags & F_TRANS) { buildColors(); showLabels(); }
  if (flags & (F_DRAW | F_TRANS)) onOpsChanged(flags);
  if (flags & F_EVENT) {
    const n = ppu.ppu_events_n();
    for (let i = 0; i < n; i++) {
      const type = R.events[i * 3], x = R.events[i * 3 + 1], y = R.events[i * 3 + 2];
      if (type === W_SFX) apu.sfx(R.sfx.subarray((x & 15) * 8, (x & 15) * 8 + 8));
      else if (x === 1) {
        const p = (y & 3) * PATTERN_SIZE;
        apu.playMusic({ step: R.music[p] / 100, steps: R.music[p + 1], vol: R.music[p + 2], notes: R.music.slice(p + 3, p + 3 + R.music[p + 1] * 4) }, (flags & F_RESET) !== 0);
      } else apu.stopMusic();
    }
  }
  if (flags & (F_DRAW | F_TRANS)) requestDraw();
}

function showLabels() {
  for (let b = 0; b < 3; b++) {
    const text = ascii(R.labels, b * LABEL_LEN, LABEL_LEN);
    $('l' + (b + 2)).textContent = text;
    $('b' + (b + 2)).parentElement.classList.toggle('unused', !text);
  }
}

setInterval(() => {
  $('stats').textContent = inMatch ? `${ppu.ppu_tick()} HZ · ${statPkts} PKT/S · ${statBytes} B/S` + (tickMs ? ` · BUF ${Math.round(bufferMs)} MS` : '') : '';
  statBytes = statPkts = 0;
}, 1000);

// ---------------------------------------------------------------- input thread
const worker = new Worker('input-worker.js');
worker.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'pkt') { if (inMatch) onPacket(m.buf); }
  else if (m.t === 'open') { $('led').classList.add('on'); $('net').textContent = 'ONLINE'; }
  else if (m.t === 'close') { $('led').classList.remove('on'); $('net').textContent = inMatch ? 'RECONNECTING' : 'OFFLINE'; }
};

// ---------------------------------------------------------------- controller -> input byte
// bit 0-2 stick direction | bit 3 stick active | bit 4 A | bit 5 B | bit 6-7 action (one at a time)
const held = { keys: new Set(), touchDir: -1, a: false, b: false, actions: new Set() };
const DIRS = { '0,-1': 0, '1,-1': 1, '1,0': 2, '1,1': 3, '0,1': 4, '-1,1': 5, '-1,0': 6, '-1,-1': 7 };
const KNOB = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
let lastByte = 0, knobAt = null;                         // knobAt: where the finger holds the knob, in pixels

function updateInput() {
  const k = held.keys;
  const dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0), dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  const dir = (dx || dy) ? DIRS[dx + ',' + dy] : held.touchDir;
  const action = held.actions.size ? Math.min(...held.actions) : 0;
  let byte = (dir >= 0 ? 8 | dir : 0) | (held.a ? 0x10 : 0) | (held.b ? 0x20 : 0) | (action << 6);
  if (!inMatch || !$('home').hidden) byte = 0;        // HOME open: the cartridge sees nothing

  $('knob').style.transform = knobAt ? `translate(${knobAt[0]}px, ${knobAt[1]}px)` : dir >= 0 ? `translate(${KNOB[dir][0] * 55}%, ${KNOB[dir][1] * 55}%)` : '';
  $('ba').classList.toggle('down', held.a); $('bb').classList.toggle('down', held.b);
  for (let n = 1; n <= 3; n++) $('b' + (n + 1)).classList.toggle('down', held.actions.has(n));

  if (byte === lastByte) return;
  // local echo: the player's own presses click and buzz instantly, with no round trip
  const pressed = byte & ~lastByte;
  if ((pressed & 0x30) || ((byte >> 6) && (byte >> 6) !== (lastByte >> 6))) { apu.click(); navigator.vibrate?.(8); }
  lastByte = byte;
  worker.postMessage({ t: 'in', b: byte });
}

// Buttons: each finger holds at most one button, and sliding a finger moves it to the
// button under it (roll from B to A without lifting). A finger that started on a button is
// followed until it lifts, also across the gap between two buttons.
const fingers = new Map();                              // pointerId -> button name, or null between buttons
function buttonsChanged() {
  const on = new Set(fingers.values());
  held.a = on.has('a'); held.b = on.has('b');
  held.actions.clear();
  for (let n = 1; n <= 3; n++) if (on.has('act' + n)) held.actions.add(n);
  updateInput();
}
function fingerAt(e) {
  let name = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-btn]')?.dataset.btn ?? null;
  const followed = fingers.has(e.pointerId), before = fingers.get(e.pointerId) ?? null;
  if (!name && !followed) return;
  e.preventDefault();
  if (name === 'home') {                                // HOME answers a fresh tap only, never a slide
    if (!followed) { if (e.type === 'pointerdown') toggleHome(); return; }
    name = null;
  }
  if (followed && name === before) return;
  fingers.set(e.pointerId, name);
  buttonsChanged();
}
// Browsers start audio only inside a tap or a key press, and Safari counts the end of a
// touch, not its start. Same events as Challengeme (public/play.js).
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  addEventListener(type, () => apu.start(), { capture: true, passive: true });
}
document.addEventListener('pointerdown', fingerAt);
document.addEventListener('pointermove', (e) => { if (fingers.has(e.pointerId)) fingerAt(e); });
const fingerUp = (e) => { if (fingers.delete(e.pointerId)) buttonsChanged(); };
document.addEventListener('pointerup', fingerUp);
document.addEventListener('pointercancel', fingerUp);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Safari ignores user-scalable=no: stop its pinch and double-tap zoom here too. A second
// finger (stick and A at once) must never start a pinch.
for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', (e) => { if (e.target.closest?.('.overlay') && e.touches.length === 1) return; e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {         // two quick taps are never a zoom
  const now = Date.now();
  // Not inside the lobby and HOME: there a cancelled touch would also cancel the tap itself,
  // and quick taps on a menu row would do nothing. Their CSS (touch-action) already forbids
  // the double-tap zoom.
  if (now - lastTouchEnd < 350 && !e.target.closest?.('.overlay')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// stick: 8 directions + released. The knob follows the finger; the direction snaps.
const stick = $('stick');
let stickId = null;
function stickMove(e) {
  const r = stick.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy), max = r.width * 0.3;
  held.touchDir = dist < r.width * 0.11 ? -1 : (Math.round(Math.atan2(dx, -dy) / (Math.PI / 4)) + 8) % 8;
  const k = dist > max ? max / dist : 1;
  knobAt = [dx * k, dy * k];
  updateInput();
}
stick.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  stickId = e.pointerId;
  try { stick.setPointerCapture(e.pointerId); } catch {}
  apu.start(); stickMove(e);
});
stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
const stickEnd = (e) => { if (e.pointerId !== stickId) return; stickId = null; held.touchDir = -1; knobAt = null; updateInput(); };
stick.addEventListener('pointerup', stickEnd); stick.addEventListener('pointercancel', stickEnd);

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const c = e.code;
  if (KEYS[c]) held.keys.add(KEYS[c]);
  else if (c === 'KeyZ' || c === 'KeyJ' || c === 'KeyL' || c === 'Enter' || c === 'Space') held.a = true;
  else if (c === 'KeyX' || c === 'KeyK' || c === 'Backspace') held.b = true;
  else if (c === 'Digit2' || c === 'Digit3' || c === 'Digit4') held.actions.add(Number(c[5]) - 1);
  else if (c === 'Digit1' || c === 'Escape') toggleHome();
  else return;
  e.preventDefault(); apu.start(); updateInput();
});
addEventListener('keyup', (e) => {
  const c = e.code;
  if (KEYS[c]) held.keys.delete(KEYS[c]);
  else if (c === 'KeyZ' || c === 'KeyJ' || c === 'KeyL' || c === 'Enter' || c === 'Space') held.a = false;
  else if (c === 'KeyX' || c === 'KeyK' || c === 'Backspace') held.b = false;
  else if (c === 'Digit2' || c === 'Digit3' || c === 'Digit4') held.actions.delete(Number(c[5]) - 1);
  else return;
  updateInput();
});
addEventListener('blur', () => { held.keys.clear(); held.actions.clear(); fingers.clear(); held.a = held.b = false; held.touchDir = -1; knobAt = null; stickId = null; updateInput(); });
// Back from the lock screen or another app: a phone can hold a socket that looks open but
// is dead. The input thread checks it and reconnects at once if it has to.
const wake = () => { if (document.hidden) return; apu.start(); if (inMatch) worker.postMessage({ t: 'wake' }); };
document.addEventListener('visibilitychange', wake);
addEventListener('pageshow', wake);
addEventListener('online', wake);

// ---------------------------------------------------------------- HOME overlay (system, trusted)
function toggleHome(force) {
  if (!inMatch) return;
  const home = $('home');
  home.hidden = force === undefined ? !home.hidden : !force;
  if (!home.hidden) renderHome();
  updateInput();
}
function renderHome() {
  const q = (a) => document.querySelector(`#home [data-act="${a}"]`);
  const row = (label, value) => `${label}<small>${value}</small>`;
  q('sound').innerHTML = row('SOUND', settings.sound ? 'ON' : 'OFF');
  q('music').innerHTML = row('MUSIC', settings.music ? 'ON' : 'OFF');
  q('bright').innerHTML = row('BRIGHTNESS', ['40%', '60%', '80%', '100%'][settings.bright]);
  q('warm').innerHTML = row('WARM FILTER', settings.warm ? 'ON' : 'OFF');
  q('smooth').innerHTML = row('SMOOTH MOTION', settings.smooth ? 'ON' : 'OFF');
}
$('home').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  apu.start();
  if (act === 'resume') return toggleHome(false);
  if (act === 'resign') { worker.postMessage({ t: 'sys', c: SYS_RESIGN }); return toggleHome(false); }   // a system message, never an input bit
  if (act === 'leave') return leaveMatch();
  if (act === 'sound') { settings.sound = !settings.sound; apu.setSound(settings.sound); }
  if (act === 'music') { settings.music = !settings.music; apu.setMusic(settings.music); }
  if (act === 'bright') settings.bright = (settings.bright + 1) % 4;
  if (act === 'warm') settings.warm = !settings.warm;
  if (act === 'smooth') settings.smooth = !settings.smooth;
  save(); renderHome(); buildColors(); if (R && inMatch) onOpsChanged(F_RESET); requestDraw(); apu.click();
});

// ---------------------------------------------------------------- lobby
function token() {
  try {
    let t = sessionStorage.getItem('op-token');
    if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('op-token', t); }
    return t;
  } catch { return Math.random().toString(36).slice(2); }
}

function startMatch(cart) {
  apu.start();
  const room = ($('room').value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'ROOM1').slice(0, 12);
  $('room').value = room;
  try { history.replaceState(null, '', `?cart=${cart}&room=${room}`); } catch {}
  inMatch = true;
  $('lobby').hidden = true; $('home').hidden = true;
  shown.fill(0); resetTimeline();
  $('net').textContent = 'CONNECTING';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  worker.postMessage({ t: 'connect', url: `${proto}://${location.host}/match/${cart}/${room}?t=${token()}` });
  requestDraw();
}

function leaveMatch() {
  inMatch = false;
  worker.postMessage({ t: 'close' });
  apu.stopMusic();
  lastByte = 0;
  $('home').hidden = true; $('lobby').hidden = false;
  for (let b = 2; b <= 4; b++) { $('l' + b).textContent = ''; $('b' + b).parentElement.classList.add('unused'); }
  requestDraw();
}

async function loadLobby() {
  let carts = [{ id: 'dama', name: 'DAMA', players: 2, tick_hz: 1 }, { id: 'pong', name: 'PONG', players: 2, tick_hz: 60 }];
  try { const r = await fetch('/api/carts'); if (r.ok) carts = await r.json(); } catch {}
  const box = $('carts');
  box.textContent = '';
  for (const c of carts) {
    const b = document.createElement('button');
    b.textContent = c.name;
    const s = document.createElement('small');
    s.textContent = `${c.players}P · ${c.tick_hz} HZ`;
    b.appendChild(s);
    b.addEventListener('click', () => startMatch(c.id));
    box.appendChild(b);
  }
  const room = new URLSearchParams(location.search).get('room');
  if (room) $('room').value = room.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
}

// ---------------------------------------------------------------- boot
for (let b = 2; b <= 4; b++) $('b' + b).parentElement.classList.add('unused');
await loadPPU();
buildColors();
new ResizeObserver(resize).observe(canvas);
resize();
loadLobby();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

// for measuring and testing from the console: the picture being shown, and this client's own memory
window.opDebug = { shown, get bufferMs() { return bufferMs; }, get mem() { return R; }, get byte() { return lastByte; }, get settings() { return settings; }, apu };
