; BELOTE (Tunisian coinche): four players, one Game Boy each, on the 4-Player Adapter,
; in two teams: players 1 and 3 against players 2 and 4 (partners sit opposite).
;
; - 32 cards, 8 each. The deal goes round the table: player 1, 2, 3, 4, 1...
; - Bidding, from the dealer's left: a bid is a number of points, 90 to 160 in tens, and
;   the trump suit; each bid must be higher than the last. Capot (all 8 tricks) is the
;   highest bid, and can be called by anyone at any moment of the bidding, even out of
;   turn: the first press wins. After a bid, either opponent may contrer (double) at any
;   moment; the bidding team then has a moment to surcontrer (redouble), and the bidding
;   ends. Nobody can contrer a capot. Three passes after a bid end the bidding; four
;   passes without one, and the next player deals again.
; - Play: follow the suit led. Without it, trump (higher than any trump on the table if
;   you can; if you cannot, any trump), unless your partner is winning the trick: then
;   play anything. When trump is led, play a higher trump if you can. The highest trump,
;   or else the highest card of the suit led, takes the trick, and its taker leads next.
; - Points: trump J 20, 9 14, A 11, 10 10, K 4, Q 3; other suits A 11, 10 10, K 4, Q 3,
;   J 2; 10 more for the last trick (162 in all; 250 for a team that takes every trick).
;   King and queen of trump in one hand: belote and rebelote, 20 for that team.
; - The bidders make their contract with at least the points they bid (belote counts),
;   or for capot by taking every trick. Made: they score the bid plus their points, the
;   others their points. Down: the others score 160 plus the bid. Contré (x2) or
;   surcontré (x4): the winning team scores 160 plus the bid times 2 or 4, the other
;   nothing. Belote's 20 always go to its team.
; - A game is to TARGET points; the higher team past it wins (tied: the bidders). Round
;   wins at $C000-$C003 for players 1-4 (teammates win together); the server's choice
;   of round wins for the match at $C004.
; - Each player has PLAY_SECONDS to bid or play; then the game passes, or plays their
;   first card that may be played.
;
; Controls. Bidding: up / down the points, left / right the suit, A bids (on your
; turn), B passes, SELECT contre / surcontre, START capot (with the suit you have
; picked). Play: left / right picks a card, A plays it; cards you may not play are grey.
;
; Fair cards: the deck is shuffled with random bytes the server writes once every Game
; Boy asks for them ($C005, a request number; the bytes at $C0C0), so no deal follows
; from an earlier one. Each phone only ever gets its own screen.
;
; Lockstep, like skyhop/: one game tick per adapter packet, from the same four button
; bytes on every Game Boy; each Game Boy only draws what its player may see.
;
; Build, translate and test from rom_maker/: python3 tools/build.py belote

INCLUDE "hardware.inc"
INCLUDE "tiles.asm"

DEF WINS_TO_MATCH EQU 1            ; round wins (games) for the match when the server sets none
DEF TARGET        EQU 1000         ; points that win a game
DEF PLAY_SECONDS  EQU 20           ; to bid or to play a card
DEF TICKS_PER_SEC EQU 59           ; adapter packets per second (17 ms apart)
DEF CONTRE_TICKS  EQU 4 * 59       ; the bidders' moment to surcontrer
DEF TRICK_TICKS   EQU 75           ; a full trick stays on the table
DEF SCORE_TICKS   EQU 7 * 59       ; the deal's result stays on screen
DEF RANDOM_DELAY  EQU 30           ; ticks from asking for random bytes to using them
DEF RANDOM_BYTES  EQU 64

DEF CAPOT   EQU 17                 ; bid values: 9-16 = 90-160, 17 = capot
DEF NO_CARD EQU $FF
DEF NOBODY  EQU $FF

; Game states
DEF ST_LINK   EQU 0                ; waiting for the first game packet
DEF ST_DEAL   EQU 1                ; asked for random bytes, dealing in a moment
DEF ST_BID    EQU 2
DEF ST_CONTRE EQU 3                ; contré: the bidders may surcontrer
DEF ST_PLAY   EQU 4
DEF ST_TRICK  EQU 5                ; a full trick on the table
DEF ST_SCORE  EQU 6                ; the deal's result
DEF ST_WAIT   EQU 7                ; game over, waiting for START from everybody
DEF ST_OVER   EQU 8                ; match over

