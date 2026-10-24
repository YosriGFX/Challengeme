; COIN DUEL: the example two-player game. Each player moves a square; a coin appears at
; the same place on both Game Boys; whoever touches it first wins the round; first to
; WINS_TO_MATCH wins the match.
;
; It shows everything a Challenge Me game needs (see ../ASSEMBLY.md):
; - a link handshake that decides who is player 1 (master) and player 2 (slave),
; - player 1's random seed sent to player 2, so both get the same coins,
; - both joypads swapped over the link every frame, and the whole game run from both
;   (lockstep), so both screens always agree,
; - each Game Boy's round wins kept at fixed addresses for the server ($C000, $C001),
; - a sound effect,
; - nothing the translator cannot follow: no code in RAM, no jump tables.
;
; Build, translate and test it from rom_maker/: python3 tools/build.py template

INCLUDE "hardware.inc"
INCLUDE "tiles.asm"

DEF WINS_TO_MATCH EQU 5
DEF HELLO         EQU $A5          ; player 1's first byte
DEF SPEED         EQU 2            ; pixels per frame
; Sprite coordinates of the play area (a sprite's X is screen x + 8, Y is screen y + 16)
DEF MIN_X EQU 16
DEF MAX_X EQU 152
DEF MIN_Y EQU 32
DEF MAX_Y EQU 144

; ---------------------------------------------------------------------------- RAM
; The server reads these two bytes on both Game Boys to announce rounds and the
; winner. Keep them at fixed addresses and count up by one per round won.
SECTION "Results", WRAM0[$C000]
wMyWins::    db                    ; $C000: rounds won by this Game Boy's player
wTheirWins:: db                    ; $C001: rounds won by the other player

SECTION "State", WRAM0[$C010]
wPlayer: db                        ; 1 or 2
wSeed:   dw                        ; random generator state, never 0
wMyPad:  db
wPad1:   db                        ; this frame's buttons of player 1 and player 2
wPad2:   db
wP1X:    db
wP1Y:    db
wP2X:    db
wP2Y:    db
wCoinX:  db
wCoinY:  db                        ; 0 = hidden
wScore1: db
wScore2: db
wOver:   db                        ; 1 once the match is decided

; ---------------------------------------------------------------------------- vectors
SECTION "VBlank interrupt", ROM0[$40]
    reti                           ; only wakes `halt` once a frame

SECTION "Header", ROM0[$100]
    nop
    jp Start
    ds $150 - @, 0                 ; the header: rgbfix fills it in

; ---------------------------------------------------------------------------- start
SECTION "Main", ROM0
Start:
    di
    ld sp, $E000
    call LcdOff
    ld hl, Tiles
    ld de, _VRAM
    ld bc, TilesEnd - Tiles
    call Copy
    call DrawField
    ld hl, _OAM                    ; no sprites yet
    ld bc, 160
    xor a
    call Fill
    ld hl, $C000                   ; all variables 0
    ld bc, $100
    xor a
    call Fill
    ld a, %11100100                ; shades 3 2 1 0
    ldh [rBGP], a
    ldh [rOBP0], a
    xor a
    ldh [rSCX], a
    ldh [rSCY], a
    ld a, $80                      ; sound on, both speakers, full volume
    ldh [rNR52], a
    ld a, $77
    ldh [rNR50], a
    ld a, $FF
    ldh [rNR51], a
    ld a, LCDC_ON
    ldh [rLCDC], a
    ld a, IE_VBLANK
    ldh [rIE], a
    xor a
    ldh [rIF], a
    ei

    call Handshake
    call InitGame
MainLoop:
    halt                           ; wait for the next frame
    nop
    call Draw                      ; in VBlank: sprites and scores
    call ReadJoypad
    ld [wMyPad], a
    call Exchange                  ; a = the other player's buttons
    ld b, a
    ld a, [wPlayer]
    cp 1
    ld a, [wMyPad]
    jr nz, .iAmPlayer2
    ld [wPad1], a
    ld a, b
    ld [wPad2], a
    jr .update
.iAmPlayer2:
    ld [wPad2], a
    ld a, b
    ld [wPad1], a
.update:
    call Update
    jr MainLoop

; ---------------------------------------------------------------------------- link
; Both Game Boys run this same code. Each listens on the link; the one whose player
; presses START first sends HELLO and becomes player 1 (master); the one that receives
; HELLO becomes player 2. Player 1 then sends the random seed. On the server, the
; game's `start` script presses START on Game Boy 1, so phone 1 is always player 1.
Handshake:
.listen:
    xor a                          ; what we answer if the other side says hello
    ldh [rSB], a
    ld a, $80                      ; wait for the other side's clock
    ldh [rSC], a
.wait:
    halt
    nop
    ldh a, [rSC]
    bit 7, a
    jr z, .received                ; a byte came in
    call ReadJoypad
    and PAD_START
    jr z, .wait
    xor a                          ; START: stop listening and say hello
    ldh [rSC], a
    ld a, HELLO
    ldh [rSB], a
    ld a, $81
    ldh [rSC], a
.sending:
    ldh a, [rSC]
    bit 7, a
    jr nz, .sending
    ldh a, [rSB]
    and a                          ; the other side was listening: it answered 0
    jr nz, .listen                 ; nobody ($FF), or both said hello at once: again
    ld a, 1
    ld [wPlayer], a
    halt                           ; two frames for player 2 to get ready
    nop
    halt
    nop
    ldh a, [rDIV]                  ; the seed: any value but 0
    or 1
    ld [wSeed], a
    ldh [rSB], a
    xor $5A
    ld [wSeed + 1], a
    ld a, $81
    ldh [rSC], a
.sendingSeed:
    ldh a, [rSC]
    bit 7, a
    jr nz, .sendingSeed
    ret
.received:
    ldh a, [rSB]
    cp HELLO
    jr nz, .listen
    ld a, 2
    ld [wPlayer], a
    xor a
    ldh [rSB], a
    ld a, $80                      ; wait for the seed
    ldh [rSC], a
.waitSeed:
    ldh a, [rSC]
    bit 7, a
    jr nz, .waitSeed
    ldh a, [rSB]
    ld [wSeed], a
    xor $5A
    ld [wSeed + 1], a
    ret

; Swaps this frame's buttons (a) with the other Game Boy's; returns theirs in a.
; Player 1 clocks the byte; player 2 waits for it. Both Game Boys reach this point at
; almost the same moment each frame; player 1 waits a little so player 2 is ready.
Exchange:
    ldh [rSB], a
    ld a, [wPlayer]
    cp 1
    jr nz, .slave
    ld b, 64
.delay:
    dec b
    jr nz, .delay
    ld a, $81
    jr .go
.slave:
    ld a, $80
.go:
    ldh [rSC], a
.wait:
    ldh a, [rSC]
    bit 7, a
    jr nz, .wait
    ldh a, [rSB]
    ret

; ---------------------------------------------------------------------------- game
InitGame:
    ld a, 40
    ld [wP1X], a
    ld a, 128
    ld [wP2X], a
    ld a, 88
    ld [wP1Y], a
    ld [wP2Y], a
    xor a
    ld [wScore1], a
    ld [wScore2], a
    ld [wOver], a
    call SetResults
    jp PlaceCoin

; One frame of the game, from both players' buttons. Runs the same on both Game Boys.
Update:
    ld a, [wOver]
    and a
    ret nz
    ld a, [wPad1]
    ld hl, wP1X
    call Move
    ld a, [wPad2]
    ld hl, wP2X
    call Move
    ld hl, wP1X                    ; d = player 1 touches the coin, e = player 2
    call Touch
    ld a, 0
    rla
    ld d, a
    ld hl, wP2X
    call Touch
    ld a, 0
    rla
    ld e, a
    or d
    ret z                          ; nobody
    ld a, d
    and e
    jp nz, PlaceCoin               ; both in the same frame: nobody scores
    ld hl, wScore1
    ld a, d
    and a
    jr nz, .scored
    ld hl, wScore2
.scored:
    inc [hl]
    call Beep
    call SetResults
    ld a, [wScore1]
    cp WINS_TO_MATCH
    jr nc, .over
    ld a, [wScore2]
    cp WINS_TO_MATCH
    jp c, PlaceCoin
.over:
    ld a, 1
    ld [wOver], a
    xor a
    ld [wCoinY], a                 ; hide the coin
    ret

; Moves the player whose X, Y are at hl by the buttons in a, inside the walls.
Move:
    ld b, a
    bit 4, b                       ; right
    jr z, .notRight
    ld a, [hl]
    add SPEED
    cp MAX_X + 1
    jr c, .right
    ld a, MAX_X
.right:
    ld [hl], a
.notRight:
    bit 5, b                       ; left
    jr z, .notLeft
    ld a, [hl]
    sub SPEED
    cp MIN_X
    jr nc, .left
    ld a, MIN_X
.left:
    ld [hl], a
.notLeft:
    inc hl
    bit 6, b                       ; up
    jr z, .notUp
    ld a, [hl]
    sub SPEED
    cp MIN_Y
    jr nc, .up
    ld a, MIN_Y
.up:
    ld [hl], a
.notUp:
    bit 7, b                       ; down
    ret z
    ld a, [hl]
    add SPEED
    cp MAX_Y + 1
    jr c, .down
    ld a, MAX_Y
.down:
    ld [hl], a
    ret

; Carry set if the player whose X, Y are at hl touches the coin.
Touch:
    ld a, [wCoinX]
    ld b, a
    ld a, [hl+]
    sub b
    jr nc, .dx
    cpl
    inc a
.dx:
    cp 7
    ret nc
    ld a, [wCoinY]
    ld b, a
    ld a, [hl]
    sub b
    jr nc, .dy
    cpl
    inc a
.dy:
    cp 7
    ret

; A new coin at a random place (the same on both Game Boys: same seed, same calls),
; never right on a player.
PlaceCoin:
    call Rand
    and $7F
    add MIN_X
    ld [wCoinX], a
    call Rand
    and $7F
    cp MAX_Y - MIN_Y + 1
    jr c, .y
    sub 64
.y:
    add MIN_Y
    ld [wCoinY], a
    ld hl, wP1X
    call Touch
    jr c, PlaceCoin
    ld hl, wP2X
    call Touch
    jr c, PlaceCoin
    ret

; Next random byte: 8 steps of a 16-bit Galois LFSR (taps $B400).
Rand:
    ld b, 8
    ld hl, wSeed
.step:
    inc hl
    srl [hl]
    dec hl
    rr [hl]
    jr nc, .noTap
    inc hl
    ld a, [hl]
    xor $B4
    ld [hl-], a
.noTap:
    dec b
    jr nz, .step
    ld a, [hl]
    ret

; Copies the scores to the addresses the server reads, from this Game Boy's side.
SetResults:
    ld a, [wScore1]
    ld b, a
    ld a, [wScore2]
    ld c, a
    ld a, [wPlayer]
    cp 1
    jr nz, .player2
    ld a, b
    ld [wMyWins], a
    ld a, c
    ld [wTheirWins], a
    ret
.player2:
    ld a, c
    ld [wMyWins], a
    ld a, b
    ld [wTheirWins], a
    ret

; A short high beep on channel 1.
Beep:
    xor a
    ldh [rNR10], a
    ld a, $80                      ; 50% duty
    ldh [rNR11], a
    ld a, $F3                      ; full volume, fading
    ldh [rNR12], a
    ld a, $C1
    ldh [rNR13], a
    ld a, $87                      ; start, high frequency
    ldh [rNR14], a
    ret

; ---------------------------------------------------------------------------- screen
; Sprites 0-2 and the two scores. Call right after VBlank starts.
Draw:
    ld hl, _OAM
    ld a, [wP1Y]
    ld [hl+], a
    ld a, [wP1X]
    ld [hl+], a
    ld a, TILE_P1
    ld [hl+], a
    xor a
    ld [hl+], a
    ld a, [wP2Y]
    ld [hl+], a
    ld a, [wP2X]
    ld [hl+], a
    ld a, TILE_P2
    ld [hl+], a
    xor a
    ld [hl+], a
    ld a, [wCoinY]
    ld [hl+], a
    ld a, [wCoinX]
    ld [hl+], a
    ld a, TILE_COIN
    ld [hl+], a
    xor a
    ld [hl+], a
    ld a, [wScore1]
    add TILE_DIGIT_0
    ld [_SCRN0 + 2], a
    ld a, [wScore2]
    add TILE_DIGIT_0
    ld [_SCRN0 + 18], a
    ret

; The field: score line on row 0, walls around rows 1-17. LCD must be off.
DrawField:
    ld hl, _SCRN0
    ld bc, 32 * 32
    ld a, TILE_BLANK
    call Fill
    ld hl, _SCRN0 + 32 * 1
    ld b, 20
    ld a, TILE_WALL
    call FillRow
    ld hl, _SCRN0 + 32 * 17
    ld b, 20
    call FillRow
    ld hl, _SCRN0 + 32 * 2
    ld de, 19
    ld c, 15
.sides:
    ld [hl], a
    push hl
    add hl, de
    ld [hl], a
    pop hl
    push de
    ld de, 32
    add hl, de
    pop de
    dec c
    jr nz, .sides
    ld a, TILE_P1
    ld [_SCRN0 + 1], a
    ld a, TILE_P2
    ld [_SCRN0 + 17], a
    ret

LcdOff:
    ldh a, [rLY]
    cp 144
    jr c, LcdOff
    xor a
    ldh [rLCDC], a
    ret

; ---------------------------------------------------------------------------- helpers
; Returns the buttons held in a (PAD_* bits, 1 = held).
ReadJoypad:
    ld a, $20                      ; d-pad
    ldh [rP1], a
    ldh a, [rP1]
    ldh a, [rP1]
    cpl
    and $0F
    swap a
    ld b, a
    ld a, $10                      ; buttons
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

; Writes a to b bytes from hl.
FillRow:
    ld [hl+], a
    dec b
    jr nz, FillRow
    ret
