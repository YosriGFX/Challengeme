; CHESS: two players on the link cable, full rules, a chess clock per player.
;
; - Every legal move: castling, en passant, promotion (always to a queen), no move that
;   leaves your own king in check.
; - A game ends by checkmate (a round win), or a draw: stalemate, 50 moves without a
;   capture or pawn move, or not enough pieces left to mate. Whoever runs out of time
;   loses, unless the other player cannot mate any more (then it is a draw).
; - Colours: the server picks who is white in the first game (a random byte it writes to
;   $C003), then the colours swap every game. Each Game Boy shows the board from its own
;   player's side.
; - Controls: the d-pad moves your cursor, A picks one of your pieces (dots show where
;   it can go) and A again on a dot moves it; B lets go of the piece.
; - Round wins at $C000 (mine) and $C001 (theirs); the server's choice of round wins for
;   the match at $C002. Between games both players press START.
;
; Lockstep: both Game Boys run the whole game from both players' buttons, swapped over
; the cable every frame (Coin Duel's handshake and Exchange). Each frame does a bounded
; amount of work, so both always reach the next frame's exchange together: the legal
; moves of a new position are found over a few frames (GenStep).
;
; Build, translate and test from rom_maker/: python3 tools/build.py chess

INCLUDE "hardware.inc"
INCLUDE "tiles.asm"

DEF WINS_TO_MATCH EQU 1            ; round wins for the match when the server sets none
DEF CLOCK_MINUTES EQU 5            ; each player's time per game (1-9)
DEF INTRO_FRAMES  EQU 90           ; after the handshake, before the first game
DEF TESTS_PER_FRAME EQU 5          ; moves checked for legality per frame
DEF HELLO         EQU $A5

; Pieces on the board: type in bits 0-2, BLACK for black. OFF marks the border.
DEF PAWN   EQU 1
DEF KNIGHT EQU 2
DEF BISHOP EQU 3
DEF ROOK   EQU 4
DEF QUEEN  EQU 5
DEF KING   EQU 6
DEF BLACK  EQU 8
DEF OFF    EQU $FF

; The board is a 10 x 12 "mailbox": square = 21 + file + 10 * rank (a1 = 21, h1 = 28,
; a8 = 91, h8 = 98), with a border of OFF around it so moves never leave the table.
DEF SQ_A1 EQU 21
DEF SQ_B1 EQU 22
DEF SQ_C1 EQU 23
DEF SQ_D1 EQU 24
DEF SQ_E1 EQU 25
DEF SQ_F1 EQU 26
DEF SQ_G1 EQU 27
DEF SQ_H1 EQU 28
DEF SQ_A8 EQU 91
DEF SQ_B8 EQU 92
DEF SQ_C8 EQU 93
DEF SQ_D8 EQU 94
DEF SQ_E8 EQU 95
DEF SQ_F8 EQU 96
DEF SQ_G8 EQU 97
DEF SQ_H8 EQU 98

; Castling rights (wCastle)
DEF CASTLE_WK EQU 1
DEF CASTLE_WQ EQU 2
DEF CASTLE_BK EQU 4
DEF CASTLE_BQ EQU 8

; wPhase
DEF PHASE_INTRO EQU 0
DEF PHASE_PLAY  EQU 1
DEF PHASE_WAIT  EQU 2              ; game over, waiting for START from both
DEF PHASE_OVER  EQU 3              ; match over

; wGenState
DEF GEN_WAIT  EQU 0                ; a frame to draw the new position first
DEF GEN_START EQU 1
DEF GEN_TEST  EQU 2
DEF GEN_DONE  EQU 3

; wReason: how the last game ended
DEF END_MATE      EQU 1
DEF END_STALEMATE EQU 2
DEF END_FIFTY     EQU 3
DEF END_MATERIAL  EQU 4
DEF END_TIME      EQU 5

DEF QUEUE_LEN EQU 40               ; screen tiles written per frame
DEF DUMMY_VRAM EQU _SCRN0 + 32 * 20  ; an unseen map row for unused queue entries
DEF DIFF_PER_FRAME EQU 192         ; screen bytes compared per frame (3 frames for all)
DEF SCREEN_SIZE EQU 32 * 18        ; wWant and wShown are laid out like the map

; ---------------------------------------------------------------------------- RAM
; The server reads $C000 and $C001 on both Game Boys, writes the round wins for the
; match to $C002 (game.json "bestAt") and two random bytes to $C003 ("seedAt").
SECTION "Results", WRAM0[$C000]
wMyWins::    db                    ; $C000: games won by this Game Boy's player
wTheirWins:: db                    ; $C001: games won by the other player
wBest::      db                    ; $C002: round wins that win the match, 0 = WINS_TO_MATCH
wSeedIn::    ds 2                  ; $C003: random bytes from the server

SECTION "State", WRAM0[$C010]
wPlayer:   db                      ; 1 or 2: this Game Boy's player (the only state that differs)
wSeed:     ds 2                    ; player 1's seed from the handshake
wMyPad:    db
wPad1:     db                      ; this frame's buttons of player 1 and 2
wPad2:     db
wLast1:    db                      ; last frame's, to see new presses
wLast2:    db
wPhase:    db
wTimer:    db
wWhite:    db                      ; the player (1 or 2) who has white this game
wSide:     db                      ; side to move: 0 white, BLACK black
wCastle:   db
wEp:       db                      ; square a pawn can take en passant on, or 0
wHalf:     db                      ; moves since the last capture or pawn move
wKingW:    db
wKingB:    db
wClockW:   ds 3                    ; frames left in this second, seconds, minutes
wClockB:   ds 3
wGenState: db
wGenIdx:   db                      ; next pseudo-legal move to test
wPseudo:   db                      ; pseudo-legal moves found
wCount:    db                      ; legal moves found (wFrom/wTo 0 .. wCount - 1)
wInCheck:  db                      ; the side to move is in check
wReason:   db
wWinner:   db                      ; player who won the last game, 0 = draw
wScore1:   db
wScore2:   db
wReady1:   db
wReady2:   db
wPl1:      ds 4                    ; per player: cursor file, rank, selected square, repeat
wPl2:      ds 4
wLastFrom: db                      ; the last move, for the marks
wLastTo:   db
wBoardDirty: db
wMyColor:  db                      ; this Game Boy's colour: 0 or BLACK (the board's side)
wDiffPos:  dw                      ; where BuildQueue goes on comparing the screens
wSound:    db                      ; sound to play at the end of the frame

DEF PL_FILE EQU 0
DEF PL_RANK EQU 1
DEF PL_SEL  EQU 2
DEF PL_REP  EQU 3

SECTION "OAM buffer", WRAM0[$C100]
wOAM: ds 160

SECTION "Board", WRAM0[$C200]
wBoard: ds 120

SECTION "Move from", WRAM0[$C300]
wFrom: ds 256
SECTION "Move to", WRAM0[$C400]
wTo:   ds 256

SECTION "Queue", WRAM0[$C500]
wQueue: ds QUEUE_LEN * 3           ; VRAM address (little-endian), tile

; The screen as it should look (wWant) and as it was sent to VRAM (wShown): 18 rows of
; 32 tiles like the map (only 20 are seen), so wWant + i is VRAM $9800 + i and wShown
; is wWant with bit 2 of the high byte set.
SECTION "Want", WRAMX[$D000]
wWant:  ds SCREEN_SIZE
SECTION "Shown", WRAMX[$D400]
wShown: ds SCREEN_SIZE

