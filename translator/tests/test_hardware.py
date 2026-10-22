"""Hardware behaviour of the runtime: drawing, STAT/LYC, timer, joypad, MBC banking and the
link cable. Each test builds a purpose-made ROM, translates it to .wasm and runs it in V8
with the same machine module the browser uses. Expected values come from the Game Boy's
documented behaviour, not from another program.

Set CHALLENGEME_PNG_DIR to also save the rendered frames as PNG files.
"""
import os
import tempfile
import unittest
from pathlib import Path

from tools.make_hello_rom import GLYPHS, MESSAGE, MSG_COL, MSG_ROW
from translator.tests.romkit import TOOLS, build_rom, frame_from_shades, h, run, translate, write_png

ROOT = Path(__file__).resolve().parents[2]
PNG_DIR = os.environ.get("CHALLENGEME_PNG_DIR")

TIMER = {
    (0, 0x50): h("F5 FA00C0 3C EA00C0 F1 D9"),            # count++ ; reti
    (0, 0x150): h("""
        F3 31FEFF AF EA00C0
        3EC0 E006        ; TMA = $C0
        3E04 E0FF        ; IE = timer
        AF E00F          ; IF = 0
        3E05 E007        ; TAC = on, 16 cycles per tick
        FB 76 18FD       ; ei ; halt ; jr halt
    """),
}

STAT = {
    (0, 0x40): h("C30002"),
    (0, 0x48): h("C32002"),
    (0, 0x200): h("F5 FA10C0 3C EA10C0 F1 D9"),          # V-Blank: count at C010
    (0, 0x220): h("""
        F5 E5 FA11C0 C620 6F 26C0
        F044 77          ; C020+n = LY
        7D C610 6F F041 77   ; C030+n = STAT
        FA11C0 3C EA11C0 E1 F1 D9
    """),
    (0, 0x150): h("""
        F3 31FEFF AF EA10C0 EA11C0
        3E40 E045        ; LYC = 64
        3E40 E041        ; STAT: LYC interrupt
        3E03 E0FF        ; IE = V-Blank + STAT
        AF E00F FB 76 18FD
    """),
}

JOYPAD = {
    (0, 0x150): h("3E20 E000 F000 EA00C0 3E10 E000 F000 EA01C0 18FE"),
}

MBC = {
    (0, 0x150): h("""
        31FEFF
        3E02 EA0020 CD0040    ; bank 2, call $4000
        3E03 EA0020 CD0040    ; bank 3, call $4000 (same address, other code)
        3E01 EA0021 CD0040    ; bank 1 through $2100
        3E02 EA0020 FAFF7F EA03C0   ; data read from bank 2
        3E0A EA0000           ; enable cartridge RAM
        3E01 EA0060           ; MBC1: RAM banking mode (ignored by MBC3/MBC5)
        3E01 EA0040 3E5A EA00A0     ; RAM bank 1: $5A
        AF EA0040 3EA5 EA00A0       ; RAM bank 0: $A5
        3E01 EA0040 FA00A0 EA04C0
        AF EA0040 FA00A0 EA05C0
        18FE
    """),
    (1, 0x4000): h("3E11 EA02C0 C9"),
    (2, 0x4000): h("3E22 EA00C0 C9"),
    (2, 0x7FFF): h("B2"),
    (3, 0x4000): h("3E33 EA01C0 C9"),
}


def serial_rom(out_byte, control):
    return build_rom({(0, 0x150): h(f"""
        31FEFF 3E{out_byte:02X} E001 3E{control:02X} E002
        F002 CB7F 20FA        ; wait for FF02 bit 7 to clear
        F001 EA00C0 F00F EA01C0 18FE
    """)})


DRAW = {
    (0, 0x150): h("""
        F3 31FEFF
        F044 FE90 38FA AF E040          ; LCD off in V-Blank
        211080 0608 3EFF 22 AF 22 05 20F8   ; tile 1: colour 1
        0608 3E0F 22 22 05 20F9         ; tile 2: right half colour 3
        3E01 EA0098 EA009C              ; BG (0,0) and window (0,0) use tile 1
        2100C1
        3E20 22 3E18 22 3E02 22 AF 22   ; sprite at (16,16)
        3E20 22 3E30 22 3E02 22 3E20 22 ; sprite at (40,16), X flip
        3E10 22 3E08 22 3E02 22 3E80 22 ; sprite at (0,0), behind BG
        3EC1 E046                       ; OAM DMA from $C100
        3EE4 E047 E048                  ; BGP, OBP0
        3E48 E04A 3E57 E04B             ; window at (80,72)
        3EF3 E040                       ; LCD, window map $9C00, window, sprites, BG
        18FE
    """),
}


