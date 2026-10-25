#!/usr/bin/env python3
"""Writes zobrist.asm: random 32-bit keys for spotting repeated positions (run it from
anywhere: python3 make_zobrist.py; the seed is fixed, so the file only changes if this does).

A position's key is the XOR of one key per piece on its square, one for the castling
rights, one for an en passant square (only when a pawn can really take there) and one
when black is to move. main.asm keeps the key of every position since the last capture
or pawn move; three equal keys with the same side to move are a draw by repetition.
Pages (256 bytes each, 4 bytes per entry): 0-11 the pieces (white pawn ... king, then
black), indexed by square 0-63 (a1 = 0, h8 = 63); 12 en passant, by square; 13 castling
rights 0-15 at 0-60, and black to move at 64.
"""
import random
from pathlib import Path

rng = random.Random(0xC4E55)
out = ["; Zobrist keys, written by make_zobrist.py (edit that, not this).", "",
       'SECTION "Zobrist", ROM0, ALIGN[8]', "Zobrist:"]
for page in range(14):
    entries = 64 if page < 13 else 17
    keys = b"".join(rng.getrandbits(32).to_bytes(4, "little") for _ in range(entries))
    out.append(f"    ; page {page}")
    out += ["    db " + ", ".join(f"${b:02X}" for b in keys[i:i + 16]) for i in range(0, len(keys), 16)]
Path(__file__).with_name("zobrist.asm").write_text("\n".join(out) + "\n")
print("zobrist.asm: 14 pages")