SECTION "HRAM", HRAM
hDma:     ds 10                    ; the OAM DMA routine, copied here at start
hSide:    db
hMoved:   db
hCaptured: db
hEpSq:    db
hEpPawn:  db
hLegal:   db
hX:       db
hY:       db
hSq:      db
hRowSq:   db
hStep:    db
hRowStep: db
hNew:     db
hMove:    db
hMat:     ds 4                     ; heavy white, minors white, heavy black, minors black

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
    ld hl, DmaRoutine
    ld de, hDma
    ld bc, DmaRoutineEnd - DmaRoutine
    call Copy
    ld hl, $C000                   ; all variables 0, both screens blank (TILE_BLANK is 0)
    ld bc, $DE00 - $C000
    xor a
    call Fill
    ld hl, _SCRN0
    ld bc, 32 * 32
    call Fill
    call ClearQueue
    call ResetDiff
    call hDma                      ; no sprites
    ld a, %11100100                ; shades 3 2 1 0
    ldh [rBGP], a
    ld a, %10110000                ; sprites: colour 1 white, 2 black, 3 dark grey
    ldh [rOBP0], a
    ld a, %01001100                ; inverted: colour 1 black, 2 white
    ldh [rOBP1], a
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
    ld a, PHASE_INTRO
    ld [wPhase], a
    ld a, INTRO_FRAMES
    ld [wTimer], a
MainLoop:
    halt                           ; wait for the next frame
    nop
    call Draw                      ; in VBlank, the same time on both Game Boys
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
    call Render
    call BuildQueue
    call PlaySound
    ld a, [wPad1]
    ld [wLast1], a
    ld a, [wPad2]
    ld [wLast2], a
    jr MainLoop

; ---------------------------------------------------------------------------- link
; Coin Duel's handshake: whoever presses START first is player 1 (the server's start
; script presses it on Game Boy 1) and sends a seed byte to player 2.
Handshake:
.listen:
    xor a
    ldh [rSB], a
    ld a, $80
    ldh [rSC], a
.wait:
    halt
    nop
    ldh a, [rSC]
    bit 7, a
    jr z, .received
    call ReadJoypad
    and PAD_START
    jr z, .wait
    xor a
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
    and a
    jr nz, .listen
    ld a, 1
    ld [wPlayer], a
    halt
    nop
    halt
    nop
    ldh a, [rDIV]
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
    ld a, $80
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

; ---------------------------------------------------------------------------- game flow
; One frame of the game from both players' buttons; the same on both Game Boys.
Update:
    ld a, [wPhase]
    cp PHASE_INTRO
    jr z, .intro
    cp PHASE_PLAY
    jr z, .play
    cp PHASE_WAIT
    jp z, WaitStart
    ret
.intro:
    ld hl, wTimer
    dec [hl]
    ret nz
    ld a, [wSeedIn]                ; who is white first: the server's random byte
    ld b, a
    ld a, [wSeedIn + 1]
    xor b
    ld b, a
    ld a, [wSeed]
    xor b
    and 1
    inc a
    ld [wWhite], a
    jp NewGame
.play:
    ld c, 1
    call Input
    ld a, [wPhase]
    cp PHASE_PLAY
    ret nz
    ld c, 2
    call Input
    ld a, [wPhase]
    cp PHASE_PLAY
    ret nz
    call GenStep
    ld a, [wPhase]
    cp PHASE_PLAY
    ret nz
    jp Tick

; Between games: each player presses START; then the next game, colours swapped.
WaitStart:
    ld a, [wLast1]
    cpl
    ld b, a
    ld a, [wPad1]
    and b
    and PAD_START
    jr z, .notReady1
    ld a, 1
    ld [wReady1], a
.notReady1:
    ld a, [wLast2]
    cpl
    ld b, a
    ld a, [wPad2]
    and b
    and PAD_START
    jr z, .notReady2
    ld a, 1
    ld [wReady2], a
.notReady2:
    ld a, [wReady1]
    ld b, a
    ld a, [wReady2]
    and b
    ret z
    ld a, [wWhite]                 ; colours swap
    xor 3
    ld [wWhite], a
    ; fall through

; A new game: pieces in place, clocks full, white to move.
NewGame:
    ld hl, StartBoard
    ld de, wBoard
    ld bc, 120
    call Copy
    xor a
    ld [wSide], a
    ld [wEp], a
    ld [wHalf], a
    ld [wLastFrom], a
    ld [wLastTo], a
    ld [wInCheck], a
    ld [wReason], a
    ld [wWinner], a
    ld [wReady1], a
    ld [wReady2], a
    ld a, CASTLE_WK | CASTLE_WQ | CASTLE_BK | CASTLE_BQ
    ld [wCastle], a
    ld a, SQ_E1
    ld [wKingW], a
    ld a, SQ_E8
    ld [wKingB], a
    ld hl, wClockW
    call FullClock
    ld hl, wClockB
    call FullClock
    ld c, 1                        ; cursors on the king's pawn
    call PlayerStruct
    call PlaceCursor
    ld c, 2
    call PlayerStruct
    call PlaceCursor
    ld a, [wWhite]                 ; this Game Boy's side of the board
    ld b, a
    ld a, [wPlayer]
    cp b
    ld a, 0
    jr z, .white
    ld a, BLACK
.white:
    ld [wMyColor], a
    ld a, 1
    ld [wBoardDirty], a
    ld a, GEN_WAIT
    ld [wGenState], a
    ld a, PHASE_PLAY
    ld [wPhase], a
    ret

; hl = a clock: full time.
FullClock:
    ld a, 60
    ld [hl+], a
    xor a
    ld [hl+], a
    ld a, CLOCK_MINUTES
    ld [hl], a
    ret

; hl = player c's struct: cursor on e2 (white) or e7 (black), nothing selected.
PlaceCursor:
    ld a, 4
    ld [hl+], a
    call ColourOf                  ; a = 0 or BLACK for player c
    and a
    ld a, 1
    jr z, .rank
    ld a, 6
.rank:
    ld [hl+], a
    xor a
    ld [hl+], a
    ld [hl], a
    ret

; a = player c's colour this game (0 or BLACK). Keeps bc, de, hl.
ColourOf:
    ld a, [wWhite]
    cp c
    ld a, 0
    ret z
    ld a, BLACK
    ret

; hl = player c's struct (wPl1 / wPl2). Keeps bc, de.
PlayerStruct:
    ld hl, wPl1
    ld a, c
    cp 1
    ret z
    ld hl, wPl2
    ret

; a = the player (1 or 2) whose colour is in a (0 or BLACK).
PlayerOf:
    and a
    ld a, [wWhite]
    ret z
    xor 3
    ret

; Player c's buttons: cursor, picking a piece, moving it.
Input:
    call PlayerStruct
    ld a, c
    cp 1
    jr nz, .p2
    ld a, [wLast1]
    cpl
    ld b, a
    ld a, [wPad1]
    jr .pads
.p2:
    ld a, [wLast2]
    cpl
    ld b, a
    ld a, [wPad2]
.pads:
    ld d, a                        ; d = held
    and b
    ldh [hNew], a                  ; new presses
    ; d-pad, with repeat while held: first after 18 frames, then every 4
    push hl
    inc hl
    inc hl
    inc hl                         ; hl = repeat counter
    ld a, d
    and $F0
    jr nz, .held
    ld [hl], a
    jr .move
