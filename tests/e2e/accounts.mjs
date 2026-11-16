// accounts.mjs — users, catalog and purchases, tested against the real Worker in
// `wrangler dev` with a local D1 database. Needs: cd worker && npm install.
//
//   node tests/e2e/accounts.mjs
//
// It writes its own temporary wrangler config (wrangler.toml with the accounts block
// switched on) and a throw-away database, and removes both when it ends.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKER = path.join(ROOT, 'worker');
if (!fs.existsSync(path.join(WORKER, 'node_modules/wrangler'))) { console.log('wrangler is not installed: skipping (cd worker && npm install).'); process.exit(0); }

const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex'), ADMIN = 'test-admin-' + crypto.randomBytes(8).toString('hex');
const PORT = 21000 + (process.pid * 13) % 20000;
const BASE = `http://127.0.0.1:${PORT}`;
const config = path.join(WORKER, '.accounts-test.toml');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'op-console-d1-'));

// the real wrangler.toml, with the commented accounts block switched on
const toml = fs.readFileSync(path.join(WORKER, 'wrangler.toml'), 'utf8').replace(/^# (\[\[d1_databases\]\]|binding = "DB"|database_name = .*|database_id = .*)$/gm, '$1');
if (!/^\[\[d1_databases\]\]$/m.test(toml)) throw new Error('the accounts block was not found in wrangler.toml');
fs.writeFileSync(config, toml);

const dev = spawn('npx', ['wrangler', 'dev', '-c', config, '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', state,
  '--var', `SESSION_SECRET:${SECRET}`, '--var', `ADMIN_KEY:${ADMIN}`], { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const cleanup = () => { try { dev.kill(); } catch {} try { fs.rmSync(config); } catch {} try { fs.rmSync(state, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
await new Promise((resolve, reject) => {
  const seen = (d) => { log += d; if (/Ready on/.test(log)) resolve(); };
  dev.stdout.on('data', seen); dev.stderr.on('data', seen);
  dev.on('exit', (c) => reject(new Error('wrangler dev exited ' + c + '\n' + log)));
  setTimeout(() => reject(new Error('wrangler dev did not start\n' + log)), 60000);
});

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what); } };

// A player: remembers its session cookie like a browser does.
function player() {
  const p = { cookie: '', user: null };
  p.fetch = async (url, init = {}) => {
    const r = await fetch(BASE + url, { ...init, headers: { ...(init.headers || {}), ...(p.cookie ? { cookie: p.cookie } : {}) } });
    const set = r.headers.get('set-cookie');
    if (set) { p.cookie = set.split(';')[0]; p.flags = set; }
    return r;
  };
  p.session = async () => { const r = await p.fetch('/api/session', { method: 'POST' }); p.user = (await r.json()).user; return r; };
  p.carts = async () => (await p.fetch('/api/carts')).json();
  // open a match socket; resolves to { open, status, ws, packets }
  p.match = (cart, room, t = 'tab1', headers = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/match/${cart}/${room}?t=${t}`, { headers: { ...(p.cookie ? { cookie: p.cookie } : {}), ...headers } });
    ws.binaryType = 'arraybuffer';
    const s = { open: false, ws, packets: [], closed: false };
    ws.onmessage = (e) => { s.packets.push(new Uint8Array(e.data)); if (s.packets.length === 1) resolve(s); };
    ws.onopen = () => { s.open = true; };
    ws.onclose = () => { s.closed = true; };
    ws.onerror = () => resolve(s);
    setTimeout(() => resolve(s), 4000);
  });
  return p;
}
// The HTTP status an upgrade request gets: 101 when the socket is accepted. (fetch() may
// not send Upgrade headers, so this is a plain HTTP request.)
const status = (p, cart, room, headers = {}) => new Promise((resolve) => {
  const req = http.request(`${BASE}/match/${cart}/${room}?t=x`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
    ...(p.cookie ? { cookie: p.cookie } : {}), ...headers } });
  req.on('response', (r) => { r.resume(); resolve(r.statusCode); });
  req.on('upgrade', (r, socket) => { socket.destroy(); resolve(101); });
  req.on('error', () => resolve(0));
  req.end();
});
const admin = (what, body, key = ADMIN) => fetch(`${BASE}/api/admin/${what}`, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sign = (user, exp, secret = SECRET) => { const body = `v1.${user}.${exp}`; return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url'); };

try {
  console.log('\nusers');
  const a = player(), b = player();
  const r1 = await a.session();
  ok(r1.status === 200 && /^[A-Za-z0-9_-]{22}$/.test(a.user), 'first visit makes a guest account: ' + a.user);
  ok(/HttpOnly/i.test(a.flags) && /SameSite=Lax/i.test(a.flags) && /Path=\//i.test(a.flags), 'the session cookie is HttpOnly, SameSite=Lax');
  const first = a.user;
  await a.session();
  ok(a.user === first, 'the next visit is the same user');
  await b.session();
  ok(b.user !== a.user, 'another device is another user');

  console.log('\nsessions cannot be forged');
  const nobody = player();
  ok(await status(nobody, 'dama', 'S1') === 401, 'no session: the match socket is refused (401)');
  for (const [name, token] of Object.entries({
    'a signature from another secret': sign(a.user, Math.floor(Date.now() / 1000) + 1000, 'wrong-secret'),
    'someone else\'s id with my signature': a.cookie.split('=')[1].replace(a.user, b.user),
    'an expired session': sign(a.user, Math.floor(Date.now() / 1000) - 10),
    'a damaged token': a.cookie.split('=')[1].slice(0, -3),
    'nonsense': 'v1.x.y.z',
  })) {
    const forged = player(); forged.cookie = 'op_session=' + token;
    ok(await status(forged, 'dama', 'S1') === 401, name + ' is refused (401)');
  }
  const valid = player(); valid.cookie = 'op_session=' + sign(a.user, Math.floor(Date.now() / 1000) + 1000);
  ok(await status(valid, 'dama', 'S1') === 101, '(a token signed with the real secret is accepted)');

  console.log('\ncatalog');
  let carts = await a.carts();
  ok(carts.length === 4 && carts.every((c) => c.price_cents === 0 && c.owned === true), 'four games, all free, all playable');
  let m = await a.match('dama', 'S2');
  ok(m.open && m.packets.length === 1 && m.packets[0][3] === 0x01, 'a free game opens and sends its full dump');
  m.ws.close();

  console.log('\nadmin');
  ok((await admin('cart', { cart: 'pong', price_cents: 199 }, 'wrong-key')).status === 403, 'a wrong admin key is refused (403)');
  ok((await fetch(BASE + '/api/admin/cart', { method: 'POST', body: '{}' })).status === 403, 'no admin key is refused (403)');
  ok((await admin('cart', { cart: 'nosuchgame', price_cents: 1 })).status === 404, 'an unknown game is refused (404)');
  const set = await admin('cart', { cart: 'pong', price_cents: 199 });
  ok(set.status === 200 && (await set.json()).price_cents === 199, 'pong now costs 1.99');

  console.log('\npurchases');
  carts = await a.carts();
  const pong = carts.find((c) => c.id === 'pong');
  ok(pong.price_cents === 199 && pong.owned === false, 'the catalog shows pong as not owned');
  ok(carts.filter((c) => c.owned).length === 3, 'the other three are still playable');
  ok(await status(a, 'pong', 'S3') === 403, 'a game that is not owned is refused before any socket exists (403)');
  m = await a.match('pong', 'S3');
  ok(!m.open && m.packets.length === 0, 'not one byte of it reaches the device');
  ok((await admin('grant', { user: 'AAAAAAAAAAAAAAAAAAAAAA', cart: 'pong' })).status === 404, 'a grant to an unknown user is refused (404)');
  ok((await admin('grant', { user: a.user, cart: 'pong' })).status === 200, 'grant: the user now owns pong');
  ok((await a.carts()).find((c) => c.id === 'pong').owned === true, 'the catalog shows it as owned');
  m = await a.match('pong', 'S3');
  ok(m.open && m.packets.length === 1, 'and the match opens');
  m.ws.close();
  ok((await b.carts()).find((c) => c.id === 'pong').owned === false && await status(b, 'pong', 'S3') === 403, 'the other user still does not own it');

  ok((await admin('cart', { cart: 'keys', listed: false })).status === 200, 'keys is taken off the list');
  ok(!(await a.carts()).some((c) => c.id === 'keys') && await status(a, 'keys', 'S4') === 404, 'an unlisted game is not in the catalog and cannot be joined (404)');
  await admin('cart', { cart: 'keys', listed: true }); await admin('cart', { cart: 'pong', price_cents: 0 });
  ok((await b.carts()).every((c) => c.owned) && (await b.carts()).length === 4, 'listed again and free again: everything is playable');

  console.log('\nseats belong to users');
  const s1 = await a.match('dama', 'S5', 'tabX');                      // a: seat 1
  const s2 = await b.match('dama', 'S5', 'tabX');                      // b sends the same tab id: must NOT take a's seat
  await new Promise((r) => setTimeout(r, 300));
  ok(s1.open && !s1.closed && s2.open, 'another user with the same tab id gets their own seat; nobody is thrown out');
  const s3 = await a.match('dama', 'S5', 'tabX');                      // the same user and tab: reconnect
  await new Promise((r) => setTimeout(r, 300));
  ok(s3.open && s1.closed && !s2.closed, 'the same user and tab gets their seat back; the old socket is closed');
  s2.ws.close(); s3.ws.close();

  console.log('\nother sites');
  ok(await status(a, 'dama', 'S6', { Origin: 'https://evil.example' }) === 403, 'a page on another site cannot open a match socket (403)');
  ok(await status(a, 'dama', 'S6', { Origin: BASE }) === 101, 'our own page can');
} catch (e) { failed++; console.log('  FAIL ' + (e.stack || e)); }

cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
