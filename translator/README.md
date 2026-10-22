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

A jump to an address with no translated code traps; the page shows the address (with its
ROM bank for 0x4000-0x7FFF, as `BB:AAAA`). Add it to a hints file and rebuild:

```json
{ "entries": ["039F", "05:4A20"], "ram_code": [{ "addr": "FFB6", "rom": "2A7F", "len": 12 }] }
```

`ram_code` covers routines the game copies into RAM and runs there (like an OAM DMA routine).
Banked code is found on its own when bank 0 switches banks with a constant
(`ld a,n` then `ld ($2000),a`) before jumping; a bank chosen at runtime needs a hint.

## Running in the browser

```sh
python -m translator roms/linkdemo.gb -o build/linkdemo.wat --wasm
cp build/linkdemo.wasm public/games/
npx wrangler dev          # then open http://localhost:8787/?game=linkdemo
```

The host page runs two Game Boys in a Web Worker, linked by cable, and shows both. Each
player opens the controller link under their screen on a phone; buttons travel phone ->
`Match` Durable Object -> host page -> the Game Boy's shared memory. The keyboard works too.
Set `APP_ORIGIN` in `wrangler.jsonc` to the deployed origin before deploying.

## Not yet supported

Sound, MBC3's real-time clock, battery saves, CGB features, and the second multiplayer
mode (each phone running its own Game Boy, link cable over the network).
