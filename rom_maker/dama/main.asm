; DAMA (checkers, draughts): two players on the link cable, the game with flying kings.
;
; - 8 x 8, 12 men each on the dark squares; white moves first.
; - A man moves one square diagonally forward. A man that ends its move on the far row
;   becomes a king, drawn as two discs: it moves any number of empty squares along a
;   diagonal.
; - Taking is forced: a man jumps an enemy piece next to it (forward or backward) onto
;   the empty square behind; a king jumps the first piece along a diagonal and lands on
;   any empty square beyond it. A piece keeps jumping while it can, and of all the ways
;   to take, the one that takes the most pieces must be played. Jumped pieces leave the
;   board when the move ends, and none can be jumped twice. A man that only passes the
;   far row in the middle of a capture stays a man.
; - Win: the other player has no piece or no move left, resigns, or runs out of time.
; - Draw: the same position a third time; 25 moves each with only kings moving and
;   nothing taken; a lone king against a king and two more pieces (16 moves each) or a
;   king and at most one more (5 moves each); or both players agreeing.
; - Controls: the d-pad moves your cursor, A picks one of your pieces (dots show where it
;   can go), A on a dot moves it; a capture is played landing by landing. B lets go.
;   SELECT opens the menu: A offers a draw (or takes the other player's offer), B
;   resigns (A confirms).
; - Round wins at $C000 (mine) and $C001 (theirs); the server's choice of round wins for
;   the match at $C002; its random bytes at $C003 pick who plays white in the first
;   game, then colours swap every game.
;
; Lockstep, like chess/: both Game Boys run the whole game from both players' buttons.
; Captures are searched one piece per frame (GenStep), so every frame stays short.
;
; Build, translate and test from rom_maker/: python3 tools/build.py dama

INCLUDE "hardware.inc"
INCLUDE "tiles.asm"
INCLUDE "zobrist.asm"

DEF WINS_TO_MATCH EQU 1            ; round wins for the match when the server sets none
DEF CLOCK_MINUTES EQU 5            ; each player's time per game (1-9)
DEF INTRO_FRAMES  EQU 90           ; after the handshake, before the first game
DEF HELLO         EQU $A5

; Pieces on the board: type in bits 0-2, BLACK for black. OFF marks the border.
DEF MAN    EQU 1
DEF KING   EQU 2
DEF BLACK  EQU 8
DEF TAKEN  EQU $40                 ; jumped in the capture being searched (OFF has it too)
DEF OFF    EQU $FF

; The board is chess/'s 10 x 12 "mailbox": square = 21 + file + 10 * rank (a1 = 21,
; h8 = 98), with a border of OFF around it. Diagonal steps are 9 and 11.
DEF SQ_A1 EQU 21
DEF SQ_H1 EQU 28
DEF SQ_A8 EQU 91
DEF SQ_H8 EQU 98

DEF MAX_TAKES EQU 64               ; capture moves kept in the list
DEF MAX_JUMPS EQU 12               ; jumps in one capture (there are only 12 pieces)

; wPhase
DEF PHASE_INTRO EQU 0
DEF PHASE_PLAY  EQU 1
DEF PHASE_WAIT  EQU 2              ; game over, waiting for START from both
DEF PHASE_OVER  EQU 3              ; match over

; wGenState
DEF GEN_WAIT  EQU 0                ; a frame to draw the new position first
DEF GEN_START EQU 1
DEF GEN_TAKES EQU 2                ; searching captures, one piece a frame
DEF GEN_DONE  EQU 3                ; the side to move may move
DEF GEN_END   EQU 4                ; the moves are known: is the game over?

; wReason: how the last game ended
DEF END_BLOCKED   EQU 1            ; the side to move has no move
DEF END_ALL_TAKEN EQU 2            ; the side to move has no piece
DEF END_REPEAT    EQU 3            ; the same position a third time
DEF END_KINGS     EQU 4            ; 25 moves each with only kings moving
DEF END_SHORT     EQU 5            ; a lone king held out (16 or 5 moves each)
DEF END_TIME      EQU 6
DEF END_RESIGN    EQU 7
DEF END_AGREED    EQU 8

; wMenu1 / wMenu2
DEF MENU_OPEN   EQU 1
DEF MENU_RESIGN EQU 2              ; "resign?" waiting for A

DEF ZOB_BLACK EQU 4                ; the Zobrist page of "black to move" (make_zobrist.py)

DEF QUEUE_LEN EQU 40               ; screen tiles written per frame
DEF DUMMY_VRAM EQU _SCRN0 + 32 * 20  ; an unseen map row for unused queue entries
DEF DIFF_ROWS EQU 4                ; screen rows compared per frame (all 18 in 5 frames)
DEF DRAWS_PER_FRAME EQU 16         ; board squares drawn per frame at most
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
wQuiet:    db                      ; moves in a row with only kings moving and nothing taken
wClockW:   ds 3                    ; frames left in this second, seconds, minutes
wClockB:   ds 3
wGenState: db
wGenIdx:   db                      ; next square to search for captures
wCount:    db                      ; legal moves (wFrom / wTo / wLen 0 .. wCount - 1)
wTakes:    db                      ; pieces every legal move takes (0: none can take)
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
wDiffRow:  db                      ; the screen row BuildQueue compares next
wSound:    db                      ; sound to play at the end of the frame
wLoops:    db                      ; frames run
wEndLY:    db                      ; the line the last frame's work ended on (VBlank 144-153 first)
wMenu1:    db                      ; per player: 0, MENU_OPEN or MENU_RESIGN
wMenu2:    db
wOffer:    db                      ; the player who offered a draw, 0 = none
wStep:     db                      ; landings picked so far in a capture (in wPath)
wPath:     ds MAX_JUMPS
wPiecesW:  db                      ; pieces on the board (CountPieces), in this order
wPiecesB:  db
wKingsW:   db
wKingsB:   db
; The capture search (SearchTakes): the piece, where it is, and per jump (node) the
; direction being tried, the piece jumped, where it landed, and whether it jumped on.
wOrigin:   db
wPiece:    db
wCur:      db
wDepth:    db
wNodeDir:  ds MAX_JUMPS + 1
wNodeCap:  ds MAX_JUMPS + 1
wNodeLand: ds MAX_JUMPS + 1
wNodeHad:  ds MAX_JUMPS + 1

