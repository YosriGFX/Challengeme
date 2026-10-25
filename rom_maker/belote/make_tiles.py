#!/usr/bin/env python3
"""Draws Belote's tiles and writes tiles.asm (run it from anywhere: python3 make_tiles.py).

Background tiles: blank, the font (with the four suits as letters s h d c, and digits
inverted for the clock of the player to act), every card as 2 x 3 tiles (16 x 24
pixels: rank and small suit on top, a big suit below), also greyed for cards that may
not be played, and a card back. Sprite tiles: the arrow at the player to act. Edit the
drawings below and run it again; main.asm uses only the DEF names it writes.
"""
from pathlib import Path

RED = 2                            # hearts and diamonds are drawn in shade 2, spades and clubs 3
SUITS = "shdc"                     # card = suit * 8 + rank; suit 0 spades, 1 hearts, 2 diamonds, 3 clubs
RANKS = ["7", "8", "9", "10", "J", "Q", "K", "A"]

# 5 x 7 font, drawn in shade 3 on shade 0.
FONT = {
    " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
    "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
    "N": ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
    "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
    "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
    "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
    "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
    "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
    "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
    "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
    "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
    "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
    "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
    "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
    "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
    "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
    ":": [".....", "..#..", "..#..", ".....", "..#..", "..#..", "....."],
    "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
    "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
    ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
    "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
    "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
    "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
    "<": ["...#.", "..#..", ".#...", "#....", ".#...", "..#..", "...#."],
    ">": [".#...", "..#..", "...#.", "....#", "...#.", "..#..", ".#..."],
}
FONT["s"] = ["...#...", "..###..", ".#####.", "#######", "#######", "...#...", "..###.."]
FONT["h"] = [".##.##.", "#######", "#######", "#######", ".#####.", "..###..", "...#..."]
FONT["d"] = ["...#...", "..###..", ".#####.", "#######", ".#####.", "..###..", "...#..."]
FONT["c"] = ["..###..", "..###..", "#.###.#", "#######", "#.#.#.#", "...#...", "..###.."]
FONT["+"] = [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."]
FONT["x"] = [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"]
CLOCK_CHARS = "0123456789"         # also drawn inverted, for the clock of the player to act

# Card ranks, up to 6 x 7, at the card's top left.
RANK_ART = {r: FONT[r] for r in "789JQKA"}
RANK_ART["10"] = ["#..##.", "#.#..#", "#.#..#", "#.#..#", "#.#..#", "#.#..#", "#..##."]
SMALL = {   # 5 x 5, at the card's top right
    "s": ["..#..", ".###.", "#####", "..#..", ".###."],
    "h": [".#.#.", "#####", "#####", ".###.", "..#.."],
    "d": ["..#..", ".###.", "#####", ".###.", "..#.."],
    "c": ["..#..", ".###.", "#####", "#.#.#", "..#.."],
}
BIG = {     # 10 x 10, in the card's lower part
    "s": ["....##....", "...####...", "..######..", ".########.", "##########",
          "##########", "##########", ".##.##.##.", "....##....", "...####..."],
    "h": [".###..###.", "##########", "##########", "##########", "##########",
          ".########.", "..######..", "...####...", "....##....", ".........."],
    "d": ["....##....", "...####...", "..######..", ".########.", "##########",
          "##########", ".########.", "..######..", "...####...", "....##...."],
    "c": ["...####...", "...####...", "...####...", ".##.##.##.", "##########",
          "##########", ".##.##.##.", "....##....", "...####...", "..######.."],
}
BACK = ["##..##..", "#..##..#", "..##..##", ".##..##.", "##..##..", "#..##..#", "..##..##", ".##..##."]

# Sprites, 8 x 8: '.' transparent, '1' colour 1, '2' colour 2 (OBP0: 1 = white, 2 = black).
SPRITES = {
    "DOWN": ["22222222", "21111112", ".211112.", ".211112.", "..2112..", "..2112..", "...22...", "........"],
    "RIGHT": ["22......", "2122....", "211122..", "2111112.", "2111112.", "211122..", "2122....", "22......"],
}


def card_pixels(rank, suit, grey):
    """16 x 24 shades of one card (rank None: the back)."""
    paper = 1 if grey else 0
    px = [[0] * 16 for _ in range(24)]
    for y in range(24):
        for x in range(16):
            edge = y in (0, 23) or x in (0, 15)
            corner = (y in (0, 23)) and (x in (0, 15))
            px[y][x] = 0 if corner else 3 if edge else paper
    if rank is None:
        for y in range(2, 22):
            for x in range(2, 14):
                px[y][x] = 2 if BACK[y % 8][x % 8] == "#" else 1
        return px
    ink = RED if suit in "hd" else 3
    for y, row in enumerate(RANK_ART[rank]):
        for x, c in enumerate(row):
            if c == "#":
                px[1 + y][2 + x] = ink
    for y, row in enumerate(SMALL[suit]):
        for x, c in enumerate(row):
            if c == "#":
                px[2 + y][9 + x] = ink
    for y, row in enumerate(BIG[suit]):
        for x, c in enumerate(row):
            if c == "#":
                px[11 + y][3 + x] = ink
    return px


def cut(px, tx, ty):
    return [row[tx * 8:tx * 8 + 8] for row in px[ty * 8:ty * 8 + 8]]


def glyph_tile(rows, ink, paper):
    tile = [[paper] * 8 for _ in range(8)]
    for y, row in enumerate(rows):
        for x, c in enumerate(row):
            if c == "#":
                tile[y][x + 1] = ink
    return tile


def main():
    tiles, defs = [], []

    def add(name, tile, define=True):
        if define:
            defs.append(f"DEF TILE_{name} EQU {len(tiles)}")
        tiles.append((name, tile))

    add("BLANK", [[0] * 8 for _ in range(8)])
    charmap = []
    for ch, rows in FONT.items():
        if ch == " ":
            charmap.append('CHARMAP " ", TILE_BLANK')
            continue
        name = {":": "COLON", "-": "DASH", "!": "BANG", ".": "DOT_", "'": "QUOTE", "?": "QMARK", "/": "SLASH",
                "<": "LT", ">": "GT", "+": "PLUS", "x": "TIMES", "s": "SPADE", "h": "HEART", "d": "DIAMOND",
                "c": "CLUB"}.get(ch, f"CH_{ch}")
        add(name, glyph_tile(rows, RED if ch in "hd" else 3, 0))
        charmap.append(f'CHARMAP "{ch}", TILE_{name}')
    for ch in CLOCK_CHARS:
        add(f"INV_{ch}", glyph_tile(FONT[ch], 0, 3))
    # Cards: TILE_RANK + (grey * 16 + red * 8 + rank) is the top left; TILE_SUIT + grey * 4 +
    # suit the top right; TILE_BIG + (grey * 4 + suit) * 4 + part the lower four
    # (part 0 middle left, 1 middle right, 2 bottom left, 3 bottom right).
    defs.append(f"DEF TILE_RANK EQU {len(tiles)}")
    for grey in (0, 1):
        for red in (0, 1):
            for rank in RANKS:
                add(f"rank {rank} {'red' if red else 'black'}{' grey' if grey else ''}",
                    cut(card_pixels(rank, "h" if red else "s", grey), 0, 0), False)
    defs.append(f"DEF TILE_SUIT EQU {len(tiles)}")
    for grey in (0, 1):
        for suit in SUITS:
            add(f"small {suit}{' grey' if grey else ''}", cut(card_pixels("7", suit, grey), 1, 0), False)
    defs.append(f"DEF TILE_BIG EQU {len(tiles)}")
    for grey in (0, 1):
        for suit in SUITS:
            px = card_pixels("7", suit, grey)
            for tx, ty in ((0, 1), (1, 1), (0, 2), (1, 2)):
                add(f"big {suit} {tx},{ty}{' grey' if grey else ''}", cut(px, tx, ty), False)
    defs.append(f"DEF TILE_BACK EQU {len(tiles)}   ; + part: 0 top left ... 5 bottom right")
    px = card_pixels(None, None, False)
    for ty in range(3):
        for tx in range(2):
            add(f"back {tx},{ty}", cut(px, tx, ty), False)
    for name, rows in SPRITES.items():
        add(f"SPR_{name}", [[int(c) if c != "." else 0 for c in row] for row in rows])
    assert len(tiles) <= 256, len(tiles)

    out = ["; Belote's tiles, written by make_tiles.py (edit that, not this). 2 bits per pixel as",
           "; RGBDS backtick rows: 0 = lightest ... 3 = darkest. Everything reads them from $8000.", ""]
    out += defs + [f"DEF TILE_COUNT EQU {len(tiles)}", ""] + charmap + ["", 'SECTION "Tiles", ROM0', "Tiles:"]
    for i, (name, tile) in enumerate(tiles):
        out.append(f"    ; {i}: {name}")
        out += [f"    dw `{''.join(str(p) for p in row)}" for row in tile]
    out.append("TilesEnd:")
    Path(__file__).with_name("tiles.asm").write_text("\n".join(out) + "\n")
    print(f"tiles.asm: {len(tiles)} tiles")


if __name__ == "__main__":
    main()
