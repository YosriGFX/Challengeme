; Chess's tiles, written by make_tiles.py (edit that, not this). 2 bits per pixel as
; RGBDS backtick rows: 0 = lightest ... 3 = darkest. Everything reads them from $8000.

DEF TILE_BLANK EQU 0
DEF TILE_LIGHT EQU 1
DEF TILE_DARK EQU 2
DEF TILE_CH_A EQU 3
DEF TILE_CH_B EQU 4
DEF TILE_CH_C EQU 5
DEF TILE_CH_D EQU 6
DEF TILE_CH_E EQU 7
DEF TILE_CH_F EQU 8
DEF TILE_CH_G EQU 9
DEF TILE_CH_H EQU 10
DEF TILE_CH_I EQU 11
DEF TILE_CH_J EQU 12
DEF TILE_CH_K EQU 13
DEF TILE_CH_L EQU 14
DEF TILE_CH_M EQU 15
DEF TILE_CH_N EQU 16
DEF TILE_CH_O EQU 17
DEF TILE_CH_P EQU 18
DEF TILE_CH_Q EQU 19
DEF TILE_CH_R EQU 20
DEF TILE_CH_S EQU 21
DEF TILE_CH_T EQU 22
DEF TILE_CH_U EQU 23
DEF TILE_CH_V EQU 24
DEF TILE_CH_W EQU 25
DEF TILE_CH_X EQU 26
DEF TILE_CH_Y EQU 27
DEF TILE_CH_Z EQU 28
DEF TILE_CH_0 EQU 29
DEF TILE_CH_1 EQU 30
DEF TILE_CH_2 EQU 31
DEF TILE_CH_3 EQU 32
DEF TILE_CH_4 EQU 33
DEF TILE_CH_5 EQU 34
DEF TILE_CH_6 EQU 35
DEF TILE_CH_7 EQU 36
DEF TILE_CH_8 EQU 37
DEF TILE_CH_9 EQU 38
DEF TILE_COLON EQU 39
DEF TILE_DASH EQU 40
DEF TILE_BANG EQU 41
DEF TILE_DOT_ EQU 42
DEF TILE_QUOTE EQU 43
DEF TILE_QMARK EQU 44
DEF TILE_SLASH EQU 45
DEF TILE_LT EQU 46
DEF TILE_GT EQU 47
DEF TILE_INV_0 EQU 48
DEF TILE_INV_1 EQU 49
DEF TILE_INV_2 EQU 50
DEF TILE_INV_3 EQU 51
DEF TILE_INV_4 EQU 52
DEF TILE_INV_5 EQU 53
DEF TILE_INV_6 EQU 54
DEF TILE_INV_7 EQU 55
DEF TILE_INV_8 EQU 56
DEF TILE_INV_9 EQU 57
DEF TILE_INV_COLON EQU 58
DEF TILE_INV_BLANK EQU 59
DEF TILE_PIECES EQU 60   ; + ((type - 1) * 4 + black * 2 + dark) * 4 + quarter
DEF TILE_SPR_CORNER EQU 156
DEF TILE_SPR_DOT EQU 157
DEF TILE_SPR_MARK EQU 158
DEF TILE_COUNT EQU 159