DEF PL_FILE EQU 0
DEF PL_RANK EQU 1
DEF PL_SEL  EQU 2
DEF PL_REP  EQU 3

SECTION "OAM buffer", WRAM0[$C100]
wOAM: ds 160

SECTION "Board", WRAM0[$C200]
wBoard: ds 120

; The legal moves: from, to (where the piece ends) and pieces taken (0 = a plain move).
SECTION "Move from", WRAM0[$C300]
wFrom: ds 256
SECTION "Move to", WRAM0[$C400]
wTo:   ds 256

SECTION "Queue", WRAM0[$C500]
wQueue: ds QUEUE_LEN * 3           ; VRAM address (little-endian), tile

SECTION "Drawn", WRAM0[$C600]
wDrawn: ds 120                     ; the board as last drawn into wWant

; The key of every position since the last capture or man move (index wQuiet): byte k
; of position i at wHist + k * 128 + i.
SECTION "History", WRAM0[$C700]
wHist: ds 4 * 128

SECTION "Move length", WRAM0[$C900]
wLen:  ds 256
; A capture move's landing squares and the squares of the pieces it jumps: jump k of
; move i at wLand / wCap + k * 64 + i (LandAddr, CapAddr).
SECTION "Move landings", WRAM0[$CA00]
wLand: ds MAX_JUMPS * MAX_TAKES
SECTION "Move captures", WRAM0[$CD00]
wCap:  ds MAX_JUMPS * MAX_TAKES

; The screen as it should look (wWant) and as it was sent to VRAM (wShown): 18 rows of
; 32 tiles like the map (only 20 are seen), so wWant + i is VRAM $9800 + i and wShown
; is wWant with bit 2 of the high byte set.
SECTION "Want", WRAMX[$D000]
wWant:  ds SCREEN_SIZE
SECTION "Shown", WRAMX[$D400]
wShown: ds SCREEN_SIZE

SECTION "HRAM", HRAM
hDma:     ds 10                    ; the OAM DMA routine, copied here at start
hX:       db
hY:       db
hSq:      db
hRowSq:   db
hStep:    db
hRowStep: db
hNew:     db
hMove:    db
hQ:       ds 2                     ; where BuildQueue writes next
hRows:    db
hDrawn:   db                       ; squares drawn this frame
hHash:    ds 4                     ; PositionKey's result
hDir:     db                       ; NextJump: the direction tried
hK:       db
hMoved:   db                       ; MakeMove: the piece before it was crowned
hSaveC:   db
hTarget:  db

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
    call Draw
    ld hl, wLoops
    inc [hl]                      ; in VBlank, the same time on both Game Boys
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
    ldh a, [rLY]
    ld [wEndLY], a
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

; Swaps this frame's buttons (wMyPad) with the other Game Boy's; returns theirs in a.
; Player 1 clocks the byte; player 2 waits for it. If player 2 is not listening yet (its
; last frame ran long), player 1's transfer ends with $FF, as on hardware, and player 2
; gets nothing: so player 1 sends again until a real answer comes. A pad byte is never
; $FF (pressing everything at once counts as all but A).
Exchange:
    ld a, [wMyPad]
    cp $FF
    jr nz, .padOk
    dec a
    ld [wMyPad], a
.padOk:
    ld a, [wPlayer]
    cp 1
    jr nz, .slave
.master:
    ld b, 64                       ; give player 2 a moment to get ready
.delay:
    dec b
    jr nz, .delay
    ld a, [wMyPad]
    ldh [rSB], a
    ld a, $81
    ldh [rSC], a
.masterWait:
    ldh a, [rSC]
    bit 7, a
    jr nz, .masterWait
    ldh a, [rSB]
    cp $FF                         ; nobody answered: try again
    jr z, .master
    ret
.slave:
    ld a, [wMyPad]
    ldh [rSB], a
    ld a, $80
    ldh [rSC], a
.slaveWait:
    ldh a, [rSC]
    bit 7, a
    jr nz, .slaveWait
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
    ld a, [wSeedIn]                ; who is white first: the server's random bytes
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


; A new game: men in place, clocks full, white to move.
NewGame:
    ld hl, StartBoard
    ld de, wBoard
    ld bc, 120
    call Copy
    xor a
    ld [wSide], a
    ld [wQuiet], a
    ld [wLastFrom], a
    ld [wLastTo], a
    ld [wReason], a
    ld [wWinner], a
    ld [wReady1], a
    ld [wReady2], a
    call ClearAsks
    ld hl, wClockW
    call FullClock
    ld hl, wClockB
    call FullClock
    ld c, 1                        ; cursors on a man in the front row
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
    ld hl, wDrawn                  ; draw every square again
    ld bc, 120
    ld a, $FE
    call Fill
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


