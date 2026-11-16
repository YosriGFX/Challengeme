// sim.mjs — the console on your own machine: what the Worker and its Durable Objects do
// on Cloudflare, with nothing but Node.js. No accounts here: every game is open.
//
//   node host/sim.mjs                   then open http://localhost:8787 in two tabs
//   JITTER_MS=40 node host/sim.mjs      the same, on a simulated uneven network
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Match } from './match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;
const JITTER = Number(process.env.JITTER_MS) || 0;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const cartFile = (id) => path.join(ROOT, 'dist', id + '.wasm');
function catalog() {
  return fs.readdirSync(path.join(ROOT, 'carts')).filter((id) => fs.existsSync(cartFile(id))).map((id) =>
    ({ ...JSON.parse(fs.readFileSync(path.join(ROOT, 'carts', id, 'manifest.json'), 'utf8')), price_cents: 0, owned: true }));
}
const json = (res, body) => { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/carts') return json(res, catalog());
  if (url.pathname === '/api/session') return json(res, { user: 'local' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = '/'; }
  const file = path.join(PUBLIC, path.normalize(rel === '/' ? '/index.html' : rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }      // only public/ is served
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
});

// one match per <cart>/<room>, like one Durable Object per match
const matches = new Map();
function match(cart, room) {
  const key = cart + '/' + room;
  if (!matches.has(key)) {
    matches.set(key, Match.create(fs.readFileSync(cartFile(cart))).then((m) => { m.onEmpty = () => matches.delete(key); return m; }));
  }
  return matches.get(key);
}

// a small WebSocket server (RFC 6455, binary frames)
const CLOSE = Buffer.from([0x88, 2, 0x03, 0xE8]);                                         // close frame, code 1000
server.on('upgrade', async (req, socket) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/match\/([a-z0-9_-]{1,32})\/([A-Za-z0-9_-]{1,32})$/);
  const key = req.headers['sec-websocket-key'];
  let origin = null;                                                                       // like the Worker: our own pages only
  try { if (req.headers.origin) origin = new URL(req.headers.origin).host; } catch { origin = ''; }
  if (!m || !key || !fs.existsSync(cartFile(m[1]))) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  if (origin !== null && origin !== req.headers.host) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);

  const frame = (opcode, payload) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);      // packets are under 64 KB
    if (!socket.destroyed) socket.write(Buffer.concat([head, payload]));
  };
  let due = 0;                                                                             // JITTER_MS: each packet 0..N ms late, order kept
  const deliver = (buf) => {
    if (!JITTER) return frame(2, buf);
    due = Math.max(due, Date.now() + Math.random() * JITTER);
    setTimeout(() => frame(2, buf), due - Date.now());
  };
  const conn = { view: -1, send: (bytes) => deliver(Buffer.from(bytes)), close: () => { if (!socket.destroyed) socket.end(CLOSE); } };

  let game = null, gone = false, buf = Buffer.alloc(0);
  const leave = () => { if (!gone) { gone = true; game?.leave(conn); } };
  socket.on('close', leave);
  socket.on('error', () => { leave(); socket.destroy(); });
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { leave(); return socket.destroy(); }                          // no client message is that long
      const total = at + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const payload = Buffer.from(buf.subarray(total - len, total));
      if (masked) { const k = buf.subarray(at, at + 4); for (let i = 0; i < len; i++) payload[i] ^= k[i & 3]; }
      buf = buf.subarray(total);
      if (opcode === 8) { leave(); return socket.end(CLOSE); }                             // answer the close, then hang up
      if (opcode === 9) frame(10, payload);
      else if (opcode === 2 && game && !gone) game.message(conn, payload);
    }
  });

  try {
    game = await match(m[1], m[2]);
    if (!gone) game.join(conn, url.searchParams.get('t') || crypto.randomUUID());
  } catch (e) { console.error(e); leave(); socket.destroy(); }
});

server.listen(PORT, () => {
  console.log('\n  OP Console, local simulator\n\n  open in two browser tabs:   http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log('  on a phone, same Wi-Fi:     http://' + a.address + ':' + PORT);
  console.log('\n  games: ' + catalog().map((c) => c.id).join(', ') + '\n');
});