CHARMAP " ", TILE_BLANK
CHARMAP "A", TILE_CH_A
CHARMAP "B", TILE_CH_B
CHARMAP "C", TILE_CH_C
CHARMAP "D", TILE_CH_D
CHARMAP "E", TILE_CH_E
CHARMAP "F", TILE_CH_F
CHARMAP "G", TILE_CH_G
CHARMAP "H", TILE_CH_H
CHARMAP "I", TILE_CH_I
CHARMAP "J", TILE_CH_J
CHARMAP "K", TILE_CH_K
CHARMAP "L", TILE_CH_L
CHARMAP "M", TILE_CH_M
CHARMAP "N", TILE_CH_N
CHARMAP "O", TILE_CH_O
CHARMAP "P", TILE_CH_P
CHARMAP "Q", TILE_CH_Q
CHARMAP "R", TILE_CH_R
CHARMAP "S", TILE_CH_S
CHARMAP "T", TILE_CH_T
CHARMAP "U", TILE_CH_U
CHARMAP "V", TILE_CH_V
CHARMAP "W", TILE_CH_W
CHARMAP "X", TILE_CH_X
CHARMAP "Y", TILE_CH_Y
CHARMAP "Z", TILE_CH_Z
CHARMAP "0", TILE_CH_0
CHARMAP "1", TILE_CH_1
CHARMAP "2", TILE_CH_2
CHARMAP "3", TILE_CH_3
CHARMAP "4", TILE_CH_4
CHARMAP "5", TILE_CH_5
CHARMAP "6", TILE_CH_6
CHARMAP "7", TILE_CH_7
CHARMAP "8", TILE_CH_8
CHARMAP "9", TILE_CH_9
CHARMAP ":", TILE_COLON
CHARMAP "-", TILE_DASH
CHARMAP "!", TILE_BANG
CHARMAP ".", TILE_DOT_
CHARMAP "'", TILE_QUOTE
CHARMAP "?", TILE_QMARK
CHARMAP "/", TILE_SLASH
CHARMAP "<", TILE_LT
CHARMAP ">", TILE_GT

