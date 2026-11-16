// The Cloudflare side: a Hono Worker (gateway) + one Durable Object per match (the CPU).
//
//   GET /                          the client (static assets, see wrangler.toml)
//   GET /api/carts                 the game catalog
//   WS  /match/<cart>/<room>?t=    upgraded by the Worker, then handed to the Durable Object
//
// The Durable Object runs the exact same host/match.mjs as the local simulator.
import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { Match } from '../../host/match.mjs';
import damaWasm from './carts/dama.wasm';      // copied here by `make`
import pongWasm from './carts/pong.wasm';
import flapWasm from './carts/flap.wasm';
import keysWasm from './carts/keys.wasm';
import damaManifest from '../../carts/dama/manifest.json';
import pongManifest from '../../carts/pong/manifest.json';
import flapManifest from '../../carts/flap/manifest.json';
import keysManifest from '../../carts/keys/manifest.json';

const CARTS = {
  dama: { wasm: damaWasm, manifest: damaManifest },
  pong: { wasm: pongWasm, manifest: pongManifest },
  flap: { wasm: flapWasm, manifest: flapManifest },
  keys: { wasm: keysWasm, manifest: keysManifest },
};

const app = new Hono();

app.get('/api/carts', (c) => c.json(Object.values(CARTS).map((x) => x.manifest)));

// This is where auth, users, purchases and sessions go: check them here,
// before the socket ever reaches a match.
app.get('/match/:cart/:room', (c) => {
  const { cart, room } = c.req.param();
  if (c.req.header('Upgrade') !== 'websocket') return c.text('expected a WebSocket', 426);
  if (!CARTS[cart] || !/^[A-Za-z0-9_-]{1,32}$/.test(room)) return c.text('unknown game or room', 404);
  const id = c.env.MATCH.idFromName(cart + '/' + room);
  return c.env.MATCH.get(id).fetch(c.req.raw);          // the WebSocket now belongs to the Durable Object
});

export default app;

export class MatchDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.match = null;       // a promise, so two joins at the same time share one match
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cart = url.pathname.split('/')[2];
    if (!CARTS[cart]) return new Response('unknown game', { status: 404 });

    if (!this.match) {
      this.match = Match.create(CARTS[cart].wasm).then((m) => {
        m.onEmpty = () => { this.match = null; };        // everyone left: the next join starts a fresh match
        return m;
      });
    }
    const match = await this.match;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.binaryType = 'arraybuffer';

    const conn = { view: -1, send: (bytes) => server.send(bytes), close: () => { try { server.close(1000, 'replaced'); } catch {} } };
    let closed = false;
    const leave = () => { if (!closed) { closed = true; match.leave(conn); } };
    server.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) match.message(conn, new Uint8Array(e.data));
      else if (e.data && e.data.arrayBuffer) e.data.arrayBuffer().then((b) => match.message(conn, new Uint8Array(b)));
    });
    // The client's close frame must be answered, or its socket hangs in CLOSING and the
    // connection keeps this Durable Object awake after the player has left.
    server.addEventListener('close', () => { leave(); try { server.close(1000, 'bye'); } catch {} });
    server.addEventListener('error', leave);

    match.join(conn, url.searchParams.get('t') || crypto.randomUUID());
    return new Response(null, { status: 101, webSocket: client });
  }
}
