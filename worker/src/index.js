// The Cloudflare side: a Hono Worker (the gateway) and two kinds of Durable Object.
//
//   GET  /                        the client (static files from public/, see wrangler.toml)
//   POST /api/session             who am I: makes this device's account on the first visit
//   POST /api/link                a one-time code that puts this account on another device
//   POST /api/link/use            { code }: this device becomes that account
//   GET  /api/carts               the catalog, with price and whether this user may play
//   WS   /match/<cart>/<room>     upgraded here, then handed to that match's Durable Object
//   POST /api/buy                 { cart } -> { url } of a Stripe Checkout page
//   POST /api/stripe              Stripe's webhook: a paid order becomes ownership
//   POST /api/admin/cart          { cart, price_cents?, listed? }     (Bearer ADMIN_KEY)
//   POST /api/admin/grant         { user, cart }                      (Bearer ADMIN_KEY)
//
// MatchDO  : one per match, the CPU. It runs host/match.mjs, the same file as the simulator.
// RegistryDO: one for the console. Users, catalog, ownership, in its own SQLite.
//
// Everything a player may not have is stopped here, before a socket exists: a game that is
// not owned sends nothing at all to the device.
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { DurableObject } from 'cloudflare:workers';
import { Match } from '../../host/match.mjs';
import damaWasm from './carts/dama.wasm';          // copied here by `make`
import pongWasm from './carts/pong.wasm';
import flapWasm from './carts/flap.wasm';
import keysWasm from './carts/keys.wasm';
import trailWasm from './carts/trail.wasm';
import damaInfo from '../../carts/dama/manifest.json';
import pongInfo from '../../carts/pong/manifest.json';
import flapInfo from '../../carts/flap/manifest.json';
import keysInfo from '../../carts/keys/manifest.json';
import trailInfo from '../../carts/trail/manifest.json';

const CARTS = {
  dama: { wasm: damaWasm, info: damaInfo },
  pong: { wasm: pongWasm, info: pongInfo },
  flap: { wasm: flapWasm, info: flapInfo },
  keys: { wasm: keysWasm, info: keysInfo },
  trail: { wasm: trailWasm, info: trailInfo },
};
const known = (cart) => typeof cart === 'string' && Object.hasOwn(CARTS, cart);      // "constructor" is not a game

const COOKIE = 'op_session', YEAR = 365 * 24 * 3600;
const LINK_SECONDS = 300, LINK_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';      // no 0/O, 1/I: easy to read aloud
const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('console'));

// ---------------------------------------------------------------- signing
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));
const keys = new Map();                              // secret -> HMAC key, per isolate
function hmacKey(secret) {
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret);
}
const hmac = async (secret, text) => crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
const hmacOk = async (secret, sig, text) => crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(text));   // constant time

// The key for session cookies: SESSION_SECRET if the owner set one, otherwise a random one
// the registry made on first use and keeps.
let made = null;
function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  made ??= registry(env).secret().catch((e) => { made = null; throw e; });
  return made;
}

// A session token: v1.<user id>.<expires, seconds>.<HMAC of the first three parts>
async function sign(env, user, expires) {
  const body = `v1.${user}.${expires}`;
  return body + '.' + b64url(await hmac(await sessionSecret(env), body));
}
// The user of this request, or null for no cookie or one that is forged, damaged or expired.
async function userOf(c) {
  const parts = String(getCookie(c, COOKIE) || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) || !/^\d{1,12}$/.test(parts[2])) return null;
  let sig;
  try { sig = unb64url(parts[3]); } catch { return null; }
  const good = await hmacOk(await sessionSecret(c.env), sig, parts.slice(0, 3).join('.'));
  return good && Number(parts[2]) > now() ? parts[1] : null;
}

// ---------------------------------------------------------------- routes
const app = new Hono();