; hl = player c's struct: cursor on c3 (white) or f6 (black), nothing selected.
PlaceCursor:
    call ColourOf                  ; a = 0 or BLACK for player c
    and a
    ld a, 2
    jr z, .square
    ld a, 5
.square:
    ld [hl+], a
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


; Player c's buttons: the menu, the cursor, picking a piece and moving it.
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
    and PAD_SELECT                 ; SELECT opens or closes the menu
    jr z, .noSelect
    push hl
    call MenuAddr
    ld a, [hl]
    and a
    ld a, MENU_OPEN
    jr z, .toggle
    xor a
.toggle:
    ld [hl], a
    pop hl
    ret
.noSelect:
    call MenuOf
    and a
    jp nz, MenuInput
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
    call ColourOf
    ld b, a                        ; b = this player's colour
    ldh a, [hNew]
    and PAD_B
    jr z, .notB
    inc hl
    inc hl
    ld [hl], 0                     ; let go of the piece
    dec hl
    dec hl
    ld a, [wSide]                  ; and of the capture picked so far
    cp b
    jr nz, .notB
    xor a
    ld [wStep], a
.notB:
    ldh a, [hNew]
    and PAD_A
    ret z
    ld a, [wGenState]              ; still finding the legal moves
    cp GEN_DONE
    ret nz
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
    ld a, [hl]                     ; the piece picked
    and a
    jr z, .pick
    ld d, a
    call FindStep                  ; carry: move b goes on to e; Z: and ends there
    jr nc, .pick
    jr nz, .landing
    xor a                          ; the whole move: play it
    ld [wPl1 + PL_SEL], a
    ld [wPl2 + PL_SEL], a
    jp MakeMove
.landing:
    ld a, [wStep]                  ; one more landing of a capture
    add LOW(wPath)
    ld l, a
    ld h, HIGH(wPath)
    ld [hl], e
    ld hl, wStep
    inc [hl]
    ld a, 1                        ; a knock
    ld [wSound], a
    ret
.pick:
    ld a, [wStep]                  ; partway through a capture: only its landings count
    and a
    ret nz
    call ColourOf
    ld b, a
    ld a, [hl]                     ; A on the picked piece again: let go
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

; Is there a legal move of the piece on d whose next square (after the landings picked
; in wPath) is e? Carry if so, with b = that move, and then Z if e is where it ends.
; Keeps c, de, hl.
FindStep:
    push hl
    ld a, c
    ldh [hSaveC], a
    ld a, e
    ldh [hTarget], a
    ld a, [wCount]
    and a
    jr z, .no
    ld b, a
    ld c, 0
.loop:
    call NextOf                    ; keeps bc, d
    ld e, a
    ldh a, [hTarget]
    cp e
    jr z, .found
    inc c
    dec b
    jr nz, .loop
.no:
    ldh a, [hTarget]
    ld e, a
    ldh a, [hSaveC]
    ld c, a
    pop hl
    and a
    ret
.found:
    ld e, a
    ld b, c
    ld h, HIGH(wLen)
    ld l, c
    ld a, [wStep]                  ; the last jump of a capture?
    inc a
    cp [hl]
    jr z, .yes
    ld a, [hl]                     ; or a plain move (Z)
    and a
.yes:
    ldh a, [hSaveC]
    ld c, a
    pop hl
    scf
    ret

; Move c's next square for the piece on d: where it ends (a plain move), or its next
; landing when its landings so far are the ones picked (a capture); 0 if move c is not
; the piece's or does not fit the landings picked. Keeps bc, d.
NextOf:
    ld h, HIGH(wFrom)
    ld l, c
    ld a, [hl]
    cp d
    jr nz, .no
    ld h, HIGH(wLen)
    ld a, [hl]
    and a
    jr nz, .take
    ld a, [wStep]
    and a
    jr nz, .no
    ld h, HIGH(wTo)
    ld a, [hl]
    ret
.take:
    ld e, 0
.prefix:
    ld a, [wStep]
    cp e
    jr z, .last
    ld a, e
    call LandAddr
    ld a, e
    add LOW(wPath)
    push de
    ld e, a
    ld d, HIGH(wPath)
    ld a, [de]
    pop de
    cp [hl]
    jr nz, .no
    inc e
    jr .prefix
.last:
    ld a, e
    call LandAddr
    ld a, [hl]
    ret
.no:
    xor a
    ret

; hl = landing k of capture move c: wLand + k * 64 + c (a = k). Keeps bc, de.
LandAddr:
    ld l, a
    srl a
    srl a
    add HIGH(wLand)
    ld h, a
    ld a, l
    and 3
    rrca
    rrca
    or c
    ld l, a
    ret

; hl = the square of the piece jumped at jump k of capture move c (a = k). Keeps bc, de.
CapAddr:
    call LandAddr
    ld a, h
    add HIGH(wCap) - HIGH(wLand)
    ld h, a
    ret

; Player c's menu is open: A offers a draw, or agrees to the other player's offer; B
; asks "resign?", where A resigns and B closes the menu. SELECT closed it (Input).
MenuInput:
    call MenuAddr
    ld a, [hl]
    cp MENU_RESIGN
    jr z, .confirm
    ldh a, [hNew]
    and PAD_B
    jr z, .notB
    ld [hl], MENU_RESIGN
    ret
.notB:
    ldh a, [hNew]
    and PAD_A
    ret z
    ld [hl], 0
    ld a, [wOffer]
    and a
    jr z, .offer
    cp c
    ret z                          ; offered already
    xor a                          ; the other player offered: a draw
    ld [wWinner], a
    ld a, END_AGREED
    ld [wReason], a
    jp EndGame