; What a player last said in the bidding (wSaid)
DEF SAID_NONE   EQU 0
DEF SAID_PASS   EQU 1
DEF SAID_BID    EQU 2
DEF SAID_CAPOT  EQU 3
DEF SAID_CONTRE EQU 4
DEF SAID_SUR    EQU 5

; Sounds (wSound)
DEF SND_CARD  EQU 1
DEF SND_TURN  EQU 2
DEF SND_CALL  EQU 3                ; contre, surcontre, capot, belote
DEF SND_DEAL  EQU 4                ; the deal is over
DEF SND_NO    EQU 5                ; that card may not be played

; Link states
DEF LINK_PING EQU 0
DEF LINK_CC   EQU 1
DEF LINK_XFER EQU 2

DEF QUEUE_LEN  EQU 48              ; screen tiles written per frame
DEF DUMMY_VRAM EQU _SCRN0 + 32 * 20  ; an unseen map row for unused queue entries
DEF SCREEN_SIZE EQU 32 * 18        ; wWant and wShown are laid out like the map

; ---------------------------------------------------------------------------- RAM
; The server reads $C000-$C003 on every Game Boy: round wins of players 1-4, the same on
; all of them ("winsBy"); it writes $C004 once the game has started ("bestAt"). $C005
; is the request number for random bytes and $C0C0-$C0FF where they come ("random").
SECTION "Results", WRAM0[$C000]
wWins::  ds 4
wBest::  db                        ; 0 = WINS_TO_MATCH
wAsk::   db

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
wPackets:  ds 8 * 4                ; 8 packets of 4 button bytes

; The game: the same on every Game Boy (players as 0-3 here).
SECTION "Game", WRAM0[$C300]
wState:    db
wTicks:    dw                      ; ticks run (for tests: Game Boys at the same tick agree)
wBusy:     db                      ; 1 during a tick (for tests)
wMe:       db                      ; my player, 0-3 (the only state that differs)
wIn:       ds 4                    ; this tick's buttons of each player
wPrev:     ds 4                    ; last tick's
wNew:      ds 4                    ; pressed this tick
wTimer:    dw                      ; ticks left in this state
wSecT:     db                      ; the player to act: ticks left in this second...
wSecs:     db                      ; ...and seconds left
wDealer:   db                      ; NOBODY: pick one at random
wTurn:     db                      ; the player to act
wLeader:   db                      ; who led this trick
wCount:    ds 4                    ; cards in each hand
wTable:    ds 4                    ; each player's card in this trick, or NO_CARD
wPlayed:   db                      ; cards in this trick
wTrick:    db                      ; tricks done in this deal
wWinner:   db                      ; the full trick's taker
wTrump:    db                      ; the bid's suit
wBid:      db                      ; 0 = none yet, 9-16, CAPOT
wBidder:   db
wCoinche:  db                      ; 0, 1 contré, 2 surcontré
wPasses:   db                      ; passes since the last bid
wSaid:     ds 4                    ; SAID_* per player
wSaidV:    ds 4                    ; their bid's value and suit
wSaidS:    ds 4
wSelV:     ds 4                    ; each player's bid picker: value and suit
wSelS:     ds 4
wCur:      ds 4                    ; each player's card cursor
wPoints:   ds 4                    ; card points this deal, team 0 then 1 (16 bits each)
wTricks:   ds 2                    ; tricks taken this deal, per team
wScore:    ds 4                    ; game score per team (16 bits each)
wDelta:    ds 4                    ; what the last deal scored, per team
wShownPts: ds 4                    ; the last deal's card points, per team, as counted
wMade:     db                      ; the last contract: 1 made
wBelote:   db                      ; who holds king and queen of trump, or NOBODY
wBeloteSaid: db                    ; 0, 1 belote, 2 rebelote
wBeloteTrick: db                   ; the trick it was said in
wGameWinner: db                    ; the last game's team
wReady:    db                      ; players who pressed START since the game ended (bits)
wRot:      db                      ; whose buttons count first in a tick (same-tick presses)
wRndIdx:   db                      ; next random byte to use
wDeck:     ds 32
wHands:    ds 4 * 8                ; player p's cards at wHands + p * 8, sorted

