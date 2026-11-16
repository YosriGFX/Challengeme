// sim.mjs — local simulator. Plays the role of the Hono Worker + Durable Objects
// on your machine, with zero dependencies (only Node.js built-ins).
//
//   node host/sim.mjs            then open http://localhost:8787 in two tabs
//   JITTER_MS=40 node host/sim.mjs   the same, with a simulated uneven network
//
// Routes (the same ones the Cloudflare Worker serves):
//   GET /                         the client
//   GET /api/carts                the game catalog
//   WS  /match/<cart>/<room>?t=<token>

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from './match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const JITTER = Number(process.env.JITTER_MS) || 0;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function catalog() {
  const dir = path.join(ROOT, 'carts');
  return fs.readdirSync(dir).filter((id) => fs.existsSync(path.join(ROOT, 'dist', id + '.wasm'))).map((id) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8')); } catch { return { id, name: id.toUpperCase(), players: 2 }; }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/carts') {
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
    return res.end(JSON.stringify(catalog()));
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, 'public', path.normalize(rel));
  if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

// ---- matches: one per <cart>/<room>, like one Durable Object per match ----
const matches = new Map();
async function getMatch(cart, room) {
  const key = cart + '/' + room;
  if (!matches.has(key)) {
    const promise = Match.create(fs.readFileSync(path.join(ROOT, 'dist', cart + '.wasm'))).then((m) => {
      m.onEmpty = () => { matches.delete(key); console.log('match closed ', key); };
      console.log('match created', key);
      return m;
    });
    matches.set(key, promise);
  }
  return matches.get(key);
}

// ---- a minimal WebSocket server (RFC 6455, binary frames only) ----
server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/match\/([a-z0-9_-]{1,32})\/([A-Za-z0-9_-]{1,32})$/);
  const key = req.headers['sec-websocket-key'];
  if (!m || !key || !fs.existsSync(path.join(ROOT, 'dist', m[1] + '.wasm'))) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const frame = (opcode, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n])
      : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])]);
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
  };
  // JITTER_MS=40 delays every packet by a random 0..40 ms (order kept), to test on a "bad network"
  let due = 0;
  const deliver = (buf) => {
    if (!JITTER) return frame(2, buf);
    due = Math.max(due, Date.now() + Math.random() * JITTER);
    setTimeout(() => frame(2, buf), due - Date.now());
  };
  const conn = { view: -1, send: (bytes) => deliver(Buffer.from(bytes)), close: () => { if (!socket.destroyed) socket.end(Buffer.from([0x88, 2, 0x03, 0xE8])); } };

  let match, closed = false, buf = Buffer.alloc(0);
  const close = () => { if (closed) return; closed = true; match?.leave(conn); socket.destroy(); };
  const bye = () => {                                   // answer a close frame, then hang up: a clean close (1000)
    if (closed) return;
    closed = true; match?.leave(conn);
    socket.end(Buffer.from([0x88, 2, 0x03, 0xE8]));
  };
  socket.on('close', close);
  socket.on('error', close);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return close();
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const payload = Buffer.from(buf.subarray(total - len, total));
      if (masked) { const k = buf.subarray(off, off + 4); for (let i = 0; i < len; i++) payload[i] ^= k[i & 3]; }
      buf = buf.subarray(total);
      if (opcode === 8) return bye();
      if (opcode === 9) frame(10, payload);
      else if (opcode === 2 && match) match.message(conn, payload);
    }
  });

  try {
    match = await getMatch(m[1], m[2]);
    if (closed) return;
    match.join(conn, url.searchParams.get('t') || crypto.randomUUID());
  } catch (e) { console.error(e); close(); }
});

server.listen(PORT, () => {
  console.log('\n  op-console local simulator\n');
  console.log('  open in two browser tabs:  http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  on your phone (same Wi-Fi): http://' + a.address + ':' + PORT);
  console.log('\n  games: ' + catalog().map((c) => c.id).join(', ') + '\n');
});