.held:
    ldh a, [hNew]
    and $F0
    jr z, .repeat
    ld [hl], 0
    jr .move
.repeat:
    inc [hl]
    ld a, [hl]
    cp 18
    jr nz, .noMove
    ld [hl], 14
    ld a, d
    and $F0
    jr .move
.noMove:
    xor a
.move:
    pop hl
    ldh [hMove], a
    call MoveCursor
.buttons:
    ldh a, [hNew]
    and PAD_B
    jr z, .notB
    inc hl
    inc hl
    ld [hl], 0                     ; let go of the piece
    dec hl
    dec hl
.notB:
    ldh a, [hNew]
    and PAD_A
    ret z
    ld a, [wGenState]              ; still finding the legal moves
    cp GEN_DONE
    ret nz
    call ColourOf
    ld b, a
    ld a, [wSide]
    cp b
    ret nz                         ; not this player's turn
    ; e = the square under the cursor
    ld a, [hl+]                    ; file
    ld e, a
    ld a, [hl+]                    ; rank
    ld d, a
    add a                          ; 10 * rank = 8 * rank + 2 * rank
    add a
    add a
    add d
    add d
    add e
    add SQ_A1
    ld e, a
    ld a, [hl]                     ; selected square
    and a
    jr z, .pick
    ld d, a
    call FindMove                  ; d -> e legal?
    jr nc, .pick
    xor a
    ld [wPl1 + PL_SEL], a
    ld [wPl2 + PL_SEL], a
    jp MakeMove
.pick:
    ld a, [hl]                     ; A on the selected piece again: let go
    cp e
    jr z, .letGo
    push hl
    ld h, HIGH(wBoard)
    ld l, e
    ld a, [hl]
    pop hl
    and a
    jr z, .letGo
    cp OFF
    jr z, .letGo
    and BLACK
    cp b
    jr nz, .letGo
    ld [hl], e
    ret
.letGo:
    ld [hl], 0
    ret

; Moves the cursor of the struct at hl by the d-pad bits in hMove, from that player's
; side of the board (c = player). Keeps c, hl.
MoveCursor:
    ldh a, [hMove]
    and a
    ret z
    call ColourOf
    ld b, a                        ; 0 white, BLACK black: black's view is turned around
    ldh a, [hMove]
    and PAD_RIGHT
    jr z, .notRight
    ld a, b
    and a
    call z, FileUp
    call nz, FileDown
.notRight:
    ldh a, [hMove]
    and PAD_LEFT
    jr z, .notLeft
    ld a, b
    and a
    call z, FileDown
    call nz, FileUp
.notLeft:
    inc hl
    ldh a, [hMove]
    and PAD_UP
    jr z, .notUp
    ld a, b
    and a
    call z, FileUp
    call nz, FileDown
.notUp:
    ldh a, [hMove]
    and PAD_DOWN
    jr z, .notDown
    ld a, b
    and a
    call z, FileDown
    call nz, FileUp
.notDown:
    dec hl
    ret

; [hl] + 1 up to 7, or - 1 down to 0. Both keep the Z flag as it came in (so the
; `call z` / `call nz` pairs above run exactly one of them).
FileUp:
    push af
    ld a, [hl]
    cp 7
    jr z, .done
    inc [hl]
.done:
    pop af
    ret
FileDown:
    push af
    ld a, [hl]
    and a
    jr z, .done
    dec [hl]
.done:
    pop af
    ret

; Carry set if d -> e is in the legal move list. Keeps bc, de, hl.
FindMove:
    push bc
    push hl
    ld a, [wCount]
    and a
    jr z, .no
    ld b, a
    ld l, 0
.loop:
    ld h, HIGH(wFrom)
    ld a, [hl]
    cp d
    jr nz, .next
    ld h, HIGH(wTo)
    ld a, [hl]
    cp e
    jr z, .yes
.next:
    inc l
    dec b
    jr nz, .loop
.no:
    pop hl
    pop bc
    and a
    ret
.yes:
    pop hl
    pop bc
    scf
    ret

; The side to move's clock loses one frame; at 0:00 its player has lost on time.
Tick:
    ld a, [wSide]
    and a
    ld hl, wClockW
    jr z, .clock
    ld hl, wClockB
.clock:
    dec [hl]                       ; frames in this second
    ret nz
    ld [hl], 60
    inc hl
    ld a, [hl]
    and a
    jr nz, .second
    ld [hl], 59                    ; x:00 -> (x - 1):59
    inc hl
    dec [hl]
    ret
.second:
    dec [hl]
    ret nz
    inc hl
    ld a, [hl]                     ; 0:00?
    and a
    ret nz
    ; Out of time: the other side wins, if it still has pieces that can mate.
    call Material
    ld a, [wSide]
    and a
    ld hl, hMat + 2                ; the other side's: black's
    jr z, .other
    ld hl, hMat
.other:
    ld a, [hl+]                    ; pawns, rooks or queens: can mate
    and a
    jr nz, .wins
    ld a, [hl]                     ; two minor pieces or more: can mate
    cp 2
    jr nc, .wins
    xor a                          ; a lone king, or king and one minor piece: draw
    jr .end
.wins:
    ld a, [wSide]
    xor BLACK
    call PlayerOf
.end:
    ld [wWinner], a
    ld a, END_TIME
    ld [wReason], a
    jp EndGame

; Counts pieces into hMat: for white then black, "heavy" pieces (pawns, rooks, queens)
; and minor pieces (knights, bishops).
Material:
    xor a
    ld hl, hMat
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld d, HIGH(wBoard)
    ld e, SQ_A1
.loop:
    ld a, [de]
    and a
    jr z, .next
    cp OFF
    jr z, .next
    ld hl, hMat
    bit 3, a
    jr z, .white
    inc hl
    inc hl
.white:
    and 7
    cp KNIGHT
    jr z, .minor
    cp BISHOP
    jr z, .minor
    cp KING
    jr z, .next
    inc [hl]                       ; heavy
    jr .next
.minor:
    inc hl
    inc [hl]
.next:
    inc e
    ld a, e
    cp SQ_H8 + 1
    jr c, .loop
    ret

; The game is over: wReason and wWinner say how. Counts the win and waits for START
; (or ends the match).
EndGame:
    xor a
    ld [wReady1], a
    ld [wReady2], a
    ld [wPl1 + PL_SEL], a
    ld [wPl2 + PL_SEL], a
    ld a, PHASE_WAIT
    ld [wPhase], a
    ld a, 4                        ; the end-of-game sound
    ld [wSound], a
    ld a, [wWinner]
    and a
    ret z                          ; draw
    ld hl, wScore1
    cp 1
    jr z, .count
    ld hl, wScore2
.count:
    inc [hl]
    call SetResults
    call Best
    ld b, a
    ld a, [wScore1]
    cp b
    jr nc, .over
    ld a, [wScore2]
    cp b
    ret c
.over:
    ld a, PHASE_OVER
    ld [wPhase], a
    ret

; a = round wins that win the match: the server's choice, or WINS_TO_MATCH.
Best:
    ld a, [wBest]
    and a
    ret nz
    ld a, WINS_TO_MATCH
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

; ---------------------------------------------------------------------------- moves
; Finds the legal moves of the side to move over a few frames: first every
; pseudo-legal move (GenPseudo), then TESTS_PER_FRAME of them per frame are kept if they
; do not leave the king in check. Then decides whether the game is over.
GenStep:
    ld a, [wGenState]
    cp GEN_WAIT
    jr nz, .notWait
    ld a, GEN_START
    ld [wGenState], a
    ret