SECTION "Tiles", ROM0
Tiles:
    ; 0: BLANK
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    ; 1: LIGHT
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    ; 2: DARK
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    ; 3: CH_A
    dw `00333000
    dw `03000300
    dw `03000300
    dw `03333300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00000000
    ; 4: CH_B
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `00000000
    ; 5: CH_C
    dw `00333000
    dw `03000300
    dw `03000000
    dw `03000000
    dw `03000000
    dw `03000300
    dw `00333000
    dw `00000000
    ; 6: CH_D
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03333000
    dw `00000000
    ; 7: CH_E
    dw `03333300
    dw `03000000
    dw `03000000
    dw `03333000
    dw `03000000
    dw `03000000
    dw `03333300
    dw `00000000
    ; 8: CH_F
    dw `03333300
    dw `03000000
    dw `03000000
    dw `03333000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `00000000
    ; 9: CH_G
    dw `00333000
    dw `03000300
    dw `03000000
    dw `03033300
    dw `03000300
    dw `03000300
    dw `00333300
    dw `00000000
    ; 10: CH_H
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03333300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00000000
    ; 11: CH_I
    dw `00333000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00333000
    dw `00000000
    ; 12: CH_J
    dw `00033300
    dw `00003000
    dw `00003000
    dw `00003000
    dw `00003000
    dw `03003000
    dw `00330000
    dw `00000000
    ; 13: CH_K
    dw `03000300
    dw `03003000
    dw `03030000
    dw `03300000
    dw `03030000
    dw `03003000
    dw `03000300
    dw `00000000
    ; 14: CH_L
    dw `03000000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `03333300
    dw `00000000
    ; 15: CH_M
    dw `03000300
    dw `03303300
    dw `03030300
    dw `03030300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00000000
    ; 16: CH_N
    dw `03000300
    dw `03000300
    dw `03300300
    dw `03030300
    dw `03003300
    dw `03000300
    dw `03000300
    dw `00000000
    ; 17: CH_O
    dw `00333000
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 18: CH_P
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `03000000
    dw `03000000
    dw `03000000
    dw `00000000
    ; 19: CH_Q
    dw `00333000
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03030300
    dw `03003000
    dw `00330300
    dw `00000000
    ; 20: CH_R
    dw `03333000
    dw `03000300
    dw `03000300
    dw `03333000
    dw `03030000
    dw `03003000
    dw `03000300
    dw `00000000
    ; 21: CH_S
    dw `00333300
    dw `03000000
    dw `03000000
    dw `00333000
    dw `00000300
    dw `00000300
    dw `03333000
    dw `00000000
    ; 22: CH_T
    dw `03333300
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00000000
    ; 23: CH_U
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 24: CH_V
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03000300
    dw `00303000
    dw `00030000
    dw `00000000
    ; 25: CH_W
    dw `03000300
    dw `03000300
    dw `03000300
    dw `03030300
    dw `03030300
    dw `03030300
    dw `00303000
    dw `00000000
    ; 26: CH_X
    dw `03000300
    dw `03000300
    dw `00303000
    dw `00030000
    dw `00303000
    dw `03000300
    dw `03000300
    dw `00000000
    ; 27: CH_Y
    dw `03000300
    dw `03000300
    dw `00303000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00000000
    ; 28: CH_Z
    dw `03333300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `03000000
    dw `03333300
    dw `00000000
    ; 29: CH_0
    dw `00333000
    dw `03000300
    dw `03003300
    dw `03030300
    dw `03300300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 30: CH_1
    dw `00030000
    dw `00330000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00333000
    dw `00000000
    ; 31: CH_2
    dw `00333000
    dw `03000300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `03333300
    dw `00000000
    ; 32: CH_3
    dw `03333300
    dw `00003000
    dw `00030000
    dw `00003000
    dw `00000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 33: CH_4
    dw `00003000
    dw `00033000
    dw `00303000
    dw `03003000
    dw `03333300
    dw `00003000
    dw `00003000
    dw `00000000
    ; 34: CH_5
    dw `03333300
    dw `03000000
    dw `03333000
    dw `00000300
    dw `00000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 35: CH_6
    dw `00033000
    dw `00300000
    dw `03000000
    dw `03333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 36: CH_7
    dw `03333300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `00300000
    dw `00300000
    dw `00000000
    ; 37: CH_8
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333000
    dw `00000000
    ; 38: CH_9
    dw `00333000
    dw `03000300
    dw `03000300
    dw `00333300
    dw `00000300
    dw `00003000
    dw `00330000
    dw `00000000
    ; 39: COLON
    dw `00000000
    dw `00030000
    dw `00030000
    dw `00000000
    dw `00030000
    dw `00030000
    dw `00000000
    dw `00000000
    ; 40: DASH
    dw `00000000
    dw `00000000
    dw `00000000
    dw `03333300
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    ; 41: BANG
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00030000
    dw `00000000
    dw `00030000
    dw `00000000
    ; 42: DOT_
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00330000
    dw `00330000
    dw `00000000
    ; 43: QUOTE
    dw `00030000
    dw `00030000
    dw `00300000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    dw `00000000
    ; 44: QMARK
    dw `00333000
    dw `03000300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00000000
    dw `00030000
    dw `00000000
    ; 45: SLASH
    dw `00000300
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `03000000
    dw `03000000
    dw `00000000
    ; 46: LT
    dw `00003000
    dw `00030000
    dw `00300000
    dw `03000000
    dw `00300000
    dw `00030000
    dw `00003000
    dw `00000000
    ; 47: GT
    dw `00300000
    dw `00030000
    dw `00003000
    dw `00000300
    dw `00003000
    dw `00030000
    dw `00300000
    dw `00000000
    ; 48: INV_0
    dw `33000333
    dw `30333033
    dw `30330033
    dw `30303033
    dw `30033033
    dw `30333033
    dw `33000333
    dw `33333333
    ; 49: INV_1
    dw `33303333
    dw `33003333
    dw `33303333
    dw `33303333
    dw `33303333
    dw `33303333
    dw `33000333
    dw `33333333
    ; 50: INV_2
    dw `33000333
    dw `30333033
    dw `33333033
    dw `33330333
    dw `33303333
    dw `33033333
    dw `30000033
    dw `33333333
    ; 51: INV_3
    dw `30000033
    dw `33330333
    dw `33303333
    dw `33330333
    dw `33333033
    dw `30333033
    dw `33000333
    dw `33333333
    ; 52: INV_4
    dw `33330333
    dw `33300333
    dw `33030333
    dw `30330333
    dw `30000033
    dw `33330333
    dw `33330333
    dw `33333333
    ; 53: INV_5
    dw `30000033
    dw `30333333
    dw `30000333
    dw `33333033
    dw `33333033
    dw `30333033
    dw `33000333
    dw `33333333
    ; 54: INV_6
    dw `33300333
    dw `33033333
    dw `30333333
    dw `30000333
    dw `30333033
    dw `30333033
    dw `33000333
    dw `33333333
    ; 55: INV_7
    dw `30000033
    dw `33333033
    dw `33330333
    dw `33303333
    dw `33033333
    dw `33033333
    dw `33033333
    dw `33333333
    ; 56: INV_8
    dw `33000333
    dw `30333033
    dw `30333033
    dw `33000333
    dw `30333033
    dw `30333033
    dw `33000333
    dw `33333333
    ; 57: INV_9
    dw `33000333
    dw `30333033
    dw `30333033
    dw `33000033
    dw `33333033
    dw `33330333
    dw `33003333
    dw `33333333
    ; 58: INV_COLON
    dw `33333333
    dw `33303333
    dw `33303333
    dw `33333333
    dw `33303333
    dw `33303333
    dw `33333333
    dw `33333333
    ; 59: INV_BLANK
    dw `33333333
    dw `33333333
    dw `33333333
    dw `33333333
    dw `33333333
    dw `33333333
    dw `33333333
    dw `33333333
    ; 60: PAWN white on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111133
    dw `11111300
    dw `11113000
    dw `11113000
    ; 61: PAWN white on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `31111111
    dw `03111111
    dw `00311111
    dw `00311111
    ; 62: PAWN white on light 2
    dw `11111300
    dw `11111130
    dw `11111300
    dw `11113000
    dw `11130000
    dw `11133333
    dw `11111111
    dw `11111111
    ; 63: PAWN white on light 3
    dw `03111111
    dw `31111111
    dw `03111111
    dw `00311111
    dw `00031111
    dw `33331111
    dw `11111111
    dw `11111111
    ; 64: PAWN white on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222233
    dw `22222300
    dw `22223000
    dw `22223000
    ; 65: PAWN white on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `32222222
    dw `03222222
    dw `00322222
    dw `00322222
    ; 66: PAWN white on dark 2
    dw `22222300
    dw `22222230
    dw `22222300
    dw `22223000
    dw `22230000
    dw `22233333
    dw `22222222
    dw `22222222
    ; 67: PAWN white on dark 3
    dw `03222222
    dw `32222222
    dw `03222222
    dw `00322222
    dw `00032222
    dw `33332222
    dw `22222222
    dw `22222222
    ; 68: PAWN black on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111133
    dw `11111333
    dw `11113333
    dw `11113333
    ; 69: PAWN black on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `31111111
    dw `33111111
    dw `33311111
    dw `33311111
    ; 70: PAWN black on light 2
    dw `11111333
    dw `11111133
    dw `11111333
    dw `11113333
    dw `11133333
    dw `11133333
    dw `11111111
    dw `11111111
    ; 71: PAWN black on light 3
    dw `33111111
    dw `31111111
    dw `33111111
    dw `33311111
    dw `33331111
    dw `33331111
    dw `11111111
    dw `11111111
    ; 72: PAWN black on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222233
    dw `22222333
    dw `22223333
    dw `22223333
    ; 73: PAWN black on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `32222222
    dw `33222222
    dw `33322222
    dw `33322222
    ; 74: PAWN black on dark 2
    dw `22222333
    dw `22222233
    dw `22222333
    dw `22223333
    dw `22233333
    dw `22233333
    dw `22222222
    dw `22222222
    ; 75: PAWN black on dark 3
    dw `33222222
    dw `32222222
    dw `33222222
    dw `33322222
    dw `33332222
    dw `33332222
    dw `22222222
    dw `22222222
    ; 76: KNIGHT white on light 0
    dw `11111111
    dw `11111111
    dw `11111133
    dw `11111300
    dw `11113000
    dw `11130030
    dw `11300000
    dw `13000000
    ; 77: KNIGHT white on light 1
    dw `11111111
    dw `11111111
    dw `13111111
    dw `30311111
    dw `00031111
    dw `00003111
    dw `00003111
    dw `00003111
    ; 78: KNIGHT white on light 2
    dw `13000330
    dw `11333130
    dw `11111300
    dw `11113000
    dw `11130000
    dw `11133333
    dw `11111111
    dw `11111111
    ; 79: KNIGHT white on light 3
    dw `00003111
    dw `00003111
    dw `00003111
    dw `00003111
    dw `00000311
    dw `33333311
    dw `11111111
    dw `11111111
    ; 80: KNIGHT white on dark 0
    dw `22222222
    dw `22222222
    dw `22222233
    dw `22222300
    dw `22223000
    dw `22230030
    dw `22300000
    dw `23000000
    ; 81: KNIGHT white on dark 1
    dw `22222222
    dw `22222222
    dw `23222222
    dw `30322222
    dw `00032222
    dw `00003222
    dw `00003222
    dw `00003222
    ; 82: KNIGHT white on dark 2
    dw `23000330
    dw `22333230
    dw `22222300
    dw `22223000
    dw `22230000
    dw `22233333
    dw `22222222
    dw `22222222
    ; 83: KNIGHT white on dark 3
    dw `00003222
    dw `00003222
    dw `00003222
    dw `00003222
    dw `00000322
    dw `33333322
    dw `22222222
    dw `22222222
    ; 84: KNIGHT black on light 0
    dw `11111111
    dw `11111111
    dw `11111133
    dw `11111333
    dw `11113333
    dw `11133313
    dw `11333333
    dw `13333333
    ; 85: KNIGHT black on light 1
    dw `11111111
    dw `11111111
    dw `13111111
    dw `33311111
    dw `33331111
    dw `33333111
    dw `33333111
    dw `33333111
    ; 86: KNIGHT black on light 2
    dw `13333313
    dw `11333133
    dw `11111333
    dw `11113333
    dw `11133333
    dw `11133333
    dw `11111111
    dw `11111111
    ; 87: KNIGHT black on light 3
    dw `33333111
    dw `33333111
    dw `33333111
    dw `33333111
    dw `33333311
    dw `33333311
    dw `11111111
    dw `11111111
    ; 88: KNIGHT black on dark 0
    dw `22222222
    dw `22222222
    dw `22222233
    dw `22222333
    dw `22223333
    dw `22233313
    dw `22333333
    dw `23333333
    ; 89: KNIGHT black on dark 1
    dw `22222222
    dw `22222222
    dw `23222222
    dw `33322222
    dw `33332222
    dw `33333222
    dw `33333222
    dw `33333222
    ; 90: KNIGHT black on dark 2
    dw `23333313
    dw `22333233
    dw `22222333
    dw `22223333
    dw `22233333
    dw `22233333
    dw `22222222
    dw `22222222
    ; 91: KNIGHT black on dark 3
    dw `33333222
    dw `33333222
    dw `33333222
    dw `33333222
    dw `33333322
    dw `33333322
    dw `22222222
    dw `22222222
    ; 92: BISHOP white on light 0
    dw `11111111
    dw `11111113
    dw `11111130
    dw `11111300
    dw `11113003
    dw `11113030
    dw `11113000
    dw `11111300
    ; 93: BISHOP white on light 1
    dw `11111111
    dw `11111111
    dw `31111111
    dw `03111111
    dw `00311111
    dw `00311111
    dw `00311111
    dw `03111111
    ; 94: BISHOP white on light 2
    dw `11111130
    dw `11111300
    dw `11113000
    dw `11130000
    dw `11300000
    dw `11333333
    dw `11111111
    dw `11111111
    ; 95: BISHOP white on light 3
    dw `31111111
    dw `03111111
    dw `00311111
    dw `00031111
    dw `00003111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 96: BISHOP white on dark 0
    dw `22222222
    dw `22222223
    dw `22222230
    dw `22222300
    dw `22223003
    dw `22223030
    dw `22223000
    dw `22222300
    ; 97: BISHOP white on dark 1
    dw `22222222
    dw `22222222
    dw `32222222
    dw `03222222
    dw `00322222
    dw `00322222
    dw `00322222
    dw `03222222
    ; 98: BISHOP white on dark 2
    dw `22222230
    dw `22222300
    dw `22223000
    dw `22230000
    dw `22300000
    dw `22333333
    dw `22222222
    dw `22222222
    ; 99: BISHOP white on dark 3
    dw `32222222
    dw `03222222
    dw `00322222
    dw `00032222
    dw `00003222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 100: BISHOP black on light 0
    dw `11111111
    dw `11111113
    dw `11111133
    dw `11111333
    dw `11113331
    dw `11113313
    dw `11113333
    dw `11111333
    ; 101: BISHOP black on light 1
    dw `11111111
    dw `11111111
    dw `31111111
    dw `33111111
    dw `33311111
    dw `33311111
    dw `33311111
    dw `33111111
    ; 102: BISHOP black on light 2
    dw `11111133
    dw `11111333
    dw `11113333
    dw `11133333
    dw `11333333
    dw `11333333
    dw `11111111
    dw `11111111
    ; 103: BISHOP black on light 3
    dw `31111111
    dw `33111111
    dw `33311111
    dw `33331111
    dw `33333111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 104: BISHOP black on dark 0
    dw `22222222
    dw `22222223
    dw `22222233
    dw `22222333
    dw `22223331
    dw `22223313
    dw `22223333
    dw `22222333
    ; 105: BISHOP black on dark 1
    dw `22222222
    dw `22222222
    dw `32222222
    dw `33222222
    dw `33322222
    dw `33322222
    dw `33322222
    dw `33222222
    ; 106: BISHOP black on dark 2
    dw `22222233
    dw `22222333
    dw `22223333
    dw `22233333
    dw `22333333
    dw `22333333
    dw `22222222
    dw `22222222
    ; 107: BISHOP black on dark 3
    dw `32222222
    dw `33222222
    dw `33322222
    dw `33332222
    dw `33333222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 108: ROOK white on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11333133
    dw `11303330
    dw `11300000
    dw `11130000
    dw `11130000
    ; 109: ROOK white on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `31333111
    dw `33303111
    dw `00003111
    dw `00031111
    dw `00031111
    ; 110: ROOK white on light 2
    dw `11130000
    dw `11130000
    dw `11130000
    dw `11300000
    dw `13000000
    dw `13333333
    dw `11111111
    dw `11111111
    ; 111: ROOK white on light 3
    dw `00031111
    dw `00031111
    dw `00031111
    dw `00003111
    dw `00000311
    dw `33333311
    dw `11111111
    dw `11111111
    ; 112: ROOK white on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22333233
    dw `22303330
    dw `22300000
    dw `22230000
    dw `22230000
    ; 113: ROOK white on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `32333222
    dw `33303222
    dw `00003222
    dw `00032222
    dw `00032222
    ; 114: ROOK white on dark 2
    dw `22230000
    dw `22230000
    dw `22230000
    dw `22300000
    dw `23000000
    dw `23333333
    dw `22222222
    dw `22222222
    ; 115: ROOK white on dark 3
    dw `00032222
    dw `00032222
    dw `00032222
    dw `00003222
    dw `00000322
    dw `33333322
    dw `22222222
    dw `22222222
    ; 116: ROOK black on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11333133
    dw `11331313
    dw `11333333
    dw `11133333
    dw `11133333
    ; 117: ROOK black on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `31333111
    dw `13133111
    dw `33333111
    dw `33331111
    dw `33331111
    ; 118: ROOK black on light 2
    dw `11133333
    dw `11133333
    dw `11133333
    dw `11333333
    dw `13333333
    dw `13333333
    dw `11111111
    dw `11111111
    ; 119: ROOK black on light 3
    dw `33331111
    dw `33331111
    dw `33331111
    dw `33333111
    dw `33333311
    dw `33333311
    dw `11111111
    dw `11111111
    ; 120: ROOK black on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22333233
    dw `22331313
    dw `22333333
    dw `22233333
    dw `22233333
    ; 121: ROOK black on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `32333222
    dw `13133222
    dw `33333222
    dw `33332222
    dw `33332222
    ; 122: ROOK black on dark 2
    dw `22233333
    dw `22233333
    dw `22233333
    dw `22333333
    dw `23333333
    dw `23333333
    dw `22222222
    dw `22222222
    ; 123: ROOK black on dark 3
    dw `33332222
    dw `33332222
    dw `33332222
    dw `33333222
    dw `33333322
    dw `33333322
    dw `22222222
    dw `22222222
    ; 124: QUEEN white on light 0
    dw `11111111
    dw `11131113
    dw `11303130
    dw `11300300
    dw `11300000
    dw `11130000
    dw `11113000
    dw `11113000
    ; 125: QUEEN white on light 1
    dw `11111111
    dw `11131111
    dw `31303111
    dw `03003111
    dw `00003111
    dw `00031111
    dw `00311111
    dw `00311111
    ; 126: QUEEN white on light 2
    dw `11111300
    dw `11111300
    dw `11113000
    dw `11130000
    dw `11300000
    dw `11333333
    dw `11111111
    dw `11111111
    ; 127: QUEEN white on light 3
    dw `03111111
    dw `03111111
    dw `00311111
    dw `00031111
    dw `00003111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 128: QUEEN white on dark 0
    dw `22222222
    dw `22232223
    dw `22303230
    dw `22300300
    dw `22300000
    dw `22230000
    dw `22223000
    dw `22223000
    ; 129: QUEEN white on dark 1
    dw `22222222
    dw `22232222
    dw `32303222
    dw `03003222
    dw `00003222
    dw `00032222
    dw `00322222
    dw `00322222
    ; 130: QUEEN white on dark 2
    dw `22222300
    dw `22222300
    dw `22223000
    dw `22230000
    dw `22300000
    dw `22333333
    dw `22222222
    dw `22222222
    ; 131: QUEEN white on dark 3
    dw `03222222
    dw `03222222
    dw `00322222
    dw `00032222
    dw `00003222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 132: QUEEN black on light 0
    dw `11111111
    dw `11131113
    dw `11333133
    dw `11333333
    dw `11333333
    dw `11133333
    dw `11113333
    dw `11113333
    ; 133: QUEEN black on light 1
    dw `11111111
    dw `11131111
    dw `31333111
    dw `33333111
    dw `33333111
    dw `33331111
    dw `33311111
    dw `33311111
    ; 134: QUEEN black on light 2
    dw `11111333
    dw `11111333
    dw `11113333
    dw `11133333
    dw `11333333
    dw `11333333
    dw `11111111
    dw `11111111
    ; 135: QUEEN black on light 3
    dw `33111111
    dw `33111111
    dw `33311111
    dw `33331111
    dw `33333111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 136: QUEEN black on dark 0
    dw `22222222
    dw `22232223
    dw `22333233
    dw `22333333
    dw `22333333
    dw `22233333
    dw `22223333
    dw `22223333
    ; 137: QUEEN black on dark 1
    dw `22222222
    dw `22232222
    dw `32333222
    dw `33333222
    dw `33333222
    dw `33332222
    dw `33322222
    dw `33322222
    ; 138: QUEEN black on dark 2
    dw `22222333
    dw `22222333
    dw `22223333
    dw `22233333
    dw `22333333
    dw `22333333
    dw `22222222
    dw `22222222
    ; 139: QUEEN black on dark 3
    dw `33222222
    dw `33222222
    dw `33322222
    dw `33332222
    dw `33333222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 140: KING white on light 0
    dw `11111111
    dw `11111113
    dw `11111133
    dw `11111113
    dw `11133313
    dw `11300033
    dw `11300003
    dw `11300000
    ; 141: KING white on light 1
    dw `11111111
    dw `11111111
    dw `31111111
    dw `11111111
    dw `13331111
    dw `30003111
    dw `00003111
    dw `00003111
    ; 142: KING white on light 2
    dw `11130000
    dw `11113000
    dw `11113000
    dw `11130000
    dw `11300000
    dw `11333333
    dw `11111111
    dw `11111111
    ; 143: KING white on light 3
    dw `00031111
    dw `00311111
    dw `00311111
    dw `00031111
    dw `00003111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 144: KING white on dark 0
    dw `22222222
    dw `22222223
    dw `22222233
    dw `22222223
    dw `22233323
    dw `22300033
    dw `22300003
    dw `22300000
    ; 145: KING white on dark 1
    dw `22222222
    dw `22222222
    dw `32222222
    dw `22222222
    dw `23332222
    dw `30003222
    dw `00003222
    dw `00003222
    ; 146: KING white on dark 2
    dw `22230000
    dw `22223000
    dw `22223000
    dw `22230000
    dw `22300000
    dw `22333333
    dw `22222222
    dw `22222222
    ; 147: KING white on dark 3
    dw `00032222
    dw `00322222
    dw `00322222
    dw `00032222
    dw `00003222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 148: KING black on light 0
    dw `11111111
    dw `11111113
    dw `11111131
    dw `11111113
    dw `11133313
    dw `11333331
    dw `11333331
    dw `11333333
    ; 149: KING black on light 1
    dw `11111111
    dw `11111111
    dw `31111111
    dw `11111111
    dw `13331111
    dw `33333111
    dw `33333111
    dw `33333111
    ; 150: KING black on light 2
    dw `11133333
    dw `11113333
    dw `11113333
    dw `11133333
    dw `11333333
    dw `11333333
    dw `11111111
    dw `11111111
    ; 151: KING black on light 3
    dw `33331111
    dw `33311111
    dw `33311111
    dw `33331111
    dw `33333111
    dw `33333111
    dw `11111111
    dw `11111111
    ; 152: KING black on dark 0
    dw `22222222
    dw `22222223
    dw `22222231
    dw `22222223
    dw `22233323
    dw `22333331
    dw `22333331
    dw `22333333
    ; 153: KING black on dark 1
    dw `22222222
    dw `22222222
    dw `32222222
    dw `22222222
    dw `23332222
    dw `33333222
    dw `33333222
    dw `33333222
    ; 154: KING black on dark 2
    dw `22233333
    dw `22223333
    dw `22223333
    dw `22233333
    dw `22333333
    dw `22333333
    dw `22222222
    dw `22222222
    ; 155: KING black on dark 3
    dw `33332222
    dw `33322222
    dw `33322222
    dw `33332222
    dw `33333222
    dw `33333222
    dw `22222222
    dw `22222222
    ; 156: SPR_CORNER
    dw `22222200
    dw `21111200
    dw `21222200
    dw `21200000
    dw `21200000
    dw `22200000
    dw `00000000
    dw `00000000
    ; 157: SPR_DOT
    dw `00000000
    dw `00222200
    dw `02111120
    dw `02111120
    dw `02111120
    dw `02111120
    dw `00222200
    dw `00000000
    ; 158: SPR_MARK
    dw `22222000
    dw `21120000
    dw `21200000
    dw `22000000
    dw `20000000
    dw `00000000
    dw `00000000
    dw `00000000
TilesEnd:
