// main.js — the console's front panel: lobby, HOME, and the wiring between the
// controller (pad.js), the screen (screen.js), the sound chip (sound.js) and the
// network thread (net.js). No game runs here; games exist only on the server.
import * as screen from './screen.js';
import { F } from './screen.js';
import { createPad } from './pad.js';
import { Sound } from './sound.js';

const $ = (id) => document.getElementById(id);
const W_SFX = 0x40, SYS_RESIGN = 1, PATTERN_SIZE = 3 + 32 * 4;

// ---------------------------------------------------------------- the player's own settings
// Display and sound belong to the player, like the menu of a monitor.
const settings = { sound: true, music: true, bright: 3, warm: false, smooth: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem('op-console') || '{}')); } catch {}
const save = () => { try { localStorage.setItem('op-console', JSON.stringify(settings)); } catch {} };

const apu = new Sound();
apu.setSound(settings.sound); apu.setMusic(settings.music);
for (const type of ['pointerdown', 'pointerup', 'touchend', 'keydown']) {
  addEventListener(type, () => apu.start(), { capture: true, passive: true });
}

let R = null, pad = null;
let inMatch = false, online = false;
let wire = 0, count = 0;                     // the byte the server has, and inputs sent since the socket opened
let active = null;                           // the open menu (lobby or HOME), or null while playing

// ---------------------------------------------------------------- menus: stick + A / B, or a tap
function makeMenu(box, back) {
  const m = {
    box, back, rows: [], focus: 0,
    set(rows) { m.rows = rows; m.focus = Math.min(m.focus, Math.max(0, rows.length - 1)); m.draw(); },
    draw() {
      box.textContent = '';
      m.rows.forEach((r, i) => {
        const d = document.createElement('div');
        d.className = 'row' + (i === m.focus ? ' focus' : '') + (r.cls ? ' ' + r.cls : '');
        d.dataset.row = i;
        d.append(r.text);
        if (r.note) { const s = document.createElement('small'); s.textContent = r.note; d.append(s); }
        box.append(d);
      });
    },
    move(d) { if (m.rows.length) { m.focus = (m.focus + d + m.rows.length) % m.rows.length; m.draw(); } },
    press() { const r = m.rows[m.focus]; if (r) { apu.click(); r.act(); } },
  };
  return m;
}
const lobby = makeMenu($('games'), null);
const home = makeMenu($('homemenu'), () => toggleHome(false));

function menuInput(byte, prev) {
  const on = byte & 8, pushed = on && (!(prev & 8) || (byte & 7) !== (prev & 7));
  const dir = byte & 7, pressed = byte & ~prev;
  if (pushed && (dir === 7 || dir === 0 || dir === 1)) active.move(-1);
  if (pushed && (dir === 3 || dir === 4 || dir === 5)) active.move(1);
  if (pressed & 0x10) active.press();
  else if ((pressed & 0x20) && active.back) active.back();
}

// ---------------------------------------------------------------- input
function toGame(byte) {
  if (byte === wire) return;
  const was = wire;
  wire = byte;
  // the player's own presses click here at once, with no round trip
  if ((byte & ~was & 0x30) || ((byte >> 6) && (byte >> 6) !== (was >> 6))) { apu.click(); navigator.vibrate?.(8); }
  const seq = online ? (count = (count + 1) & 255) : -1;
  net.postMessage({ t: 'in', b: byte, f: screen.tickOnScreen() });
  screen.input(byte, was, seq);
}
function onByte(byte, prev) {
  if (active) menuInput(byte, prev);         // a menu is open: the cartridge sees nothing
  else if (inMatch) toGame(byte);
}
function onTouch(el) {
  const row = el.closest('[data-row]');
  if (row && active && active.box.contains(row)) { active.focus = Number(row.dataset.row); active.press(); }
}

// ---------------------------------------------------------------- packets
let lastResync = 0, statBytes = 0, statPkts = 0;

