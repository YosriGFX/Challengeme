"""Code discovery idioms found in real games (first met in Dr. Mario): jump tables placed
right after a call, tables of code addresses picked by an index, interrupt handlers that
run on past their 8 bytes, and the OAM DMA routine copied to HRAM. Each test builds a
small ROM with the idiom, checks what discovery finds and, where it matters, that the
translated code takes the right branch when it runs.
"""
import tempfile
import unittest

from translator.cfg import discover
from translator.tests.romkit import TOOLS, build_rom, h, run, translate

# Index helper: HL = word at HL + 2 * A.
INDEX = h("87 5F 1600 19 5E 23 56 62 6B C9")   # add a,a; ld e,a; ld d,0; add hl,de; ld e,(hl); inc hl; ld d,(hl); ld h,d; ld l,e; ret
MARK = lambda v: h(f"3E{v:02X} EA00C0 18FE")    # ld a,v; ld ($C000),a; jr $


def rom_with(pieces):
    return build_rom({(0, a): code for a, code in pieces.items()})


# RST $28 pops its return address: the words after `rst $28` are the table, not code.
RST_TABLE = rom_with({
    0x0028: h("87 E1 5F 1600 19 5E 23 56 D5 E1 E9"),  # add a,a; pop hl; hl += 2a; hl = (hl); jp hl
    0x0150: h("31FEFF 3E01 EF 6001 7001 0000"),         # ld sp; ld a,1; rst $28; dw $0160, $0170
    0x0160: MARK(0x11),
    0x0170: MARK(0x22),
})

# ld hl,table / call index / jp hl: the table lies elsewhere.
HL_TABLE = rom_with({
    0x0150: h("31FEFF 3E01 210002 CD8001 E9"),          # ld sp; ld a,1; ld hl,$0200; call $0180; jp hl
    0x0180: INDEX,
    0x0200: h("1002 2002 0000"),                        # dw $0210, $0220
    0x0210: MARK(0x11),
    0x0220: MARK(0x22),
})

# add a,low / adc a,high builds the table address; the table has an unused slot.
ADC_TABLE = rom_with({
    0x0150: h("31FEFF 3E02 87 C600 6F 3E00 CE02 67 2A 66 6F E9"),   # hl = $0200 + 2a; hl = (hl); jp hl
    0x0200: h("1002 0000 2002 0000"),                    # dw $0210, 0, $0220
    0x0210: MARK(0x11),
    0x0220: MARK(0x22),
})

# ld de,table / add hl,de, then push hl / ret jumps to the entry; the return address
# pushed before it (ld bc,nn / push bc) is code too. Index 0 is unused, so the base
# points into the dispatch code.
PUSH_RET = rom_with({
    0x0150: h("31FEFF 018001 C5 3E01 87 6F 2600 116401 19 2A 66 6F E5 C9 7001"),
    # ld sp; ld bc,$0180; push bc; ld a,1; add a,a; ld l,a; ld h,0; ld de,$0164;
    # add hl,de; ld a,(hl+); ld h,(hl); ld l,a; push hl; ret; dw $0170 (entry 1, at $0166)
    0x0170: MARK(0x22),
    0x0180: h("18FE"),
})

# The serial handler at $58 is longer than 8 bytes: its `ld a,($C4F1)` covers $60, which
# is then not the joypad vector's code.
LONG_HANDLER = rom_with({
    0x0040: h("D9"), 0x0048: h("D9"), 0x0050: h("D9"),
    0x0058: h("F5 C5 F001 E0F2 47 FAF1C4 A7 C1 F1 D9"),
    0x0150: h("FB 18FE"),
})

# A call into HRAM with no hints: the game copied the standard DMA routine there.
DMA = rom_with({
    0x0150: h("CD80FF 18FE"),
    0x0300: h("3EC0 E046 3E28 3D 20FD C9"),
})


class Discovery(unittest.TestCase):
    def test_inline_table_after_rst(self):
        prog = discover(RST_TABLE)
        self.assertIn(0x160, prog.instrs)
        self.assertIn(0x170, prog.instrs)
        self.assertNotIn(0x156, prog.instrs)            # the table itself is not code

    def test_table_loaded_into_hl_before_jp_hl(self):
        prog = discover(HL_TABLE)
        self.assertIn(0x210, prog.instrs)
        self.assertIn(0x220, prog.instrs)
        self.assertNotIn(0x200, prog.instrs)

    def test_table_from_add_adc_with_unused_slot(self):
        prog = discover(ADC_TABLE)
        self.assertIn(0x210, prog.instrs)
        self.assertIn(0x220, prog.instrs)

    def test_push_ret_table_and_pushed_return_address(self):
        prog = discover(PUSH_RET)
        self.assertIn(0x170, prog.instrs)                # table entry, base + 2
        self.assertIn(0x180, prog.instrs)                # return address pushed earlier

    def test_handler_running_over_next_vector(self):
        prog = discover(LONG_HANDLER)
        self.assertIn(0x5F, prog.instrs)
        self.assertNotIn(0x60, prog.instrs)
        self.assertEqual(prog.instrs[0x5F].length, 3)

    def test_dma_routine_mapped_into_hram(self):
        prog = discover(DMA)
        self.assertIn(0xFF80, prog.instrs)
        self.assertNotIn(0xFF80, prog.unresolved)


@unittest.skipUnless(TOOLS, "needs wat2wasm and node")
class Dispatch(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def entry_taken(self, rom, name):
        res = run(translate(rom, name, self._tmp.name), 2, "C000:1")
        self.assertIsNone(res["trap"])
        return res["dump"]["C000"][0]

    def test_rst_table_takes_entry_a(self):
        self.assertEqual(self.entry_taken(RST_TABLE, "rst"), 0x22)

    def test_hl_table_takes_entry_a(self):
        self.assertEqual(self.entry_taken(HL_TABLE, "hl"), 0x22)

    def test_adc_table_takes_entry_a(self):
        self.assertEqual(self.entry_taken(ADC_TABLE, "adc"), 0x22)

    def test_push_ret_table_takes_entry_a(self):
        self.assertEqual(self.entry_taken(PUSH_RET, "pushret"), 0x22)


if __name__ == "__main__":
    unittest.main()