.notWait:
    cp GEN_START
    jr nz, .test
    call GenPseudo
    xor a
    ld [wGenIdx], a
    ld [wCount], a
    ld a, GEN_TEST
    ld [wGenState], a
    ret
.test:
    cp GEN_TEST
    ret nz
    ld b, TESTS_PER_FRAME
.loop:
    ld a, [wGenIdx]
    ld hl, wPseudo
    cp [hl]
    jr z, .done
    ld l, a
    ld h, HIGH(wFrom)
    ld d, [hl]
    ld h, HIGH(wTo)
    ld e, [hl]
    inc a
    ld [wGenIdx], a
    push bc
    call Legal
    pop bc
    jr z, .next
    ld a, [wCount]                 ; keep it (in place: wCount <= wGenIdx)
    ld l, a
    inc a
    ld [wCount], a
    ld h, HIGH(wFrom)
    ld [hl], d
    ld h, HIGH(wTo)
    ld [hl], e
.next:
    dec b
    jr nz, .loop
    ret
.done:
    ld a, GEN_DONE
    ld [wGenState], a
    ; in check?
    ld a, [wSide]
    and a
    ld a, [wKingW]
    jr z, .king
    ld a, [wKingB]
.king:
    ld c, a
    ld a, [wSide]
    xor BLACK
    ld b, a
    call IsAttacked
    ld a, 0
    rla
    ld [wInCheck], a
    and a
    jr z, .noCheck
    ld a, 3                        ; check sound
    ld [wSound], a
.noCheck:
    ld a, [wCount]
    and a
    jr nz, .moves
    ld a, [wInCheck]               ; no legal move: checkmate or stalemate
    and a
    jr z, .stalemate
    ld a, END_MATE
    ld [wReason], a
    ld a, [wSide]
    xor BLACK
    call PlayerOf
    ld [wWinner], a
    jp EndGame
.stalemate:
    ld a, END_STALEMATE
    jr .draw
.moves:
    ld a, [wHalf]                  ; 50 moves each without a capture or pawn move
    cp 100
    jr c, .material
    ld a, END_FIFTY
    jr .draw
.material:
    call Material                  ; neither side can mate any more?
    ld a, [hMat]
    ld b, a
    ld a, [hMat + 2]
    or b
    ret nz                         ; pawns, rooks or queens left
    ld a, [hMat + 1]
    ld b, a
    ld a, [hMat + 3]
    add b
    cp 2
    ret nc                         ; two or more minor pieces left
    ld a, END_MATERIAL
.draw:
    ld [wReason], a
    xor a
    ld [wWinner], a
    jp EndGame

; Every pseudo-legal move of the side to move into wFrom/wTo (count in wPseudo).
GenPseudo:
    xor a
    ld [wPseudo], a
    ld a, [wSide]
    ldh [hSide], a
    ld c, SQ_A1
.square:
    ld h, HIGH(wBoard)
    ld l, c
    ld a, [hl]
    and a
    jr z, .next
    cp OFF
    jr z, .next
    ld b, a
    and BLACK
    ld d, a
    ldh a, [hSide]
    cp d
    jr nz, .next
    ld a, b
    and 7
    cp PAWN
    jr nz, .notPawn
    call GenPawn
    jr .next
.notPawn:
    cp KNIGHT
    jr nz, .notKnight
    ld hl, KnightOffsets
    call GenJumps
    jr .next
.notKnight:
    cp BISHOP
    jr nz, .notBishop
    ld hl, DiagonalDirs
    call GenRays
    jr .next
.notBishop:
    cp ROOK
    jr nz, .notRook
    ld hl, StraightDirs
    call GenRays
    jr .next
.notRook:
    cp QUEEN
    jr nz, .king
    ld hl, DiagonalDirs
    call GenRays
    ld hl, StraightDirs
    call GenRays
    jr .next
.king:
    ld hl, KingOffsets
    call GenJumps
    call GenCastling
.next:
    inc c
    ld a, c
    cp SQ_H8 + 1
    jr c, .square
    ret

; Adds c -> e to the pseudo-legal moves. Keeps bc, de; leaves h = HIGH(wBoard).
AddMove:
    ld a, [wPseudo]
    cp 255
    jr z, .full
    ld l, a
    inc a
    ld [wPseudo], a
    ld h, HIGH(wFrom)
    ld [hl], c
    ld h, HIGH(wTo)
    ld [hl], e
.full:
    ld h, HIGH(wBoard)
    ret

; Moves from c by each offset in the 0-ended table at hl, one step each. Keeps c.
GenJumps:
    ld a, [hl+]
    and a
    ret z
    push hl
    ld d, a
    ld a, c
    add d
    ld e, a
    call Target                    ; a = 1 empty, 2 enemy, 0 own or off the board
    and a
    call nz, AddMove
    pop hl
    jr GenJumps

; Slides from c along each direction in the 0-ended table at hl. Keeps c.
GenRays:
    ld a, [hl+]
    and a
    ret z
    push hl
    ld d, a
    ld e, c
.step:
    ld a, e
    add d
    ld e, a
    call Target
    and a
    jr z, .end
    push af
    call AddMove
    pop af
    cp 1
    jr z, .step                    ; empty: go on
.end:
    pop hl
    jr GenRays

; What is on square e for the side to move: a = 1 empty, 2 enemy, 0 own piece or off
; the board. Keeps bc, de.
Target:
    ld h, HIGH(wBoard)
    ld l, e
    ld a, [hl]
    and a
    jr z, .empty
    cp OFF
    jr z, .no
    and BLACK
    ld l, a
    ldh a, [hSide]
    cp l
    jr z, .no
    ld a, 2
    ret
.empty:
    ld a, 1
    ret
.no:
    xor a
    ret

; Pawn moves from c: one or two squares ahead, captures, en passant.
GenPawn:
    ldh a, [hSide]
    and a
    jr nz, .black
    ld a, c                        ; white: up the board
    add 10
    ld e, a
    call Target
    cp 1
    jr nz, .whiteCaptures
    call AddMove
    ld a, c
    cp SQ_A1 + 10                  ; on rank 2?
    jr c, .whiteCaptures
    cp SQ_H1 + 11
    jr nc, .whiteCaptures
    ld a, c
    add 20
    ld e, a
    call Target
    cp 1
    call z, AddMove
.whiteCaptures:
    ld a, c
    add 9
    ld e, a
    call PawnCapture
    ld a, c
    add 11
    ld e, a
    jr PawnCapture
.black:
    ld a, c                        ; black: down the board
    sub 10
    ld e, a
    call Target
    cp 1
    jr nz, .blackCaptures
    call AddMove
    ld a, c
    cp SQ_A8 - 10                  ; on rank 7?
    jr c, .blackCaptures
    cp SQ_H8 - 9
    jr nc, .blackCaptures
    ld a, c
    sub 20
    ld e, a
    call Target
    cp 1
    call z, AddMove
.blackCaptures:
    ld a, c
    sub 9
    ld e, a
    call PawnCapture
    ld a, c
    sub 11
    ld e, a
    ; fall through

; A pawn on c takes on e: an enemy piece there, or the en passant square.
PawnCapture:
    ld a, [wEp]
    and a
    jr z, .normal
    cp e
    jp z, AddMove