function onPacket(buf) {
  statBytes += buf.byteLength; statPkts++;
  const { flags, events } = screen.apply(buf);
  if (flags & F.ERROR) {                     // a packet that does not parse changes nothing: ask for a full dump
    if (Date.now() - lastResync > 1000) { lastResync = Date.now(); net.postMessage({ t: 'resync' }); }
    return;
  }
  if (flags & F.TRANS) showLabels();
  for (const [type, a, b] of events) {
    if (type === W_SFX) apu.sfx(R.sfx.subarray((a & 15) * 8, (a & 15) * 8 + 8));
    else if (a === 1) {
      const p = (b & 3) * PATTERN_SIZE;
      apu.play({ step: R.music[p] / 100, steps: R.music[p + 1], vol: R.music[p + 2], notes: R.music.slice(p + 3, p + 3 + R.music[p + 1] * 4) }, (flags & F.RESET) !== 0);
    } else apu.stop();
  }
}

function showLabels() {
  for (let b = 0; b < 3; b++) {
    let text = '';
    for (let i = 0; i < 8 && R.labels[b * 8 + i]; i++) text += String.fromCharCode(R.labels[b * 8 + i]);
    $('l' + (b + 2)).textContent = text;
    $('l' + (b + 2)).parentElement.classList.toggle('unused', !text);
  }
}
function clearLabels() { for (let b = 2; b <= 4; b++) { $('l' + b).textContent = ''; $('l' + b).parentElement.classList.add('unused'); } }

setInterval(() => {
  const s = screen.stats();
  $('stats').textContent = inMatch ? `${s.hz} HZ · ${statPkts} PKT/S · ${statBytes} B/S` + (s.bufMs ? ` · BUF ${Math.round(s.bufMs)} MS` : '') : '';
  statBytes = statPkts = 0;
}, 1000);

// ---------------------------------------------------------------- the network thread
const net = new Worker('net.js');
net.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'pkt') { if (inMatch) onPacket(m.buf); }
  else if (m.t === 'open') {
    online = true; count = m.resent ? 1 : 0;
    screen.link(true, m.resent);
    $('led').classList.add('on'); $('net').textContent = 'ONLINE';
  } else if (m.t === 'close') {
    online = false;
    screen.link(false);
    $('led').classList.remove('on'); $('net').textContent = inMatch ? 'RECONNECTING' : 'OFFLINE';
    if (inMatch) session();                  // a lost session would refuse every retry
  }
};

// Back from the lock screen or another app: the network thread checks its socket.
const wake = () => { if (document.hidden) return; apu.start(); if (inMatch) net.postMessage({ t: 'wake' }); };
document.addEventListener('visibilitychange', wake);
addEventListener('pageshow', wake);
addEventListener('online', wake);

// ---------------------------------------------------------------- HOME (the system's own, above every game)
let resignArmed = false;
function homeRows() {
  const toggle = (key, set) => () => { settings[key] = !settings[key]; set?.(settings[key]); changed(); };
  const changed = () => { save(); screen.configure(settings); home.set(homeRows()); };
  return [
    { text: 'RESUME', act: () => toggleHome(false) },
    { text: 'SOUND', note: settings.sound ? 'ON' : 'OFF', act: toggle('sound', (v) => apu.setSound(v)) },
    { text: 'MUSIC', note: settings.music ? 'ON' : 'OFF', act: toggle('music', (v) => apu.setMusic(v)) },
    { text: 'BRIGHTNESS', note: ['40%', '60%', '80%', '100%'][settings.bright], act: () => { settings.bright = (settings.bright + 1) % 4; changed(); } },
    { text: 'WARM FILTER', note: settings.warm ? 'ON' : 'OFF', act: toggle('warm') },
    { text: 'SMOOTH MOTION', note: settings.smooth ? 'ON' : 'OFF', act: toggle('smooth') },
    { text: resignArmed ? 'RESIGN?' : 'RESIGN', note: resignArmed ? 'PRESS AGAIN' : '', cls: 'danger', act: () => {
      if (!resignArmed) { resignArmed = true; home.set(homeRows()); return; }
      net.postMessage({ t: 'sys', c: SYS_RESIGN });          // a system message, never an input bit
      toggleHome(false);
    } },
    { text: 'LEAVE MATCH', act: leaveMatch },
  ];
}
function toggleHome(open = $('home').hidden) {
  if (!inMatch) return;
  $('home').hidden = !open;
  resignArmed = false;
  if (open) { toGame(0); active = home; home.focus = 0; home.set(homeRows()); }      // the cartridge sees every button released
  else { active = null; toGame(pad.byte); }
}

// ---------------------------------------------------------------- lobby
// Makes (or renews) this device's account. The cookie it sets is the player's identity.
const session = () => fetch('/api/session', { method: 'POST' }).catch(() => {});

function tabId() {                           // tells two tabs of the same player apart
  try {
    let t = sessionStorage.getItem('op-tab');
    if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('op-tab', t); }
    return t;
  } catch { return Math.random().toString(36).slice(2); }
}

function startMatch(cart) {
  const room = ($('room').value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') || 'ROOM1').slice(0, 12);
  $('room').value = room;
  try { history.replaceState(null, '', `?room=${room}`); } catch {}
  inMatch = true; active = null; wire = 0;
  $('lobby').hidden = true; $('home').hidden = true;
  $('net').textContent = 'CONNECTING';
  screen.power(true);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  net.postMessage({ t: 'connect', url: `${proto}://${location.host}/match/${cart}/${room}?t=${tabId()}` });
}

function leaveMatch() {
  inMatch = false; wire = 0;
  net.postMessage({ t: 'close' });
  apu.stop();
  screen.power(false);
  clearLabels();
  $('home').hidden = true; $('lobby').hidden = false;
  active = lobby;
  loadLobby();
}

async function buy(cart) {
  $('hint').textContent = 'OPENING THE SHOP';
  try {
    const r = await fetch('/api/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cart }) });
    const answer = r.ok ? await r.json() : null;
    if (answer?.url) { location.href = answer.url; return; }
    if (answer?.owned) return loadLobby();
  } catch {}
  $('hint').textContent = 'NOT FOR SALE YET';
}

// The same account on another device: this device shows a code, the other one types it.
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
async function showLinkCode() {
  try {
    const r = await post('/api/link');
    if (r.ok) { const { code } = await r.json(); $('hint').textContent = `CODE ${code.slice(0, 4)}-${code.slice(4)} · 5 MINUTES`; return; }
  } catch {}
  $('hint').textContent = 'NOT AVAILABLE HERE';
}
async function useLinkCode() {
  const code = prompt('CODE FROM YOUR OTHER DEVICE');
  if (!code) return;
  try { if ((await post('/api/link/use', { code })).ok) { await loadLobby(); $('hint').textContent = 'THIS DEVICE IS LINKED'; return; } } catch {}
  $('hint').textContent = 'UNKNOWN CODE';
}

async function loadLobby() {
  await session();
  let carts = [];
  try { const r = await fetch('/api/carts'); if (r.ok) carts = await r.json(); } catch {}
  const rows = carts.map((c) => (c.owned === false
    ? { text: c.name, note: `${(c.price_cents / 100).toFixed(2)} ${(c.currency || '').toUpperCase()}`, cls: 'locked', act: () => buy(c.id) }
    : { text: c.name, note: `${c.players}P · ${c.tick_hz} HZ`, act: () => startMatch(c.id) }));
  if (carts.length) rows.push({ text: 'LINK A DEVICE', note: 'SHOW CODE', act: showLinkCode }, { text: 'LINK A DEVICE', note: 'ENTER CODE', act: useLinkCode });
  lobby.set(rows);
  $('hint').textContent = carts.length ? 'SAME ROOM = SAME MATCH' : 'NO CONNECTION';
}

// ---------------------------------------------------------------- boot
clearLabels();
R = await screen.init($('lcd'));
screen.configure(settings);
document.fonts?.load('700 12px ConsoleFont').then(() => screen.configure(settings)).catch(() => {});     // draw again once the font is in
pad = createPad({ onByte, onHome: () => toggleHome(), onTouch });
const room = new URLSearchParams(location.search).get('room');
if (room) $('room').value = room.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
// Safari can leave a pinned page shifted after its keyboard closes: put it back.
$('room').addEventListener('blur', () => window.scrollTo(0, 0));
active = lobby;
loadLobby();
if (new URLSearchParams(location.search).has('paid')) {       // back from the shop: the payment may land a moment later
  setTimeout(() => { if (!inMatch) loadLobby(); }, 2500);
  setTimeout(() => { if (!inMatch) loadLobby(); }, 7000);
}
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

window.opDebug = { R, screen, get byte() { return wire; } };       // this device's own memory, for the console
