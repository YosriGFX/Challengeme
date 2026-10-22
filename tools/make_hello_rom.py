#!/usr/bin/env python3
"""Build a 32 KiB ROM-only Game Boy (DMG) ROM that shows "HELLO WORLD!".

This is the proof-of-concept input for the SM83 -> WASM translator. It is
hand-assembled here so the project needs no external toolchain, and it
deliberately uses a small, readable subset of SM83 opcodes.

Usage: python3 tools/make_hello_rom.py [out.gb]
"""
import sys

ROM_SIZE = 0x8000

# Boot ROM compares this against the cartridge before handing over control.
NINTENDO_LOGO = bytes.fromhex(
    "CEED6666CC0D000B03730083000C000D"
    "0008111F8889000EDCCC6EE6DDDDD999"
    "BBBB67636E0EECCCDDDC999FBBB9333E"
)

# 8x8 1bpp glyphs, MSB = leftmost pixel. Tile 0 stays blank (space).
GLYPHS = {
    "H": [0xC6, 0xC6, 0xC6, 0xFE, 0xC6, 0xC6, 0xC6, 0x00],
    "E": [0xFE, 0xC0, 0xC0, 0xFC, 0xC0, 0xC0, 0xFE, 0x00],
    "L": [0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0xC0, 0xFE, 0x00],
    "O": [0x7C, 0xC6, 0xC6, 0xC6, 0xC6, 0xC6, 0x7C, 0x00],
    "W": [0xC6, 0xC6, 0xC6, 0xD6, 0xFE, 0xEE, 0xC6, 0x00],
    "R": [0xFC, 0xC6, 0xC6, 0xFC, 0xD8, 0xCC, 0xC6, 0x00],
    "D": [0xF8, 0xCC, 0xC6, 0xC6, 0xC6, 0xCC, 0xF8, 0x00],
    "!": [0x18, 0x18, 0x18, 0x18, 0x18, 0x00, 0x18, 0x00],
}
MESSAGE = "HELLO WORLD!"
MSG_ROW, MSG_COL = 8, (20 - len(MESSAGE)) // 2


class Asm:
    """Minimal two-pass helper: emit bytes, define labels, patch JR/abs refs."""

    def __init__(self, origin):
        self.origin = origin
        self.code = bytearray()
        self.labels = {}
        self.fixups = []  # (offset, label, kind)

    @property
    def pc(self):
        return self.origin + len(self.code)

    def label(self, name):
        self.labels[name] = self.pc

    def db(self, *bs):
        self.code += bytes(bs)

    def jr(self, opcode, label):
        self.db(opcode, 0)
        self.fixups.append((len(self.code) - 1, label, "rel8"))

    def imm16(self, opcode, label):
        self.db(opcode, 0, 0)
        self.fixups.append((len(self.code) - 2, label, "abs16"))

    def link(self):
        for off, name, kind in self.fixups:
            target = self.labels[name]
            if kind == "rel8":
                rel = target - (self.origin + off + 1)
                assert -128 <= rel <= 127, name
                self.code[off] = rel & 0xFF
            else:
                self.code[off:off + 2] = target.to_bytes(2, "little")
        return bytes(self.code)


def tile_data():
    order = list(dict.fromkeys(c for c in MESSAGE if c != " "))
    data = bytearray(16)  # tile 0: blank
    for ch in order:
        for row in GLYPHS[ch]:
            data += bytes((row, row))  # both bit planes set -> colour 3
    index = {ch: i + 1 for i, ch in enumerate(order)}
    index[" "] = 0
    return bytes(data), bytes(index[c] for c in MESSAGE) + b"\xFF"


def program():
    tiles, msg = tile_data()
    a = Asm(0x0150)
    a.label("start")
    a.db(0xF3)                    # DI
    a.db(0x31, 0xFE, 0xFF)        # LD SP,$FFFE
    a.label("wait_vblank")        # LCD may only be switched off in V-Blank
    a.db(0xF0, 0x44)              # LDH A,(LY)
    a.db(0xFE, 0x90)              # CP 144
    a.jr(0x38, "wait_vblank")     # JR C,wait_vblank
    a.db(0xAF)                    # XOR A
    a.db(0xE0, 0x40)              # LDH (LCDC),A   ; LCD off

    a.db(0x21, 0x00, 0x80)        # LD HL,$8000    ; tile data
    a.imm16(0x11, "tiles")        # LD DE,tiles
    a.db(0x06, len(tiles))        # LD B,len
    a.label("copy_tiles")
    a.db(0x1A)                    # LD A,(DE)
    a.db(0x22)                    # LD (HL+),A
    a.db(0x13)                    # INC DE
    a.db(0x05)                    # DEC B
    a.jr(0x20, "copy_tiles")      # JR NZ,copy_tiles

    a.db(0x21, 0x00, 0x98)        # LD HL,$9800    ; BG map 0
    a.db(0x01, 0x00, 0x04)        # LD BC,$0400
    a.label("clear_map")
    a.db(0xAF)                    # XOR A
    a.db(0x22)                    # LD (HL+),A
    a.db(0x0B)                    # DEC BC
    a.db(0x78)                    # LD A,B
    a.db(0xB1)                    # OR C
    a.jr(0x20, "clear_map")       # JR NZ,clear_map

    dest = 0x9800 + MSG_ROW * 32 + MSG_COL
    a.db(0x21, dest & 0xFF, dest >> 8)  # LD HL,dest
    a.imm16(0x11, "message")      # LD DE,message
    a.label("write_msg")
    a.db(0x1A)                    # LD A,(DE)
    a.db(0xFE, 0xFF)              # CP $FF
    a.jr(0x28, "done")            # JR Z,done
    a.db(0x22)                    # LD (HL+),A
    a.db(0x13)                    # INC DE
    a.jr(0x18, "write_msg")       # JR write_msg
    a.label("done")

    a.db(0x3E, 0xE4)              # LD A,%11100100
    a.db(0xE0, 0x47)              # LDH (BGP),A
    a.db(0xAF)                    # XOR A
    a.db(0xE0, 0x42)              # LDH (SCY),A
    a.db(0xE0, 0x43)              # LDH (SCX),A
    a.db(0x3E, 0x91)              # LD A,$91       ; LCD on, BG on, tiles at $8000
    a.db(0xE0, 0x40)              # LDH (LCDC),A
    a.label("forever")
    a.jr(0x18, "forever")         # JR forever

    a.label("tiles")
    a.code += tiles
    a.label("message")
    a.code += msg
    return a.link()


def build():
    rom = bytearray(ROM_SIZE)
    rom[0x0100:0x0104] = bytes((0x00, 0xC3, 0x50, 0x01))  # NOP; JP $0150
    rom[0x0104:0x0134] = NINTENDO_LOGO
    rom[0x0134:0x0134 + 5] = b"HELLO"                     # title
    rom[0x0147] = 0x00  # cartridge type: ROM only
    rom[0x0148] = 0x00  # ROM size: 32 KiB
    rom[0x0149] = 0x00  # no cartridge RAM
    rom[0x014A] = 0x01  # non-Japanese
    code = program()
    rom[0x0150:0x0150 + len(code)] = code

    x = 0
    for b in rom[0x0134:0x014D]:
        x = (x - b - 1) & 0xFF
    rom[0x014D] = x
    total = (sum(rom) - rom[0x014E] - rom[0x014F]) & 0xFFFF
    rom[0x014E:0x0150] = total.to_bytes(2, "big")
    return bytes(rom)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "roms/hello.gb"
    with open(out, "wb") as f:
        f.write(build())
    print(f"wrote {out}")