.offer:
    ld a, c
    ld [wOffer], a
    ld a, 3                        ; the other player hears it
    ld [wSound], a
    ret
.confirm:
    ldh a, [hNew]
    and PAD_B
    jr z, .notNo
    ld [hl], 0
    ret
.notNo:
    ldh a, [hNew]
    and PAD_A
    ret z
    ld [hl], 0
    ld a, c                        ; resigned: the other player wins
    xor 3
    ld [wWinner], a
    ld a, END_RESIGN
    ld [wReason], a
    jp EndGame


; hl = player c's menu state (wMenu1 / wMenu2). Keeps bc, de.
MenuAddr:
    ld hl, wMenu1
    ld a, c
    cp 1
    ret z
    inc hl
    ret

; a = player c's menu state. Keeps bc, de, hl.
MenuOf:
    ld a, c
    cp 1
    ld a, [wMenu1]
    ret z
    ld a, [wMenu2]
    ret


; No menu open, no draw offer, no capture being picked.
ClearAsks:
    xor a
    ld [wMenu1], a
    ld [wMenu2], a
    ld [wOffer], a
    ld [wStep], a
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
    ld a, [wSide]                  ; out of time: the other player wins
    xor BLACK
    call PlayerOf
    ld [wWinner], a
    ld a, END_TIME
    ld [wReason], a
    jp EndGame

; The game is over: wReason and wWinner say how. Counts the win and waits for START
; (or ends the match).
EndGame:
    call ClearAsks
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
; Finds the legal moves of the side to move over several frames: the captures of one
; piece per frame (SearchTakes), then, if nothing can be taken, the plain moves. Then,
; in a frame of its own, decides whether the game is over (EndChecks).
GenStep:
    ld a, [wGenState]
    cp GEN_WAIT
    jr nz, .notWait
    ld a, GEN_START
    ld [wGenState], a
    ret
.notWait:
    cp GEN_START
    jr nz, .notStart
    xor a
    ld [wCount], a
    ld [wTakes], a
    ld a, SQ_A1
    ld [wGenIdx], a
    call CountPieces
    ld a, GEN_TAKES
    ld [wGenState], a
    ret
.notStart:
    cp GEN_END
    jp z, EndChecks
    cp GEN_TAKES
    ret nz
    ld a, [wGenIdx]                ; the side to move's next piece
    ld c, a
.find:
    ld a, c
    cp SQ_H8 + 1
    jr nc, .searched
    ld h, HIGH(wBoard)
    ld l, c
    ld a, [hl]
    inc c
    and a
    jr z, .find
    cp OFF
    jr z, .find
    and BLACK
    ld b, a
    ld a, [wSide]
    cp b
    jr nz, .find
    ld a, c
    ld [wGenIdx], a                ; next frame: from the square after it
    dec c
    jp SearchTakes
.searched:
    ld a, [wTakes]                 ; nothing to take: the plain moves
    and a
    call z, GenQuiet
    ld a, GEN_END
    ld [wGenState], a
    ret

; Counts each side's pieces and kings (wPiecesW, wPiecesB, wKingsW, wKingsB).
CountPieces:
    xor a
    ld hl, wPiecesW
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld c, SQ_A1
.loop:
    ld h, HIGH(wBoard)
    ld l, c
    ld a, [hl]
    and a
    jr z, .next
    cp OFF
    jr z, .next
    ld b, a
    ld hl, wPiecesW
    bit 3, b
    jr z, .white
    inc hl
.white:
    inc [hl]
    ld a, b
    and 7
    cp KING
    jr nz, .next
    inc hl
    inc hl
    inc [hl]
.next:
    inc c
    ld a, c
    cp SQ_H8 + 1
    jr c, .loop
    ret

; Every capture of the piece on square c, followed jump by jump as far as it goes (a
; depth-first search with its own stack, wNode*). Each complete capture goes through
; Record, which keeps the ones that take the most pieces.
SearchTakes:
    ld a, c
    ld [wOrigin], a
    ld [wCur], a
    ld h, HIGH(wBoard)
    ld l, c
    ld a, [hl]
    ld [wPiece], a
    ld [hl], 0                     ; lifted: its own square is free while it jumps
    xor a
    ld [wDepth], a
    call NewNode
.loop:
    call NextJump                  ; carry: a jump (wNodeCap / wNodeLand at wDepth)
    jr nc, .back
    ld a, [wDepth]
    ld c, a
    ld b, 0
    ld hl, wNodeHad
    add hl, bc
    ld [hl], 1
    ld hl, wNodeCap
    add hl, bc
    ld a, [hl]
    ld h, HIGH(wBoard)
    ld l, a
    set 6, [hl]                    ; TAKEN: still in the way, cannot be jumped again
    ld hl, wNodeLand
    add hl, bc
    ld a, [hl]
    ld [wCur], a
    ld a, c
    inc a
    ld [wDepth], a
    call NewNode
    jr .loop
.back:
    ld a, [wDepth]
    and a
    jr z, .done
    ld c, a
    ld b, 0
    ld hl, wNodeHad
    add hl, bc
    ld a, [hl]
    and a
    call z, Record                 ; no jump from here: a whole capture
    ld a, [wDepth]
    dec a
    ld [wDepth], a
    ld c, a
    ld b, 0
    ld hl, wNodeCap                ; the jumped piece is free again
    add hl, bc
    ld a, [hl]
    ld h, HIGH(wBoard)
    ld l, a
    res 6, [hl]
    ld a, c                        ; back where that jump started
    and a
    ld a, [wOrigin]
    jr z, .from
    ld hl, wNodeLand - 1
    add hl, bc
    ld a, [hl]
