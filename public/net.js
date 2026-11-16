// net.js — the input thread (a Web Worker). It owns the WebSocket, so input never waits
// for drawing and drawing never holds up input.
//
//   page -> thread : { t:'connect', url } | { t:'in', b, f } | { t:'sys', c } | { t:'resync' } | { t:'wake' } | { t:'close' }
//   thread -> page : { t:'open', resent } | { t:'close' } | { t:'pkt', buf }
'use strict';

const C_IN = 0x01, C_SYS = 0x02, C_RESYNC = 0x03;
const RETRY_MS = 1000, PROBE_MS = 2500;
let ws = null, url = null, input = 0, shown = 0, wired = -1, retry = null, probe = null, heard = 0;

const up = () => ws !== null && ws.readyState === 1;

function connect() {
  clearTimeout(retry); clearTimeout(probe);
  if (!url) return;
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    wired = 0;                                         // the server starts from "nothing pressed"
    const resent = input !== 0;
    if (resent) { sock.send(new Uint8Array([C_IN, input, shown])); wired = input; }
    postMessage({ t: 'open', resent });
  };
  sock.onmessage = (e) => { if (ws === sock) { heard++; postMessage({ t: 'pkt', buf: e.data }, [e.data]); } };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    postMessage({ t: 'close' });
    if (url) retry = setTimeout(connect, RETRY_MS);    // every join gets a full dump
  };
  sock.onerror = () => {};
}

function drop() {
  const old = ws;
  ws = null;
  if (old) try { old.close(); } catch {}
}

// The page is visible again, or the network came back. After a phone sleeps, a socket can
// look open for a long time with nobody at the other end, and an idle screen is silent by
// design, so silence proves nothing. A RESYNC is always answered with a full dump: if none
// comes, the socket is dead and a new one is opened.
function wake() {
  if (!url) return;
  if (!ws || ws.readyState > 1) return connect();      // closed: do not wait for the retry timer
  if (ws.readyState !== 1) return;                     // still connecting
  const sock = ws, before = heard;
  sock.send(new Uint8Array([C_RESYNC]));
  clearTimeout(probe);
  probe = setTimeout(() => {
    if (ws !== sock || heard !== before) return;
    drop();
    postMessage({ t: 'close' });
    connect();
  }, PROBE_MS);
}

onmessage = (e) => {
  const m = e.data;
  if (m.t === 'in') {                                  // sent only when the byte changes; f = the tick on screen
    input = m.b; shown = m.f;
    if (up() && input !== wired) { ws.send(new Uint8Array([C_IN, input, shown])); wired = input; }
  }
  else if (m.t === 'sys') { if (up()) ws.send(new Uint8Array([C_SYS, m.c])); }
  else if (m.t === 'resync') { if (up()) ws.send(new Uint8Array([C_RESYNC])); }
  else if (m.t === 'wake') wake();
  else if (m.t === 'connect') { url = m.url; input = 0; drop(); connect(); }
  else if (m.t === 'close') { url = null; clearTimeout(retry); clearTimeout(probe); const had = ws !== null; drop(); if (had) postMessage({ t: 'close' }); }
};
