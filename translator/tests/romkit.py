"""Helpers for the hardware tests: build small test ROMs, translate and run them, save PNGs."""
import json
import shutil
import struct
import subprocess
import zlib
from pathlib import Path

from translator.__main__ import main

HARNESS = Path(__file__).with_name("run_wasm.mjs")
TOOLS = shutil.which("wat2wasm") and shutil.which("node")

# DMG shades as the runtime writes them (RGBA).
SHADES = [(0xE0, 0xF8, 0xD0, 0xFF), (0x88, 0xC0, 0x70, 0xFF), (0x34, 0x68, 0x56, 0xFF), (0x08, 0x18, 0x20, 0xFF)]


def build_rom(pieces, cart=0x00, rom_banks=2, ram_code=0x00):
    """pieces: {(bank, addr): bytes}. Bank 0 holds 0x0000-0x3FFF; bank n >= 1 maps at 0x4000."""
    rom = bytearray(rom_banks * 0x4000)
    rom[0x100:0x104] = bytes((0x00, 0xC3, 0x50, 0x01))     # NOP; JP $0150
    rom[0x147] = cart
    rom[0x148] = (rom_banks // 2).bit_length() - 1
    rom[0x149] = ram_code
    for (bank, addr), code in pieces.items():
        off = addr if bank == 0 else bank * 0x4000 + (addr - 0x4000)
        rom[off:off + len(code)] = code
    return bytes(rom)


def h(text):
    """Hex bytes with spaces and ';' comments allowed."""
    return bytes.fromhex("".join(line.split(";")[0] for line in text.splitlines()).replace(" ", ""))


def translate(rom, name, tmp):
    path = Path(tmp) / f"{name}.gb"
    path.write_bytes(rom)
    wat = path.with_suffix(".wat")
    assert main([str(path), "-o", str(wat), "--wasm"]) == 0
    return wat.with_suffix(".wasm")


def run(*args):
    out = subprocess.run(["node", str(HARNESS), *map(str, args)], check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def frame_from_shades(shade_at):
    """Expected RGBA frame from a function (x, y) -> shade 0..3."""
    return b"".join(bytes(SHADES[shade_at(x, y)]) for y in range(144) for x in range(160))


def write_png(path, rgba, width=160, height=144, scale=3):
    rows = []
    for y in range(height):
        line = b"".join(rgba[(y * width + x) * 4:(y * width + x) * 4 + 4] * scale for x in range(width))
        rows.extend([b"\0" + line] * scale)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width * scale, height * scale, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(png)
