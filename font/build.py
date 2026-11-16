#!/usr/bin/env python3
"""The console font: one table of strokes, two outputs.

    python3 font/build.py          (needs: pip install fonttools)

  public/console.ttf   for the browser: menus and game text (see public/style.css)
  ppu/font.h           the same strokes as a C table, for a client with no font engine
  fpga/font_rom.vh     the same strokes as two ROMs, for the FPGA client

Every glyph is a few straight strokes on a grid 4 wide and 6 high (y up, 0 = baseline),
drawn with one pen width. Corners are cut, nothing is curved. Capital letters only:
a small letter shows its capital. The advance is 0.6 em, like the monospace it replaces,
so every text in every game keeps its width.
"""
import math, os, sys

O = [(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)]
P = [(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]
S = [(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]
dot = lambda x, y: [(x, y), (x, y)]

GLYPHS = {
    ' ': [],
    'A': [[(0, 0), (0, 4), (2, 6), (4, 4), (4, 0)], [(0, 2), (4, 2)]],
    'B': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    'C': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1)]],
    'D': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 1), (3, 0), (0, 0)]],
    'E': [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]],
    'F': [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    'G': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 3), (2, 3)]],
    'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(1, 6), (3, 6)], [(2, 6), (2, 0)], [(1, 0), (3, 0)]],
    'J': [[(4, 6), (4, 1), (3, 0), (1, 0), (0, 1)]],
    'K': [[(0, 0), (0, 6)], [(4, 6), (1, 3), (4, 0)], [(0, 3), (1, 3)]],
    'L': [[(0, 6), (0, 0), (4, 0)]],
    'M': [[(0, 0), (0, 6), (2, 4), (4, 6), (4, 0)]],
    'N': [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    'O': [O],
    'P': [P],
    'Q': [O, [(2, 2), (4, 0)]],
    'R': [P, [(2, 3), (4, 0)]],
    'S': [S],
    'T': [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    'U': [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]],
    'V': [[(0, 6), (2, 0), (4, 6)]],
    'W': [[(0, 6), (0, 0), (2, 2), (4, 0), (4, 6)]],
    'X': [[(0, 6), (4, 0)], [(0, 0), (4, 6)]],
    'Y': [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]],
    'Z': [[(0, 6), (4, 6), (0, 0), (4, 0)]],
    '0': [O, [(1, 2), (3, 4)]],
    '1': [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    '2': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]],
    '3': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '4': [[(3, 0), (3, 6), (0, 2), (4, 2)]],
    '5': [[(4, 6), (0, 6), (0, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '6': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)]],
    '7': [[(0, 6), (4, 6), (1, 0)]],
    '8': [[(1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3), (0, 2), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3)]],
    '9': [[(0, 1), (1, 0), (3, 0), (4, 1), (4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (4, 3)]],
    '.': [dot(2, 0)],
    ',': [[(2, 0), (1, -1)]],
    ':': [dot(2, 1), dot(2, 4)],
    ';': [dot(2, 4), [(2, 1), (1, 0)]],
    '!': [[(2, 6), (2, 2)], dot(2, 0)],
    '?': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (2, 2)], dot(2, 0)],
    "'": [[(2, 6), (2, 5)]],
    '"': [[(1, 6), (1, 5)], [(3, 6), (3, 5)]],
    '`': [[(1, 6), (2, 5)]],
    '-': [[(1, 3), (3, 3)]],
    '+': [[(0, 3), (4, 3)], [(2, 5), (2, 1)]],
    '=': [[(0, 4), (4, 4)], [(0, 2), (4, 2)]],
    '/': [[(0, 0), (4, 6)]],
    '\\': [[(0, 6), (4, 0)]],
    '(': [[(3, 6), (1, 4), (1, 2), (3, 0)]],
    ')': [[(1, 6), (3, 4), (3, 2), (1, 0)]],
    '[': [[(3, 6), (1, 6), (1, 0), (3, 0)]],
    ']': [[(1, 6), (3, 6), (3, 0), (1, 0)]],
    '{': [[(3, 6), (2, 5), (2, 4), (1, 3), (2, 2), (2, 1), (3, 0)]],
    '}': [[(1, 6), (2, 5), (2, 4), (3, 3), (2, 2), (2, 1), (1, 0)]],
    '<': [[(4, 6), (0, 3), (4, 0)]],
    '>': [[(0, 6), (4, 3), (0, 0)]],
    '_': [[(0, 0), (4, 0)]],
    '*': [[(0, 3), (4, 3)], [(1, 5), (3, 1)], [(3, 5), (1, 1)]],
    '#': [[(1, 6), (1, 0)], [(3, 6), (3, 0)], [(0, 4), (4, 4)], [(0, 2), (4, 2)]],
    '%': [[(0, 0), (4, 6)], dot(1, 5), dot(3, 1)],
    '&': [[(4, 0), (1, 4), (1, 5), (2, 6), (3, 5), (0, 2), (0, 1), (1, 0), (2, 0), (4, 2)]],
    '@': [O, [(3, 2), (2, 2), (2, 4), (4, 4)]],
    '$': [S, [(2, 7), (2, -1)]],
    '^': [[(1, 4), (2, 6), (3, 4)]],
    '|': [[(2, 6), (2, 0)]],
    '~': [[(0, 3), (1, 4), (3, 2), (4, 3)]],
    '\u00b7': [dot(2, 3)],            # the middle dot of "2P · 60 HZ"
}

EM, ADVANCE = 1000, 600
UNIT = 700 / 6                        # the capitals are 0.7 em high
LEFT = (ADVANCE - 4 * UNIT) / 2
HALF = 50                             # half the pen width: the pen is 0.1 em