.normal:
    call Target
    cp 2
    ret nz
    jp AddMove

; Castling for the king on c, if allowed: the rights, empty squares between, and the
; king neither in check nor passing an attacked square (where it lands is tested like
; any other move).
GenCastling:
    ldh a, [hSide]
    and a
    jr nz, .black
    ld a, c
    cp SQ_E1
    ret nz
    ld a, [wCastle]
    and CASTLE_WK
    jr z, .whiteLong
    ld a, [wBoard + SQ_F1]
    ld b, a
    ld a, [wBoard + SQ_G1]
    or b
    jr nz, .whiteLong
    ld a, [wBoard + SQ_H1]
    cp ROOK
    jr nz, .whiteLong
    ld a, SQ_F1
    call SafePath
    jr c, .whiteLong
    ld e, SQ_G1
    call AddMove
.whiteLong:
    ld a, [wCastle]
    and CASTLE_WQ
    ret z
    ld a, [wBoard + SQ_D1]
    ld b, a
    ld a, [wBoard + SQ_C1]
    or b
    ld b, a
    ld a, [wBoard + SQ_B1]
    or b
    ret nz
    ld a, [wBoard + SQ_A1]
    cp ROOK
    ret nz
    ld a, SQ_D1
    call SafePath
    ret c
    ld e, SQ_C1
    jp AddMove
.black:
    ld a, c
    cp SQ_E8
    ret nz
    ld a, [wCastle]
    and CASTLE_BK
    jr z, .blackLong
    ld a, [wBoard + SQ_F8]
    ld b, a
    ld a, [wBoard + SQ_G8]
    or b
    jr nz, .blackLong
    ld a, [wBoard + SQ_H8]
    cp ROOK | BLACK
    jr nz, .blackLong
    ld a, SQ_F8
    call SafePath
    jr c, .blackLong
    ld e, SQ_G8
    call AddMove
.blackLong:
    ld a, [wCastle]
    and CASTLE_BQ
    ret z
    ld a, [wBoard + SQ_D8]
    ld b, a
    ld a, [wBoard + SQ_C8]
    or b
    ld b, a
    ld a, [wBoard + SQ_B8]
    or b
    ret nz
    ld a, [wBoard + SQ_A8]
    cp ROOK | BLACK
    ret nz
    ld a, SQ_D8
    call SafePath
    ret c
    ld e, SQ_C8
    jp AddMove

; Carry set if the king's square c or the square it passes (a) is attacked by the
; other side. Keeps c.
SafePath:
    push bc
    push af
    ldh a, [hSide]
    xor BLACK
    ld b, a
    call IsAttacked                ; the king's square
    jr c, .attacked
    pop af
    ld c, a
    call IsAttacked                ; the square it passes
    pop bc
    ret
.attacked:
    pop af
    pop bc
    scf
    ret

; Nonzero (NZ) if the move d -> e of the side to move does not leave its own king in
; check. Makes the move on the board, looks, and puts everything back. Keeps de.
Legal:
    ld h, HIGH(wBoard)
    ld l, d
    ld a, [hl]
    ldh [hMoved], a
    ld l, e
    ld a, [hl]
    ldh [hCaptured], a
    xor a
    ldh [hEpSq], a
    ldh a, [hMoved]                ; en passant: the taken pawn leaves its square too
    and 7
    cp PAWN
    jr nz, .make
    ld a, [wEp]
    and a
    jr z, .make
    cp e
    jr nz, .make
    ld a, [wSide]
    and a
    ld a, e
    jr nz, .blackEp
    sub 20
.blackEp:
    add 10                         ; white: e - 10; black: e + 10
    ldh [hEpSq], a
    ld l, a
    ld a, [hl]
    ldh [hEpPawn], a
    ld [hl], 0
.make:
    ld l, e
    ldh a, [hMoved]
    ld [hl], a
    ld l, d
    ld [hl], 0
    ldh a, [hMoved]
    and 7
    cp KING
    jr nz, .notKing
    ld c, e
    jr .look
.notKing:
    ld a, [wSide]
    and a
    ld a, [wKingW]
    jr z, .king
    ld a, [wKingB]
.king:
    ld c, a
.look:
    ld a, [wSide]
    xor BLACK
    ld b, a
    push de
    call IsAttacked
    pop de
    ccf
    ld a, 0
    rla
    ldh [hLegal], a
    ld h, HIGH(wBoard)
    ld l, d
    ldh a, [hMoved]
    ld [hl], a
    ld l, e
    ldh a, [hCaptured]
    ld [hl], a
    ldh a, [hEpSq]
    and a
    jr z, .done
    ld l, a
    ldh a, [hEpPawn]
    ld [hl], a
.done:
    ldh a, [hLegal]
    and a
    ret

; Carry set if square c is attacked by colour b (0 or BLACK). Keeps bc; h = HIGH(wBoard).
IsAttacked:
    ld h, HIGH(wBoard)
    ld a, b                        ; pawns: white ones attack up, black ones down
    and a
    jr nz, .blackPawns
    ld a, c
    sub 9
    ld l, a
    ld a, [hl]
    cp PAWN
    jr z, .yes
    dec l
    dec l
    ld a, [hl]
    cp PAWN
    jr z, .yes
    jr .knights
.blackPawns:
    ld a, c
    add 9
    ld l, a
    ld a, [hl]
    cp PAWN | BLACK
    jr z, .yes
    inc l
    inc l
    ld a, [hl]
    cp PAWN | BLACK
    jr z, .yes
.knights:
    ld de, KnightOffsets
.knight:
    ld a, [de]
    and a
    jr z, .kings
    add c
    ld l, a
    ld a, [hl]
    xor b                          ; the attacker's colour gives the bare type
    cp KNIGHT
    jr z, .yes
    inc de
    jr .knight
.kings:
    ld de, KingOffsets
.king:
    ld a, [de]
    and a
    jr z, .diagonals
    add c
    ld l, a
    ld a, [hl]
    xor b
    cp KING
    jr z, .yes
    inc de
    jr .king
.diagonals:
    ld de, DiagonalDirs
.diagonal:
    ld a, [de]
    and a
    jr z, .straights
    ld l, c
.diagonalStep:
    ld a, [de]
    add l
    ld l, a
    ld a, [hl]
    and a
    jr z, .diagonalStep
    xor b
    cp BISHOP
    jr z, .yes
    cp QUEEN
    jr z, .yes
    inc de
    jr .diagonal
.straights:
    ld de, StraightDirs
.straight:
    ld a, [de]
    and a
    jr z, .no
    ld l, c
.straightStep:
    ld a, [de]
    add l
    ld l, a
    ld a, [hl]
    and a
    jr z, .straightStep
    xor b
    cp ROOK
    jr z, .yes
    cp QUEEN
    jr z, .yes
    inc de
    jr .straight
.no:
    and a
    ret
.yes:
    scf
    ret

; Plays d -> e on the board for real (a legal move): captures, en passant, castling's
; rook, promotion to a queen, castling rights, the 50-move count; then the other side.
MakeMove:
    ld h, HIGH(wBoard)
    ld l, d
    ld b, [hl]                     ; b = the piece
    ld l, e
    ld c, [hl]                     ; c = what it takes
    ld a, b
    and 7
    cp PAWN
    jr nz, .notPawn
    ld a, [wEp]                    ; en passant: take the pawn beside
    and a
    jr z, .resetHalf
    cp e
    jr nz, .resetHalf
    ld a, b
    and BLACK
    ld a, e
    jr nz, .blackEp
    sub 20
