"""Translate ROMs, assemble them with wat2wasm, run the .wasm in Node's V8, check results.

Needs `wat2wasm` (wabt) and `node` on PATH; skipped otherwise. Expected values are
known answers from the SM83 documentation, not output from another program.
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from translator.__main__ import main

ROOT = Path(__file__).resolve().parents[2]
HARNESS = Path(__file__).with_name("run_wasm.mjs")
TOOLS = shutil.which("wat2wasm") and shutil.which("node")

# (setup + instruction bytes, expected A, expected F). Each case's A and F are stored to
# WRAM by: LD (nn),A / PUSH AF / POP BC / LD A,C / LD (nn+1),A.
CASES = [
    ("add a,b",            "3E3A 06C6 80",       0x00, 0xB0),
    ("add a,d8",           "3E3C C6FF",          0x3B, 0x30),
    ("sub e (zero)",       "3E3E 1E3E 93",       0x00, 0xC0),
    ("sub d8 (half)",      "3E3E D60F",          0x2F, 0x60),
    ("sub b (borrow)",     "3E3E 0640 90",       0xFE, 0x50),
    ("adc a,e",            "3EE1 1E0F 37 8B",    0xF1, 0x20),
    ("adc a,d8",           "3EE1 37 CE3B",       0x1D, 0x10),
    ("adc to zero",        "3EE1 1E1E 37 8B",    0x00, 0xB0),
    ("sbc a,h",            "3E3B 262A 37 9C",    0x10, 0x40),
    ("sbc to zero",        "3E3B 37 DE3A",       0x00, 0xC0),
    ("sbc borrow",         "3E3B 37 DE4F",       0xEB, 0x70),
    ("cp b",               "3E3C 062F B8",       0x3C, 0x60),
    ("cp equal",           "3E3C FE3C",          0x3C, 0xC0),
    ("cp greater",         "3E3C FE40",          0x3C, 0x50),
    ("inc a wraps",        "3EFF B7 3C",         0x00, 0xA0),
    ("dec a keeps carry",  "3E01 37 3D",         0x00, 0xD0),
    ("daa after add",      "3E45 0638 80 27",    0x83, 0x00),
    ("daa after sub",      "3E83 0638 90 27",    0x45, 0x40),
    ("rlca",               "3E85 07",            0x0B, 0x10),
    ("rla",                "3E95 37 17",         0x2B, 0x10),
    ("rrca",               "3E3B 0F",            0x9D, 0x10),
    ("rra",                "3E81 B7 1F",         0x40, 0x10),
    ("swap a",             "3EF0 CB37",          0x0F, 0x00),
    ("srl a",              "3E01 CB3F",          0x00, 0x90),
    ("sra a",              "3E8A CB2F",          0xC5, 0x00),
    ("bit 7,h set",        "3E00 2680 37 CB7C",  0x00, 0x30),
    ("bit 0,h clear",      "3E00 2680 B7 CB44",  0x00, 0xA0),
    ("add hl,bc",          "3E01 B7 21238A 010506 09 7C", 0x90, 0x20),
    ("add hl,hl",          "3E01 B7 21238A 29 7D",        0x46, 0x30),
    ("ld hl,sp+8",         "31F8FF F808 7C",     0x00, 0x30),
    ("add sp,2",           "31F8FF E802 F800 7D", 0xFA, 0x00),
    ("pop af masks F",     "01FF12 C5 F1",       0x12, 0xF0),
    ("call / ret",         "3E00 CD0070",        0x42, 0x00),
    ("ret z taken",        "3E05 CD1070",        0x00, 0x80),
    ("jp (hl)",            "JPHL",               0x77, 0x00),
    ("dec b / jr nz loop", "3E00 0605 3C 05 20FC", 0x05, 0xC0),
    ("rl c through carry", "0E80 37 CB11 79",    0x01, 0x10),
    ("set / res",          "3E00 CBC7 CBFF CB87", 0x80, 0x10),
]
SUBS = {0x7000: "3E42 B7 C9", 0x7010: "AF C8 3E99 C9"}


def build_alu_rom():
    rom = bytearray(0x8000)
    rom[0x100:0x103] = bytes((0xC3, 0x50, 0x01))
    code, pc = bytearray(), 0x150
    for i, (_, hexcode, _, _) in enumerate(CASES):
        if hexcode == "JPHL":
            target = pc + 4 + 2                       # skip the "LD A,$11" after JP (HL)
            body = bytes((0x21, target & 0xFF, target >> 8, 0xE9, 0x3E, 0x11, 0x3E, 0x77, 0xB7))
        else:
            body = bytes.fromhex(hexcode.replace(" ", ""))
        a = 0xC000 + 2 * i
        body += bytes((0xEA, a & 0xFF, a >> 8, 0xF5, 0xC1, 0x79, 0xEA, (a + 1) & 0xFF, (a + 1) >> 8))
        body += bytes((0x31, 0xFE, 0xFF))             # LD SP,$FFFE (some cases move SP)
        code += body
        pc += len(body)
    code += bytes((0x18, 0xFE))                       # JR to itself
    rom[0x150:0x150 + len(code)] = code
    for addr, hexcode in SUBS.items():
        sub = bytes.fromhex(hexcode.replace(" ", ""))
        rom[addr:addr + len(sub)] = sub
    return bytes(rom)


def run(rom_path, frames, *ranges, tmp):
    wat = Path(tmp) / (Path(rom_path).stem + ".wat")
    assert main([str(rom_path), "-o", str(wat), "--wasm"]) == 0
    out = subprocess.run(["node", str(HARNESS), str(wat.with_suffix(".wasm")), str(frames), *ranges],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


@unittest.skipUnless(TOOLS, "needs wat2wasm and node on PATH")
class EndToEndTest(unittest.TestCase):
    def test_known_answer_alu(self):
        with tempfile.TemporaryDirectory() as tmp:
            rom = Path(tmp) / "alu.gb"
            rom.write_bytes(build_alu_rom())
            res = run(rom, 1, f"C000:{2 * len(CASES)}", tmp=tmp)
        self.assertIsNone(res["trap"])
        got = res["dump"]["C000"]
        for i, (name, _, a, f) in enumerate(CASES):
            with self.subTest(case=name):
                self.assertEqual((got[2 * i], got[2 * i + 1]), (a, f),
                                 f"A/F = {got[2 * i]:02X}/{got[2 * i + 1]:02X}, want {a:02X}/{f:02X}")

    def test_hello_world(self):
        hello = ROOT / "roms" / "hello.gb"
        rom = hello.read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            res = run(hello, 3, "8000:144", "9800:1024", "FF40:1", "FF47:1", tmp=tmp)
        self.assertIsNone(res["trap"])
        dump = res["dump"]
        self.assertEqual(dump["8000"], list(rom[0x196:0x196 + 144]), "tile data in VRAM")
        bg = dump["9800"]
        msg = [1, 2, 3, 3, 4, 0, 5, 4, 6, 3, 7, 8]          # HELLO WORLD! as tile indices
        self.assertEqual(bg[0x104:0x104 + 12], msg)
        self.assertEqual(sum(bg) - sum(msg), 0, "rest of the BG map is blank")
        self.assertEqual(dump["FF40"], [0x91], "LCD and BG on")
        self.assertEqual(dump["FF47"], [0xE4], "palette")
        self.assertEqual(res["regs"]["PC"], 0x194, "parked in the final JR loop")


if __name__ == "__main__":
    unittest.main()
