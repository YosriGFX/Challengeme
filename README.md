# OP Console

A streamed fantasy console. **DO = CPU, client = PPU + APU, OP is the new pixel.**

The game runs only on the server, as C compiled to WASM inside a Cloudflare Durable Object.
The client holds a small fixed memory map and draws what it is told. The wire carries only the
bytes that changed; an idle screen costs zero bytes. Nothing a player has not reached, or may not
see, is ever sent to their device: no game code, no hidden state, no asset pack.

The book in `book/` teaches the whole engine in three days.

## Run it

Only **Node.js 18+** is needed. The `.wasm` files are in the repository.

```bash
node host/sim.mjs
```

Open **http://localhost:8787** in two browser tabs, keep the same room, pick the same game.
The simulator also prints an address for a phone on the same Wi-Fi.

| Keyboard | |
|---|---|
| Arrows / WASD | stick |
| Z, L, Enter, Space | A |
| X, K, Backspace | B |
| 1, Esc | HOME |
| 2 3 4 | the cartridge's buttons |

The lobby and HOME work with the stick and A / B as well as with a tap.

## On Cloudflare

```bash
cd worker
npm install
npx wrangler dev
npx wrangler deploy
```

Nothing has to be created by hand. Accounts, the catalog and ownership live in a Durable Object
with its own SQLite and are on from the first deploy. Optional secrets (`npx wrangler secret put NAME`):

| Secret | What it switches on |
|---|---|
| `ADMIN_KEY` | `POST /api/admin/cart` (price, listed) and `POST /api/admin/grant` |
| `STRIPE_SECRET_KEY` | buying: `POST /api/buy` opens a Stripe Checkout page |
| `STRIPE_WEBHOOK_SECRET` | `POST /api/stripe`: a paid order becomes ownership |
| `SESSION_SECRET` | your own key for session cookies (one is made and kept otherwise) |

Set a price: `curl -X POST https://<host>/api/admin/cart -H "Authorization: Bearer $ADMIN_KEY" -d '{"cart":"keys","price_cents":199}'`

## Rebuild the WASM

```bash
make
```

Needs clang with the wasm32 target and `wasm-ld` (Debian / Ubuntu: `apt install clang lld`;
macOS: `brew install llvm lld`, then `make WASM_CC=$(brew --prefix llvm)/bin/clang`).

## What is where

| Path | What it is | Served to players |
|---|---|---|
| `sdk/console.h` | the whole contract a cartridge sees: OPs, colors, input, sound, motion, bindings | no |
| `sdk/wire.h` | the bytes between server and client | no |
| `sdk/runtime.c` | linked into every cartridge: one mirror per view, diff, packet encoder | no |
| `ppu/ppu.c` | the client memory map in C: atomic packets, transitions | no (only its build) |
| `carts/<name>/` | the games: `dama`, `pong`, `flap`, `keys`, `trail` | no |
| `host/match.mjs` | one running match, the same file in the simulator and in the Durable Object | no |
| `host/sim.mjs` | the local simulator, Node.js only | no |
| `worker/` | Hono Worker, `MatchDO` (a match), `RegistryDO` (users, catalog, ownership) | no |
| `font/build.py` | the console font: one table of strokes, built into `public/console.ttf` and `ppu/font.h` | no (only its build) |
| `hardware/` | the reference client for a device: an integer-only rasterizer and a desktop program that uses it | no |
| `public/` | **the only folder that is served** | yes |

In `public/`: `index.html`, `style.css`, `main.js` (lobby, HOME, wiring), `screen.js` (memory map,
time, drawing), `pad.js` (controller), `net.js` (the input thread, owns the WebSocket),
`sound.js` + `chip.js` (the sound chip), `sw.js`, `ppu.wasm`, `console.ttf`.

## The games

| Game | Players | Tick | |
|---|---|---|---|
| DAMA | 2 | 10 Hz | checkers; the full rules are at the top of `carts/dama/dama.c` |
| PONG | 2 | 60 Hz | each player sees their own paddle at the bottom; first to 5 |
| FLAP | 2 | 60 Hz | both birds on one screen, the same pipes for both |
| KEYS | 2 | 60 Hz | piano tiles: stick left, stick right, B, A; the same song for both |
| TRAIL | 2 to 6 | 30 Hz | everybody leaves a wall; the last one riding wins the round |

