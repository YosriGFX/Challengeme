; The Game Boy registers this template uses. Pan Docs (https://gbdev.io/pandocs/) has
; every register; add the ones you need here with the same names.

; Joypad: write $20 to read the d-pad, $10 for the buttons (0 = pressed).
DEF rP1   EQU $FF00
; Link cable: SB holds the byte, SC starts a transfer.
;   SC = $81: this Game Boy is master (sends now, using its own clock)
;   SC = $80: this Game Boy waits for the other side's clock (slave)
;   SC bit 7 goes back to 0 when the byte has been swapped.
DEF rSB   EQU $FF01
DEF rSC   EQU $FF02
DEF rDIV  EQU $FF04
DEF rIF   EQU $FF0F
; Sound
DEF rNR10 EQU $FF10
DEF rNR11 EQU $FF11
DEF rNR12 EQU $FF12
DEF rNR13 EQU $FF13
DEF rNR14 EQU $FF14
DEF rNR50 EQU $FF24
DEF rNR51 EQU $FF25
DEF rNR52 EQU $FF26
; Screen
DEF rLCDC EQU $FF40
DEF rSTAT EQU $FF41
DEF rSCY  EQU $FF42
DEF rSCX  EQU $FF43
DEF rLY   EQU $FF44
DEF rBGP  EQU $FF47
DEF rOBP0 EQU $FF48
DEF rOBP1 EQU $FF49
DEF rIE   EQU $FFFF

DEF LCDC_ON    EQU %10010011       ; LCD on, tiles at $8000, BG map $9800, sprites 8x8 on, BG on
DEF IE_VBLANK  EQU %00000001

DEF _VRAM  EQU $8000               ; tile data
DEF _SCRN0 EQU $9800               ; background map, 32 x 32 tiles
DEF _OAM   EQU $FE00               ; 40 sprites x 4 bytes: Y+16, X+8, tile, attributes

; Joypad bits as ReadJoypad returns them (1 = held)
DEF PAD_A      EQU %00000001
DEF PAD_B      EQU %00000010
DEF PAD_SELECT EQU %00000100
DEF PAD_START  EQU %00001000
DEF PAD_RIGHT  EQU %00010000
DEF PAD_LEFT   EQU %00100000
DEF PAD_UP     EQU %01000000
DEF PAD_DOWN   EQU %10000000

DEF rDMA  EQU $FF46                ; OAM DMA: write the high byte of a 160-byte table
DEF rNR21 EQU $FF16
DEF rNR22 EQU $FF17
DEF rNR23 EQU $FF18
DEF rNR24 EQU $FF19
DEF rNR41 EQU $FF20
DEF rNR42 EQU $FF21
DEF rNR43 EQU $FF22
DEF rNR44 EQU $FF23

; Added for Belote: the serial interrupt (4-Player Adapter)
DEF IE_SERIAL EQU %00001000