def draw_expected(x, y):
    if y >= 72 and x >= 80:
        return 1 if x < 88 and y < 80 else 0
    if 16 <= y < 24 and (20 <= x < 24 or 40 <= x < 44):
        return 3
    return 1 if x < 8 and y < 8 else 0


def hello_expected(x, y):
    col, row = x // 8 - MSG_COL, y // 8 - MSG_ROW
    if row != 0 or not 0 <= col < len(MESSAGE) or MESSAGE[col] == " ":
        return 0
    return 3 if GLYPHS[MESSAGE[col]][y % 8] & (0x80 >> (x % 8)) else 0


@unittest.skipUnless(TOOLS, "needs wat2wasm and node on PATH")
class HardwareTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def wasm(self, pieces_or_rom, name, **kw):
        rom = pieces_or_rom if isinstance(pieces_or_rom, bytes) else build_rom(pieces_or_rom, **kw)
        return translate(rom, name, self.tmp)

    def check_frame(self, res, expected, name):
        self.assertIsNone(res["trap"])
        got = bytes.fromhex(res["fb"])
        if PNG_DIR:
            write_png(Path(PNG_DIR) / f"{name}.png", got)
        bad = [(i // 4 % 160, i // 640) for i in range(0, len(got), 4) if got[i:i + 4] != expected[i:i + 4]]
        self.assertEqual(bad[:5], [], f"{len(bad)} pixels differ")

    def test_draws_hello_world(self):
        res = run(self.wasm((ROOT / "roms" / "hello.gb").read_bytes(), "hello"), 3, "--fb")
        self.check_frame(res, frame_from_shades(hello_expected), "hello")

    def test_draws_background_window_and_sprites(self):
        res = run(self.wasm(DRAW, "draw"), 3, "--fb")
        self.check_frame(res, frame_from_shades(draw_expected), "draw")

    def test_lyc_and_vblank_interrupts(self):
        res = run(self.wasm(STAT, "stat"), 3, "C010:2", "C020:3", "C030:3")
        self.assertIsNone(res["trap"])
        d = res["dump"]
        self.assertEqual(d["C010"], [3, 3], "one V-Blank and one LYC interrupt per frame")
        self.assertEqual(d["C020"], [64] * 3, "LY inside the LYC handler")
        self.assertEqual(d["C030"], [0xC7] * 3, "STAT: LYC enable, coincidence, mode 3 (read ~150 dots in)")

    def test_timer_interrupts(self):
        res = run(self.wasm(TIMER, "timer"), 1, "C000:1")
        self.assertIsNone(res["trap"])
        # First overflow after 256 ticks of 16 cycles, then every (256 - $C0) ticks.
        want = (70224 - 256 * 16) // (64 * 16) + 1
        self.assertAlmostEqual(res["dump"]["C000"][0], want, delta=2)

    def test_joypad(self):
        res = run(self.wasm(JOYPAD, "joypad"), 1, "C000:2", "--buttons=91")   # Right, A, Start
        self.assertEqual(res["dump"]["C000"], [0xEE, 0xD6])

    def test_mbc_bank_switching(self):
        for name, cart in (("mbc1", 0x03), ("mbc3", 0x13), ("mbc5", 0x1B)):
            with self.subTest(mbc=name):
                res = run(self.wasm(MBC, name, cart=cart, rom_banks=4, ram_code=0x03), 1, "C000:6")
                self.assertIsNone(res["trap"])
                self.assertEqual(res["dump"]["C000"], [0x22, 0x33, 0x11, 0xB2, 0x5A, 0xA5])

    def test_link_cable(self):
        master = self.wasm(serial_rom(0x42, 0x81), "master")
        slave = self.wasm(serial_rom(0x99, 0x80), "slave")
        res = run("--link", master, slave, 1, "C000:2")
        m, s = (x["dump"]["C000"] for x in res["machines"])
        self.assertEqual((m[0], s[0]), (0x99, 0x42), "bytes swapped over the cable")
        self.assertTrue(m[1] & 8 and s[1] & 8, "serial interrupt requested on both sides")

    def test_serial_without_partner_reads_ff(self):
        res = run(self.wasm(serial_rom(0x42, 0x81), "alone"), 1, "C000:1")
        self.assertEqual(res["dump"]["C000"], [0xFF])


if __name__ == "__main__":
    unittest.main()
