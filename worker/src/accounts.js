// accounts.js — users, the catalog database and purchases. PROPOSAL, and optional.
//
// It is switched on by configuration, not by code: when the Worker has a D1 database bound
// as DB and a secret named SESSION_SECRET, everything below is active. Without them the
// Worker behaves exactly as before: every game is open to everyone (see wrangler.toml).
//
// What it does when it is on:
//   - Users. A player is a guest account made on first visit: a random id in the `users`
//     table and a signed session cookie (HttpOnly, so page scripts cannot read it). No
//     e-mail, no password. A real login (passkey, OAuth, e-mail) plugs in at session().
//   - Catalog. The `carts` table holds what a redeploy should not be needed for: the price
//     of each game and whether it is listed. The games themselves stay inside the Worker.
//   - Purchases. The `owned` table says who may play what. A game with a price above 0 can
//     only be joined by a user who owns it: the Worker refuses the WebSocket before it
//     ever reaches a match, so a locked game sends nothing at all to the device.
//   - No payment provider is built. grant() is the one function a payment webhook has to
//     call; until then POST /api/admin/grant does it by hand, guarded by ADMIN_KEY.
import { getCookie, setCookie } from 'hono/cookie';

const COOKIE = 'op_session';
const YEAR = 365 * 24 * 3600;
const enc = new TextEncoder();

export const enabled = (env) => Boolean(env.DB && env.SESSION_SECRET);

// ---------------------------------------------------------------- database
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS carts (id TEXT PRIMARY KEY, price_cents INTEGER NOT NULL DEFAULT 0, listed INTEGER NOT NULL DEFAULT 1)',
  'CREATE TABLE IF NOT EXISTS owned (user TEXT NOT NULL, cart TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (user, cart))',
];
let ready = null;                                    // once per isolate
function db(env) {
  ready ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((e) => { ready = null; throw e; });
  return ready.then(() => env.DB);
}
const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- session tokens
// v1.<user id>.<expires, seconds>.<HMAC-SHA256 of the first three parts>
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const keys = new Map();                              // secret -> CryptoKey
function key(secret) {
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret);
}
export async function sign(secret, user, expires) {
  const body = `v1.${user}.${expires}`;
  return body + '.' + b64url(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(body)));
}
// Returns the user id, or null for a token that is forged, damaged or expired.
export async function verify(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) || !/^\d{1,12}$/.test(parts[2])) return null;
  let sig;
  try { sig = unb64url(parts[3]); } catch { return null; }
  const good = await crypto.subtle.verify('HMAC', await key(secret), sig, enc.encode(parts.slice(0, 3).join('.')));   // constant time
  return good && Number(parts[2]) > now() ? parts[1] : null;
}

// The signed-in user of this request, or null.
export const userOf = (c) => verify(c.env.SESSION_SECRET, getCookie(c, COOKIE));

// POST /api/session: who am I? Makes the guest account on the first visit.
export async function session(c) {
  const d = await db(c.env);
  let user = await userOf(c);
  if (!user) user = b64url(crypto.getRandomValues(new Uint8Array(16)));
  await d.prepare('INSERT OR IGNORE INTO users (id, created) VALUES (?, ?)').bind(user, now()).run();
  setCookie(c, COOKIE, await sign(c.env.SESSION_SECRET, user, now() + YEAR), {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: YEAR,
    secure: new URL(c.req.url).protocol === 'https:',   // plain http only happens in local development
  });
  return c.json({ user });
}

// ---------------------------------------------------------------- catalog and purchases
// The games built into this Worker, with price and ownership for this user.
export async function catalog(env, manifests, user) {
  const d = await db(env);
  const rows = (await d.prepare('SELECT id, price_cents, listed FROM carts').all()).results;
  const mine = user ? (await d.prepare('SELECT cart FROM owned WHERE user = ?').bind(user).all()).results.map((r) => r.cart) : [];
  const out = [];
  for (const m of manifests) {
    const row = rows.find((r) => r.id === m.id);
    if (row && !row.listed) continue;
    const price = row ? row.price_cents : 0;
    out.push({ ...m, price_cents: price, owned: price === 0 || mine.includes(m.id) });
  }
  return out;
}

// May this user open a match of this game? { ok } or { ok: false, status, why }.
export async function mayPlay(env, user, cart) {
  if (!user) return { ok: false, status: 401, why: 'no session' };
  const d = await db(env);
  const row = await d.prepare('SELECT price_cents, listed FROM carts WHERE id = ?').bind(cart).first();
  if (row && !row.listed) return { ok: false, status: 404, why: 'unknown game' };
  if (!row || row.price_cents === 0) return { ok: true };
  const has = await d.prepare('SELECT 1 AS x FROM owned WHERE user = ? AND cart = ?').bind(user, cart).first();
  return has ? { ok: true } : { ok: false, status: 403, why: 'not owned' };
}

// The one door for purchases: a payment webhook calls this after the money arrived.
export async function grant(env, user, cart, source) {
  const d = await db(env);
  if (!(await d.prepare('SELECT 1 AS x FROM users WHERE id = ?').bind(user).first())) return false;
  await d.prepare('INSERT OR IGNORE INTO owned (user, cart, at, source) VALUES (?, ?, ?, ?)').bind(user, cart, now(), String(source).slice(0, 64)).run();
  return true;
}

// ---------------------------------------------------------------- admin (by hand, until a store exists)
// Authorization: Bearer <ADMIN_KEY>. With no ADMIN_KEY set these routes do not exist.
async function isAdmin(c) {
  const want = c.env.ADMIN_KEY, got = (c.req.header('Authorization') || '').replace(/^Bearer /, '');
  if (!want || !got) return false;
  const k = await key(want);                          // compare through an HMAC: no timing leak, any length
  const [a, b] = await Promise.all([crypto.subtle.sign('HMAC', k, enc.encode(want)), crypto.subtle.sign('HMAC', k, enc.encode(got))]);
  return b64url(a) === b64url(b);
}

export function adminRoutes(app, known) {
  app.post('/api/admin/:what', async (c) => {
    if (!enabled(c.env) || !c.env.ADMIN_KEY) return c.notFound();
    if (!(await isAdmin(c))) return c.text('forbidden', 403);
    let body;
    try { body = await c.req.json(); } catch { return c.text('expected JSON', 400); }
    if (!known(body.cart)) return c.text('unknown game', 404);
    const d = await db(c.env);
    if (c.req.param('what') === 'grant') {            // { user, cart }
      return (await grant(c.env, String(body.user || ''), body.cart, 'admin')) ? c.json({ ok: true }) : c.text('unknown user', 404);
    }
    if (c.req.param('what') === 'cart') {             // { cart, price_cents?, listed? }
      const price = Number.isInteger(body.price_cents) && body.price_cents >= 0 ? body.price_cents : null;
      const listed = typeof body.listed === 'boolean' ? Number(body.listed) : null;
      await d.prepare('INSERT INTO carts (id, price_cents, listed) VALUES (?1, COALESCE(?2, 0), COALESCE(?3, 1)) ' +
                      'ON CONFLICT (id) DO UPDATE SET price_cents = COALESCE(?2, price_cents), listed = COALESCE(?3, listed)').bind(body.cart, price, listed).run();
      return c.json(await d.prepare('SELECT id, price_cents, listed FROM carts WHERE id = ?').bind(body.cart).first());
    }
    return c.notFound();
  });
}
