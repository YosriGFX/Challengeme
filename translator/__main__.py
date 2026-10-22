"""translate: Game Boy ROM -> WebAssembly text, ahead of time.

    python -m translator rom.gb -o game.wat [--hints hints.json] [--wasm]

Runs only on the developer machine. Production ships the resulting .wasm.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from .cfg import TranslateError, discover
from .decoder import DecodeError
from .emit import emit_module


def load_hints(path):
    """{"entries": ["039F"], "ram_code": [{"addr": "FFB6", "rom": "2A7F", "len": 12}]}"""
    if not path:
        return [], []
    data = json.loads(Path(path).read_text())
    ram = [(int(h["addr"], 16), int(h["rom"], 16), int(h["len"])) for h in data.get("ram_code", [])]
    return ram, [int(a, 16) for a in data.get("entries", [])]


def main(argv=None):
    ap = argparse.ArgumentParser(prog="translate", description=__doc__.splitlines()[0])
    ap.add_argument("rom", type=Path)
    ap.add_argument("-o", "--out", type=Path, help="output .wat (default: <rom>.wat)")
    ap.add_argument("--hints", type=Path,
                    help="JSON hints: extra entries (JP (HL) targets) and routines copied to RAM")
    ap.add_argument("--wasm", action="store_true", help="also assemble .wasm with wat2wasm")
    ap.add_argument("--wat2wasm", default="wat2wasm", help="path to wabt's wat2wasm")
    args = ap.parse_args(argv)

    rom = args.rom.read_bytes()
    if rom[0x147] != 0x00:
        print(f"warning: cartridge type {rom[0x147]:#04x}; only ROM-only carts are supported yet",
              file=sys.stderr)
    try:
        ram_code, entries = load_hints(args.hints)
        prog = discover(rom, ram_code, entries)
        wat, stats = emit_module(prog, rom)
    except (DecodeError, TranslateError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    out = args.out or args.rom.with_suffix(".wat")
    out.write_text(wat)
    print(f"{out}: {stats['functions']} functions, {stats['blocks']} blocks, "
          f"{stats['instructions']} instructions, {stats['dead_flags']} flag computations removed")
    for a in sorted(prog.unresolved):
        print(f"note: no code at {a:04X} (jumps there will trap)", file=sys.stderr)

    if args.wasm:
        tool = shutil.which(args.wat2wasm)
        if not tool:
            print(f"error: {args.wat2wasm} not found; install wabt", file=sys.stderr)
            return 1
        wasm = out.with_suffix(".wasm")
        subprocess.run([tool, "--enable-threads", str(out), "-o", str(wasm)], check=True)
        print(f"{wasm}: {wasm.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
