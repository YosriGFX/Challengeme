; SKY HOP: two to four players, one Game Boy each, joined by the 4-Player Adapter.
; Everybody bounces up the same tower of platforms (left/right to steer, the bounce is
; automatic). The screen climbs on its own, a little faster as time goes on, and never
; lets the highest player get more than FOLLOW pixels above its bottom. Whoever drops
; below the bottom of the screen is out; the last one left wins the round. Then the next
; round waits until every player has pressed START. The first to the number of round
; wins the server chose ($C004) wins the match.
;
; What it shows (see ../ASSEMBLY.md):
; - the 4-Player Adapter protocol, all in the serial interrupt (SerialIsr): answering the
;   ping packets, player 1's START starting the game, then one byte per player per packet,
; - lockstep: every Game Boy runs one game tick per adapter packet, from the same four
;   button bytes, so all screens agree; the random generator is fed from those bytes,
; - round wins per player at fixed addresses for the server ($C000-$C003),
; - drawing in the V-Blank interrupt, platforms streamed into the scrolling background,
;   scores in the window.
;
; Build, translate and test it from rom_maker/: python3 tools/build.py skyhop

INCLUDE "hardware.inc"
INCLUDE "tiles.asm"

DEF WINS_TO_MATCH EQU 3            ; round wins for the match when the server sets none
DEF JUMP_HI     EQU $05            ; bounce speed: 5 pixels per tick up
DEF GRAVITY     EQU $28            ; minus 0.156 pixels per tick, every tick
DEF FALL_MAX_HI EQU $FB            ; falling no faster than 5 pixels per tick
DEF STEP        EQU 2              ; pixels per tick left or right
DEF SPEED0      EQU $50            ; the screen climbs 0.31 pixels per tick at first...
DEF SPEED_UP    EQU 6              ; ...and this much faster (1/256 px) every 256 ticks
DEF SPEED_MAX   EQU $E0
DEF START_DELAY EQU 120            ; ticks before the screen starts climbing
DEF FOLLOW      EQU 128            ; the highest player stays at most this far above the bottom
DEF ROWS_AHEAD  EQU 176            ; platforms exist up to this far above the bottom

; Link states
DEF LINK_PING EQU 0                ; answering ping packets
DEF LINK_CC   EQU 1                ; the adapter is sending $CC x 4
DEF LINK_XFER EQU 2                ; game packets
; Game states
DEF ST_LINK  EQU 0                 ; waiting for the first game packet
DEF ST_PLAY  EQU 1
DEF ST_WAIT  EQU 2                 ; round over, waiting for START from everybody
DEF ST_OVER  EQU 3                 ; match over
; Window text
DEF TXT_NONE  EQU 0
DEF TXT_LINK  EQU 1
DEF TXT_ROUND EQU 2
DEF TXT_OVER  EQU 3

; ---------------------------------------------------------------------------- RAM
; The server reads $C000-$C003 on every Game Boy: round wins of players 1-4, the same on
; all of them, +1 per round won (game.json "winsBy"). It writes $C004 once the game has
; started: the round wins the players chose for the match ("bestAt").
SECTION "Results", WRAM0[$C000]
wWins::  ds 4
wBest::  db                        ; 0 = WINS_TO_MATCH

SECTION "Link", WRAM0[$C010]
wLink:     db
wIdx:      db                      ; byte number in the current packet
wCcs:      db                      ; $CC bytes seen
wStartReq: db                      ; 1: answer $AA (player 1 pressed START)
wStat:     db                      ; last ping STAT: connected ports (bits 4-7), my number
wMyPad:    db                      ; my buttons, sent in my block
wBuf:      ds 4                    ; the packet being received
wQHead:    db                      ; packets queued by the interrupt...
wQTail:    db                      ; ...and taken by the main loop

SECTION "Queue", WRAM0[$C040]
wQueue:    ds 8 * 4                ; 8 packets of 4 button bytes