.from:
    ld [wCur], a
    jr .loop
.done:
    ld a, [wOrigin]
    ld h, HIGH(wBoard)
    ld l, a
    ld a, [wPiece]
    ld [hl], a
    ret

; A fresh node at wDepth: no direction tried yet.
NewNode:
    ld a, [wDepth]
    ld c, a
    ld b, 0
    xor a
    ld hl, wNodeDir
    add hl, bc
    ld [hl], a
    ld hl, wNodeLand
    add hl, bc
    ld [hl], a
    ld hl, wNodeHad
    add hl, bc
    ld [hl], a
    ret

; The next jump from wCur for the node at wDepth: carry, with wNodeCap / wNodeLand
; set, or no carry once every direction has been tried. A man jumps the piece next to
; it; a king the first piece along the diagonal, landing on each empty square beyond.
NextJump:
    ld a, [wDepth]
    ld c, a
    ld b, 0
.dir:
    ld hl, wNodeDir
    add hl, bc
    ld a, [hl]
    cp 4
    ret nc
    ld e, a
    ld d, 0
    ld hl, Dirs
    add hl, de
    ld a, [hl]
    ldh [hDir], a
    ld hl, wNodeLand
    add hl, bc
    ld a, [hl]
    and a
    jr z, .fresh
    ld e, a                        ; landed here before: a king may land further on
    ld a, [wPiece]
    and 7
    cp KING
    jr nz, .nextDir
    ldh a, [hDir]
    add e
    ld e, a
    ld h, HIGH(wBoard)
    ld l, a
    ld a, [hl]
    and a
    jr nz, .nextDir
    ld hl, wNodeLand
    add hl, bc
    ld [hl], e
    scf
    ret
.nextDir:
    ld hl, wNodeLand
    add hl, bc
    ld [hl], 0
    ld hl, wNodeDir
    add hl, bc
    inc [hl]
    jr .dir
.fresh:
    ld a, [wCur]
    ld e, a
    ld h, HIGH(wBoard)
.slide:
    ldh a, [hDir]
    add e
    ld e, a
    ld l, a
    ld a, [hl]
    and a
    jr nz, .piece
    ld a, [wPiece]                 ; empty: only a king looks further
    and 7
    cp KING
    jr z, .slide
    jr .nextDir
.piece:
    bit 6, a                       ; the border, or a piece jumped already
    jr nz, .nextDir
    and BLACK
    ld d, a
    ld a, [wSide]
    cp d
    jr z, .nextDir                 ; one of ours
    ld d, e                        ; d = the piece to jump
    ldh a, [hDir]
    add e
    ld e, a
    ld l, a
    ld a, [hl]
    and a
    jr nz, .nextDir                ; no empty square behind it
    ld hl, wNodeCap
    add hl, bc
    ld [hl], d
    ld hl, wNodeLand
    add hl, bc
    ld [hl], e
    scf
    ret

; A whole capture of wDepth jumps (wNodeCap / wNodeLand 0 .. wDepth - 1), ending on
; wCur: kept if it takes as many pieces as the best so far; one that takes more starts
; the list again.
Record:
    ld a, [wTakes]
    ld b, a
    ld a, [wDepth]
    cp b
    ret c
    jr z, .add
    ld [wTakes], a
    xor a
    ld [wCount], a
.add:
    ld a, [wCount]
    cp MAX_TAKES
    ret nc
    ld c, a
    inc a
    ld [wCount], a
    ld h, HIGH(wFrom)
    ld l, c
    ld a, [wOrigin]
    ld [hl], a
    ld h, HIGH(wTo)
    ld a, [wCur]
    ld [hl], a
    ld h, HIGH(wLen)
    ld a, [wDepth]
    ld [hl], a
    ld e, 0                        ; e = jump
.copy:
    ld a, [wDepth]
    cp e
    ret z
    ld d, 0
    ld hl, wNodeLand
    add hl, de
    ld b, [hl]
    ld a, e
    call LandAddr
    ld [hl], b
    ld hl, wNodeCap
    add hl, de
    ld b, [hl]
    ld a, e
    call CapAddr
    ld [hl], b
    inc e
    jr .copy

; Every plain move of the side to move (when nothing can be taken): a man one square
; diagonally forward, a king any number of empty squares along a diagonal.
GenQuiet:
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
    ld a, [wSide]
    cp d
    jr nz, .next
    ld a, b
    and 7
    cp KING
    jr z, .king
    ld hl, ForwardWhite
    ld a, [wSide]
    and a
    jr z, .man
    ld hl, ForwardBlack
.man:
    ld a, [hl+]
    call QuietStep
    ld a, [hl]
    call QuietStep
    jr .next
.king:
    ld hl, Dirs
    ld b, 4
.dir:
    ld a, [hl+]
    push hl
    push bc
    call QuietRay
    pop bc
    pop hl
    dec b
    jr nz, .dir
.next:
    inc c
    ld a, c
    cp SQ_H8 + 1
    jr c, .square
    ret

; A man's step from c by a, if that square is empty. Keeps bc, hl.
QuietStep:
    push hl
    add c
    ld e, a
    ld h, HIGH(wBoard)
    ld l, a
    ld a, [hl]
    and a
    call z, AddQuiet
    pop hl
    ret

; A king's moves from c along direction a, up to the first square that is not empty.
; Keeps c.
QuietRay:
    ld d, a
    ld e, c
.step:
    ld a, e
    add d
    ld e, a
    ld h, HIGH(wBoard)
    ld l, a
    ld a, [hl]
    and a
    ret nz
    call AddQuiet
    jr .step

; Adds the plain move c -> e. Keeps bc, de.
AddQuiet:
    ld a, [wCount]
    cp 255
    ret z
    ld l, a
    inc a
    ld [wCount], a
    ld h, HIGH(wFrom)
    ld [hl], c
    ld h, HIGH(wTo)
    ld [hl], e
    ld h, HIGH(wLen)
    ld [hl], 0
    ret

; The legal moves are known: no move (or no piece) loses; 25 king moves each, a lone
; king holding out, or a third repetition draw; otherwise the side to move may move.
EndChecks:
    ld a, [wCount]
    and a
    jr nz, .moves
    ld a, [wSide]                  ; nothing to move: the other player wins
    and a
    ld a, [wPiecesW]
    jr z, .mine
    ld a, [wPiecesB]
.mine:
    and a
    ld a, END_ALL_TAKEN
    jr z, .lost
    ld a, END_BLOCKED
.lost:
    ld [wReason], a
    ld a, [wSide]
    xor BLACK
    call PlayerOf
    ld [wWinner], a
    jp EndGame
.moves:
    ld a, [wQuiet]                 ; 25 moves each with only kings moving
    cp 50
    ld a, END_KINGS
    jr nc, .draw
    call LoneKing                  ; a lone king held out long enough?
    and a
    jr z, .repeat
    ld b, a
    ld a, [wQuiet]
    cp b
    ld a, END_SHORT
    jr nc, .draw
.repeat:
    call Repetition
    jr nc, .goOn
    ld a, END_REPEAT
.draw:
    ld [wReason], a
    xor a
    ld [wWinner], a
    jp EndGame
.goOn:
    ld a, GEN_DONE                 ; the side to move may move
    ld [wGenState], a
    ret

; One side has a lone king and the other at least one king: a = the moves in a row
; (both sides', counted in wQuiet) it may hold out for: 32 against three pieces, 10
; against one or two. Else 0.
LoneKing:
    ld a, [wPiecesW]
    cp 1
    jr nz, .notWhite
    ld a, [wKingsW]
    and a
    jr z, .notWhite
    ld a, [wKingsB]
    and a
    jr z, .notWhite
    ld a, [wPiecesB]
    jr .limit
.notWhite:
    ld a, [wPiecesB]
    cp 1
    jr nz, .none
    ld a, [wKingsB]
    and a
    jr z, .none
    ld a, [wKingsW]
    and a
    jr z, .none
    ld a, [wPiecesW]
.limit:
    cp 3
    jr z, .three
    jr nc, .none
    ld a, 10
    ret
.three:
    ld a, 32
    ret
.none:
    xor a
    ret

; Carry set if this position has been seen twice before (the same pieces on the same
; squares, the same side to move). Only positions since the last capture or man move
; can repeat: their keys are in wHist, this one's goes at wQuiet.
Repetition:
    call PositionKey
    ld a, [wQuiet]
    ld c, a
    ld h, HIGH(wHist)
    ld l, c
    ldh a, [hHash]
    ld [hl], a
    set 7, l
    ldh a, [hHash + 1]
    ld [hl], a
    inc h
    res 7, l
    ldh a, [hHash + 2]
    ld [hl], a
    set 7, l
    ldh a, [hHash + 3]
    ld [hl], a
    ld b, 0                        ; earlier positions with the same side to move: equal?
.loop:
    ld a, c
    sub 2
    jr c, .no
    ld c, a
    ld h, HIGH(wHist)
    ld l, c
    ldh a, [hHash]
    cp [hl]
    jr nz, .loop
    set 7, l
    ldh a, [hHash + 1]
    cp [hl]
    jr nz, .loop
    inc h
    res 7, l
    ldh a, [hHash + 2]
    cp [hl]
    jr nz, .loop
    set 7, l
    ldh a, [hHash + 3]
    cp [hl]
    jr nz, .loop
    inc b
    ld a, b
    cp 2
    jr c, .loop
    scf
    ret
.no:
    and a
    ret


; hHash = the position's Zobrist key (make_zobrist.py): each piece on its square, and
; black to move.
PositionKey:
    xor a
    ldh [hHash], a
    ldh [hHash + 1], a
    ldh [hHash + 2], a
    ldh [hHash + 3], a
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
    and 7                          ; page: white man 0, white king 1, black man 2, king 3
    dec a
    bit 3, b
    jr z, .white
    add 2
.white:
    add HIGH(Zobrist)
    ld b, a
    ld h, HIGH(SquareKey)
    ld a, [hl]
    and $FC
    ld l, a
    ld h, b
    call XorKey
.next:
    inc c
    ld a, c
    cp SQ_H8 + 1
    jr c, .square
    ld a, [wSide]
    and a
    ret z
    ld hl, Zobrist + ZOB_BLACK * 256
    ; fall through

; hHash ^= the 4 bytes at hl (in one page). Keeps bc, de.
XorKey:
    ldh a, [hHash]
    xor [hl]
    ldh [hHash], a
    inc l
    ldh a, [hHash + 1]
    xor [hl]
    ldh [hHash + 1], a
    inc l
    ldh a, [hHash + 2]
    xor [hl]
    ldh [hHash + 2], a
    inc l
    ldh a, [hHash + 3]
    xor [hl]
    ldh [hHash + 3], a
    ret


; Plays legal move b: the piece goes from wFrom to wTo, every piece it jumped leaves
; the board, a man ending on the far row becomes a king; then the other side.
MakeMove:
    ld c, b
    ld h, HIGH(wFrom)
    ld l, c
    ld d, [hl]
    ld h, HIGH(wTo)
    ld e, [hl]
    ld h, HIGH(wLen)
    ld a, [hl]
    ldh [hK], a                    ; pieces taken
    ld h, HIGH(wBoard)
    ld l, d
    ld b, [hl]                     ; b = the piece
    ld [hl], 0
    ld a, b
    ldh [hMoved], a
    ldh a, [hK]
.take:
    and a
    jr z, .taken
    dec a
    push af
    call CapAddr
    ld l, [hl]
    ld h, HIGH(wBoard)
    ld [hl], 0
    pop af
    jr .take
.taken:
    ld a, b                        ; a man ending on the far row is crowned
    and 7
    cp MAN
    jr nz, .place
    ld a, b
    and BLACK
    jr nz, .blackMan
    ld a, e
    cp SQ_A8
    jr c, .place
    jr .crown
.blackMan:
    ld a, e
    cp SQ_H1 + 1
    jr nc, .place
.crown:
    ld a, b
    and BLACK
    or KING
    ld b, a
.place:
    ld h, HIGH(wBoard)
    ld l, e
    ld [hl], b
    ldh a, [hK]                    ; only kings moving, nothing taken: one more quiet move
    and a
    jr nz, .reset
    ldh a, [hMoved]
    and 7
    cp KING
    jr nz, .reset
    ld hl, wQuiet
    inc [hl]
    jr .counted
.reset:
    xor a
    ld [wQuiet], a
.counted:
    ld a, d
    ld [wLastFrom], a
    ld a, e
    ld [wLastTo], a
    ldh a, [hK]                    ; sound: a take, or a move
    and a
    ld a, 2
    jr nz, .sound
    dec a
.sound:
    ld [wSound], a
    xor a
    ld [wStep], a
    ld a, [wSide]                  ; a move by the player offered a draw turns it down
    call PlayerOf
    ld l, a
    ld a, [wOffer]
    cp l
    jr z, .offerStands
    xor a
    ld [wOffer], a
.offerStands:
    ld a, [wSide]
    xor BLACK
    ld [wSide], a
    ld a, 1
    ld [wBoardDirty], a
    ld a, GEN_WAIT
    ld [wGenState], a
    ret

Dirs:
    db -11, -9, 9, 11
ForwardWhite:
    db 9, 11
ForwardBlack:
    db -9, -11

; SquareKey[square]: 4 * its number a1 = 0 ... h8 = 63 (a Zobrist page offset), plus 1
; on a light square (bits 0-1 are free for it). 0 off the board.
SECTION "Square keys", ROM0, ALIGN[8]
SquareKey:
FOR SQ, 120
    REDEF SQF = (SQ - 21) % 10
    REDEF SQR = (SQ - 21) / 10
    IF SQ >= 21 && SQ <= 98 && SQF < 8
        db (SQF + 8 * SQR) * 4 + ((SQF + SQR) & 1)
    ELSE
        db 0
    ENDC
ENDR


SECTION "Start board", ROM0
StartBoard:
    ds 20, OFF
    db OFF, MAN, 0, MAN, 0, MAN, 0, MAN, 0, OFF
    db OFF, 0, MAN, 0, MAN, 0, MAN, 0, MAN, OFF
    db OFF, MAN, 0, MAN, 0, MAN, 0, MAN, 0, OFF
    REPT 2
    db OFF, 0, 0, 0, 0, 0, 0, 0, 0, OFF
    ENDR
    db OFF, 0, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, OFF
    db OFF, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, 0, OFF
    db OFF, 0, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, 0, MAN | BLACK, OFF
    ds 20, OFF

; ---------------------------------------------------------------------------- screen
; The screen in wWant: board (16 x 16 tiles, from this Game Boy's side), status line on
; top, hint line at the bottom, and a panel on the right: the other player at the top
; (a man and pieces left, clock, wins, OK), this player at the bottom. And the sprites in wOAM.
Render:
    call RenderBoard
    ld a, [wLoops]                 ; the words and clocks: every 4th frame is enough
    and 3
    call z, RenderText
    jp RenderSprites

; Draws the squares that changed since they were last drawn (DRAWS_PER_FRAME at most;
; the rest next frame).
RenderBoard:
    ld a, [wBoardDirty]
    and a
    ret z
    xor a
    ld [wBoardDirty], a
    ldh [hDrawn], a
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
    ld b, HIGH(wDrawn)
    ld a, [bc]
    cp e
    jr nz, .changed
    inc hl                         ; as drawn: next square
    inc hl
    jr .nextSquare
.changed:
    ldh a, [hDrawn]
    cp DRAWS_PER_FRAME
    jr nz, .draw
    ld a, 1                        ; enough for this frame: the rest next frame
    ld [wBoardDirty], a
    ret
.draw:
    inc a
    ldh [hDrawn], a
    ld a, e
    ld [bc], a
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
.nextSquare:
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
    jp nz, .row
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
    ld a, [wGenState]              ; and how many it must take
    cp GEN_DONE
    jr nz, .bottom
    ld a, [wTakes]
    and a
    jr z, .bottom
    ld de, TextTake
    call PutText
    ld a, [wTakes]
    call PutNumber
    jr .bottom
.ended:
    ld a, [wReason]                ; how the game ended
    dec a
    add a
    add LOW(ReasonTexts)
    ld l, a
    adc HIGH(ReasonTexts)
    sub l
    ld h, a
    ld a, [hl+]
    ld e, a
    ld d, [hl]
    ld hl, wWant + ROW0
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
    call PutHint
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
    ld hl, wWant + 1 * 32 + 16
    call PutMen
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
    ld hl, wWant + 15 * 32 + 16
    jp PutMen

; The bottom line while playing (hl): this player's menu, the capture being picked, a
; draw offer, or else which colour they play, taking turns with how to open the menu.
PutHint:
    ld a, [wPlayer]
    ld c, a
    call MenuOf
    cp MENU_RESIGN
    ld de, TextConfirm
    jp z, PutText
    and a
    ld de, TextMenu
    jp nz, PutText
    ld a, [wStep]
    and a
    jr z, .offer
    ld a, [wSide]
    ld b, a
    ld a, [wMyColor]
    cp b
    ld de, TextJumpOn
    jp z, PutText
.offer:
    ld a, [wOffer]
    and a
    jr z, .colour
    cp c
    ld de, TextDrawSent
    jp z, PutText
    ld de, TextDrawOffered
    jp PutText
.colour:
    ld a, [wLoops]
    bit 7, a
    ld de, TextMenuHint
    jp nz, PutText
    ld a, [wMyColor]
    and a
    ld de, TextYouWhite
    jp z, PutText
    ld de, TextYouBlack
    jp PutText

; Player c's man (in their colour) as 2 x 2 tiles at hl, and their pieces left beside
; its lower half.
PutMen:
    call ColourOf
    push af
    add TILE_PIECES                ; a man on a light square
    ld [hl+], a
    inc a
    ld [hl], a
    inc a
    ld de, 31
    add hl, de
    ld [hl+], a
    inc a
    ld [hl+], a
    pop af
    and a
    ld a, [wPiecesW]
    jr z, .count
    ld a, [wPiecesB]
.count:
    cp 10
    jr nc, PutNumber
    push af
    ld a, TILE_BLANK
    ld [hl+], a
    pop af
    ; fall through

; a (0-99) at hl, without a leading 0 (hl ends after it). Keeps bc, de.
PutNumber:
    push bc
    ld b, 0
.tens:
    cp 10
    jr c, .ones
    sub 10
    inc b
    jr .tens
.ones:
    ld c, a
    ld a, b
    and a
    jr z, .one
    add TILE_CH_0
    ld [hl+], a
.one:
    ld a, c
    add TILE_CH_0
    ld [hl+], a
    pop bc
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
TextTake:       db " TAKE ", EOS
TextBlocked:    db "BLOCKED", EOS
TextAllTaken:   db "ALL TAKEN", EOS
TextRepeat:     db "REPETITION", EOS
TextKings:      db "25 MOVES", EOS
TextShort:      db "MOVE LIMIT", EOS
TextTime:       db "TIME OUT", EOS
TextResigned:   db "RESIGNED", EOS
TextAgreed:     db "AGREED", EOS
ReasonTexts:    dw TextBlocked, TextAllTaken, TextRepeat, TextKings, TextShort, TextTime
                dw TextResigned, TextAgreed
TextWin:        db " - YOU WIN", EOS
TextLose:       db " - YOU LOSE", EOS
TextDraw:       db " - DRAW", EOS
TextYouWhite:   db " YOU PLAY WHITE", EOS
TextYouBlack:   db " YOU PLAY BLACK", EOS
TextPressStart: db "    PRESS START", EOS
TextMatchWon:   db "  YOU WON THE MATCH", EOS
TextMatchLost:  db " YOU LOST THE MATCH", EOS
TextWins:       db "WINS", EOS
TextConfirm:    db " RESIGN? A:YES B:NO", EOS
TextMenu:       db " A:DRAW   B:RESIGN", EOS
TextMenuHint:   db " SELECT: DRAW/RESIGN", EOS
TextDrawSent:   db " DRAW OFFERED", EOS
TextDrawOffered: db " DRAW? PRESS SELECT", EOS
TextJumpOn:     db " NEXT JUMP - B:BACK", EOS

; Sprites: this player's cursor (while playing); on their turn the piece they picked
; (or where its capture has got to) and dots where it can go next; the last move's
; two marks.
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
    jp z, .marks
    ld a, [wGenState]
    cp GEN_DONE
    jp nz, .marks
    ld a, [wSide]
    ld b, a
    ld a, [wMyColor]
    cp b
    jp nz, .marks
    ld a, [wStep]                  ; where it is: its last landing, or its square
    and a
    jr z, .atStart
    add LOW(wPath) - 1
    ld e, a
    ld d, HIGH(wPath)
    ld a, [de]
    jr .at
.atStart:
    ldh a, [hSq]
.at:
    push hl
    call SquareXY
    pop hl
    ld c, $10                      ; inverted palette
    call PutCorners
    ld a, [wCount]                 ; dots: each move's next square
    and a
    jr z, .marks
    ld b, a
    ld c, 0
.dot:
    push bc
    push hl
    ldh a, [hSq]
    ld d, a
    call NextOf
    pop hl
    pop bc
    and a
    jr z, .nextDot
    push hl
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
    ld a, l                        ; hide the other sprites (Y = 0)
    cp 160
    ret nc
    ld [hl], 0
    add 4
    ld l, a
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
; Compares DIFF_ROWS rows of wWant with wShown each frame and queues the tiles that
; changed (at most QUEUE_LEN a frame); Draw writes the queue in the next VBlank.
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

ResetDiff:
    xor a
    ld [wDiffRow], a
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
; wSound: 1 move, 2 take, 3 a draw offer, 4 game over.
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
    ld a, $80                      ; a draw offer: a high beep on channel 2
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