.blackEp:
    add 10
    ld l, a
    ld [hl], 0
    ld c, PAWN
    jr .resetHalf
.notPawn:
    ld a, c
    and a
    jr nz, .resetHalf
    ld hl, wHalf
    inc [hl]
    jr .halfDone
.resetHalf:
    xor a
    ld [wHalf], a
.halfDone:
    ld h, HIGH(wBoard)
    xor a                          ; a new en passant square after a double step
    ld [wEp], a
    ld a, b
    and 7
    cp PAWN
    jr nz, .noDouble
    ld a, e
    sub d
    cp 20
    jr z, .double
    cp -20 & $FF
    jr nz, .noDouble
.double:
    ld a, d
    add e
    srl a
    ld [wEp], a
.noDouble:
    ld a, b                        ; king: its square, and castling's rook
    and 7
    cp KING
    jr nz, .notKing
    ld a, b
    and BLACK
    ld a, e
    jr nz, .blackKing
    ld [wKingW], a
    jr .castling
.blackKing:
    ld [wKingB], a
.castling:
    ld a, e
    sub d
    cp 2
    jr z, .short
    cp -2 & $FF
    jr nz, .notKing
    ld a, d                        ; long: rook from d - 4 to d - 1
    sub 4
    ld l, a
    ld a, [hl]
    ld [hl], 0
    ld l, d
    dec l
    ld [hl], a
    jr .notKing
.short:
    ld a, d                        ; short: rook from d + 3 to d + 1
    add 3
    ld l, a
    ld a, [hl]
    ld [hl], 0
    ld l, d
    inc l
    ld [hl], a
.notKing:
    ld a, b                        ; promotion: a pawn on the last rank is a queen
    and 7
    cp PAWN
    jr nz, .place
    ld a, e
    cp SQ_A8
    jr nc, .promote
    cp SQ_H1 + 1
    jr nc, .place
.promote:
    ld a, b
    and BLACK
    or QUEEN
    ld b, a
.place:
    ld l, e
    ld [hl], b
    ld l, d
    ld [hl], 0
    ld a, d
    call LoseRights
    ld a, e
    call LoseRights
    ld a, d
    ld [wLastFrom], a
    ld a, e
    ld [wLastTo], a
    ld a, c                        ; sound: a take, or a move
    and a
    ld a, 2
    jr nz, .sound
    dec a
.sound:
    ld [wSound], a
    ld a, [wSide]
    xor BLACK
    ld [wSide], a
    ld a, 1
    ld [wBoardDirty], a
    ld a, GEN_WAIT
    ld [wGenState], a
    ret

; A move from or to square a loses the castling rights of a king or rook there.
LoseRights:
    ld hl, wCastle
    cp SQ_E1
    jr nz, .notE1
    ld a, [hl]
    and ~(CASTLE_WK | CASTLE_WQ)
    ld [hl], a
    ret
.notE1:
    cp SQ_H1
    jr nz, .notH1
    res 0, [hl]
    ret
.notH1:
    cp SQ_A1
    jr nz, .notA1
    res 1, [hl]
    ret
.notA1:
    cp SQ_E8
    jr nz, .notE8
    ld a, [hl]
    and ~(CASTLE_BK | CASTLE_BQ)
    ld [hl], a
    ret
.notE8:
    cp SQ_H8
    jr nz, .notH8
    res 2, [hl]
    ret
.notH8:
    cp SQ_A8
    ret nz
    res 3, [hl]
    ret

KnightOffsets:
    db -21, -19, -12, -8, 8, 12, 19, 21, 0
KingOffsets:
    db -11, -10, -9, -1, 1, 9, 10, 11, 0
DiagonalDirs:
    db -11, -9, 9, 11, 0
StraightDirs:
    db -10, -1, 1, 10, 0

StartBoard:
    ds 20, OFF
    db OFF, ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK, OFF
    db OFF, PAWN, PAWN, PAWN, PAWN, PAWN, PAWN, PAWN, PAWN, OFF
    REPT 4
    db OFF, 0, 0, 0, 0, 0, 0, 0, 0, OFF
    ENDR
    db OFF
    ds 8, PAWN | BLACK
    db OFF
    db OFF, ROOK | BLACK, KNIGHT | BLACK, BISHOP | BLACK, QUEEN | BLACK
    db KING | BLACK, BISHOP | BLACK, KNIGHT | BLACK, ROOK | BLACK, OFF
    ds 20, OFF