def segments(strokes):
    out = []
    for line in strokes:
        for a, b in zip(line, line[1:]):
            out.append((a, b))
    return out

def capsule(a, b):
    """One stroke as an outline: a bar with an eight-sided end at each point (clockwise)."""
    ax, ay = LEFT + a[0] * UNIT, a[1] * UNIT
    bx, by = LEFT + b[0] * UNIT, b[1] * UNIT
    t = math.atan2(by - ay, bx - ax) if (ax, ay) != (bx, by) else 0.0
    pts = [(bx + HALF * math.cos(t + math.radians(d)), by + HALF * math.sin(t + math.radians(d))) for d in (90, 45, 0, -45, -90)]
    pts += [(ax + HALF * math.cos(t + math.radians(d)), ay + HALF * math.sin(t + math.radians(d))) for d in (-90, -135, 180, 135, 90)]
    return [(round(x), round(y)) for x, y in pts]

def build_ttf(path):
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    names, glyphs, metrics, cmap = ['.notdef'], {}, {}, {}
    def add(name, strokes):
        pen, xmin = TTGlyphPen(None), None
        for a, b in segments(strokes):
            pts = capsule(a, b)
            xmin = min([p[0] for p in pts] + ([xmin] if xmin is not None else []))
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
        g = pen.glyph()
        if g.numberOfContours > 0:
            g.flags[0] |= 0x40        # strokes overlap on purpose: tell the rasterizer
        glyphs[name], metrics[name] = g, (ADVANCE, xmin or 0)
    add('.notdef', [[(0, 0), (0, 6), (4, 6), (4, 0), (0, 0)]])
    for ch, strokes in GLYPHS.items():
        name = 'uni%04X' % ord(ch)
        names.append(name)
        add(name, strokes)
        cmap[ord(ch)] = name
        if ch.isalpha():
            cmap[ord(ch.lower())] = name          # a small letter shows its capital
    fb = FontBuilder(EM, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({'familyName': 'ConsoleFont', 'styleName': 'Regular'})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, sCapHeight=700, sxHeight=700)
    fb.setupPost(isFixedPitch=1)
    fb.save(path)

def build_header(path):
    """Strokes as bytes: a point is (x << 4) | (y + 1), a stroke is two points."""
    data, index = [], []
    for code in range(0x20, 0x7F):
        ch = chr(code).upper()
        segs = segments(GLYPHS.get(ch, GLYPHS['?']))
        index.append((len(data) // 2, len(segs)))
        for a, b in segs:
            data += [(a[0] << 4) | (a[1] + 1), (b[0] << 4) | (b[1] + 1)]
    with open(path, 'w') as f:
        f.write('/* font.h — the console font as strokes. Made by font/build.py: do not edit by hand.\n')
        f.write(' * A glyph sits on a grid 4 wide and 6 high. A point is (x << 4) | (y + 1), y up from the\n')
        f.write(' * baseline; a stroke is two points; the pen is 0.1 em wide and a glyph advances 0.6 em.\n')
        f.write(' * FONT_AT[c - 0x20] = { first stroke, number of strokes } for the characters 0x20..0x7E. */\n')
        f.write('#ifndef FONT_H\n#define FONT_H\n\n')
        f.write('static const unsigned short FONT_AT[%d][2] = {\n' % len(index))
        for i in range(0, len(index), 8):
            f.write('  ' + ' '.join('{%d,%d},' % p for p in index[i:i + 8]) + '\n')
        f.write('};\n\nstatic const unsigned char FONT_STROKES[%d] = {\n' % len(data))
        for i in range(0, len(data), 20):
            f.write('  ' + ','.join('0x%02X' % b for b in data[i:i + 20]) + ',\n')
        f.write('};\n\n#endif\n')

def strokes_by_char():
    """For 0x20..0x7E: the glyph's strokes as (first, count), and all strokes in one list."""
    index, flat = [], []
    for code in range(0x20, 0x7F):
        segs = segments(GLYPHS.get(chr(code).upper(), GLYPHS['?']))
        index.append((len(flat), len(segs)))
        flat += segs
    return index, flat

def build_verilog(path):
    """font_at[c - 0x20] = {first stroke (11 bits), count (5 bits)}; font_st[i] = {point a, point b}."""
    index, flat = strokes_by_char()
    pt = lambda p: (p[0] << 4) | (p[1] + 1)
    with open(path, 'w') as f:
        f.write('// font_rom.vh — the console font for the FPGA client. Made by font/build.py: do not edit.\n')
        f.write('// A point is (x << 4) | (y + 1) on the 4 x 6 grid, y up from the baseline.\n')
        f.write('reg [15:0] font_at [0:%d];\nreg [15:0] font_st [0:%d];\ninitial begin\n' % (len(index) - 1, len(flat) - 1))
        for i, (first, count) in enumerate(index):
            f.write('  font_at[%d] = 16\'h%04X;\n' % (i, (first << 5) | count))
        for i, (a, b) in enumerate(flat):
            f.write('  font_st[%d] = 16\'h%04X;\n' % (i, (pt(a) << 8) | pt(b)))
        f.write('end\n')

if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_header(os.path.join(root, 'ppu', 'font.h'))
    build_verilog(os.path.join(root, 'fpga', 'font_rom.vh'))
    try:
        build_ttf(os.path.join(root, 'public', 'console.ttf'))
        print('wrote ppu/font.h, fpga/font_rom.vh and public/console.ttf')
    except ImportError:
        print('wrote ppu/font.h and fpga/font_rom.vh (pip install fonttools to also rebuild public/console.ttf)')
