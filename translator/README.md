# translator

Ahead-of-time recompiler: Game Boy (SM83) ROM in, WebAssembly text out. Runs only on the
developer machine; production ships the resulting `.wasm`.

```sh
python3 -m venv .venv && . .venv/bin/activate      # no third-party packages needed
python -m translator roms/hello.gb -o build/hello.wat --wasm
python -m unittest discover -s translator/tests -t .
```

`--wasm` and the end-to-end tests need [wabt](https://github.com/WebAssembly/wabt)'s
`wat2wasm`; the end-to-end tests also run the `.wasm` with `node` (dev tooling only).

## Pipeline

| Module | Job |
| --- | --- |
| `decoder.py` | Bytes to `Instr` records (all 245 primary + 256 CB opcodes, cycles, flags read/written) |
| `cfg.py` | Recursive traversal from the entry points, basic blocks, one function per jump-table entry, flag liveness |
| `emit.py` | One WAT template per instruction; blocks inside a function are picked with a local `br_table` |
| `runtime.wat` | Hand-written native WASM: memory slow paths, MBC1/3/5 banking, per-scanline PPU events and drawing (BG, window, sprites) into the shared RGBA framebuffers, STAT/LYC/V-Blank, timer, serial, joypad, interrupts, `run_frame`, `reset` |

## Hints

A jump to an address with no translated code traps; the phone shows the address (with its
ROM bank for 0x4000-0x7FFF, as `BB:AAAA`). Add it to a hints file and rebuild:

```json
{ "entries": ["039F", "05:4A20"], "ram_code": [{ "addr": "FFB6", "rom": "2A7F", "len": 12 }] }
```

`ram_code` covers routines the game copies into RAM and runs there (like an OAM DMA routine).
Banked code is found on its own when bank 0 switches banks with a constant
(`ld a,n` then `ld ($2000),a`) before jumping; a bank chosen at runtime needs a hint.

## Playing (server-rendered, two phones)

```sh
npx wrangler dev          # listens on every address, port 8787 (see "dev" in wrangler.jsonc)
```

Open `http://192.168.64.10:8787/` (LAN) or `http://172.20.10.3:8787/` (phone hotspot) on a
phone, pick a game, start a match, and share the player 2 link. Each phone is one Game
Boy: its screen and its buttons. A page on any other address needs that origin added to
`APP_ORIGIN` in wrangler.jsonc, or its match socket is refused.

Committed games (`src/games/*.wasm`, listed in `src/games/index.js`) need no Python: Dr.
Mario, the link demo and Hello World. A game is built with `python -m translator rom.gb
-o build/x.wat --wasm`, copied to `src/games/` and listed there. To try a ROM on one
machine without committing it, `python -m tools.add_game rom.gb id "Title"` writes it to
`src/games/local/` and `src/games/local.js`, which stay out of git.

Both Game Boys run inside the match's Durable Object (`src/match.js`), linked by cable, at
59.73 Hz. Phones send one byte when their buttons change and receive screen updates in
the spirit of VNC's RFB protocol (`src/gb/frames.js`): a scroll is one move command, then
only the 8x8 tiles that still differ, each sent as solid, two-shade or raw. A still screen
costs nothing; a one-pixel change costs about 70 bytes. Phones acknowledge updates, so a
slow phone skips frames instead of queueing them. Cheating is designed out: the game's code and memory never leave
the server, each phone can only press its own seat's buttons (rate limited, impossible
d-pad combinations removed), and a seat belongs to the first phone that joins it.

`--target browser` still builds the shared-memory variant for running in a Web Worker.

## Not yet supported

Sound, MBC3's real-time clock, battery saves, CGB features, and keeping a match's game
state when its Durable Object is evicted (the game restarts).
