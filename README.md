# OP Console

A streamed fantasy console. **DO = CPU, client = PPU + APU, OP is the new pixel.**

The game runs only on the server (C compiled to WASM). The client holds a tiny memory map
(256 draw OPs, strings, palette, sound bank) and the server streams only the bytes that changed.

## Run it

You need only **Node.js 18+**. The `.wasm` files are already built.

```
node host/sim.mjs          # or: make run
```

Open **http://localhost:8787** in **two browser tabs**, pick the same game in both, keep the same room.
The simulator also prints an address for your phone on the same Wi-Fi.

| Keys | |
|---|---|
| Arrows / WASD | stick |
| Z (or L, Enter) | A |
| X (or K) | B |
| 1 (or Esc) | HOME |
| 2 3 4 | cartridge action buttons |

**Dama**: stick moves the cursor, A selects a piece and then the destination, B cancels.
Button 2 = RESIGN (then A to confirm), button 3 = DRAW (offer, or accept the other player's offer). After the match, button 2 = REMATCH.
On your turn the pieces that cannot move are dimmed. The full rules are at the top of `carts/dama/dama.c`.
**Pong**: stick left / right. First to 5.
**Flap** (2-player Flappy Bird, both birds on one screen): A flaps. Same pipes for both players.
**Keys** (fake-3D piano tiles): the 4 lanes are stick left, stick right, B, A. On a keyboard: Left, Right, K, L.

## Rebuild the WASM

```
make            # needs clang with the wasm32 target, and wasm-ld (package: lld)
```

- Debian / Ubuntu: `sudo apt install clang lld`
- macOS: `brew install llvm lld`, then `make WASM_CC=$(brew --prefix llvm)/bin/clang`

## Run on Cloudflare

```
cd worker
npm install
npx wrangler dev        # the real Worker + Durable Object, locally
npx wrangler deploy
```

## What is where

| Path | What it is | Served to players? |
|---|---|---|
| `sdk/console.h` | The one header a cartridge needs: OPs, colors, input byte, sound, callbacks | no |
| `sdk/wire.h` | The byte protocol (server ↔ client) | no |
| `sdk/runtime.c` | CPU-side runtime linked into every cartridge: per-view memory, diff, packet encoder | no |
| `carts/dama/` | Dama: almost static. 10 Hz tick so a held stick repeats; about one packet a second | no |
| `carts/pong/` | Pong: 60 Hz while the ball is in play | no |
| `carts/flap/` | Flap: 2-player Flappy Bird, both birds in one shared world | no |
| `carts/keys/` | Keys: fake-3D piano tiles, same song for both players | no |
| `ppu/ppu.c` | Source of the client memory map: applies packets atomically, enforces transitions | no |
| `host/match.mjs` | One running match. Host-agnostic: used by the simulator and by the Durable Object | no |
| `host/sim.mjs` | Local simulator: HTTP + WebSocket server with zero dependencies | no |
| `worker/` | Hono Worker + `MatchDO` Durable Object, with the built cartridges inside | no |
| `public/` | **The only folder that is served**: the built client, nothing else | yes |

Inside `public/`: `index.html`, `style.css`, `main.js` (drawing, controller, lobby, HOME overlay, smooth playback),
`input-worker.js` (the input thread, owns the WebSocket), `sound.js` + `chip.js` (the sound chip),
`sw.js` (offline shell) and `ppu.wasm` (built from `ppu/ppu.c`).

No C source, no cartridge and no game asset is in `public/`. Games exist only inside the Worker.

## Smooth playback

Every packet carries the number of the server tick it belongs to (`W_FRAME`). For games at 20 Hz or
more, the client does not draw a frame when it arrives. It plays frames back on its own steady clock,
slightly behind the newest one, and glides between two frames. The game still runs only in the Durable
Object; this only decides when a finished frame is shown. The status line shows the current buffer
(`BUF 33 MS`). It can be turned off in HOME under SMOOTH MOTION.

Measured here with Pong, ball movement per displayed frame at 60 fps:

| Network | Smooth | Frozen frames | Jump frames |
|---|---|---|---|
| clean | off | 0.2% | 1.8% |
| clean | on | 0.2% | 0.2% |
| packets delayed 0 to 40 ms at random | off | 34.8% | 28.9% |
| packets delayed 0 to 40 ms at random | on | 0.4% | 0.0% |

To try a bad network yourself: `JITTER_MS=40 node host/sim.mjs`.

## Sound

The sound chip is the Game Boy APU from Challengeme, running in an AudioWorklet: 2 pulse channels,
a wave channel (loaded with a triangle) and noise. Cartridges keep the same calls; `public/sound.js`
turns each 8-byte preset and each music step into the chip's register writes.

## Writing a cartridge

1. Create `carts/<name>/<name>.c` and `carts/<name>/manifest.json`.
2. Implement the `cart_*` callbacks from `sdk/console.h`.
3. Add the name to `CARTS` in the `Makefile`, run `make`, restart the simulator.
4. For Cloudflare, also add it to `CARTS` in `worker/src/index.js`.

`cart_draw(view)` is called once per view and starts from an empty OP buffer. Draw what **that**
player may see; the runtime diffs it against what that player's client already has. Use fixed slot
numbers for things that persist (a board cell, a paddle), so a change costs one slot (9 bytes).

## Wire protocol

One WebSocket binary message = one atomic packet = a sequence of records.

| Record | Bytes | Meaning |
|---|---|---|
| `RESET` 0x01 | 1 | clear OPs and strings (join / resync) |
| `FRAME` 0x02 | 3 | `[lo][hi]` the server tick this packet belongs to |
| `OPS_LIST` 0x10 | 2 + n×9 | `[n]` then `[slot][8 B]` each |
| `OPS_MASK` 0x11 | 33 + n×8 | 256-bit dirty mask, then the changed slots |
| `STR` 0x20 | 3 + len | `[id][len][bytes]` |
| `BEGIN` 0x30 / `END` 0x31 | 1 | transition: everything between is applied at once at END |
| `PAL` 0x32 | 5 | `[role 1-7][R][G][B]` |
| `LABEL` 0x33 | 10 | `[button 2-4][8 B text]` |
| `TICK` 0x34 | 2 | `[hz]` |
| `SFXDEF` 0x35 | 10 | `[id][8 B preset]` |
| `MUSDEF` 0x36 | 5 + steps×4 | `[id][step_10ms][steps][vol][notes]` |
| `SFX` 0x40 | 2 | `[id]` |
| `MUSIC` 0x41 | 3 | `[cmd][pattern]` |

Client → server: `IN` 0x01 `[byte]`, `SYS` 0x02 `[code]`, `RESYNC` 0x03.

Measured here: Dama full dump on join ≈ 0.9 KB, one cursor move = 14 B. Pong ≈ 14 B per frame.

## Choices made while building (all PROPOSALS, easy to change)

- **Button labels can change at transitions** (RESIGN / DRAW during play → REMATCH at match end).
- **String pool** = 16 strings × 16 bytes = 256 B, fixed slots.
- **Color byte** = role (3 bits) | brightness (2) | fill (1) | stroke width (2). Role 7 is still spare.
- **RECT strokes are drawn inside** the rectangle, so a border never grows outside its box.
- **Music** = up to 4 patterns of up to 32 steps × 4 channels, looped on the client's clock.
- **Spectators**: once all seats are taken, extra connections share one neutral view.
- **Seats**: a player who reconnects with the same tab gets the seat back with a full dump.
- **Dama rules** are the ones you gave me, listed at the top of `carts/dama/dama.c`.
- The input worker gets input by `postMessage`, not a SharedArrayBuffer yet (no COOP/COEP headers needed).
- The console font is a system monospace placeholder. Add your font as `ConsoleFont` in `public/style.css`.

## Tests

```
make test                          # 84 checks, needs only Node.js 18+
node tests/e2e/browser.mjs         # two touch phones in Chromium play all four games (needs Playwright)
node tests/e2e/accounts.mjs        # users / catalog / purchases against wrangler dev (needs: cd worker && npm install)
node tools/sounds.mjs out/         # one .wav per sound and music pattern, to listen without a phone
```

| File | What it checks |
|---|---|
| `tests/dama.test.mjs` | 39 rule checks on set-up positions, played through the real input byte |
| `tests/engine.test.mjs` | wire protocol, atomic packets, transitions, deltas = full dump under random play, 6 private views, match host |
| `tests/carts.test.mjs` | Pong, Flap, Keys played to the end by bots that see only their own view; same pipes / same song for both |
| `tests/client.test.mjs` | the input thread: input only on change, reconnect, dead-socket check on wake-up |
| `tests/sound.test.mjs` | every preset at its pitch and length, no clipping |

`tests/dama_harness.c` and `tests/carts/six.c` (a 6-seat test cartridge, not a game) are built by `make`
into `tests/build/`. They are never served and never copied into the Worker.

## Accounts, catalog, purchases (PROPOSAL, off by default)

`worker/src/accounts.js`. It is switched on by configuration only: uncomment the D1 block in
`worker/wrangler.toml` and set `SESSION_SECRET` (steps are written there). Without it, every game is
open to everyone, exactly as before.

- **Users**: a guest account on first visit, kept in a signed HttpOnly cookie. No e-mail, no password.
- **Catalog**: table `carts` holds price and listed / unlisted. The games stay inside the Worker.
- **Purchases**: table `owned`. A game with a price is refused by the Worker (403) before any socket
  exists, so a locked game sends nothing to the device. The lobby shows it as `LOCKED`.
- **Seats** are tied to the verified user, so a client cannot claim another player's seat.
- **No payment provider.** `grant()` is the one function a payment webhook must call. By hand:
  `POST /api/admin/grant {user, cart}` and `POST /api/admin/cart {cart, price_cents, listed}`
  with `Authorization: Bearer <ADMIN_KEY>`.

## Fixed in this revision

- The Durable Object never answered a client's close frame: the socket hung and kept the object awake.
- Quick taps on HOME / lobby rows were swallowed by the double-tap-zoom guard.
- A finger rolling from B to A was dropped in the gap between the buttons.
- Audio unlock now also happens on touch end (Safari), and resumes from Safari's "interrupted" state.
- Back from the lock screen: a dead socket is detected (RESYNC, 2.5 s) and reopened at once.
- `/match/constructor/x` returned 500; match sockets are now refused from other sites (Origin).
- PPU: a tick above 60 Hz is malformed; labels are kept to printable ASCII.

## Not built yet

- A real login and a payment provider (the accounts skeleton above has the hooks for both).
- Durable Object hibernation (decided: the object stays awake while a match is open).
- Motion OPs and latency compensation. Not started on purpose: they change the hardware contract
  (wire + memory map), and latency compensation goes against "network speed is not our problem".
- A game with more than 2 players. The engine side is proven with the 6-seat test cartridge.
- The console font, ESP32 / FPGA client, offline mode, EVM.

## Tested / not tested

- **Tested here**: `make` rebuilds every `.wasm` bit-for-bit; `make test`; all four games on two emulated
  touch phones (Chromium) against the simulator and against `wrangler dev` (Worker + Durable Object);
  smooth playback under 0 to 40 ms jitter (frozen frames 34.6% to 0.6%, jumps 4.9% to 0.0%);
  accounts against `wrangler dev` with a local D1; `wrangler deploy --dry-run` (the bundle builds).
- **Not tested**: a real iPhone Safari (zoom, stick feel, 60 Hz, audio unlock); how the sound sounds
  to a human ear (pitch and level are measured, taste is not); a real `wrangler deploy` (no Cloudflare
  account here); a real D1 database in production.
