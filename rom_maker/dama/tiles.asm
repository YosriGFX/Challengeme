; Dama's tiles, written by make_tiles.py (edit that, not this). 2 bits per pixel as
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
DEF TILE_SPR_CORNER EQU 92
DEF TILE_SPR_DOT EQU 93
DEF TILE_SPR_MARK EQU 94
DEF TILE_COUNT EQU 95

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
    ; 60: MAN white on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11113333
    dw `11330000
    dw `13000000
    dw `13000000
    ; 61: MAN white on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `33331111
    dw `00003311
    dw `00000031
    dw `00000031
    ; 62: MAN white on light 2
    dw `13200000
    dw `13022222
    dw `13000000
    dw `11330000
    dw `11113333
    dw `11111111
    dw `11111111
    dw `11111111
    ; 63: MAN white on light 3
    dw `00000231
    dw `22222031
    dw `00000031
    dw `00003311
    dw `33331111
    dw `11111111
    dw `11111111
    dw `11111111
    ; 64: MAN white on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22223333
    dw `22330000
    dw `23000000
    dw `23000000
    ; 65: MAN white on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `33332222
    dw `00003322
    dw `00000032
    dw `00000032
    ; 66: MAN white on dark 2
    dw `23200000
    dw `23022222
    dw `23000000
    dw `22330000
    dw `22223333
    dw `22222222
    dw `22222222
    dw `22222222
    ; 67: MAN white on dark 3
    dw `00000232
    dw `22222032
    dw `00000032
    dw `00003322
    dw `33332222
    dw `22222222
    dw `22222222
    dw `22222222
    ; 68: MAN black on light 0
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11113333
    dw `11333333
    dw `13333333
    dw `13333333
    ; 69: MAN black on light 1
    dw `11111111
    dw `11111111
    dw `11111111
    dw `11111111
    dw `33331111
    dw `33333311
    dw `33333331
    dw `33333331
    ; 70: MAN black on light 2
    dw `13133333
    dw `13311111
    dw `13333333
    dw `11333333
    dw `11113333
    dw `11111111
    dw `11111111
    dw `11111111
    ; 71: MAN black on light 3
    dw `33333131
    dw `11111331
    dw `33333331
    dw `33333311
    dw `33331111
    dw `11111111
    dw `11111111
    dw `11111111
    ; 72: MAN black on dark 0
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22223333
    dw `22333333
    dw `23333333
    dw `23333333
    ; 73: MAN black on dark 1
    dw `22222222
    dw `22222222
    dw `22222222
    dw `22222222
    dw `33332222
    dw `33333322
    dw `33333332
    dw `33333332
    ; 74: MAN black on dark 2
    dw `23133333
    dw `23311111
    dw `23333333
    dw `22333333
    dw `22223333
    dw `22222222
    dw `22222222
    dw `22222222
    ; 75: MAN black on dark 3
    dw `33333132
    dw `11111332
    dw `33333332
    dw `33333322
    dw `33332222
    dw `22222222
    dw `22222222
    dw `22222222
    ; 76: KING white on light 0
    dw `11111111
    dw `11113333
    dw `11330000
    dw `13000000
    dw `13000000
    dw `13200000
    dw `13022222
    dw `13000000
    ; 77: KING white on light 1
    dw `11111111
    dw `33331111
    dw `00003311
    dw `00000031
    dw `00000031
    dw `00000231
    dw `22222031
    dw `00000031
    ; 78: KING white on light 2
    dw `13233000
    dw `13022222
    dw `13000000
    dw `11330000
    dw `11113333
    dw `11111111
    dw `11111111
    dw `11111111
    ; 79: KING white on light 3
    dw `00033231
    dw `22222031
    dw `00000031
    dw `00003311
    dw `33331111
    dw `11111111
    dw `11111111
    dw `11111111
    ; 80: KING white on dark 0
    dw `22222222
    dw `22223333
    dw `22330000
    dw `23000000
    dw `23000000
    dw `23200000
    dw `23022222
    dw `23000000
    ; 81: KING white on dark 1
    dw `22222222
    dw `33332222
    dw `00003322
    dw `00000032
    dw `00000032
    dw `00000232
    dw `22222032
    dw `00000032
    ; 82: KING white on dark 2
    dw `23233000
    dw `23022222
    dw `23000000
    dw `22330000
    dw `22223333
    dw `22222222
    dw `22222222
    dw `22222222
    ; 83: KING white on dark 3
    dw `00033232
    dw `22222032
    dw `00000032
    dw `00003322
    dw `33332222
    dw `22222222
    dw `22222222
    dw `22222222
    ; 84: KING black on light 0
    dw `11111111
    dw `11113333
    dw `11333333
    dw `13333333
    dw `13333333
    dw `13133333
    dw `13311111
    dw `13333333
    ; 85: KING black on light 1
    dw `11111111
    dw `33331111
    dw `33333311
    dw `33333331
    dw `33333331
    dw `33333131
    dw `11111331
    dw `33333331
    ; 86: KING black on light 2
    dw `13133333
    dw `13311111
    dw `13333333
    dw `11333333
    dw `11113333
    dw `11111111
    dw `11111111
    dw `11111111
    ; 87: KING black on light 3
    dw `33333131
    dw `11111331
    dw `33333331
    dw `33333311
    dw `33331111
    dw `11111111
    dw `11111111
    dw `11111111
    ; 88: KING black on dark 0
    dw `22222222
    dw `22223333
    dw `22333333
    dw `23333333
    dw `23333333
    dw `23133333
    dw `23311111
    dw `23333333
    ; 89: KING black on dark 1
    dw `22222222
    dw `33332222
    dw `33333322
    dw `33333332
    dw `33333332
    dw `33333132
    dw `11111332
    dw `33333332
    ; 90: KING black on dark 2
    dw `23133333
    dw `23311111
    dw `23333333
    dw `22333333
    dw `22223333
    dw `22222222
    dw `22222222
    dw `22222222
    ; 91: KING black on dark 3
    dw `33333132
    dw `11111332
    dw `33333332
    dw `33333322
    dw `33332222
    dw `22222222
    dw `22222222
    dw `22222222
    ; 92: SPR_CORNER
    dw `22222200
    dw `21111200
    dw `21222200
    dw `21200000
    dw `21200000
    dw `22200000
    dw `00000000
    dw `00000000
    ; 93: SPR_DOT
    dw `00000000
    dw `00222200
    dw `02111120
    dw `02111120
    dw `02111120
    dw `02111120
    dw `00222200
    dw `00000000
    ; 94: SPR_MARK
    dw `22222000
    dw `21120000
    dw `21200000
    dw `22000000
    dw `20000000
    dw `00000000
    dw `00000000
    dw `00000000
TilesEnd:
