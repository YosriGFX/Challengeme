; ---------------------------------------------------------------------------- screen
; Render builds this Game Boy's whole screen in wWant from the game state, as its player
; sees it: their own hand, the table, what everybody said. It only reads the state.
;
;   row 0       US 0420   THEM 0310         the game's score
;   row 1       P3 120h CONTRE              the contract (or who deals)
;   rows 2-12   the table: partner at the top, the next player to the right, the one
;               before to the left, each with what they said or the card they played,
;               and the seconds left for whoever has to act
;   row 13      the bid picker, or whose turn it is
;   rows 14-17  my hand; the card under my cursor is raised

MACRO at                            ; hl = the screen at row \1, column \2
    ld hl, wWant + (\1) * 32 + (\2)
ENDM

Render:
    call ClearWant
    call RenderScore
    ld a, [wState]
    cp ST_LINK
    jr z, .link
    cp ST_SCORE
    jp z, RenderDeal
    cp ST_WAIT
    jp z, RenderGame
    cp ST_OVER
    jp z, RenderGame
    call RenderContract
    call RenderSeats
    call RenderMessage
    jp RenderHand
.link:
    at 8, 3
    ld de, TextLink
    jp PutText

; 18 rows of 20 blank tiles.
ClearWant:
    ld hl, wWant
    ld c, 18
.row:
    xor a
    ld b, 20
.col:
    ld [hl+], a
    dec b
    jr nz, .col
    ld a, l
    add 12
    ld l, a
    jr nc, .next
    inc h
.next:
    dec c
    jr nz, .row
    ret

RenderScore:
    at 0, 0
    ld de, TextUs
    call PutText
    ld a, [wMe]
    and 1
    call ScoreOf
    at 0, 3
    call PutNum4
    at 0, 10
    ld de, TextThem
    call PutText
    ld a, [wMe]
    and 1
    xor 1
    call ScoreOf
    at 0, 15
    jp PutNum4

; de = team a's score
ScoreOf:
    ld hl, wScore
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ret

; Row 1: the contract, or who deals.
RenderContract:
    ld a, [wState]
    cp ST_DEAL
    jr z, .dealing
    ld a, [wBid]
    and a
    jr nz, .contract
    at 1, 0
    ld a, [wDealer]
    call PutPlayer
    ld de, TextDeals
    jp PutText
.dealing:
    at 1, 0
    ld de, TextShuffling
    jp PutText
.contract:
    at 1, 0
    ld a, [wBidder]
    call PutPlayer
    inc hl
    ld a, [wTrump]
    ld b, a
    ld a, [wBid]
    call PutBid
    ld a, [wCoinche]
    and a
    ret z
    inc hl
    ld de, TextContre
    dec a
    jr z, .said
    ld de, TextSurcontre
.said:
    jp PutText

; Each player around the table: label, clock, what they said, their card.
RenderSeats:
    ld c, 0
.seat:
    push bc
    ld a, [wMe]                    ; hP = where they sit: 0 me, 1 right, 2 top, 3 left
    ld b, a
    ld a, c
    sub b
    and 3
    ldh [hP], a
    call SeatLabel
    call SeatClock
    call SeatSaid
    call SeatCard
    pop bc
    inc c
    ld a, c
    cp 4
    jr nz, .seat
    ret

SeatLabel:
    ldh a, [hP]
    and a
    ret z
    ld de, LabelPos
    call SeatPos
    ld a, c
    jp PutPlayer

; The seconds left of the player to act (mine are on row 13).
SeatClock:
    ld a, [wState]
    cp ST_BID
    jr z, .acting
    cp ST_PLAY
    ret nz
.acting:
    ld a, [wTurn]
    cp c
    ret nz
    ldh a, [hP]
    and a
    ret z
    ld de, ClockPos
    call SeatPos
    jp PutClock