; Drawing and sound: this Game Boy's own.
wSound:      db
wQueueReady: db                    ; 1: wQueue and wOAM are ready for the next VBlank
wDiffRow:    db                    ; the screen row BuildQueue compares next

SECTION "OAM buffer", WRAM0[$C100]
wOAM: ds 160

SECTION "Random", WRAM0[$C0C0]
wRandom:: ds RANDOM_BYTES

SECTION "Queue", WRAM0[$C200]
wQueue: ds QUEUE_LEN * 3           ; VRAM address (little-endian), tile

; The screen as it should look (wWant) and as it was sent to VRAM (wShown): 18 rows of
; 32 tiles like the map (only 20 are seen), so wWant + i is VRAM $9800 + i and wShown
; is wWant with bit 2 of the high byte set.
SECTION "Want", WRAMX[$D000]
wWant:  ds SCREEN_SIZE
SECTION "Shown", WRAMX[$D400]
wShown: ds SCREEN_SIZE

SECTION "HRAM", HRAM
hDma:   ds 10                      ; the OAM DMA routine, copied here at start
hQ:     ds 2                       ; where BuildQueue writes next
hRows:  db
hLed:   db                         ; LegalMask: the suit led
hBest:  db                         ; the best trump on the table, 1 + its order (0: none)
hMLed:  db                         ; cards of the suit led, as slot bits
hMTrump: db                        ; trumps
hMHigh: db                         ; trumps above hBest
hBit:   db
hKey:   db
hP:     db
hT:     db                         ; ScoreDeal: the bidders' team
hTmp:   ds 2

; ---------------------------------------------------------------------------- vectors
SECTION "VBlank interrupt", ROM0[$40]
    jp VBlankIsr

SECTION "Serial interrupt", ROM0[$58]
    jp SerialIsr

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
    ld hl, DmaRoutine
    ld de, hDma
    ld bc, DmaRoutineEnd - DmaRoutine
    call Copy
    ld hl, $C000                   ; all variables 0, the screen blank (TILE_BLANK is 0)
    ld bc, $DE00 - $C000
    xor a
    call Fill
    ld hl, _SCRN0
    ld bc, 32 * 32
    call Fill
    call ClearQueue
    call hDma                      ; no sprites
    ld a, %11100100                ; shades 3 2 1 0
    ldh [rBGP], a
    ld a, %10110000                ; sprites: colour 1 white, 2 black
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
    xor a                          ; listen to the adapter
    ldh [rSB], a
    ld a, $80
    ldh [rSC], a
    ld a, IE_VBLANK | IE_SERIAL
    ldh [rIE], a
    xor a
    ldh [rIF], a
    ei

; One game tick per adapter packet (Tick, from the packets SerialIsr queues), then this
; Game Boy's screen is built (Render, BuildQueue) for the next VBlank to copy.
MainLoop:
    halt
    nop
.packet:
    ld a, [wQTail]
    ld b, a
    ld a, [wQHead]
    cp b
    jr z, .render
    ld a, b                        ; copy packet wQTail to wIn
    add a
    add a
    ld e, a
    ld d, 0
    ld hl, wPackets
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
    jr .packet
.render:
    ld a, [wQueueReady]
    and a
    jr nz, MainLoop
    call Render
    call BuildQueue
    ld a, 1
    ld [wQueueReady], a
    call PlaySound
    jr MainLoop

; In VBlank: the screen changes Render queued (always QUEUE_LEN tile writes) and the
; sprites, then my buttons for the next packet.
VBlankIsr:
    push af
    push bc
    push de
    push hl
    ei                             ; the link must not wait for drawing
    ld a, [wQueueReady]
    and a
    jr z, .pad
    call hDma
    ld hl, wQueue
    ld b, QUEUE_LEN
.draw:
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    ld a, [hl+]
    ld [de], a
    dec b
    jr nz, .draw
    xor a
    ld [wQueueReady], a
.pad:
    call ReadJoypad
    cp $FF                         ; never $FF: that would end the game packets
    jr nz, .keep
    ld a, $7F
.keep:
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

; ---------------------------------------------------------------------------- link
; Sky Hop's 4-Player Adapter link (see skyhop/main.asm): ping answers, player 1's START
; starts the game, then packets of everybody's button byte, queued for MainLoop.
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
    ld hl, wPackets
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

INCLUDE "game.asm"
INCLUDE "render.asm"
INCLUDE "util.asm"
