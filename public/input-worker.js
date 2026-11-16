// input-worker.js — the input thread. It owns the WebSocket.
// Input never waits for rendering, and rendering never blocks input.
//
//   main -> worker : { t:'connect', url } | { t:'in', b } | { t:'sys', c } | { t:'resync' } | { t:'wake' } | { t:'close' }
//   worker -> main : { t:'open' } | { t:'close' } | { t:'pkt', buf }
'use strict';

const C_IN = 0x01, C_SYS = 0x02, C_RESYNC = 0x03;
const PROBE_MS = 2500;
let ws = null, url = null, input = 0, sentInput = -1, retry = null, probe = null, heard = 0;

function send(a, b) {
  if (ws && ws.readyState === 1) { ws.send(b === undefined ? new Uint8Array([a]) : new Uint8Array([a, b])); return true; }
  return false;
}

function connect() {
  clearTimeout(retry); clearTimeout(probe);
  if (!url) return;
  const sock = new WebSocket(url);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    postMessage({ t: 'open' });
    sentInput = 0;                                   // the server starts from "nothing pressed"
    if (input !== 0 && send(C_IN, input)) sentInput = input;
  };
  sock.onmessage = (e) => { if (ws === sock) { heard++; postMessage({ t: 'pkt', buf: e.data }, [e.data]); } };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    postMessage({ t: 'close' });
    if (url) retry = setTimeout(connect, 1000);      // the server sends a full dump on every join
  };
  sock.onerror = () => {};
}

// The page is visible again (or the network came back). After a phone sleeps, a socket can
// stay "open" for a long time with nobody at the other end, and an idle screen is silent by
// design, so silence proves nothing. A RESYNC is always answered with a full dump: if none
// comes back, the socket is dead and we reconnect.
function wake() {
  if (!url) return;
  if (!ws || ws.readyState > 1) return connect();    // closed: do not wait for the retry timer
  if (ws.readyState !== 1) return;                   // still connecting
  const sock = ws, before = heard;
  send(C_RESYNC);
  clearTimeout(probe);
  probe = setTimeout(() => {
    if (ws !== sock || heard !== before) return;
    ws = null;
    try { sock.close(); } catch {}
    postMessage({ t: 'close' });
    connect();
  }, PROBE_MS);
}

onmessage = (e) => {
  const m = e.data;
  if (m.t === 'in') {                                // sent only on change
    input = m.b;
    if (input !== sentInput && send(C_IN, input)) sentInput = input;
  } else if (m.t === 'sys') send(C_SYS, m.c);
  else if (m.t === 'resync') send(C_RESYNC);
  else if (m.t === 'wake') wake();
  else if (m.t === 'connect') { url = m.url; input = 0; if (ws) { const o = ws; ws = null; o.close(); } connect(); }
  else if (m.t === 'close') { url = null; clearTimeout(retry); clearTimeout(probe); if (ws) { const o = ws; ws = null; o.close(); } postMessage({ t: 'close' }); }
};