async function setSession(c, user) {
  setCookie(c, COOKIE, await sign(c.env, user, now() + YEAR), {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: YEAR,          // HttpOnly: page scripts cannot read it
    secure: new URL(c.req.url).protocol === 'https:',                  // plain http only happens in local development
  });
}

app.post('/api/session', async (c) => {
  let user = await userOf(c);
  if (!user) user = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await registry(c.env).enter(user);
  await setSession(c, user);
  return c.json({ user });
});

// ---- the same account on another device, with no e-mail and no password: the device that
// is signed in shows a code, the other device types it. A code works once, for 5 minutes.
// What the second device already owned moves to the account it joins.
app.post('/api/link', async (c) => {
  const user = await userOf(c);
  if (!user) return c.text('no session', 401);
  return c.json({ code: await registry(c.env).linkCode(user), seconds: LINK_SECONDS });
});

app.post('/api/link/use', async (c) => {
  const { code } = await c.req.json().catch(() => ({}));
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return c.text('unknown code', 404);
  const user = await registry(c.env).redeem(clean, await userOf(c));
  if (!user) return c.text('unknown code', 404);
  await setSession(c, user);
  return c.json({ user });
});

app.get('/api/carts', async (c) => {
  const user = await userOf(c);
  const { rows, owned } = await registry(c.env).catalog(user);
  const out = [];
  for (const { info } of Object.values(CARTS)) {
    const row = rows.find((r) => r.id === info.id);
    if (row && !row.listed) continue;
    const price = row ? row.price_cents : 0;
    out.push({ ...info, price_cents: price, currency: c.env.CURRENCY || 'usd', owned: price === 0 || owned.includes(info.id) });
  }
  return c.json(out, 200, { 'cache-control': 'no-store' });
});

app.get('/match/:cart/:room', async (c) => {
  const { cart, room } = c.req.param();
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected a WebSocket', 426);
  if (!known(cart) || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) return c.text('unknown game or room', 404);

  // Only our own pages may open a match socket. A browser always sends Origin; a page on
  // another site would otherwise connect with this player's session.
  const origin = c.req.header('Origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch {}
    if (host !== new URL(c.req.url).host) return c.text('wrong origin', 403);
  }

  const user = await userOf(c);
  if (!user) return c.text('no session', 401);
  const may = await registry(c.env).mayPlay(user, cart);
  if (may !== 'ok') return c.text(may, may === 'not owned' ? 403 : 404);

  // The seat belongs to this user (plus the tab's own id, so two tabs can play each other).
  // The client cannot pick another identity: what it sends as `t` is only the tab.
  const url = new URL(c.req.url);
  url.searchParams.set('t', user + '.' + (url.searchParams.get('t') || '').slice(0, 64));
  const id = c.env.MATCH.idFromName(cart + '/' + room);
  return c.env.MATCH.get(id).fetch(new Request(url, c.req.raw));       // the socket now belongs to the match
});

// The record of a running match: every input and its tick, and a fingerprint of the
// picture. Only for games that hide nothing ("open" in the manifest): with the record and
// the cartridge anyone could work out everything the game holds.
app.get('/api/log/:cart/:room', async (c) => {
  const { cart, room } = c.req.param();
  if (!(await userOf(c))) return c.text('no session', 401);
  if (!known(cart) || !CARTS[cart].info.open || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) return c.text('no record for this game', 404);
  return c.env.MATCH.get(c.env.MATCH.idFromName(cart + '/' + room)).fetch(new Request(`https://match/log/${cart}`));
});

