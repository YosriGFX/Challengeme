; Tiles in 2 bits per pixel, written as RGBDS backtick rows: each digit is a shade,
; 0 = lightest ... 3 = darkest (with BGP and OBP0 = %11100100). Edit a digit to
; change that pixel. Sprites and background share these tiles
; (LCDC bit 4 = 1: both read tiles from $8000).

DEF TILE_BLANK EQU 0
DEF TILE_WALL EQU 1
DEF TILE_P1 EQU 2
DEF TILE_P2 EQU 3
DEF TILE_COIN EQU 4
DEF TILE_DIGIT_0 EQU 5
DEF TILE_P EQU 15                  ; letters for PRESS START and OK
DEF TILE_R EQU 16
DEF TILE_E EQU 17
DEF TILE_S EQU 18
DEF TILE_T EQU 19
DEF TILE_A EQU 20
DEF TILE_O EQU 21
DEF TILE_K EQU 22

SECTION "Tiles", ROM0
Tiles:
    ; 0: TILE_BLANK
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    ; 1: TILE_WALL
    dw `22222221
    dw `22222221
    dw `22222221
    dw `11111111
    dw `22212222
    dw `22212222
    dw `22212222
    dw `11111111
    ; 2: TILE_P1
    dw `33333333
    dw `32222223
    dw `32333323
    dw `32333323
    dw `32333323
    dw `32333323
    dw `32222223
    dw `33333333
    ; 3: TILE_P2
    dw `33333333
    dw `30000003
    dw `30333303
    dw `30300303
    dw `30300303
    dw `30333303
    dw `30000003
    dw `33333333
    ; 4: TILE_COIN
    dw `00333300
    dw `03222230
    dw `32211223
    dw `32122123
    dw `32122123
    dw `32211223
    dw `03222230
    dw `00333300
    ; 5: TILE_DIGIT_0
    dw `00333000
    dw `03000300
    dw `03003300
    dw `03030300
    dw `03300300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 6: digit 1
    dw `00030000
    dw `00330000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00333000
    dw `00000000
    ; 7: digit 2
    dw `00333000
    dw `03000300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `03333300
    dw `00000000
    ; 8: digit 3
    dw `03333000
    dw `00000300
    dw `00000300
    dw `00333000
    dw `00000300
    dw `00000300
    dw `03333000
    dw `00000000
    ; 9: digit 4
    dw `00003000
    dw `00033000
    dw `00303000
    dw `03003000
    dw `03333300
    dw `00003000
    dw `00003000
    dw `00000000
    ; 10: digit 5
    dw `03333300
    dw `03000000
    dw `03333000
    dw `00000300
    dw `00000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 11: digit 6
    dw `00033000
    dw `00300000
    dw `03000000
    dw `03333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 12: digit 7
    dw `03333300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `00300000
    dw `00300000
    dw `00000000
    ; 13: digit 8
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 14: digit 9
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333300
    dw `00000300
    dw `00003000
    dw `00330000
    dw `00000000
    ; 15: letter P
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `00000000
    ; 16: letter R
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `03030000
    dw `03003000
    dw `03000300
    dw `00000000
    ; 17: letter E
    dw `03333300
    dw `03000000
    dw `03000000
    dw `03333000
    dw `03000000
    dw `03000000
    dw `03333300
    dw `00000000
    ; 18: letter S
    dw `00333300
    dw `03000000
    dw `03000000
    dw `00333000
    dw `00000300
    dw `00000300
    dw `03333000
    dw `00000000
    ; 19: letter T
    dw `03333300
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00000000
    ; 20: letter A
    dw `00333000
    dw `03000300
    dw `03000300
    dw `03333300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00000000
    ; 21: letter O
    dw `00333000
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 22: letter K
    dw `03000300
    dw `03003000
    dw `03030000
    dw `03300000
    dw `03030000
    dw `03003000
    dw `03000300
    dw `00000000
TilesEnd:
