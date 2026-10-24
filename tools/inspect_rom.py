#!/usr/bin/env python3
"""Look inside a ROM when a translated game traps (see TRANSLATOR.md).

    python -m tools.inspect_rom refs game.gb 4770        # where the word $4770 appears
    python -m tools.inspect_rom dis game.gb 09:43C0 20   # disassemble 20 instructions

refs lists every place the address appears as a little-endian word: entries of a table of
code addresses, or the operand of a `ld hl,nn` / `call nn` that leads there. dis shows the
code around such a place, read from the given ROM bank (bank 0 for 0000-3FFF).
"""
import argparse
import re
import sys
from pathlib import Path

from translator.cfg import parse_key
from translator.decoder import DecodeError, decode


def bank_view(rom, bank):
    view = bytearray(0x8000)
    view[:0x4000] = rom[:0x4000]
    chunk = rom[bank * 0x4000:(bank + 1) * 0x4000]
    view[0x4000:0x4000 + len(chunk)] = chunk
    return view


def refs(rom, addr):
    word = bytes((addr & 0xFF, addr >> 8))
    for m in re.finditer(re.escape(word), rom):
        off = m.start()
        bank = off // 0x4000
        at = off if bank == 0 else 0x4000 + off % 0x4000
        before = rom[max(0, off - 3):off].hex(" ")
        print(f"{bank:02X}:{at:04X}  file offset {off:06X}  bytes before: {before}")


def dis(rom, bank, addr, count):
    view = bank_view(rom, bank)
    for _ in range(count):
        try:
            ins = decode(view, addr)
        except DecodeError as err:
            print(f"{bank:02X}:{addr:04X}  {err}")
            return
        print(f"{bank:02X}:{addr:04X}  {view[addr:addr + ins.length].hex():8}  {ins.text}")
        addr = ins.next


def main(argv=None):
    ap = argparse.ArgumentParser(prog="inspect_rom", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refs", help="where an address appears as a 16-bit word")
    r.add_argument("rom", type=Path)
    r.add_argument("addr", help="hex address, e.g. 4770")
    d = sub.add_parser("dis", help="disassemble from BB:AAAA (or AAAA in bank 0/1)")
    d.add_argument("rom", type=Path)
    d.add_argument("at", help="e.g. 09:43C0")
    d.add_argument("count", type=int, nargs="?", default=24)
    args = ap.parse_args(argv)

    rom = args.rom.read_bytes()
    if args.cmd == "refs":
        refs(rom, int(args.addr, 16))
    else:
        k = parse_key(args.at)
        bank, addr = (0, k) if k < 0x10000 else ((k - 0x10000) // 0x4000, 0x4000 + (k & 0x3FFF))
        if k < 0x10000 and 0x4000 <= k < 0x8000:
            bank = 1
        dis(rom, bank, addr, args.count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