// ---- buying: Stripe Checkout. The money never touches this Worker; Stripe tells us when
// an order is paid, and only that message grants ownership.
app.post('/api/buy', async (c) => {
  const user = await userOf(c);
  if (!user) return c.text('no session', 401);
  const { cart } = await c.req.json().catch(() => ({}));
  if (!known(cart)) return c.text('unknown game', 404);
  const { rows, owned } = await registry(c.env).catalog(user);
  const row = rows.find((r) => r.id === cart);
  if (row && !row.listed) return c.text('unknown game', 404);
  if (!row || !row.price_cents || owned.includes(cart)) return c.json({ owned: true });
  if (!c.env.STRIPE_SECRET_KEY) return c.text('no payment provider is set up', 501);
  const site = new URL(c.req.url).origin;
  const form = new URLSearchParams({
    mode: 'payment', success_url: `${site}/?paid=${cart}`, cancel_url: `${site}/`,
    client_reference_id: user, 'metadata[user]': user, 'metadata[cart]': cart,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': c.env.CURRENCY || 'usd',
    'line_items[0][price_data][unit_amount]': String(row.price_cents),
    'line_items[0][price_data][product_data][name]': CARTS[cart].info.name,
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST', body: form,
    headers: { Authorization: 'Bearer ' + c.env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) return c.text('the payment provider refused', 502);
  return c.json({ url: (await r.json()).url });
});

app.post('/api/stripe', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.notFound();
  const body = await c.req.text();
  // Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">[,v1=...]
  const parts = (c.req.header('Stripe-Signature') || '').split(',').map((p) => p.trim().split('='));
  const t = parts.find((p) => p[0] === 't')?.[1] || '';
  if (!/^\d+$/.test(t) || Math.abs(now() - Number(t)) > 300) return c.text('bad signature', 400);
  let good = false;
  for (const [k, v] of parts) if (k === 'v1' && /^[0-9a-f]{64}$/.test(v || '') && await hmacOk(secret, unhex(v), `${t}.${body}`)) good = true;
  if (!good) return c.text('bad signature', 400);
  let event;
  try { event = JSON.parse(body); } catch { return c.text('bad body', 400); }
  const order = event?.data?.object;
  if (event.type === 'checkout.session.completed' && order?.payment_status === 'paid' && known(order.metadata?.cart)) {
    await registry(c.env).grant(String(order.metadata.user || ''), order.metadata.cart, 'stripe:' + order.id);
  }
  return c.json({ received: true });
});

// ---- admin, by hand. With no ADMIN_KEY set these routes do not exist.
app.post('/api/admin/:what', async (c) => {
  const want = c.env.ADMIN_KEY, got = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
  if (!want) return c.notFound();
  if (!got || !(await hmacOk(want, await hmac(want, got), want))) return c.text('forbidden', 403);    // compared through an HMAC: no timing leak
  const body = await c.req.json().catch(() => ({}));
  if (!known(body.cart)) return c.text('unknown game', 404);
  if (c.req.param('what') === 'grant') {
    return (await registry(c.env).grant(String(body.user || ''), body.cart, 'admin')) ? c.json({ ok: true }) : c.text('unknown user', 404);
  }
  if (c.req.param('what') === 'cart') {
    const price = Number.isInteger(body.price_cents) && body.price_cents >= 0 ? body.price_cents : null;
    const listed = typeof body.listed === 'boolean' ? Number(body.listed) : null;
    return c.json(await registry(c.env).setCart(body.cart, price, listed));
  }
  return c.notFound();
});

export default app;

// ---------------------------------------------------------------- the registry
export class RegistryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, price_cents INTEGER NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 1)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS owned (user TEXT NOT NULL, cart TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (user, cart))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  #all(query, ...args) { return this.sql.exec(query, ...args).toArray(); }

  // The key that signs session cookies: made once, kept for good.
  secret() {
    const row = this.#all('SELECT v FROM kv WHERE k = ?', 'session')[0];
    if (row) return row.v;
    const v = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?)', 'session', v);
    return v;
  }
  enter(user) { this.sql.exec('INSERT OR IGNORE INTO users (id, created) VALUES (?, ?)', user, now()); }
  catalog(user) {
    return { rows: this.#all('SELECT id, price_cents, listed FROM carts'), owned: user ? this.#all('SELECT cart FROM owned WHERE user = ?', user).map((r) => r.cart) : [] };
  }
  // 'ok', 'not owned', or 'unknown game' for one that is off the list
  mayPlay(user, cart) {
    const row = this.#all('SELECT price_cents, listed FROM carts WHERE id = ?', cart)[0];
    if (row && !row.listed) return 'unknown game';
    if (!row || row.price_cents === 0) return 'ok';
    return this.#all('SELECT 1 AS x FROM owned WHERE user = ? AND cart = ?', user, cart).length ? 'ok' : 'not owned';
  }
  // The one door to ownership: a paid order (Stripe's webhook) or the admin.
  grant(user, cart, source) {
    if (!this.#all('SELECT 1 AS x FROM users WHERE id = ?', user).length) return false;
    this.sql.exec('INSERT OR IGNORE INTO owned (user, cart, at, source) VALUES (?, ?, ?, ?)', user, cart, now(), String(source).slice(0, 80));
    return true;
  }
  // A fresh one-time code for this user. Any older code of theirs stops working.
  linkCode(user) {
    this.sql.exec('DELETE FROM links WHERE user = ? OR expires < ?', user, now());
    let code = '';
    for (const b of crypto.getRandomValues(new Uint8Array(8))) code += LINK_LETTERS[b & 31];
    this.sql.exec('INSERT INTO links (code, user, expires) VALUES (?, ?, ?)', code, user, now() + LINK_SECONDS);
    return code;
  }
  // Use a code. Returns the account it belongs to, or null. `from` is the account this
  // device had until now: what it owned moves over.
  redeem(code, from) {
    const row = this.#all('SELECT user FROM links WHERE code = ? AND expires >= ?', code, now())[0];
    if (!row) return null;
    this.sql.exec('DELETE FROM links WHERE code = ?', code);
    if (from && from !== row.user) {
      this.sql.exec('UPDATE OR IGNORE owned SET user = ? WHERE user = ?', row.user, from);
      this.sql.exec('DELETE FROM owned WHERE user = ?', from);
    }
    return row.user;
  }
  setCart(cart, price, listed) {
    this.sql.exec('INSERT OR IGNORE INTO carts (id) VALUES (?)', cart);
    if (price !== null) this.sql.exec('UPDATE carts SET price_cents = ? WHERE id = ?', price, cart);
    if (listed !== null) this.sql.exec('UPDATE carts SET listed = ? WHERE id = ?', listed, cart);
    return this.#all('SELECT id, price_cents, listed FROM carts WHERE id = ?', cart)[0];
  }
}

// ---------------------------------------------------------------- a match
export class MatchDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.match = null;       // a promise, so two players joining at the same moment share one match
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cart = url.pathname.split('/')[2];
    if (!known(cart)) return new Response('unknown game', { status: 404 });
    if (url.pathname.startsWith('/log/')) {
      if (!this.match) return new Response('no match is running', { status: 404 });
      return Response.json({ cart, ...(await this.match).record() });
    }

    this.match ??= Match.create(CARTS[cart].wasm).then((m) => {
      m.onEmpty = () => { this.match = null; };          // everyone left: the next join starts a fresh match
      return m;
    });
    const match = await this.match;

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.binaryType = 'arraybuffer';
    const conn = { view: -1, send: (bytes) => server.send(bytes), close: () => { try { server.close(1000, 'replaced'); } catch {} } };
    let gone = false;
    const leave = () => { if (!gone) { gone = true; match.leave(conn); } };
    server.addEventListener('message', (e) => { if (e.data instanceof ArrayBuffer && !gone) match.message(conn, new Uint8Array(e.data)); });
    // A close frame must be answered, or the client's socket hangs half closed and the
    // connection keeps this object awake after the player has gone.
    server.addEventListener('close', () => { leave(); try { server.close(1000, 'bye'); } catch {} });
    server.addEventListener('error', leave);

    match.join(conn, url.searchParams.get('t') || crypto.randomUUID());
    return new Response(null, { status: 101, webSocket: client });
  }
}
