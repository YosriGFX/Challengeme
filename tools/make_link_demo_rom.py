#!/usr/bin/env python3
"""Build a two-player link-cable demo ROM (DMG, 32 KiB, ROM only).

Each Game Boy shows two halves: the left half is its own joypad (dark while any button
is held), the right half is the other Game Boy's joypad, received over the link cable
once per frame. The first Game Boy to press a button becomes the clock master; the
other answers as the slave, the way link games such as Tetris pick sides.

HRAM: $FF80 = 1 once this Game Boy is the master, $FF81 = partner's buttons.
Usage: python3 tools/make_link_demo_rom.py [out.gb]
"""
import sys

try:
    from .make_hello_rom import NINTENDO_LOGO, Asm
except ImportError:                                   # run as a script
    from make_hello_rom import NINTENDO_LOGO, Asm


def program():
    a = Asm(0x0150)
    a.db(0xF3, 0x31, 0xFE, 0xFF)          # DI ; LD SP,$FFFE
    a.label("wait_vb")
    a.db(0xF0, 0x44, 0xFE, 0x90)          # LDH A,(LY) ; CP 144
    a.jr(0x38, "wait_vb")                 # JR C
    a.db(0xAF, 0xE0, 0x40)                # XOR A ; LDH (LCDC),A

    a.db(0x21, 0x10, 0x80, 0x06, 0x08)    # LD HL,$8010 ; LD B,8      tile 1: colour 1
    a.label("t1")
    a.db(0x3E, 0xFF, 0x22, 0xAF, 0x22, 0x05)
    a.jr(0x20, "t1")
    a.db(0x06, 0x08)                      # tile 2: colour 2
    a.label("t2")
    a.db(0xAF, 0x22, 0x3E, 0xFF, 0x22, 0x05)
    a.jr(0x20, "t2")

    a.db(0x21, 0x00, 0x98, 0x16, 18)      # LD HL,$9800 ; LD D,18 rows
    a.label("row")
    a.db(0x06, 10, 0x3E, 0x01)            # 10 x tile 1
    a.label("left")
    a.db(0x22, 0x05)
    a.jr(0x20, "left")
    a.db(0x06, 10, 0x3E, 0x02)            # 10 x tile 2
    a.label("right")
    a.db(0x22, 0x05)
    a.jr(0x20, "right")
    a.db(0x01, 12, 0x00, 0x09, 0x15)      # LD BC,12 ; ADD HL,BC ; DEC D
    a.jr(0x20, "row")

    a.db(0xAF, 0xE0, 0x80, 0xE0, 0x81)    # master = 0, partner = 0
    a.db(0x3E, 0x80, 0xE0, 0x02)          # wait as slave
    a.db(0x3E, 0x91, 0xE0, 0x40)          # LCD on

    a.label("frame")
    a.db(0xF0, 0x44, 0xFE, 0x90)          # wait for LY = 144
    a.jr(0x20, "frame")
    a.db(0x3E, 0x20, 0xE0, 0x00, 0xF0, 0x00, 0x2F, 0xE6, 0x0F, 0xCB, 0x37, 0x47)   # B = d-pad << 4
    a.db(0x3E, 0x10, 0xE0, 0x00, 0xF0, 0x00, 0x2F, 0xE6, 0x0F, 0xB0, 0x47)         # B |= buttons

    a.db(0x1E, 0x04, 0x78, 0xA7)          # E = own half light ; A = B ; AND A
    a.jr(0x28, "own_idle")
    a.db(0x1E, 0x0C)                      # own half dark
    a.label("own_idle")
    a.db(0x7B, 0xF6, 0x20, 0x5F)          # partner half mid
    a.db(0xF0, 0x81, 0xA7)
    a.jr(0x28, "partner_idle")
    a.db(0x7B, 0xF6, 0x10, 0x5F)          # partner half dark
    a.label("partner_idle")
    a.db(0x7B, 0xE0, 0x47)                # BGP

    a.db(0xF0, 0x02, 0xCB, 0x7F)          # transfer finished?
    a.jr(0x28, "idle")
    a.db(0xCB, 0x47)                      # busy as master: wait
    a.jr(0x20, "next")
    a.db(0x78, 0xA7)                      # waiting as slave but a button is down:
    a.jr(0x28, "next")                    #   take the clock
    a.db(0x3E, 0x01, 0xE0, 0x80)
    a.jr(0x18, "arm")
    a.label("idle")
    a.db(0xF0, 0x01, 0xFE, 0xFF)          # received byte; $FF = nobody answered
    a.jr(0x20, "keep")
    a.db(0xAF)
    a.label("keep")
    a.db(0xE0, 0x81)
    a.label("arm")
    a.db(0x78, 0xE0, 0x01)                # send own buttons
    a.db(0xF0, 0x80, 0xA7)
    a.jr(0x20, "master")
    a.db(0x78, 0xA7)
    a.jr(0x28, "slave")
    a.db(0x3E, 0x01, 0xE0, 0x80)
    a.label("master")
    a.db(0x3E, 0x81, 0xE0, 0x02)
    a.jr(0x18, "next")
    a.label("slave")
    a.db(0x3E, 0x80, 0xE0, 0x02)

    a.label("next")
    a.db(0xF0, 0x44, 0xFE, 0x90)          # wait for LY to leave 144
    a.jr(0x28, "next")
    a.jr(0x18, "frame")
    return a.link()


def build():
    rom = bytearray(0x8000)
    rom[0x0100:0x0104] = bytes((0x00, 0xC3, 0x50, 0x01))
    rom[0x0104:0x0134] = NINTENDO_LOGO
    rom[0x0134:0x0134 + 8] = b"LINKDEMO"
    rom[0x014A] = 0x01
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
    out = sys.argv[1] if len(sys.argv) > 1 else "roms/linkdemo.gb"
    with open(out, "wb") as f:
        f.write(build())
    print(f"wrote {out}")