; In the bidding, what they said; in play, belote or rebelote in the trick they said it.
SeatSaid:
    ld de, SaidPos
    call SeatPos
    ld a, [wState]
    cp ST_BID
    jr z, .bidding
    cp ST_CONTRE
    jr z, .bidding
    cp ST_PLAY
    jr z, .belote
    cp ST_TRICK
    ret nz
.belote:
    ld a, [wBelote]
    cp c
    ret nz
    ld a, [wBeloteSaid]
    and a
    ret z
    ld b, a
    ld a, [wBeloteTrick]
    ld e, a
    ld a, [wTrick]
    cp e
    ret nz
    ld a, b
    cp 1
    jr z, .beloteWord
    ld de, TextRe
    push hl
    call PutText
    pop hl
    call NextRow
.beloteWord:
    ld de, TextBelote
    jp PutText
.bidding:
    push hl
    ld hl, wSaid
    call AddC
    ld a, [hl]
    pop hl
    cp SAID_PASS
    jr nz, .notPass
    ld de, TextPass
    jp PutText
.notPass:
    cp SAID_BID
    jr z, .bid
    cp SAID_CAPOT
    jr nz, .notCapot
.bid:
    push hl
    ld e, a
    ld hl, wSaidS
    call AddC
    ld b, [hl]
    ld hl, wSaidV
    call AddC
    ld d, [hl]
    pop hl
    ld a, e
    cp SAID_CAPOT
    ld a, d
    jp nz, PutBid
    ld a, CAPOT
    jp PutBid
.notCapot:
    cp SAID_CONTRE
    jr nz, .notContre
    ld de, TextContre
    jp PutText
.notContre:
    cp SAID_SUR
    ret nz
    ld de, TextSur
    push hl
    call PutText
    pop hl
    call NextRow
    ld de, TextContre
    jp PutText

; Their card in this trick.
SeatCard:
    ld a, [wState]
    cp ST_PLAY
    jr z, .table
    cp ST_TRICK
    ret nz
.table:
    ld hl, wTable
    call AddC
    ld a, [hl]
    cp NO_CARD
    ret z
    push bc
    ld d, a
    push de
    ld de, CardPos
    call SeatPos
    pop de
    ld e, 0
    call RenderCard
    pop bc
    ret

; hl = the word at de + hP * 2 (a screen position for that seat).
SeatPos:
    ldh a, [hP]
    add a
    add e
    ld e, a
    jr nc, .read
    inc d
.read:
    ld a, [de]
    ld l, a
    inc de
    ld a, [de]
    ld h, a
    ret

;               me                   right                 top                   left
LabelPos: dw 0,                    wWant + 6 * 32 + 18,  wWant + 2 * 32 + 9,   wWant + 6 * 32 + 0
ClockPos: dw 0,                    wWant + 6 * 32 + 15,  wWant + 2 * 32 + 12,  wWant + 6 * 32 + 3
SaidPos:  dw wWant + 11 * 32 + 13, wWant + 7 * 32 + 14,  wWant + 3 * 32 + 12,  wWant + 7 * 32 + 0
CardPos:  dw wWant + 10 * 32 + 9,  wWant + 7 * 32 + 12,  wWant + 3 * 32 + 9,   wWant + 7 * 32 + 6

; Row 13 (and the bidding's help above it).
RenderMessage:
    ld a, [wState]
    cp ST_BID
    jr z, .bidding
    cp ST_CONTRE
    jr z, .bidding
    cp ST_TRICK
    jr z, .trick
    cp ST_PLAY
    ret nz
    ld a, [wMe]
    ld b, a
    ld a, [wTurn]
    cp b
    ret nz
    at 13, 4
    ld de, TextYourTurn
    call PutText
    inc hl
    jp PutClock
.trick:
    ld a, [wMe]
    ld b, a
    ld a, [wWinner]
    cp b
    jr nz, .theyTake
    at 13, 6
    ld de, TextYouTake
    jp PutText
.theyTake:
    at 13, 6
    call PutPlayer
    ld de, TextTakes
    jp PutText
.bidding:
    at 9, 0
    ld de, TextHelp1
    call PutText
    at 10, 0
    ld de, TextHelp2
    call PutText
    at 11, 0
    ld de, TextHelp3
    call PutText
    at 13, 0                       ; my picker: <120h>
    ld a, TILE_LT
    ld [hl+], a
    ld a, [wMe]
    ld c, a
    push hl
    ld hl, wSelS
    call AddC
    ld b, [hl]
    ld hl, wSelV
    call AddC
    ld a, [hl]
    pop hl
    call PutBid
    ld a, TILE_GT
    ld [hl+], a
    ld a, [wState]
    cp ST_CONTRE
    jr nz, .myTurn
    ld a, [wBidder]                ; contré: the bidders may surcontrer
    xor c
    and 1
    ret nz
    at 13, 9
    ld de, TextSurAsk
    jp PutText
.myTurn:
    ld a, [wTurn]
    cp c
    ret nz
    at 13, 9
    ld de, TextYourBid
    call PutText
    inc hl
    jp PutClock

; Rows 14-17: my cards, centred; the one under my cursor raised while playing, and
; the ones I may not play grey on my turn.
RenderHand:
    ld a, [wState]
    cp ST_DEAL
    ret z
    ld a, [wMe]
    ld c, a
    ld a, $FF
    ldh [hTmp + 1], a              ; the cards drawn normally (not grey)
    ld a, [wState]
    cp ST_PLAY
    jr nz, .drawn
    ld a, [wTurn]
    cp c
    jr nz, .drawn
    call LegalMask
    ldh [hTmp + 1], a
.drawn:
    ld hl, wCount
    call AddC
    ld a, 10                       ; the first column: 10 - count
    sub [hl]
    ldh [hKey], a
    ld b, 0                        ; slot
.card:
    ld hl, wCount
    call AddC
    ld a, b
    cp [hl]
    ret nc
    push bc
    call HandOf
    ld a, b
    call AddA
    ld d, [hl]                     ; the card
    ld e, 0                        ; grey?
    ldh a, [hTmp + 1]
    inc b
.bit:
    dec b
    jr z, .gotBit
    rrca
    jr .bit
.gotBit:
    rrca
    jr c, .notGrey
    inc e
.notGrey:
    pop bc
    push bc
    ld hl, wWant + 15 * 32         ; raised: row 14
    ld a, [wState]
    cp ST_PLAY
    jr nz, .row
    push hl
    ld hl, wCur
    call AddC
    ld a, [hl]
    pop hl
    cp b
    jr nz, .row
    ld hl, wWant + 14 * 32
.row:
    ldh a, [hKey]
    call AddA
    call RenderCard
    ldh a, [hKey]
    add 2
    ldh [hKey], a
    pop bc
    inc b
    jr .card

; Card d at hl (2 x 3 tiles), grey if e = 1.
RenderCard:
    ld a, d
    and 7
    ld b, a                        ; rank
    ld a, d
    call SuitOf
    ld c, a
    ld a, e                        ; top left: TILE_RANK + grey * 16 + red * 8 + rank
    swap a
    add b
    ld b, a
    ld a, c
    dec a
    cp 2                           ; hearts and diamonds are red
    ld a, b
    jr nc, .black
    add 8
.black:
    add TILE_RANK
    ld [hl+], a
    ld a, e                        ; top right: TILE_SUIT + grey * 4 + suit
    add a
    add a
    add c
    add TILE_SUIT
    ld [hl], a
    ld a, e                        ; the big suit: TILE_BIG + (grey * 4 + suit) * 4 + part
    add a
    add a
    add c
    add a
    add a
    add TILE_BIG
    ld b, a
    ld a, 31
    call AddA
    ld a, b
    ld [hl+], a
    inc a
    ld [hl], a
    inc a
    ld b, a
    ld a, 31
    call AddA
    ld a, b
    ld [hl+], a
    inc a
    ld [hl], a
    ret

; The deal's result.
RenderDeal:
    call RenderContract
    at 3, 3
    ld de, TextMade
    ld a, [wMade]
    and a
    jr nz, .made
    ld de, TextDown
.made:
    call PutText
    at 5, 8
    ld de, TextUs
    call PutText
    at 5, 13
    ld de, TextThem
    call PutText
    at 6, 0
    ld de, TextPoints
    call PutText
    ld hl, wShownPts
    call TeamPair
    ld a, [wBelote]
    cp NOBODY
    jr z, .score
    at 7, 0
    ld de, TextBelote
    call PutText
    ld a, [wBelote]
    ld b, a
    ld a, [wMe]
    xor b
    and 1
    at 7, 9
    jr z, .ours
    at 7, 15
.ours:
    ld a, TILE_CH_2
    ld [hl+], a
    ld [hl], TILE_CH_0
.score:
    at 9, 0
    ld de, TextScore
    call PutText
    ld hl, wDelta
    ld a, 9 - 6
    ldh [hP], a
    jr TeamPairAt

; Both teams' words at hl (mine, then theirs) on row 6 (+ hP) under US and THEM.
TeamPair:
    xor a
    ldh [hP], a
TeamPairAt:
    push hl
    ld a, [wMe]
    and 1
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ldh a, [hP]
    ld hl, wWant + 6 * 32 + 7
    call RowsDown
    call PutNum4
    pop hl
    ld a, [wMe]
    and 1
    xor 1
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ldh a, [hP]
    ld hl, wWant + 6 * 32 + 13
    call RowsDown
    jp PutNum4

; hl += a rows
RowsDown:
    and a
    ret z
    push af
    call NextRow
    pop af
    dec a
    jr RowsDown

; The end of a game, and of the match.
RenderGame:
    at 4, 2
    ld de, TextWeWin
    ld a, [wMe]
    ld b, a
    ld a, [wGameWinner]
    xor b
    and 1
    jr z, .game
    ld de, TextTheyWin
.game:
    call PutText
    at 6, 3
    ld de, TextGames
    call PutText
    ld a, [wMe]
    and 1
    ld hl, wWins
    call AddA
    ld a, [hl+]
    ldh [hTmp], a
    ld a, [hl]                     ; the other team (wWins + 1 or + 2: same wins)
    ldh [hTmp + 1], a
    at 7, 5
    ld de, TextUs
    call PutText
    inc hl
    ldh a, [hTmp]
    call PutByte
    inc hl
    inc hl
    ld de, TextThem
    call PutText
    inc hl
    ldh a, [hTmp + 1]
    call PutByte
    ld a, [wState]
    cp ST_OVER
    jr z, .match
    at 10, 4
    ld de, TextPressStart
    call PutText
    at 12, 2
    ld de, TextReady
    call PutText
    ld c, 0
.ready:
    ld a, [wReady]
    ld b, c
    inc b
.bit:
    dec b
    jr z, .got
    rrca
    jr .bit
.got:
    rrca
    jr nc, .notReady
    inc hl
    ld a, c
    call PutPlayer
.notReady:
    inc c
    ld a, c
    cp 4
    jr nz, .ready
    ret
.match:
    at 10, 1
    ld de, TextWeWon
    ld a, [wMe]
    ld b, a
    ld a, [wGameWinner]
    xor b
    and 1
    jr z, .won
    ld de, TextTheyWon
.won:
    jp PutText

; ---------------------------------------------------------------------------- text
; "P" and player a's number (a = 0-3).
PutPlayer:
    ld b, a
    ld a, TILE_CH_P
    ld [hl+], a
    ld a, b
    add TILE_CH_1
    ld [hl+], a
    ret

; Bid a (9-16 or CAPOT) with suit b: "120h", "CAPOTs".
PutBid:
    cp CAPOT
    jr nz, .points
    ld de, TextCapot
    push bc
    call PutText
    pop bc
    jr .suit
.points:
    ld e, a                        ; a * 10
    add a
    add a
    add a
    add e
    add e
    ld e, a
    ld d, 0
    push bc
    call PutNumL
    pop bc
.suit:
    ld a, b
    add TILE_SPADE
    ld [hl+], a
    ret

; The seconds left (wSecs), two inverted digits.
PutClock:
    push bc
    ld a, [wSecs]
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
    add TILE_INV_0
    ld [hl+], a
    ld a, c
    add TILE_INV_0
    ld [hl+], a
    pop bc
    ret

; a (0-99) as digits.
PutByte:
    ld e, a
    ld d, 0
    ; fall through
PutNumL:                           ; de (0-9999) without blanks in front
    ld a, 1
    jr PutNum
PutNum4:                           ; de (0-9999) in 4 places, blanks in front
    xor a
PutNum:
    ldh [hBit], a                  ; 1: leave out leading zeros instead of blanks
    xor a
    ldh [hKey], a                  ; 1 once a digit is shown
    ld bc, 1000
    call DivStep
    call PutDigit
    ld bc, 100
    call DivStep
    call PutDigit
    ld bc, 10
    call DivStep
    call PutDigit
    ld a, 1
    ldh [hKey], a
    ld a, e
    ; fall through

PutDigit:
    ld b, a
    ldh a, [hKey]
    or b
    jr nz, .show
    ldh a, [hBit]
    and a
    ret nz
    ld [hl+], a                    ; 0 = TILE_BLANK
    ret
.show:
    ld a, 1
    ldh [hKey], a
    ld a, b
    add TILE_CH_0
    ld [hl+], a
    ret

; a = de / bc, de = de mod bc (de < 10 * bc).
DivStep:
    xor a
.loop:
    push af
    ld a, e
    sub c
    ld e, a
    ld a, d
    sbc b
    ld d, a
    jr c, .under
    pop af
    inc a
    jr .loop
.under:
    ld a, e
    add c
    ld e, a
    ld a, d
    adc b
    ld d, a
    pop af
    ret

NextRow:
    ld a, 32
    jp AddA

; Copies the text at de (ended by EOS) to hl (hl ends after it).
DEF EOS EQU $FF
PutText:
    ld a, [de]
    cp EOS
    ret z
    ld [hl+], a
    inc de
    jr PutText

TextLink:       db "WAITING FOR", EOS
TextUs:         db "US", EOS
TextThem:       db "THEM", EOS
TextDeals:      db " DEALS", EOS
TextShuffling:  db "SHUFFLING", EOS
TextContre:     db "CONTRE", EOS
TextSurcontre:  db "SURCONTRE", EOS
TextSur:        db "SUR", EOS
TextCapot:      db "CAPOT", EOS
TextPass:       db "PASS", EOS
TextRe:         db "RE", EOS
TextBelote:     db "BELOTE", EOS
TextYourTurn:   db "YOUR TURN", EOS
TextYouTake:    db "YOU TAKE", EOS
TextTakes:      db " TAKES", EOS
TextHelp1:      db "A:BID  B:PASS", EOS
TextHelp2:      db "SELECT:CONTRE", EOS
TextHelp3:      db "START:CAPOT", EOS
TextSurAsk:     db "SURCONTRE?", EOS
TextYourBid:    db "YOUR BID", EOS
TextMade:       db "CONTRACT MADE", EOS
TextDown:       db "CONTRACT DOWN", EOS
TextPoints:     db "POINTS", EOS
TextScore:      db "SCORE", EOS
TextWeWin:      db "WE WIN THE GAME", EOS
TextTheyWin:    db "THEY WIN THE GAME", EOS
TextGames:      db "GAMES WON", EOS
TextPressStart: db "PRESS START", EOS
TextReady:      db "READY:", EOS
TextWeWon:      db "WE WON THE MATCH!", EOS
TextTheyWon:    db "THEY WON THE MATCH", EOS