Fairness: every player of a match gets the same generated content (same pipes, same song,
same arena).

## What makes it feel direct

- **Motion OPs.** A cartridge can say a slot keeps moving at a fixed speed (`con_move`). The client
  moves it by itself, at the screen's own refresh rate. The moment the cartridge draws anything else
  than where that motion leads, the correction is sent. Pong's ball and paddles, Flap's pipes and
  ground are Motion OPs.
- **Input bindings.** A cartridge can say that a player's own stick drives a slot (`con_bind`):
  Pong's paddle, Dama's cursor. The client moves it at once; the server does the same when the input
  arrives, and its picture always wins.
- **Input age.** Every input carries the tick that was on the player's screen. A game that judges
  timing (Keys) judges against that tick, capped at 150 ms.
- **Smooth playback.** For games at 20 Hz or more the client plays frames on its own steady clock,
  one tick plus the measured jitter behind the newest, and glides between two frames.

## The console font

`font/build.py` holds every glyph as a few straight strokes on a grid 4 wide and 6 high: one pen
width, cut corners, capitals only (a small letter shows its capital). It writes `public/console.ttf`
for the browser and `ppu/font.h`, the same strokes as a C table, for a client with no font engine.
A glyph advances 0.6 em, like the monospace it replaced, so every text keeps its width.
To go back to the system font, remove the `@font-face` rule at the top of `public/style.css`.

```bash
make font
```

Needs `pip install fonttools`.

## A client without a browser

```bash
make hardware
```

This builds `hardware/out/ref` with your C compiler and draws one frame of every game into
`hardware/out/<game>.ppm`. It is what a device does: the packet goes into `ppu/ppu.c` (the same
file the browser runs as WASM), `ppu_view(tick)` gives the OP buffer at that tick, and
`hardware/raster.c` draws it into RGB565 pixels with integers only, text included.
A board adds three things around it: a WebSocket, a display to copy the frame to, and buttons.
`hardware/esp32/` is that for an ESP32 with a 240 × 240 ST7789 display (ESP-IDF 5).
It has not been built or run: there was no ESP-IDF and no board where it was written.
`make esp32-check` checks that it is valid C against stand-in headers, nothing more.

## Match records

A cartridge is deterministic, so a match is fully described by what went into it and when.
`Match` keeps that log. For a game that hides nothing (`"open": true` in its manifest, today
Dama) the record of a running match can be fetched and checked by anyone:

```bash
curl http://localhost:8787/api/log/dama/ROOM1 > match.json
```

```bash
node host/replay.mjs match.json
```

The second command runs the record again on a fresh cartridge and says whether it ends in the
same picture; it also prints the SHA-256 of the cartridge and of the log.
`evm/MatchLedger.sol` is a contract that records a result signed by both players together with
those two hashes, so a turn-based match can be settled on an EVM chain and audited off it.
The contract has not been compiled or deployed, and the client has no wallet to sign with.

## iPhone

The page takes no browser gesture at all. Every touch default is cancelled in `pad.js` (zoom, scroll,
long-press menu, synthetic click); the only exception is the room field, whose text is 16 px so
Safari does not zoom on focus. Menus never scroll: rows share the height. Audio is unlocked on the
end of a touch and resumed after an interruption. While a match is open the screen is kept awake,
so a phone does not lock while its player thinks. Buttons are released when the page is hidden.
Back from the lock screen, the socket is checked with a `RESYNC` and reopened if nothing answers
in 2.5 s. A phone on its side is asked to be turned upright.

## Wire protocol

One WebSocket binary message = one packet = a row of records, applied whole or not at all.

| Record | Bytes | Meaning |
|---|---|---|
| `FRAME` 0x02 | 3 | `[lo][hi]` the server tick of this packet; always first |
| `RESET` 0x01 | 1 | forget OPs, strings, motion, bindings (join / resync) |
| `ACK` 0x03 | 2 | `[n]` inputs of this player handled since they joined |
| `MID` 0x04 | 1 | made between two ticks (an input was answered): not a beat of the server's clock |
| `OPS_LIST` 0x10 | 2 + n×9 | `[n]` then `[slot][8 B]` each |
| `OPS_MASK` 0x11 | 33 + n×8 | 256-bit dirty mask, then the changed slots (from 32 slots) |
| `MOVE` 0x12 | 2 + n×7 | `[n]` then `[slot][fx][fy][vx lo][vx hi][vy lo][vy hi]` |
| `BIND` 0x13 | 10 | `[id][slot][kind][sx][sy][xmin][xmax][ymin][ymax]` |
| `STR` 0x20 | 3 + len | `[id][len][bytes]` |
| `BEGIN` 0x30 / `END` 0x31 | 1 | a transition: everything between applies at once at END |
| `PAL` 0x32 | 5 | `[role 1-7][R][G][B]` |
| `LABEL` 0x33 | 10 | `[button 2-4][8 B]` |
| `TICK` 0x34 | 2 | `[hz 0-60]` |
| `SFXDEF` 0x35 | 10 | `[id][8 B preset]` |
| `MUSDEF` 0x36 | 5 + steps×4 | `[id][step_10ms][steps][vol][notes]` |
| `SFX` 0x40 | 2 | `[id]` |
| `MUSIC` 0x41 | 3 | `[cmd][pattern]` |

Client to server: `IN` 0x01 `[byte][tick on screen]`, `SYS` 0x02 `[code]`, `RESYNC` 0x03.

## Decisions

- **Palette.** Role 0 is black. The system hues are `#ECE9E4` primary, `#5CC8F0` secondary,
  `#FFB23F` accent, `#C9A7FF` highlight, `#FF5A5A` error, `#6BE38C` success. Role 7 is a neutral
  grey for arena and text.
- **3 to 6 players.** The cartridge gives one palette role to each seat (roles 1 to 6) and keeps
  role 7 for everything that belongs to nobody. Trail does this.
- **Online only.** One device is one seat, one WebSocket, one private view.
- **A cartridge package** is one `.wasm` and one `manifest.json`, built into the Worker.
  It never leaves the server.
- **Accounts.** A device gets an account on its first visit, kept in a signed HttpOnly cookie.
  A seat in a match belongs to that account. A game with a price is refused before any socket exists.
- **The same account on another device.** LINK A DEVICE in the lobby shows a code of 8 letters,
  good once and for 5 minutes. The other device enters it and becomes that account; what it already
  owned moves over. No e-mail and no password are involved.
- **Without the internet:** run `node host/sim.mjs` on any machine of a local network and
  open its address on the phones. A single phone on its own cannot play: a game exists only on
  a server, and the games have no computer opponent.

## Writing a cartridge

1. `carts/<name>/<name>.c` and `carts/<name>/manifest.json`.
2. Implement the `cart_*` callbacks from `sdk/console.h`.
3. Add the name to `CARTS` in the `Makefile` and to `CARTS` in `worker/src/index.js`, run `make`.

`cart_draw(view)` starts from an empty screen every time and draws what **that** player may see.
Use fixed slot numbers for things that persist, so a change costs one slot.

## What was checked, and what was not

- **Checked here:** everything compiles with `-Wall -Wextra` and no warnings; the Worker bundles
  (`wrangler deploy --dry-run`); one run of all five games with two players and random input for
  1500 ticks: every packet parsed, and at every tick the picture the client derives from motion was
  identical to a fresh full redraw by the server. `make hardware` drew all five games correctly
  through the C client and the stroke font.
- **Not checked:** no browser was started for this version and it has no test suite, by request.
  A real iPhone, a real `wrangler deploy`, and a real Stripe payment have not been tried.
- **Written but never run:** `hardware/esp32/main/main.c` (no ESP-IDF, no board) and
  `evm/MatchLedger.sol` (no Solidity compiler was allowed in this session).
- **Not built:** an FPGA client; wallets and signing in the client for the ledger; play on a
  single phone with no network (it would need computer opponents, or the game on the device).