SECTION "Game", WRAM0[$C080]
wState:  db
wMe:     db                        ; my player number, 1-4
wMask:   db                        ; players in the game: bit 0 = player 1 ... bit 3 = player 4
wIn:     ds 4                      ; this tick's buttons of players 1-4
wPrev:   ds 4                      ; last tick's
wSeed:   dw
wPX:     ds 4                      ; per player: x (0-159)
wPHl:    ds 4                      ; height in pixels (16 bits, grows upwards)
wPHh:    ds 4
wPF:     ds 4                      ; height, 1/256 pixels
wPVl:    ds 4                      ; vertical speed in 1/256 pixels per tick, signed
wPVh:    ds 4
wAlive:  db                        ; players still on screen, as wMask
wCamL:   db                        ; height of the bottom of the screen
wCamH:   db
wCamF:   db
wSpeed:  db
wSpeedT: db
wDelay:  db
wTopL:   db                        ; highest platform row made (row r's top is at r * 32)
wTopH:   db
wRows:   ds 16                     ; platform column of row r at r & 15 ($FF = floor)
wReady:  db                        ; players who pressed START since the round ended
wWinner: db                        ; last round's winner, 0 = nobody
wDrawnL: db                        ; highest row drawn in the background
wDrawnH: db
wText:   db                        ; window text wanted / shown
wShown:  db
tHl:     db                        ; the player being moved
tHh:     db
tF:      db
tVl:     db
tVh:     db
tRow:    db
tFall:   db

; ---------------------------------------------------------------------------- vectors
SECTION "VBlank interrupt", ROM0[$40]
    jp VBlankIsr

SECTION "Serial interrupt", ROM0[$58]
    jp SerialIsr

SECTION "Header", ROM0[$100]
    nop
    jp Start
    ds $150 - @, 0

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
    ld hl, _SCRN0                  ; both maps blank
    ld bc, 2 * 32 * 32
    xor a
    call Fill
    ld hl, _OAM
    ld bc, 160
    xor a
    call Fill
    ld hl, $C000
    ld bc, $100
    xor a
    call Fill
    ld a, $FF
    ld [wShown], a
    ld a, TXT_LINK
    ld [wText], a
    ld a, %11100100
    ldh [rBGP], a
    ldh [rOBP0], a
    ld a, %11011000                ; my own player: body one shade darker
    ldh [rOBP1], a
    xor a
    ldh [rSCX], a
    ldh [rSCY], a
    ld a, 7
    ldh [rWX], a
    ld a, 120
    ldh [rWY], a
    ld a, $80
    ldh [rNR52], a
    ld a, $77
    ldh [rNR50], a
    ld a, $FF
    ldh [rNR51], a
    ld a, %11110011                ; LCD, window at $9C00, tiles $8000, BG $9800, sprites
    ldh [rLCDC], a
    xor a                          ; listen to the adapter
    ldh [rSB], a
    ld a, $80
    ldh [rSC], a
    ld a, IE_VBLANK | IE_SERIAL
    ldh [rIE], a
    xor a
    ldh [rIF], a
    ei

; One game tick per adapter packet. Drawing and the joypad are in VBlankIsr, the link in
; SerialIsr; this loop only runs the game.
MainLoop:
    halt
    nop
    ld a, [wQTail]
    ld b, a
    ld a, [wQHead]
    cp b
    jr z, MainLoop
    ld a, b                        ; copy packet wQTail to wIn
    add a
    add a
    ld e, a
    ld d, 0
    ld hl, wQueue
    add hl, de
    ld de, wIn
    ld c, 4
.copy:
    ld a, [hl+]
    ld [de], a
    inc de
    dec c
    jr nz, .copy
    ld a, b
    inc a
    and 7
    ld [wQTail], a
    call Tick
    ld hl, wIn
    ld de, wPrev
    ld c, 4
.prev:
    ld a, [hl+]
    ld [de], a
    inc de
    dec c
    jr nz, .prev
    jr MainLoop

; ---------------------------------------------------------------------------- link
; The 4-Player Adapter clocks every byte; each Game Boy waits with SC = $80, and gets
; this interrupt once a byte is in. What it puts in SB before re-arming is its answer,
; which the adapter reads with the next byte.
;   Ping packets: $FE, STAT, STAT, STAT. Answer $88, $88, RATE, SIZE (to stay listed),
;   or $AA, $AA, $AA, $AA to start the game: the adapter then sends $CC x 4 and the game
;   packets begin. STAT = connected ports in bits 4-7, this port's number in bits 0-2.
;   Game packets (SIZE = 1): 4 bytes, everybody's answer to the previous packet's first
;   byte, player 1 first; empty ports give 0. A Game Boy never sends $FF (that ends it).
SerialIsr:
    push af
    push bc
    push de
    push hl
    ldh a, [rSB]
    ld b, a
    ld a, [wLink]
    cp LINK_XFER
    jr z, .xfer
    cp LINK_CC
    jr z, .cc
    ld a, b                        ; ping phase
    cp $CC
    jr z, .firstCc
    cp $FE
    jr nz, .stat
    ld a, 1
    ld [wIdx], a
    ld c, $88
    jr .ping
.stat:
    ld a, [wIdx]
    cp 1
    jr nz, .notFirst
    ld a, b
    ld [wStat], a
    ld a, [wIdx]
.notFirst:
    inc a
    ld [wIdx], a
    ld c, $88                      ; after the 1st STAT
    cp 2
    jr z, .ping
    ld c, 0                        ; RATE: fastest
    cp 3
    jr z, .ping
    ld c, 1                        ; SIZE: one byte per player
.ping:
    ld a, [wStartReq]
    and a
    ld a, c
    jr z, .answer
    ld a, $AA
    jr .answer
.firstCc:
    ld a, LINK_CC
    ld [wLink], a
    ld a, 1
    ld [wCcs], a
    xor a
    jr .answer
.cc:
    ld a, [wCcs]
    inc a
    ld [wCcs], a
    cp 4
    jr nz, .zero
    ld a, LINK_XFER
    ld [wLink], a
    xor a
    ld [wIdx], a
.zero:
    xor a
    jr .answer
.xfer:
    ld a, [wIdx]
    ld e, a
    ld d, 0
    ld hl, wBuf
    add hl, de
    ld [hl], b
    ld a, e                        ; my block: the answer to byte 0
    and a
    jr nz, .notMine
    ld a, [wMyPad]
    jr .send
.notMine:
    xor a
.send:
    ldh [rSB], a
    inc e
    ld a, e
    cp 4
    jr nz, .keep
    ld a, [wQHead]                 ; packet complete: queue it
    add a
    add a
    ld e, a
    ld d, 0
    ld hl, wQueue
    add hl, de
    ld de, wBuf
    ld c, 4
.queue:
    ld a, [de]
    ld [hl+], a
    inc de
    dec c
    jr nz, .queue
    ld a, [wQHead]
    inc a
    and 7
    ld [wQHead], a
    xor a
.keep:
    ld [wIdx], a
    jr .arm
.answer:
    ldh [rSB], a
.arm:
    ld a, $80
    ldh [rSC], a
    pop hl
    pop de
    pop bc
    pop af
    reti

; ---------------------------------------------------------------------------- game
Tick:
    call MixSeed
    ld a, [wState]
    cp ST_LINK
    jr z, .first
    cp ST_PLAY
    jp z, Play
    cp ST_WAIT
    jp z, WaitRound
    ret
.first:                            ; the first game packet: who plays, then round 1
    ld a, [wStat]
    and 7
    ld [wMe], a
    ld a, [wStat]
    swap a
    and $0F
    ld [wMask], a
    jp NewRound

; Mixes everybody's buttons into the random generator, the same on every Game Boy.
MixSeed:
    ld hl, wIn
    ld a, [hl+]
    xor [hl]
    inc hl
    xor [hl]
    inc hl
    xor [hl]
    ld hl, wSeed
    xor [hl]
    ld [hl+], a
    or [hl]
    ret nz
    ld [hl], 1                     ; never 0
    ret

; a = round wins that win the match.
Best:
    ld a, [wBest]
    and a
    ret nz
    ld a, WINS_TO_MATCH
    ret

; Between rounds: each player's new START press counts; all in, next round.
WaitRound:
    ld c, 0
.player:
    ld b, 0
    ld hl, wPrev
    add hl, bc
    ld a, [hl]
    cpl
    ld hl, wIn
    add hl, bc
    and [hl]
    and PAD_START
    jr z, .next
    ld hl, BitOf
    add hl, bc
    ld a, [wReady]
    or [hl]
    ld [wReady], a
.next:
    inc c
    ld a, c
    cp 4
    jr nz, .player
    ld a, [wMask]
    ld b, a
    ld a, [wReady]
    and b
    cp b
    ret nz
    ; fall through: everybody is ready

; A new round: a fresh tower, everybody on the floor. Redraws with the LCD off.
NewRound:
    xor a
    ld [wCamL], a
    ld [wCamH], a
    ld [wCamF], a
    ld [wSpeedT], a
    ld [wTopL], a
    ld [wTopH], a
    ld [wReady], a
    ld a, SPEED0
    ld [wSpeed], a
    ld a, START_DELAY
    ld [wDelay], a
    call MakeRows
    ld c, 0                        ; players: x 16, 56, 96, 136 on the floor (row 1)
.player:
    ld b, 0
    ld a, c
    add a
    add a
    add a
    ld d, a                        ; c * 8
    add a
    add a
    add d                          ; c * 40
    add 16
    ld hl, wPX
    add hl, bc
    ld [hl], a
    ld hl, wPHl
    add hl, bc
    ld [hl], 32
    ld hl, wPHh
    add hl, bc
    ld [hl], 0
    ld hl, wPF
    add hl, bc
    ld [hl], 0
    ld hl, wPVl
    add hl, bc
    ld [hl], 0
    ld hl, wPVh
    add hl, bc
    ld [hl], JUMP_HI
    inc c
    ld a, c
    cp 4
    jr nz, .player
    ld a, [wMask]
    ld [wAlive], a
    ld a, ST_PLAY
    ld [wState], a
    ld a, TXT_NONE
    ld [wText], a
    ; redraw the whole background with the LCD off
    call LcdOff
    ld hl, _SCRN0
    ld bc, 32 * 32
    xor a
    call Fill
    ld a, 1
    ld [wDrawnL], a
    xor a
    ld [wDrawnH], a
.draw:
    call DrawRow
    call DrawNext
    jr nz, .draw
    ld a, [wCamL]
    call SetScroll
    ld a, %11110011
    ldh [rLCDC], a
    ret

; Makes platform rows until there are ROWS_AHEAD pixels of them above the bottom.
MakeRows:
.again:
    ld a, [wTopL]                  ; de = (top + 1) * 32
    ld e, a
    ld a, [wTopH]
    ld d, a
    inc de
    ld a, e
    ld l, d
    ld h, 0
    ld b, 5
.shift:
    sla a
    rl l
    dec b
    jr nz, .shift
    ld e, a
    ld d, l
    ld a, [wCamL]                  ; hl = cam + ROWS_AHEAD
    add ROWS_AHEAD
    ld l, a
    ld a, [wCamH]
    adc 0
    ld h, a
    ld a, l                        ; stop if de > hl
    sub e
    ld a, h
    sbc d
    ret c
    ld hl, wTopL                   ; top + 1
    inc [hl]
    jr nz, .noCarry
    ld hl, wTopH
    inc [hl]
.noCarry:
    ld a, [wTopL]
    and 15
    ld e, a
    ld d, 0
    ld hl, wRows
    add hl, de
    ld a, [wTopH]                  ; row 1 is the floor
    and a
    jr nz, .platform
    ld a, [wTopL]
    cp 1
    jr nz, .platform
    ld [hl], $FF
    jr .again
.platform:
    push hl
    call Rand
    pop hl
    and $1F                        ; column 0-16: a 4-tile platform fits in 20
    cp 17
    jr c, .col
    sub 16
.col:
    ld [hl], a
    jr .again

; One tick of play.
Play:
    ld a, [wDelay]
    and a
    jr z, .climb
    dec a
    ld [wDelay], a
    jr .players
.climb:
    ld a, [wSpeed]
    ld b, a
    ld a, [wCamF]
    add b
    ld [wCamF], a
    jr nc, .faster
    ld hl, wCamL
    inc [hl]
    jr nz, .faster
    ld hl, wCamH
    inc [hl]
.faster:
    ld hl, wSpeedT
    dec [hl]
    jr nz, .players
    ld a, [wSpeed]
    add SPEED_UP
    cp SPEED_MAX
    jr c, .speed
    ld a, SPEED_MAX
.speed:
    ld [wSpeed], a
.players:
    ld c, 0
.move:
    ld b, 0
    ld hl, BitOf
    add hl, bc
    ld a, [wAlive]
    and [hl]
    call nz, Move
    inc c
    ld a, c
    cp 4
    jr nz, .move
    call Follow
    call MakeRows
    ; out: below the bottom of the screen
    ld c, 0
.out:
    ld b, 0
    ld hl, BitOf
    add hl, bc
    ld a, [wAlive]
    and [hl]
    jr z, .nextOut
    ld hl, wPHl
    add hl, bc
    ld a, [wCamL]
    ld d, a
    ld a, [hl]
    sub d
    inc hl                         ; to wPHh (inc keeps the carry)
    inc hl
    inc hl
    inc hl
    ld a, [wCamH]
    ld d, a
    ld a, [hl]
    sbc d
    jr nc, .nextOut                ; height >= camera: still in
    ld hl, BitOf
    add hl, bc
    ld a, [hl]
    cpl
    ld d, a
    ld a, [wAlive]
    and d
    ld [wAlive], a
    ld a, [wMe]
    dec a
    cp c
    call z, FallSound
.nextOut:
    inc c
    ld a, c
    cp 4
    jr nz, .out
    ; round over? With two or more players: one left (or none). Alone: none left.
    ld a, [wMask]
    call Count
    ld b, a
    ld a, [wAlive]
    call Count
    and a
    jr z, .roundOver
    dec b
    ret z                          ; alone and still in
    dec a
    ret nz                         ; two or more still in
.roundOver:
    ld a, [wAlive]                 ; the winner's number, or 0
    ld c, 0
.find:
    and a                          ; also clears the carry
    jr z, .found
    inc c
    rra
    jr nc, .find
.found:
    ld a, c
    ld [wWinner], a
    and a
    jr z, .noWinner
    ld hl, wWins - 1
    ld b, 0
    add hl, bc
    inc [hl]
.noWinner:
    xor a
    ld [wReady], a
    ld a, ST_WAIT
    ld [wState], a
    ld a, TXT_ROUND
    ld [wText], a
    ld a, [wWinner]
    and a
    ret z
    ld hl, wWins - 1
    ld b, 0
    add hl, bc
    call Best
    ld b, a
    ld a, [hl]
    cp b
    ret c
    ld a, ST_OVER
    ld [wState], a
    ld a, TXT_OVER
    ld [wText], a
    ret

; a = number of bits set in a's low 4 bits.
Count:
    ld d, 0
    ld e, 4
.bit:
    rra
    jr nc, .zero
    inc d
.zero:
    dec e
    jr nz, .bit
    ld a, d
    ret

; The screen keeps the highest player at most FOLLOW pixels above its bottom.
Follow:
    ld c, 0
.player:
    ld b, 0
    ld hl, BitOf
    add hl, bc
    ld a, [wAlive]
    and [hl]
    jr z, .next
    ld hl, wPHl                    ; de = height - FOLLOW
    add hl, bc
    ld a, [hl]
    sub FOLLOW
    ld e, a
    inc hl                         ; to wPHh (inc keeps the carry)
    inc hl
    inc hl
    inc hl
    ld a, [hl]
    sbc 0
    ld d, a
    jr c, .next                    ; below FOLLOW
    ld a, [wCamL]                  ; camera < de: camera = de
    sub e
    ld a, [wCamH]
    sbc d
    jr nc, .next
    ld a, e
    ld [wCamL], a
    ld a, d
    ld [wCamH], a
.next:
    inc c
    ld a, c
    cp 4
    jr nz, .player
    ret

; Moves player c (0-3): steering, falling, bouncing on a platform it falls onto.
Move:
    ld b, 0
    ld hl, wIn
    add hl, bc
    ld d, [hl]
    ld hl, wPX
    add hl, bc
    bit 4, d                       ; right
    jr z, .notRight
    ld a, [hl]
    add STEP
    cp 160
    jr c, .right
    sub 160
.right:
    ld [hl], a
.notRight:
    bit 5, d                       ; left
    jr z, .notLeft
    ld a, [hl]
    sub STEP
    jr nc, .left
    add 160
.left:
    ld [hl], a
.notLeft:
    ld hl, wPHl                    ; load the player into tHl ... tVh
    add hl, bc
    ld a, [hl]
    ld [tHl], a
    ld hl, wPHh
    add hl, bc
    ld a, [hl]
    ld [tHh], a
    ld hl, wPF
    add hl, bc
    ld a, [hl]
    ld [tF], a
    ld hl, wPVl
    add hl, bc
    ld a, [hl]
    ld [tVl], a
    ld hl, wPVh
    add hl, bc
    ld a, [hl]
    ld [tVh], a
    and $80
    ld [tFall], a                  ; falling this tick
    call RowOfT
    ld [tRow], a
    ld a, [tVh]                    ; height += speed
    ld e, a
    rlca
    sbc a
    ld d, a
    ld a, [tVl]
    ld b, a
    ld a, [tF]
    add b
    ld [tF], a
    ld a, [tHl]
    adc e
    ld [tHl], a
    ld a, [tHh]
    adc d
    ld [tHh], a
    ld a, [tVl]                    ; speed -= gravity, not below -5
    sub GRAVITY
    ld [tVl], a
    ld a, [tVh]
    sbc 0
    ld [tVh], a
    bit 7, a
    jr z, .speedOk
    cp FALL_MAX_HI
    jr nc, .speedOk
    ld a, FALL_MAX_HI
    ld [tVh], a
    xor a
    ld [tVl], a
.speedOk:
    ld a, [tFall]                  ; fell past the top of row tRow?
    and a
    jr z, .store
    call RowOfT
    ld b, a
    ld a, [tRow]
    cp b
    jr z, .store
    and 15                         ; that row's platform under the player?
    ld e, a
    ld d, 0
    ld hl, wRows
    add hl, de
    ld a, [hl]
    cp $FF
    jr z, .land
    add a                          ; column * 8
    add a
    add a
    ld d, a
    ld b, 0
    ld hl, wPX
    add hl, bc
    ld a, [hl]
    add 7
    sub d                          ; x + 7 - platform x in 0-38
    cp 39
    jr nc, .store
.land:
    ; height = tRow * 32, speed = jump. tRow's high bits come from the old height.
    ld a, [tHl]                    ; the new height is just below the row's top
    or $1F
    add 1
    ld [tHl], a
    ld a, [tHh]
    adc 0
    ld [tHh], a
    xor a
    ld [tF], a
    ld [tVl], a
    ld a, JUMP_HI
    ld [tVh], a
    ld a, [wMe]
    dec a
    cp c
    call z, JumpSound
.store:
    ld b, 0
    ld hl, wPHl
    add hl, bc
    ld a, [tHl]
    ld [hl], a
    ld hl, wPHh
    add hl, bc
    ld a, [tHh]
    ld [hl], a
    ld hl, wPF
    add hl, bc
    ld a, [tF]
    ld [hl], a
    ld hl, wPVl
    add hl, bc
    ld a, [tVl]
    ld [hl], a
    ld hl, wPVh
    add hl, bc
    ld a, [tVh]
    ld [hl], a
    ret

; a = low byte of (tHh:tHl) / 32: the row whose top is at or below the player.
RowOfT:
    ld a, [tHh]
    ld d, a
    ld a, [tHl]
    ld b, 5
.shift:
    srl d
    rra
    dec b
    jr nz, .shift
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

JumpSound:
    xor a
    ldh [rNR10], a
    ld a, $80
    ldh [rNR11], a
    ld a, $A2
    ldh [rNR12], a
    ld a, $40
    ldh [rNR13], a
    ld a, $87
    ldh [rNR14], a
    ret

FallSound:
    ld a, $3F
    ldh [rNR41], a
    ld a, $F4
    ldh [rNR42], a
    ld a, $55
    ldh [rNR43], a
    ld a, $80
    ldh [rNR44], a
    ret

BitOf:
    db 1, 2, 4, 8

; ---------------------------------------------------------------------------- screen
; V-Blank: sprites, scroll, one new platform row, the window; then the joypad.
VBlankIsr:
    push af
    push bc
    push de
    push hl
    ei                             ; the link must not wait for drawing
    ld a, [wCamL]
    call SetScroll
    call DrawSprites
    call DrawNext
    call nz, DrawRow
    call DrawWindow
    call ReadJoypad
    and ~PAD_SELECT & $FF          ; never $FF: that would end the game packets
    ld [wMyPad], a
    ld a, [wLink]                  ; before the game: player 1's START starts it
    cp LINK_PING
    jr nz, .done
    ld a, [wStat]
    and 7
    cp 1
    jr nz, .done
    ld a, [wMyPad]
    and PAD_START
    jr z, .done
    ld a, 1
    ld [wStartReq], a
.done:
    pop hl
    pop de
    pop bc
    pop af
    reti

; SCY from the camera's low byte a: screen line 143 shows height camera.
SetScroll:
    cpl
    inc a
    add 113
    ldh [rSCY], a
    ret

; Sets nz and steps wDrawn if a made row is not drawn yet.
DrawNext:
    ld a, [wTopL]
    ld b, a
    ld a, [wDrawnL]
    cp b
    jr nz, .more
    ld a, [wTopH]
    ld b, a
    ld a, [wDrawnH]
    cp b
    ret z
.more:
    ld hl, wDrawnL
    inc [hl]
    jr nz, .done
    ld hl, wDrawnH
    inc [hl]
.done:
    or 1                           ; nz
    ret

; Draws row wDrawn: its tile row in the background is (-row * 4) & 31.
DrawRow:
    ld a, [wDrawnL]
    add a
    add a
    cpl
    inc a
    and 31
    ld l, a                        ; hl = _SCRN0 + tile row * 32
    ld h, 0
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    add hl, hl
    ld de, _SCRN0
    add hl, de
    ld a, [wDrawnL]
    and 15
    ld e, a
    ld d, 0
    push hl
    ld hl, wRows
    add hl, de
    ld c, [hl]
    pop hl
    ld a, c
    cp $FF
    jr nz, .platform
    ld a, TILE_FLOOR
    ld b, 20
    jp FillRow
.platform:
    push hl
    xor a
    ld b, 20
    call FillRow
    pop hl
    ld b, 0
    add hl, bc
    ld a, TILE_PLAT_L
    ld [hl+], a
    ld a, TILE_PLAT_M
    ld [hl+], a
    ld [hl+], a
    ld a, TILE_PLAT_R
    ld [hl], a
    ret

; Players as sprites 0-3; mine with OBP1.
DrawSprites:
    ld c, 0
    ld hl, _OAM
.player:
    push hl
    ld b, 0
    ld hl, BitOf
    add hl, bc
    ld a, [wAlive]
    and [hl]
    jr z, .hide
    ld hl, wPHl                    ; y = camera - height + 152, if 16-159
    add hl, bc
    ld a, [wCamL]
    sub [hl]
    ld e, a
    inc hl                         ; to wPHh (inc keeps the carry)
    inc hl
    inc hl
    inc hl
    ld a, [wCamH]
    sbc [hl]
    ld d, a
    ld a, e
    add 152
    ld e, a
    ld a, d
    adc 0
    jr nz, .hide
    ld a, e
    cp 160
    jr nc, .hide
    ld hl, wPX
    add hl, bc
    ld d, [hl]
    pop hl
    ld a, e
    ld [hl+], a
    ld a, d
    add 8
    ld [hl+], a
    ld a, c
    add TILE_P1
    ld [hl+], a
    ld a, [wMe]
    dec a
    cp c
    ld a, 0
    jr nz, .attr
    ld a, %00010000                ; OBP1
.attr:
    ld [hl+], a
    jr .next
.hide:
    pop hl
    xor a
    ld [hl+], a
    inc hl
    inc hl
    inc hl
.next:
    inc c
    ld a, c
    cp 4
    jr nz, .player
    ret

; Window row 0: the scores; rows 1-2: the text of the moment (WY 120 shows them).
DrawWindow:
    ld c, 0
.score:
    ld b, 0
    ld a, c                        ; hl = _SCRN1 + c * 5
    add a
    add a
    add c
    ld l, a
    ld h, HIGH(_SCRN1)
    push hl
    ld hl, BitOf
    add hl, bc
    ld a, [wMask]
    and [hl]
    pop hl
    jr z, .nextScore
    ld a, [wMe]
    dec a
    cp c
    ld a, TILE_BLANK
    jr nz, .notMe
    ld a, TILE_ARROW
.notMe:
    ld [hl+], a
    ld a, c
    add TILE_P1
    ld [hl+], a
    push hl
    ld hl, wWins
    add hl, bc
    ld a, [hl]
    pop hl
    add TILE_D0
    ld [hl], a
.nextScore:
    inc c
    ld a, c
    cp 4
    jr nz, .score
    ld a, [wText]
    ld b, a
    ld a, [wShown]
    cp b
    jr z, .readyIcons
    ld a, b
    ld [wShown], a
    ld hl, _SCRN1 + 32             ; clear rows 1 and 2
    xor a
    ld b, 20
    call FillRow
    ld hl, _SCRN1 + 64
    ld b, 20
    call FillRow
    ld a, [wText]
    cp TXT_NONE
    ld a, 136
    jr z, .wy
    ld a, [wText]
    cp TXT_LINK
    jr z, .press
    ld a, [wWinner]                ; row 1: "P2 WINS" or "DRAW"
    and a
    jr nz, .winner
    ld hl, TxtDraw
    ld de, _SCRN1 + 32 + 8
    ld b, 4
    call CopyRow
    jr .row2
.winner:
    ld hl, _SCRN1 + 32 + 6
    add TILE_P1 - 1
    ld [hl+], a
    inc hl
    ld d, h
    ld e, l
    ld hl, TxtWins
    ld b, 4
    call CopyRow
.row2:
    ld a, [wText]
    cp TXT_OVER
    jr nz, .press
    ld hl, TxtGameOver
    ld de, _SCRN1 + 64 + 5
    ld b, 9
    call CopyRow
    ld a, 120
    jr .wy
.press:
    ld hl, TxtPressStart
    ld de, _SCRN1 + 64 + 1
    ld b, 11
    call CopyRow
    ld a, 120
.wy:
    ldh [rWY], a
.readyIcons:                       ; between rounds: who pressed START
    ld a, [wText]
    cp TXT_ROUND
    ret nz
    ld c, 0
    ld hl, _SCRN1 + 64 + 13
.icon:
    push hl
    ld b, 0
    ld hl, BitOf
    add hl, bc
    ld a, [wReady]
    and [hl]
    pop hl
    ld a, TILE_BLANK
    jr z, .put
    ld a, c
    add TILE_P1
.put:
    ld [hl+], a
    inc hl
    inc c
    ld a, c
    cp 4
    jr nz, .icon
    ret

TxtPressStart:
    db TILE_P, TILE_R, TILE_E, TILE_S, TILE_S, TILE_BLANK, TILE_S, TILE_T, TILE_A, TILE_R, TILE_T
TxtWins:
    db TILE_W, TILE_I, TILE_N, TILE_S
TxtDraw:
    db TILE_D, TILE_R, TILE_A, TILE_W
TxtGameOver:
    db TILE_G, TILE_A, TILE_M, TILE_E, TILE_BLANK, TILE_O, TILE_V, TILE_E, TILE_R

LcdOff:
    ldh a, [rLCDC]
    bit 7, a
    ret z
.wait:
    ldh a, [rLY]
    cp 144
    jr c, .wait
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

; Copies b bytes from hl to de.
CopyRow:
    ld a, [hl+]
    ld [de], a
    inc de
    dec b
    jr nz, CopyRow
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
