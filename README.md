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

## Not built yet

- Auth, users, catalog database, purchases (the place for them is marked in `worker/src/index.js`).
- Durable Object hibernation for 0 Hz games (it needs the WASM memory saved to storage first).
- Motion OPs / client interpolation, and latency compensation for reaction games.
- More than 2 players per cartridge (the runtime supports 6 views; no cartridge uses them yet).

## Tested / not tested

- **Tested**: the build; the Dama rules (25 checks on set-up positions); Flap scoring with a bot;
  all four games played by two players in Chrome on a phone-sized touch screen; smoothness under
  simulated jitter (table above); every sound type rendered through the chip without errors.
- **Not tested**: real iPhone Safari, how the sound actually sounds, and `wrangler dev` after this
  revision. The Worker code only changed in what folder it serves.
