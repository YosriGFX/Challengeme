// local.js — the console's CPU on this device, for the games that are allowed to be here.
//
// Normally a game exists only on the server. A cartridge whose manifest says "offline" may
// be kept on a device, and then this thread hosts the match itself: the very same
// host/match.mjs the server runs, with the cartridge fetched from /offline/<cart>.wasm
// (the service worker keeps a copy, so it also works with no network).
//
// Two players, one phone. The thread holds both seats and shows the page the view of the
// seat that must act (the cartridge's cart_turn); after a move the board turns to the other
// player. It speaks to the page exactly like net.js, so the page does not know the difference.
import { Match } from './match.mjs';

const C_IN = 0x01, C_SYS = 0x02, C_RESYNC = 0x03;
const TURN_MS = 900;                         // the mover sees the move land before the board turns
let match = null, conns = [], seat = 0, turning = null;

const say = (bytes, conn) => { if (match && conn === conns[seat]) postMessage({ t: 'pkt', buf: bytes.buffer }, [bytes.buffer]); };

// Whose move is it? Hand the screen over when that changed.
function follow() {
  if (!match || turning) return;
  const next = match.x.con_turn();
  if (next >= match.players || next === seat) return;
  turning = setTimeout(() => {
    turning = null;
    if (!match) return;
    const now = match.x.con_turn();
    if (now >= match.players || now === seat) return;
    match.message(conns[seat], new Uint8Array([C_IN, 0, 0]));          // the seat being left lets go of everything
    seat = now;
    postMessage({ t: 'open', resent: false });                         // a new seat: the page counts its inputs from zero
    match.message(conns[seat], new Uint8Array([C_RESYNC]));            // and gets that seat's whole picture
  }, TURN_MS);
}

async function start(url) {
  stop();
  const cart = new URL(url).pathname.split('/')[2];
  let wasm;
  try {
    const res = await fetch(`offline/${cart}.wasm`);
    if (!res.ok) throw new Error(String(res.status));
    wasm = await res.arrayBuffer();
  } catch { postMessage({ t: 'close' }); return; }                     // not kept on this phone, and no network to fetch it
  const m = await Match.create(wasm);
  const tick = m.tick.bind(m);
  m.tick = () => { tick(); follow(); };                                // a clock can end a game too
  match = m; seat = 0;
  conns = Array.from({ length: m.players }, () => { const c = { view: -1, close() {} }; c.send = (bytes) => say(bytes, c); return c; });
  postMessage({ t: 'open', resent: false });
  conns.forEach((c, i) => m.join(c, 'seat' + i));                      // each join answers with that seat's full dump
  m.message(conns[seat], new Uint8Array([C_RESYNC]));                  // the picture after everybody sat down
  follow();
}

function stop() {
  clearTimeout(turning); turning = null;
  const m = match;
  match = null;
  if (m) for (const c of conns) m.leave(c);
  conns = [];
}

onmessage = (e) => {
  const m = e.data;
  if (m.t === 'connect') start(m.url);
  else if (m.t === 'close') { const had = match !== null; stop(); if (had) postMessage({ t: 'close' }); }
  else if (!match) return;
  else if (m.t === 'in') { match.message(conns[seat], new Uint8Array([C_IN, m.b, m.f])); follow(); }
  else if (m.t === 'sys') { match.message(conns[seat], new Uint8Array([C_SYS, m.c])); follow(); }
  else if (m.t === 'resync' || m.t === 'wake') match.message(conns[seat], new Uint8Array([C_RESYNC]));
};