; ---------------------------------------------------------------------------- screen
; The screen in wWant: board (16 x 16 tiles, from this Game Boy's side), status line on
; top, hint line at the bottom, and a panel on the right: the other player at the top
; (king, clock, wins, OK), this player at the bottom. And the sprites in wOAM.
Render:
    call RenderBoard
    call RenderText
    jp RenderSprites

RenderBoard:
    ld a, [wBoardDirty]
    and a
    ret z
    xor a
    ld [wBoardDirty], a
    ld a, [wMyColor]               ; white looks from rank 1, black from rank 8
    and a
    jr nz, .black
    ld a, SQ_A8
    ldh [hRowSq], a
    ld a, 1
    ldh [hStep], a
    ld a, -10
    ldh [hRowStep], a
    jr .start
.black:
    ld a, SQ_H1
    ldh [hRowSq], a
    ld a, -1
    ldh [hStep], a
    ld a, 10
    ldh [hRowStep], a
.start:
    ld hl, wWant + 32
    xor a
    ldh [hY], a
.row:
    xor a
    ldh [hX], a
    ldh a, [hRowSq]
    ldh [hSq], a
.square:
    ld c, a
    ld b, HIGH(wBoard)
    ld a, [bc]
    ld e, a                        ; the piece
    ldh a, [hX]
    ld b, a
    ldh a, [hY]
    add b
    and 1                          ; dark square when x + y is odd
    add a
    add a
    ld d, a                        ; 4 on dark squares
    ld a, e
    and a
    jr z, .empty
    and BLACK
    add d
    ld d, a
    ld a, e
    and 7
    dec a
    swap a
    add d
    add TILE_PIECES                ; + (type - 1) * 16 + black * 8 + dark * 4
    ld c, 1
    jr .put
.empty:
    ld a, d
    rrca
    rrca
    add TILE_LIGHT
    ld c, 0
.put:
    ld [hl+], a
    add c
    ld [hl], a
    add c
    ld de, 31
    add hl, de
    ld [hl+], a
    add c
    ld [hl], a
    ld de, -31
    add hl, de
    ldh a, [hStep]
    ld b, a
    ldh a, [hSq]
    add b
    ldh [hSq], a
    ldh a, [hX]
    inc a
    ldh [hX], a
    cp 8
    ldh a, [hSq]
    jr nz, .square
    ld de, 48                      ; next row of squares: two tile rows down
    add hl, de
    ldh a, [hRowStep]
    ld b, a
    ldh a, [hRowSq]
    add b
    ldh [hRowSq], a
    ldh a, [hY]
    inc a
    ldh [hY], a
    cp 8
    jr nz, .row
    ret

DEF ROW0  EQU 0
DEF ROW17 EQU 17 * 32

RenderText:
    ; top line
    ld hl, wWant + ROW0
    call BlankLine
    ld hl, wWant + ROW0
    ld a, [wPhase]
    cp PHASE_INTRO
    jr nz, .notIntro
    ld de, TextReady
    call PutText
    jp .bottom
.notIntro:
    cp PHASE_PLAY
    jr nz, .ended
    ld a, [wSide]                  ; whose move
    ld b, a
    ld a, [wMyColor]
    cp b
    ld de, TextYourMove
    jr z, .move
    ld de, TextTheirMove
.move:
    call PutText
    ld a, [wInCheck]
    and a
    jr z, .bottom
    ld de, TextCheck
    call PutText
    jr .bottom
.ended:
    ld a, [wReason]                ; how the game ended
    ld de, TextMate
    cp END_MATE
    jr z, .reason
    ld de, TextStalemate
    cp END_STALEMATE
    jr z, .reason
    ld de, TextFifty
    cp END_FIFTY
    jr z, .reason
    ld de, TextMaterial
    cp END_MATERIAL
    jr z, .reason
    ld de, TextTime
.reason:
    call PutText
    ld a, [wWinner]
    and a
    ld de, TextDraw
    jr z, .outcome
    ld b, a
    ld a, [wPlayer]
    cp b
    ld de, TextWin
    jr z, .outcome
    ld de, TextLose
.outcome:
    call PutText
.bottom:
    ld hl, wWant + ROW17
    call BlankLine
    ld hl, wWant + ROW17
    ld a, [wPhase]
    cp PHASE_PLAY
    jr nz, .notPlay
    ld a, [wMyColor]
    and a
    ld de, TextYouWhite
    jr z, .hint
    ld de, TextYouBlack
.hint:
    call PutText
    jr .panel
.notPlay:
    cp PHASE_WAIT
    jr nz, .notWait
    ld de, TextPressStart
    call PutText
    jr .panel
.notWait:
    cp PHASE_OVER
    jr nz, .panel
    ld a, [wMyWins]
    ld b, a
    ld a, [wTheirWins]
    cp b
    ld de, TextMatchWon
    jr c, .over
    ld de, TextMatchLost
.over:
    call PutText
.panel:
    ld a, [wPhase]
    cp PHASE_INTRO
    ret z
    ; the other player, at the top
    ld a, [wPlayer]
    xor 3
    ld c, a
    ld hl, wWant + 1 * 32 + 17
    call PutKing
    ld hl, wWant + 3 * 32 + 16
    call PutClock
    ld hl, wWant + 5 * 32 + 16
    call PutWins
    ld hl, wWant + 7 * 32 + 17
    call PutReady
    ; this player, at the bottom
    ld a, [wPlayer]
    ld c, a
    ld hl, wWant + 10 * 32 + 17
    call PutReady
    ld hl, wWant + 11 * 32 + 16
    call PutWins
    ld hl, wWant + 14 * 32 + 16
    call PutClock
    ld hl, wWant + 15 * 32 + 17
    jp PutKing

; Player c's king (in their colour) as 2 x 2 tiles at hl.
PutKing:
    call ColourOf
    add (KING - 1) * 16 + TILE_PIECES
    ld [hl+], a
    inc a
    ld [hl], a
    inc a
    ld de, 31
    add hl, de
    ld [hl+], a
    inc a
    ld [hl], a
    ret

; Player c's clock as M:SS at hl, inverted while it runs.
PutClock:
    push bc
    call ColourOf
    ld de, wClockW + 1
    and a
    jr z, .clock
    ld de, wClockB + 1
.clock:
    ld b, TILE_CH_0                ; plain digits, or inverted for the clock that runs
    ld a, [wPhase]
    cp PHASE_PLAY
    jr nz, .digits
    call ColourOf
    push hl
    ld hl, wSide
    cp [hl]
    pop hl
    jr nz, .digits
    ld b, TILE_INV_0
.digits:
    inc de
    ld a, [de]                     ; minutes
    add b
    ld [hl+], a
    ld a, b                        ; ':' follows the digits in both fonts
    add 10
    ld [hl+], a
    dec de
    ld a, [de]                     ; seconds: tens and ones
    ld c, 0
.tens:
    cp 10
    jr c, .ones
    sub 10
    inc c
    jr .tens
.ones:
    ld e, a
    ld a, c
    add b
    ld [hl+], a
    ld a, e
    add b
    ld [hl], a
    pop bc
    ret

; "WINS" and player c's games won (two digits) below it, at hl.
PutWins:
    ld de, TextWins
    call PutText
    ld de, 28
    add hl, de
    ld a, c
    cp 1
    ld a, [wScore1]
    jr z, .score
    ld a, [wScore2]
.score:
    ld b, 0
.tens:
    cp 10
    jr c, .ones
    sub 10
    inc b
    jr .tens
.ones:
    ld e, a
    ld a, TILE_BLANK
    ld [hl+], a
    ld a, b
    add TILE_CH_0
    ld [hl+], a
    ld a, e
    add TILE_CH_0
    ld [hl+], a
    ld a, TILE_BLANK
    ld [hl], a
    ret

; "OK" at hl when player c pressed START between games, else blank.
PutReady:
    ld a, [wPhase]
    cp PHASE_WAIT
    jr nz, .blank
    ld a, c
    cp 1
    ld a, [wReady1]
    jr z, .ready
    ld a, [wReady2]
.ready:
    and a
    jr z, .blank
    ld a, TILE_CH_O
    ld [hl+], a
    ld [hl], TILE_CH_K
    ret
.blank:
    ld a, TILE_BLANK
    ld [hl+], a
    ld [hl], a
    ret

; 20 blank tiles from hl.
BlankLine:
    ld b, 20
    ld a, TILE_BLANK
.loop:
    ld [hl+], a
    dec b
    jr nz, .loop
    ret

; Copies the text at de (ended by EOS: 0 is the blank tile) to hl (hl ends after it).
DEF EOS EQU $FF
PutText:
    ld a, [de]
    cp EOS
    ret z
    ld [hl+], a
    inc de
    jr PutText

TextReady:      db " GET READY", EOS
TextYourMove:   db " YOUR MOVE", EOS
TextTheirMove:  db " THEIR MOVE", EOS
TextCheck:      db " - CHECK!", EOS
TextMate:       db "CHECKMATE", EOS
TextStalemate:  db "STALEMATE", EOS
TextFifty:      db "50 MOVES", EOS
TextMaterial:   db "NO MATE", EOS
TextTime:       db "TIME OUT", EOS
TextWin:        db " - YOU WIN", EOS
TextLose:       db " - YOU LOSE", EOS
TextDraw:       db " - DRAW", EOS
TextYouWhite:   db " YOU PLAY WHITE", EOS
TextYouBlack:   db " YOU PLAY BLACK", EOS
TextPressStart: db "    PRESS START", EOS
TextMatchWon:   db "  YOU WON THE MATCH", EOS
TextMatchLost:  db " YOU LOST THE MATCH", EOS
TextWins:       db "WINS", EOS

; Sprites: this player's cursor (while playing), the piece they picked and the dots
; where it can go (on their turn), and the last move's two marks.
RenderSprites:
    ld hl, wOAM
    ld a, [wPhase]
    cp PHASE_PLAY
    jp nz, .marks
    ld a, [wPlayer]
    ld c, a
    call PlayerStruct
    ld a, [hl+]                    ; cursor file, rank
    ld e, a
    ld a, [hl+]
    ld d, a
    ld a, [hl]                     ; selected square
    ldh [hSq], a
    ld a, d                        ; square = 21 + file + 10 * rank
    add a
    add a
    add a
    add d
    add d
    add e
    add SQ_A1
    call SquareXY
    ld hl, wOAM
    ld c, 0
    call PutCorners
    ldh a, [hSq]                   ; the picked piece, on this player's turn
    and a
    jr z, .marks
    ld a, [wGenState]
    cp GEN_DONE
    jr nz, .marks
    ld a, [wSide]
    ld b, a
    ld a, [wMyColor]
    cp b
    jr nz, .marks
    push hl
    ldh a, [hSq]
    call SquareXY
    pop hl
    ld c, $10                      ; inverted palette
    call PutCorners
    ld a, [wCount]                 ; its moves
    and a
    jr z, .marks
    ld b, a
    ld c, 0
.dot:
    push hl
    ld h, HIGH(wFrom)
    ld l, c
    ldh a, [hSq]
    cp [hl]
    jr nz, .notThis
    ld h, HIGH(wTo)
    ld a, [hl]
    call SquareXY
    pop hl
    ld a, l                        ; sprites left?
    cp 156
    jr nc, .marks
    ld a, e
    add 4
    ld [hl+], a
    ld a, d
    add 4
    ld [hl+], a
    ld a, TILE_SPR_DOT
    ld [hl+], a
    xor a
    ld [hl+], a
    jr .nextDot
.notThis:
    pop hl
.nextDot:
    inc c
    dec b
    jr nz, .dot
.marks:
    ld a, [wLastFrom]
    and a
    jr z, .clear
    call .mark
    ld a, [wLastTo]
    call .mark
.clear:
    ld a, l                        ; hide the other sprites
    cp 160
    ret nc
    xor a
    ld [hl+], a
    jr .clear
.mark:
    push hl
    call SquareXY
    pop hl
    ld a, l
    cp 156
    ret nc
    ld a, e
    ld [hl+], a
    ld a, d
    ld [hl+], a
    ld a, TILE_SPR_MARK
    ld [hl+], a
    xor a
    ld [hl+], a
    ret

; Square a -> its top-left corner as sprite coordinates: d = X, e = Y (from this Game
; Boy's side of the board). Keeps bc, hl? No: uses hl.
SquareXY:
    sub SQ_A1
    ld e, 0                        ; e = rank, a = file
.rank:
    cp 10
    jr c, .file
    sub 10
    inc e
    jr .rank
.file:
    ld d, a
    ld a, [wMyColor]
    and a
    jr z, .white
    ld a, 7                        ; black's view: file 7 - f on the left, rank r from the top
    sub d
    ld d, a
    jr .xy
.white:
    ld a, 7                        ; white's view: rank 7 - r from the top
    sub e
    ld e, a
.xy:
    ld a, d                        ; X = column * 16 + 8
    swap a
    add 8
    ld d, a
    ld a, e                        ; Y = row * 16 + 8 (status line) + 16
    swap a
    add 24
    ld e, a
    ret

; Four corner sprites at hl around the square at X d, Y e; c = palette ($10 = OBP1).
PutCorners:
    ld a, e
    ld [hl+], a
    ld a, d
    ld [hl+], a
    ld a, TILE_SPR_CORNER
    ld [hl+], a
    ld a, c
    ld [hl+], a
    ld a, e
    ld [hl+], a
    ld a, d
    add 8
    ld [hl+], a
    ld a, TILE_SPR_CORNER
    ld [hl+], a
    ld a, c
    or $20                         ; flipped left-right
    ld [hl+], a
    ld a, e
    add 8
    ld [hl+], a
    ld a, d
    ld [hl+], a
    ld a, TILE_SPR_CORNER
    ld [hl+], a
    ld a, c
    or $40                         ; flipped upside down
    ld [hl+], a
    ld a, e
    add 8
    ld [hl+], a
    ld a, d
    add 8
    ld [hl+], a
    ld a, TILE_SPR_CORNER
    ld [hl+], a
    ld a, c
    or $60
    ld [hl+], a
    ret

; ---------------------------------------------------------------------------- VRAM
; Compares part of wWant with wShown each frame and queues what changed (at most
; QUEUE_LEN tiles a frame); Draw writes the queue in the next VBlank.
BuildQueue:
    ld de, wQueue
    ld a, [wDiffPos]
    ld l, a
    ld a, [wDiffPos + 1]
    ld h, a
    ld b, QUEUE_LEN
    ld c, DIFF_PER_FRAME
.loop:
    ld a, [hl]                     ; wanted
    set 2, h                       ; -> wShown
    cp [hl]
    jr z, .same
    ld [hl], a
    res 2, h
    push af
    ld a, l                        ; queue: VRAM address, tile
    ld [de], a
    inc de
    ld a, h
    sub HIGH(wWant) - HIGH(_SCRN0)
    ld [de], a
    inc de
    pop af
    ld [de], a
    inc de
    dec b
    jr .next
.same:
    res 2, h
.next:
    inc hl
    ld a, l
    cp LOW(wWant + SCREEN_SIZE)
    jr nz, .notEnd
    ld a, h
    cp HIGH(wWant + SCREEN_SIZE)
    jr nz, .notEnd
    ld hl, wWant
.notEnd:
    ld a, b
    and a
    jr z, .stop
    dec c
    jr nz, .loop
.stop:
    ld a, l
    ld [wDiffPos], a
    ld a, h
    ld [wDiffPos + 1], a
.pad:
    ld a, b                        ; unused entries: a map row nobody sees
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
    jr .pad

ClearQueue:
    ld de, wQueue
    ld b, QUEUE_LEN
    jr BuildQueue.pad

ResetDiff:
    ld a, LOW(wWant)
    ld [wDiffPos], a
    ld a, HIGH(wWant)
    ld [wDiffPos + 1], a
    ret

; In VBlank: sprites by DMA, then exactly QUEUE_LEN tile writes (always the same time,
; so both Game Boys reach Exchange together).
Draw:
    call hDma
    ld hl, wQueue
    ld b, QUEUE_LEN
.loop:
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    ld a, [hl+]
    ld [de], a
    dec b
    jr nz, .loop
    ret

; ---------------------------------------------------------------------------- sound
; wSound: 1 move, 2 take, 3 check, 4 game over.
PlaySound:
    ld a, [wSound]
    and a
    ret z
    ld b, a
    xor a
    ld [wSound], a
    ld a, b
    cp 2
    jr z, .take
    cp 3
    jr z, .check
    cp 4
    jr z, .over
    xor a                          ; move: a short low knock on channel 1
    ldh [rNR10], a
    ld a, $80
    ldh [rNR11], a
    ld a, $A1
    ldh [rNR12], a
    ld a, $00
    ldh [rNR13], a
    ld a, $85
    ldh [rNR14], a
    ret
.take:
    ld a, $3A                      ; take: a noise burst on channel 4
    ldh [rNR41], a
    ld a, $C2
    ldh [rNR42], a
    ld a, $55
    ldh [rNR43], a
    ld a, $C0
    ldh [rNR44], a
    ret
.check:
    ld a, $80                      ; check: a high beep on channel 2
    ldh [rNR21], a
    ld a, $F3
    ldh [rNR22], a
    ld a, $C1
    ldh [rNR23], a
    ld a, $87
    ldh [rNR24], a
    ret
.over:
    ld a, $35                      ; game over: a falling tone on channel 1
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
