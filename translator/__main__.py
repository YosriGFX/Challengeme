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

from .cfg import TranslateError, discover, fmt_key, parse_key
from .decoder import DecodeError
from .emit import emit_module


def load_hints(path):
    """{"entries": ["039F", "05:4A20"], "ram_code": [{"addr": "FFB6", "rom": "2A7F", "len": 12}]}

    An entry in 0x4000-0x7FFF names its ROM bank as BB:AAAA (bank 1 if left out)."""
    if not path:
        return [], []
    data = json.loads(Path(path).read_text())
    ram = [(int(h["addr"], 16), int(h["rom"], 16), int(h["len"])) for h in data.get("ram_code", [])]
    return ram, [parse_key(a) for a in data.get("entries", [])]


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
    try:
        ram_code, entries = load_hints(args.hints)
        prog = discover(rom, ram_code, entries)
        wat, stats = emit_module(prog, rom)
    except (DecodeError, TranslateError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    out = args.out or args.rom.with_suffix(".wat")
    out.write_text(wat)
    cart = prog.cart
    print(f"cartridge: {'ROM only' if cart.mbc == 0 else f'MBC{cart.mbc}'}, {cart.banks} ROM banks, "
          f"{cart.ram_banks} RAM banks")
    print(f"{out}: {stats['functions']} functions, {stats['blocks']} blocks, "
          f"{stats['instructions']} instructions, {stats['dead_flags']} flag computations removed")
    for a in sorted(prog.unresolved):
        print(f"note: no code at {fmt_key(a)} (jumps there will trap)", file=sys.stderr)
    for a in sorted(prog.unknown_bank):
        print(f"note: bank 0 jumps to {a:04X} with a bank set at runtime; "
              f"add \"BB:{a:04X}\" to the hints for each bank it can be", file=sys.stderr)

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
