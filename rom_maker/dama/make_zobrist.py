#!/usr/bin/env python3
"""Writes zobrist.asm: random 32-bit keys for spotting repeated positions (run it from
anywhere: python3 make_zobrist.py; the seed is fixed, so the file only changes if this does).

A position's key is the XOR of one key per piece on its square and one when black is
to move. main.asm keeps the key of every position since the last capture or man move;
three equal keys are a draw by repetition. Pages (256 bytes, 4 bytes per entry): 0
white men, 1 white kings, 2 black men, 3 black kings, indexed by square 0-63 (a1 = 0,
h8 = 63); 4: black to move at 0.
"""
import random
from pathlib import Path

rng = random.Random(0xDA4A)
out = ["; Zobrist keys, written by make_zobrist.py (edit that, not this).", "",
       'SECTION "Zobrist", ROM0, ALIGN[8]', "Zobrist:"]
for page in range(5):
    entries = 64 if page < 4 else 1
    keys = b"".join(rng.getrandbits(32).to_bytes(4, "little") for _ in range(entries))
    out.append(f"    ; page {page}")
    out += ["    db " + ", ".join(f"${b:02X}" for b in keys[i:i + 16]) for i in range(0, len(keys), 16)]
Path(__file__).with_name("zobrist.asm").write_text("\n".join(out) + "\n")
print("zobrist.asm: 5 pages")
