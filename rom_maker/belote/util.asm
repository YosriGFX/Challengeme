; ---------------------------------------------------------------------------- drawing
; Compares wWant with wShown (all 18 rows, from where it stopped last time) and queues
; up to QUEUE_LEN changed tiles for VBlankIsr; the rest wait for the next frame.
DEF DIFF_ROWS EQU 18
BuildQueue:
    ld a, LOW(wQueue)
    ldh [hQ], a
    ld a, HIGH(wQueue)
    ldh [hQ + 1], a
    ld b, QUEUE_LEN
    ld a, DIFF_ROWS
    ldh [hRows], a
.row:
    ld a, [wDiffRow]
    ld l, a
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld de, wWant
    add hl, de                     ; hl = wanted row
    ld d, h
    ld e, l
    set 2, d                       ; de = shown row
    ld c, 20
.col:
    ld a, [de]
    cp [hl]
    jr nz, .diff
.nextCol:
    inc e
    inc l
    dec c
    jr nz, .col
    ld a, [wDiffRow]
    inc a
    cp 18
    jr c, .nextRow
    xor a
.nextRow:
    ld [wDiffRow], a
    ldh a, [hRows]
    dec a
    ldh [hRows], a
    jr nz, .row
    jr .pad
.diff:
    ld a, b
    and a
    jr z, .pad                     ; queue full: this row again next frame
    dec b
    ld a, [hl]
    ld [de], a
    push de
    push af
    ldh a, [hQ]
    ld e, a
    ldh a, [hQ + 1]
    ld d, a
    ld a, l                        ; VRAM address, tile
    ld [de], a
    inc de
    ld a, h
    sub HIGH(wWant) - HIGH(_SCRN0)
    ld [de], a
    inc de
    pop af
    ld [de], a
    inc de
    ld a, e
    ldh [hQ], a
    ld a, d
    ldh [hQ + 1], a
    pop de
    jr .nextCol
.pad:
    ldh a, [hQ]                    ; unused entries: a map row nobody sees
    ld e, a
    ldh a, [hQ + 1]
    ld d, a
.padLoop:
    ld a, b
    and a
    ret z
    ld a, LOW(DUMMY_VRAM)
    ld [de], a
    inc de
    ld a, HIGH(DUMMY_VRAM)
    ld [de], a
    inc de
    ld a, TILE_BLANK
    ld [de], a
    inc de
    dec b
    jr .padLoop

ClearQueue:
    ld de, wQueue
    ld b, QUEUE_LEN
    jr BuildQueue.padLoop


; ---------------------------------------------------------------------------- sound
PlaySound:
    ld a, [wSound]
    and a
    ret z
    ld b, a
    xor a
    ld [wSound], a
    ld a, b
    cp SND_TURN
    jr z, .turn
    cp SND_CALL
    jr z, .call
    cp SND_DEAL
    jr z, .deal
    cp SND_NO
    jr z, .no
    ld a, $1A                      ; a card: a short noise tap on channel 4
    ldh [rNR41], a
    ld a, $A1
    ldh [rNR42], a
    ld a, $33
    ldh [rNR43], a
    ld a, $C0
    ldh [rNR44], a
    ret
.turn:
    ld a, $80                      ; my turn: two quick beeps' worth of a high tone
    ldh [rNR21], a
    ld a, $C2
    ldh [rNR22], a
    ld a, $83
    ldh [rNR23], a
    ld a, $87
    ldh [rNR24], a
    ret
.call:
    ld a, $80                      ; contre, capot, belote: a higher, longer tone
    ldh [rNR21], a
    ld a, $F4
    ldh [rNR22], a
    ld a, $C1
    ldh [rNR23], a
    ld a, $87
    ldh [rNR24], a
    ret
.deal:
    ld a, $35                      ; the deal is over: a falling tone on channel 1
    ldh [rNR10], a
    ld a, $80
    ldh [rNR11], a
    ld a, $F5
    ldh [rNR12], a
    ld a, $00
    ldh [rNR13], a
    ld a, $87
    ldh [rNR14], a
    ret
.no:
    xor a                          ; may not: a low buzz
    ldh [rNR10], a
    ld a, $00
    ldh [rNR11], a
    ld a, $A1
    ldh [rNR12], a
    ld a, $00
    ldh [rNR13], a
    ld a, $83
    ldh [rNR14], a
    ret

; ---------------------------------------------------------------------------- helpers
LcdOff:
    ldh a, [rLY]
    cp 144
    jr c, LcdOff
    xor a
    ldh [rLCDC], a
    ret

; Returns the buttons held in a (PAD_* bits, 1 = held).
ReadJoypad:
    ld a, $20
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    swap a
    ld b, a
    ld a, $10
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    or b
    ld b, a
    ld a, $30
    ldh [rP1], a
    ld a, b
    ret

; Copies bc bytes from hl to de.
Copy:
    ld a, [hl+]
    ld [de], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, Copy
    ret

; Writes a to bc bytes from hl.
Fill:
    ld d, a
.loop:
    ld a, d
    ld [hl+], a
    dec bc
    ld a, b
    or c
    jr nz, .loop
    ld a, d
    ret

; The standard OAM DMA routine, copied to HRAM (hDma) at start: the translator knows it.
DmaRoutine:
    ld a, HIGH(wOAM)
    ldh [rDMA], a
    ld a, 40
.wait:
    dec a
    jr nz, .wait
    ret
DmaRoutineEnd:

