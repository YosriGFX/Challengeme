import unittest

from translator.decoder import ILLEGAL, DecodeError, decode

# Instruction lengths from the SM83 opcode table, one row per high nibble ("-" = illegal).
LENGTHS = """
1311112131111121
2311112121111121
2311112121111121
2311112121111121
1111111111111111
1111111111111111
1111111111111111
1111111111111111
1111111111111111
1111111111111111
1111111111111111
1111111111111111
1133312111323321
113-3121113-3-21
211--121213---21
2111-1212131--21
""".split()

# (opcode bytes, cycles, cycles when taken) spot checks, in T-cycles.
CYCLES = [
    ("08", 20, 0), ("18", 12, 0), ("20", 8, 12), ("C0", 8, 20), ("C2", 12, 16),
    ("C4", 12, 24), ("CD", 24, 0), ("C9", 16, 0), ("D9", 16, 0), ("E8", 16, 0),
    ("F8", 12, 0), ("F9", 8, 0), ("E9", 4, 0), ("34", 12, 0), ("36", 12, 0),
    ("46", 8, 0), ("70", 8, 0), ("86", 8, 0), ("C5", 16, 0), ("C1", 12, 0),
    ("FF", 16, 0), ("EA", 16, 0), ("F0", 12, 0), ("E2", 8, 0), ("09", 8, 0),
    ("CB06", 16, 0), ("CB46", 12, 0), ("CB86", 16, 0), ("CB00", 8, 0), ("CB7C", 8, 0),
]


def rom_with(code):
    rom = bytearray(16)
    rom[:len(code)] = code
    return rom


class DecoderTest(unittest.TestCase):
    def test_lengths_match_opcode_table(self):
        self.assertEqual(len(LENGTHS), 16)
        for op in range(256):
            want = LENGTHS[op >> 4][op & 0xF]
            if op == 0xCB:
                want = "2"
            with self.subTest(op=f"{op:02X}"):
                if want == "-":
                    self.assertIn(op, ILLEGAL)
                    with self.assertRaises(DecodeError):
                        decode(rom_with([op]), 0)
                else:
                    self.assertEqual(decode(rom_with([op, 0, 0]), 0).length, int(want))

    def test_all_cb_opcodes_decode(self):
        for op in range(256):
            ins = decode(rom_with([0xCB, op]), 0)
            self.assertEqual(ins.length, 2)

    def test_cycles(self):
        for hexcode, cycles, taken in CYCLES:
            with self.subTest(op=hexcode):
                ins = decode(rom_with(bytes.fromhex(hexcode) + b"\0\0"), 0)
                self.assertEqual((ins.cycles, ins.cycles_taken), (cycles, taken))

    def test_examples_from_phase2(self):
        add = decode(rom_with([0x80]), 0)
        self.assertEqual((add.text, add.length, add.cycles), ("add a,b", 1, 4))
        ld = decode(rom_with([0x3E, 0x2A]), 0)
        self.assertEqual((ld.text, ld.length, ld.cycles, ld.args), ("ld a,$2A", 2, 8, ("a", 0x2A)))

    def test_relative_jump_target(self):
        jr = decode(rom_with([0, 0, 0x20, 0xFA]), 2)
        self.assertEqual((jr.target, jr.flow, jr.reads), (0xFFFE, "branch", frozenset("z")))


if __name__ == "__main__":
    unittest.main()
