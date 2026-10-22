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
| `runtime.wat` | Hand-written native WASM: memory slow paths, I/O registers, LY/STAT, V-Blank, interrupts, `run_frame`, `reset` |

## Hints

A jump to an address with no translated code traps, and `PC` holds the address. Add it to a
hints file and rebuild:

```json
{ "entries": ["039F"], "ram_code": [{ "addr": "FFB6", "rom": "2A7F", "len": 12 }] }
```

`ram_code` covers routines the game copies into RAM and runs there (like an OAM DMA routine).

## Not yet supported

MBC bank switching, the timer interrupt (TIMA), STAT interrupts, serial, sound, and
rendering pixels (Phase 4).
