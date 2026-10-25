; ---------------------------------------------------------------------------- game
; Everything here runs once per adapter packet on every Game Boy, from the same buttons,
; and must give the same result on all of them: no drawing, nothing from wMe except
; which sounds to play.

Tick:
    ld a, 1
    ld [wBusy], a
    call TickState
    xor a
    ld [wBusy], a
    ld hl, wTicks
    inc [hl]
    ret nz
    inc hl
    inc [hl]
    ret

TickState:
    call NewPresses
    ld a, [wState]
    cp ST_LINK
    jp z, FirstTick
    cp ST_DEAL
    jp z, DealTick
    cp ST_BID
    jp z, BidTick
    cp ST_CONTRE
    jp z, ContreTick
    cp ST_PLAY
    jp z, PlayTick
    cp ST_TRICK
    jp z, TrickTick
    cp ST_SCORE
    jp z, ScoreTick
    cp ST_WAIT
    jp z, WaitTick
    ret

; wNew = buttons pressed since the last tick, per player.
NewPresses:
    ld c, 0
.loop:
    ld hl, wPrev
    call AddC
    ld a, [hl]
    cpl
    ld b, a
    ld hl, wIn
    call AddC
    ld a, [hl]
    and b
    ld hl, wNew
    call AddC
    ld [hl], a
    inc c
    ld a, c
    cp 4
    jr nz, .loop
    ret

; The first game packet: who I am, then the first game. The first dealer is random.
FirstTick:
    ld a, [wStat]
    and 7
    dec a
    ld [wMe], a
    ld a, NOBODY
    ld [wDealer], a
    ; fall through

NewGame:
    xor a
    ld hl, wScore
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ; fall through

; Asks the server for fresh random bytes (a new request number at wAsk) and deals with
; them RANDOM_DELAY ticks later, when every Game Boy has them.
StartDeal:
    ld hl, wAsk
    inc [hl]
    jr nz, .asked
    inc [hl]                       ; never 0
.asked:
    ld bc, RANDOM_DELAY
    call SetTimer
    xor a
    ld hl, wCount
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld [wBid], a
    ld a, ST_DEAL
    ld [wState], a
    ret

DealTick:
    call CountDown
    ret nz
    ld a, [wRandom]                ; byte 0: the first dealer, whose presses count first
    ld b, a
    ld a, [wDealer]
    cp NOBODY
    jr nz, .dealer
    ld a, b
    and 3
    ld [wDealer], a
.dealer:
    ld a, b
    rrca
    rrca
    and 3
    ld [wRot], a
    ld a, 1
    ld [wRndIdx], a
    call Shuffle
    call DealCards
    call ResetDeal
    ld a, [wDealer]                ; the bidding starts at the dealer's left
    inc a
    and 3
    ld [wTurn], a
    call StartClock
    ld a, ST_BID
    ld [wState], a
    jp TurnSound

; wDeck = the 32 cards in a random order (Fisher-Yates, from wRandom).
Shuffle:
    ld hl, wDeck
    xor a
.init:
    ld [hl+], a
    inc a
    cp 32
    jr nz, .init
    ld c, 31
.loop:
    ld a, c
    inc a
    ld b, a
    call RandBelow                 ; a = 0 .. c
    ld hl, wDeck
    call AddA
    ld d, [hl]
    push hl
    ld hl, wDeck
    call AddC
    ld e, [hl]
    ld [hl], d
    pop hl
    ld [hl], e
    dec c
    jr nz, .loop
    ret

; a = a random number 0 .. b - 1 (b = 2-32) from the next random bytes, each value as
; likely as the others: a byte from the last few that would favour some is skipped.
; Keeps c.
RandBelow:
    ld a, 255                      ; d = 256 mod b: bytes 256 - d and up are skipped
.mod:
    cp b
    jr c, .rem
    sub b
    jr .mod
.rem:
    inc a
    cp b
    jr nz, .keepRem
    xor a
.keepRem:
    ld d, a
.draw:
    ld a, [wRndIdx]
    cp RANDOM_BYTES
    jr nc, .last
    ld e, a
    inc a
    ld [wRndIdx], a
    ld hl, wRandom
    ld a, e
    call AddA
    ld a, [hl]
    ld e, a
    add d
    jr c, .draw
    ld a, e
    jr .reduce
.last:                             ; out of bytes (never seen): the last one, nearly fair
    ld a, [wRandom + RANDOM_BYTES - 1]
.reduce:
    cp b
    ret c
    sub b
    jr .reduce

; Eight cards each from the shuffled deck, each hand sorted (by suit, then rank).
DealCards:
    ld hl, wDeck
    ld de, wHands
    ld bc, 32
    call Copy
    ld c, 0
.hand:
    call SortHand
    ld hl, wCount
    call AddC
    ld [hl], 8
    inc c
    ld a, c
    cp 4
    jr nz, .hand
    ret

; Sorts player c's 8 slots (NO_CARD last).
SortHand:
    call HandOf
    ld b, 7
.pass:
    push hl
    ld d, 7
.cmp:
    ld a, [hl+]
    ld e, a
    ld a, [hl]
    cp e
    jr nc, .ok
    ld [hl], e
    dec hl
    ld [hl+], a
.ok:
    dec d
    jr nz, .cmp
    pop hl
    dec b
    jr nz, .pass
    ret

ResetDeal:
    ld a, NO_CARD
    ld hl, wTable
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld a, NOBODY
    ld [wBidder], a
    ld [wBelote], a
    xor a
    ld [wPlayed], a
    ld [wTrick], a
    ld [wBid], a
    ld [wCoinche], a
    ld [wPasses], a
    ld [wBeloteSaid], a
    ld hl, wSaid
    ld b, 4
.said:
    ld [hl+], a
    dec b
    jr nz, .said
    ld hl, wCur
    ld b, 4
.cur:
    ld [hl+], a
    dec b
    jr nz, .cur
    ld hl, wPoints
    ld b, 6                        ; wPoints and wTricks
.points:
    ld [hl+], a
    dec b
    jr nz, .points
    ld a, 9
    ld hl, wSelV
    ld b, 4
.pick:
    ld [hl+], a
    dec b
    jr nz, .pick
    ret

; ---------------------------------------------------------------------------- bidding
; Every player's new presses, starting with wRot's (so presses in the same tick are
; taken in a random order), then the clock of the player to bid.
BidTick:
    ld a, [wRot]
    ld c, a
    ld b, 4
.player:
    push bc
    call BidInput
    pop bc
    ret c                          ; the bidding is over (or contré)
    ld a, c
    inc a
    and 3
    ld c, a
    dec b
    jr nz, .player
    call TickClock
    ret nz
    ld a, [wTurn]                  ; out of time: a pass
    ld c, a
    jp Pass

; Player c's presses in the bidding. Carry: the bidding is over, or contré.
BidInput:
    ld hl, wNew
    call AddC
    ld a, [hl]
    and a
    ret z
    ld b, a
    bit 6, b                       ; up: more points
    jr z, .notUp
    ld hl, wSelV
    call AddC
    ld a, [hl]
    cp CAPOT
    jr nc, .notUp
    inc [hl]
.notUp:
    bit 7, b                       ; down: fewer
    jr z, .notDown
    ld hl, wSelV
    call AddC
    ld a, [hl]
    cp 10
    jr c, .notDown
    dec [hl]
.notDown:
    bit 4, b                       ; right / left: the suit
    jr z, .notRight
    ld hl, wSelS
    call AddC
    ld a, [hl]
    inc a
    and 3
    ld [hl], a
.notRight:
    bit 5, b
    jr z, .notLeft
    ld hl, wSelS
    call AddC
    ld a, [hl]
    dec a
    and 3
    ld [hl], a
.notLeft:
    bit 3, b                       ; START: capot, any time
    jp nz, Capot
    bit 2, b                       ; SELECT: contre
    jr z, .notContre
    push bc
    call Contre
    pop bc
    ret c
.notContre:
    ld a, [wTurn]
    cp c
    jr nz, .wait
    bit 0, b
    jr nz, Bid
    bit 1, b
    jp nz, Pass
.wait:
    and a
    ret

; Player c bids their picker's points and suit, if higher than the last bid.
Bid:
    ld hl, wSelV
    call AddC
    ld a, [hl]
    ld e, a
    ld a, [wBid]
    cp e
    jr c, .higher
    call NoSound
    and a
    ret
.higher:
    ld a, e
    cp CAPOT
    jp z, Capot
    ld [wBid], a
    ld a, c
    ld [wBidder], a
    ld hl, wSelS
    call AddC
    ld a, [hl]
    ld [wTrump], a
    ld d, a
    xor a
    ld [wPasses], a
    ld hl, wSaid
    call AddC
    ld [hl], SAID_BID
    ld hl, wSaidV
    call AddC
    ld [hl], e
    ld hl, wSaidS
    call AddC
    ld [hl], d
    ld a, SND_CARD
    ld [wSound], a
    call RaisePickers
    ; fall through

NextBidder:
    ld a, [wTurn]
    inc a
    and 3
    ld [wTurn], a
    call StartClock
    call TurnSound
    and a
    ret

; Every picker below the new bid goes up to just above it.
RaisePickers:
    ld a, [wBid]
    inc a
    ld e, a
    ld hl, wSelV
    ld b, 4
.loop:
    ld a, [hl]
    cp e
    jr nc, .ok
    ld [hl], e
.ok:
    inc hl
    dec b
    jr nz, .loop
    ret

; Player c (to bid) passes. Carry: the bidding is over.
Pass:
    ld hl, wSaid
    call AddC
    ld [hl], SAID_PASS
    ld hl, wPasses
    inc [hl]
    ld a, [wBid]
    and a
    jr nz, .afterBid
    ld a, [hl]
    cp 4
    jr nz, NextBidder
    call NextDealer                ; nobody bid: the next player deals
    call StartDeal
    scf
    ret
.afterBid:
    ld a, [hl]
    cp 3
    jr nz, NextBidder
    jp EndBidding

; Player c contre the last bid, if they may: an opponent of the bidder, the bid not yet
; contré and not capot. Carry if done.
Contre:
    ld a, [wBid]
    and a
    ret z
    cp CAPOT
    jr nc, .no
    ld a, [wCoinche]
    and a
    jr nz, .no
    ld a, [wBidder]
    xor c
    and 1
    jr z, .no
    ld a, 1
    ld [wCoinche], a
    ld hl, wSaid
    call AddC
    ld [hl], SAID_CONTRE
    ld bc, CONTRE_TICKS
    call SetTimer
    ld a, ST_CONTRE
    ld [wState], a
    ld a, SND_CALL
    ld [wSound], a
    scf
    ret
.no:
    and a
    ret

; Contré: the bidders may surcontrer (SELECT) for a moment; anyone may still call capot.
ContreTick:
    ld a, [wRot]
    ld c, a
    ld b, 4
.player:
    ld hl, wNew
    call AddC
    ld a, [hl]
    bit 3, a
    jp nz, Capot
    bit 2, a
    jr z, .next
    ld a, [wBidder]
    xor c
    and 1
    jr nz, .next
    ld a, 2                        ; surcontré
    ld [wCoinche], a
    ld hl, wSaid
    call AddC
    ld [hl], SAID_SUR
    ld a, SND_CALL
    ld [wSound], a
    jp EndBidding
.next:
    ld a, c
    inc a
    and 3
    ld c, a
    dec b
    jr nz, .player
    call CountDown
    ret nz
    jp EndBidding

; Player c calls capot with the suit of their picker: nothing can follow it.
Capot:
    ld a, CAPOT
    ld [wBid], a
    ld a, c
    ld [wBidder], a
    ld hl, wSelS
    call AddC
    ld a, [hl]
    ld [wTrump], a
    ld hl, wSaidS
    call AddC
    ld [hl], a
    xor a
    ld [wCoinche], a
    ld hl, wSaid
    call AddC
    ld [hl], SAID_CAPOT
    ld a, SND_CALL
    ld [wSound], a
    ; fall through

; The contract is set: who holds belote, then the dealer's left leads. Carry.
EndBidding:
    ld a, NOBODY
    ld [wBelote], a
    ld a, [wTrump]
    add a
    add a
    add a
    add 5
    ld d, a                        ; the queen of trump
    inc a
    ld e, a                        ; the king
    ld c, 0
.player:
    call HandOf
    ld b, 8
    ld a, 0
    ldh [hBit], a
.card:
    ld a, [hl+]
    cp d
    jr z, .queen
    cp e
    jr nz, .nextCard
    ldh a, [hBit]
    or 2
    jr .found
.queen:
    ldh a, [hBit]
    or 1
.found:
    ldh [hBit], a
.nextCard:
    dec b
    jr nz, .card
    ldh a, [hBit]
    cp 3
    jr nz, .nextPlayer
    ld a, c
    ld [wBelote], a
.nextPlayer:
    inc c
    ld a, c
    cp 4
    jr nz, .player
    xor a
    ld [wPlayed], a
    ld hl, wCur
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    ld a, [wDealer]
    inc a
    and 3
    ld [wTurn], a
    ld [wLeader], a
    ld a, ST_PLAY
    ld [wState], a
    call StartClock
    call TurnSound
    scf
    ret

; ---------------------------------------------------------------------------- play
; Everybody's cursor moves; the player to play plays with A, or the clock plays for them.
PlayTick:
    ld c, 0
.cursor:
    ld hl, wNew
    call AddC
    ld b, [hl]
    ld hl, wCur
    call AddC
    bit 4, b                       ; right
    jr z, .notRight
    push hl
    ld hl, wCount
    call AddC
    ld a, [hl]
    pop hl
    dec a
    cp [hl]
    jr z, .notRight
    jr c, .notRight
    inc [hl]
.notRight:
    bit 5, b                       ; left
    jr z, .notLeft
    ld a, [hl]
    and a
    jr z, .notLeft
    dec [hl]
.notLeft:
    inc c
    ld a, c
    cp 4
    jr nz, .cursor
    ld a, [wTurn]
    ld c, a
    ld hl, wNew
    call AddC
    bit 0, [hl]
    jr z, .clock
    ld hl, wCur
    call AddC
    ld a, [hl]
    call TryPlay
    ret c
.clock:
    call TickClock
    ret nz
    ld a, [wTurn]                  ; out of time: their first card that may be played
    ld c, a
    call LegalMask
    ld b, 0
.first:
    rrca
    jr c, .found
    inc b
    jr .first
.found:
    ld a, b
    jr PlayCard

; Player c plays the card in slot a if they may. Carry if played.
TryPlay:
    ldh [hTmp], a
    call LegalMask
    ld b, a
    ldh a, [hTmp]
    call BitOf
    and b
    jr nz, .legal
    call NoSound
    and a
    ret
.legal:
    ldh a, [hTmp]
    ; fall through

; Player c plays the card in slot a: out of the hand, onto the table. Carry.
PlayCard:
    ld e, a
    call HandOf
    ld a, e
    call AddA
    ld d, [hl]                     ; the card
    ld a, 7
    sub e
    jr z, .last
    ld b, a
.shift:
    inc hl
    ld a, [hl-]
    ld [hl+], a
    dec b
    jr nz, .shift
.last:
    ld [hl], NO_CARD
    ld hl, wCount
    call AddC
    dec [hl]
    ld b, [hl]
    ld hl, wCur                    ; the cursor stays on a card
    call AddC
    ld a, b
    and a
    jr z, .cursorOk
    dec a
    cp [hl]
    jr nc, .cursorOk
    ld [hl], a
.cursorOk:
    ld hl, wTable
    call AddC
    ld [hl], d
    ld hl, wPlayed
    inc [hl]
    ld a, SND_CARD
    ld [wSound], a
    ld a, [wBelote]                ; belote, rebelote: the holder plays king or queen of trump
    cp c
    jr nz, .notBelote
    ld a, d
    call SuitOf
    ld hl, wTrump
    cp [hl]
    jr nz, .notBelote
    ld a, d
    and 7
    cp 5
    jr c, .notBelote
    cp 7
    jr nc, .notBelote
    ld hl, wBeloteSaid
    inc [hl]
    ld a, [wTrick]
    ld [wBeloteTrick], a
    ld a, SND_CALL
    ld [wSound], a
.notBelote:
    ld a, [wPlayed]
    cp 4
    jr z, .full
    ld a, [wTurn]
    inc a
    and 3
    ld [wTurn], a
    call StartClock
    call TurnSound
    scf
    ret
.full:
    call TrickWinner
    ld [wWinner], a
    ld bc, TRICK_TICKS
    call SetTimer
    ld a, ST_TRICK
    ld [wState], a
    scf
    ret

; A full trick stays on the table for a moment, then goes to its taker's team.
TrickTick:
    call CountDown
    ret nz
    ld a, [wWinner]
    and 1
    ldh [hT], a
    ld b, 0                        ; the cards' points
    ld c, 0
.sum:
    ld hl, wTable
    call AddC
    ld a, [hl]
    push bc
    call CardPoints
    pop bc
    add b
    ld b, a
    inc c
    ld a, c
    cp 4
    jr nz, .sum
    ld a, [wTrick]
    cp 7
    jr nz, .notLast
    ld a, b                        ; the last trick: 10 more
    add 10
    ld b, a
.notLast:
    ldh a, [hT]
    ld hl, wPoints
    call TeamWord
    ld a, [hl]
    add b
    ld [hl+], a
    jr nc, .noCarry
    inc [hl]
.noCarry:
    ld hl, wTricks
    ldh a, [hT]
    call AddA
    inc [hl]
    ld a, NO_CARD
    ld hl, wTable
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    xor a
    ld [wPlayed], a
    ld hl, wTrick
    inc [hl]
    ld a, [hl]
    cp 8
    jp z, ScoreDeal
    ld a, [wWinner]
    ld [wTurn], a
    ld [wLeader], a
    ld a, ST_PLAY
    ld [wState], a
    call StartClock
    jp TurnSound

; a = the cards c may play, as slot bits (bit i: slot i).
LegalMask:
    ld a, [wPlayed]
    and a
    jr nz, .trick
.all:
    ld hl, wCount
    call AddC
    ld b, [hl]
    xor a
    inc b
    jr .countDown
.allBits:
    scf
    rla
.countDown:
    dec b
    jr nz, .allBits
    ret
.trick:
    call TableBest                 ; hLed, hBest
    xor a
    ldh [hMLed], a
    ldh [hMTrump], a
    ldh [hMHigh], a
    ld a, 1
    ldh [hBit], a
    call HandOf
    push bc
    ld hl, wCount
    call AddC
    ld b, [hl]
    call HandOf
.card:
    ld a, b
    and a
    jr z, .scanned
    ld a, [hl+]
    ld e, a
    call SuitOf
    ld d, a
    ldh a, [hLed]
    cp d
    jr nz, .notLed
    ldh a, [hBit]
    ld c, a
    ldh a, [hMLed]
    or c
    ldh [hMLed], a
.notLed:
    ld a, [wTrump]
    cp d
    jr nz, .nextCard
    ldh a, [hBit]
    ld c, a
    ldh a, [hMTrump]
    or c
    ldh [hMTrump], a
    ld a, e
    and 7
    push hl
    ld hl, TrumpOrder
    call AddA
    ld a, [hl]
    pop hl
    inc a
    ld d, a
    ldh a, [hBest]
    cp d
    jr nc, .nextCard
    ldh a, [hBit]
    ld c, a
    ldh a, [hMHigh]
    or c
    ldh [hMHigh], a
.nextCard:
    ldh a, [hBit]
    add a
    ldh [hBit], a
    dec b
    jr .card
.scanned:
    pop bc
    ldh a, [hLed]
    ld hl, wTrump
    cp [hl]
    jr nz, .plain
    ldh a, [hMTrump]               ; trump led: higher if you can, else any trump
    and a
    jp z, .all
    ldh a, [hMHigh]
    and a
    ret nz
    ldh a, [hMTrump]
    ret
.plain:
    ldh a, [hMLed]                 ; follow the suit led
    and a
    ret nz
    push bc                        ; cannot: anything if my partner is winning
    call TrickWinner
    pop bc
    xor c
    and 1
    jp z, .all
    ldh a, [hMTrump]               ; else trump: higher if you can, else any trump
    and a
    jp z, .all
    ldh a, [hMHigh]
    and a
    ret nz
    ldh a, [hMTrump]
    ret

; hLed = the suit led; hBest = 1 + the order of the best trump on the table (0: none).
TableBest:
    push bc
    ld a, [wLeader]
    ld hl, wTable
    call AddA
    ld a, [hl]
    call SuitOf
    ldh [hLed], a
    xor a
    ldh [hBest], a
    ld c, 0
.loop:
    ld hl, wTable
    call AddC
    ld a, [hl]
    cp NO_CARD
    jr z, .next
    ld e, a
    call SuitOf
    ld hl, wTrump
    cp [hl]
    jr nz, .next
    ld a, e
    and 7
    ld hl, TrumpOrder
    call AddA
    ld a, [hl]
    inc a
    ld e, a
    ldh a, [hBest]
    cp e
    jr nc, .next
    ld a, e
    ldh [hBest], a
.next:
    inc c
    ld a, c
    cp 4
    jr nz, .loop
    pop bc
    ret

; a = the player whose card takes the trick so far: the best trump, or else the best
; card of the suit led. Sets hLed.
TrickWinner:
    ld a, [wLeader]
    ld c, a
    ld hl, wTable
    call AddC
    ld a, [hl]
    call SuitOf
    ldh [hLed], a
    ld a, [wPlayed]
    ld b, a
    ld d, 0                        ; the best key so far
    ld e, c
.loop:
    ld hl, wTable
    call AddC
    ld a, [hl]
    call CardKey
    cp d
    jr c, .next
    jr z, .next
    ld d, a
    ld e, c
.next:
    ld a, c
    inc a
    and 3
    ld c, a
    dec b
    jr nz, .loop
    ld a, e
    ret

; a = how card a ranks in the trick: 16 + its order as a trump, 8 + its order in the
; suit led, or 0.
CardKey:
    push hl
    ld l, a
    call SuitOf
    ld h, a
    ld a, [wTrump]
    cp h
    jr z, .trump
    ldh a, [hLed]
    cp h
    jr nz, .none
    ld a, l
    and 7
    ld hl, PlainOrder
    call AddA
    ld a, [hl]
    add 8
    pop hl
    ret
.trump:
    ld a, l
    and 7
    ld hl, TrumpOrder
    call AddA
    ld a, [hl]
    add 16
    pop hl
    ret
.none:
    xor a
    pop hl
    ret

; a = card a's points.
CardPoints:
    ld b, a
    and 7
    ld e, a
    ld a, b
    call SuitOf
    ld hl, wTrump
    cp [hl]
    ld hl, PlainPoints
    jr nz, .got
    ld hl, TrumpPoints
.got:
    ld a, e
    call AddA
    ld a, [hl]
    ret

; Ranks 7 8 9 10 J Q K A
PlainOrder:  db 0, 1, 2, 6, 3, 4, 5, 7
TrumpOrder:  db 0, 1, 6, 4, 7, 2, 3, 5
PlainPoints: db 0, 0, 0, 10, 2, 3, 4, 11
TrumpPoints: db 0, 0, 14, 10, 20, 3, 4, 11

; ---------------------------------------------------------------------------- scoring
ScoreDeal:
    ld a, [wBidder]
    and 1
    ldh [hT], a
    ld c, 0                        ; a team with every trick counts 250
.capot:
    ld hl, wTricks
    call AddC
    ld a, [hl]
    cp 8
    jr nz, .notCapot
    ld a, c
    ld hl, wPoints
    call TeamWord
    ld a, LOW(250)
    ld [hl+], a
    ld [hl], HIGH(250)
.notCapot:
    inc c
    ld a, c
    cp 2
    jr nz, .capot
    ld hl, wPoints
    ld de, wShownPts
    ld bc, 4
    call Copy
    xor a
    ld hl, wDelta
    ld [hl+], a
    ld [hl+], a
    ld [hl+], a
    ld [hl], a
    call ContractValue             ; de = the bid's points
    ; made? capot: every trick; else the bidders' points (and their belote) >= the bid
    ld a, [wBid]
    cp CAPOT
    jr nz, .points
    ldh a, [hT]
    ld hl, wTricks
    call AddA
    ld a, [hl]
    cp 8
    ld a, 0
    jr nz, .made
    inc a
    jr .made
.points:
    ldh a, [hT]
    ld hl, wPoints
    call TeamWord
    ld a, [hl+]
    ld h, [hl]
    ld l, a                        ; hl = the bidders' points
    ld a, [wBelote]
    cp NOBODY
    jr z, .noBelote
    and 1
    ld b, a
    ldh a, [hT]
    cp b
    jr nz, .noBelote
    ld bc, 20
    add hl, bc
.noBelote:
    ld a, l                        ; hl - de: no borrow = made
    sub e
    ld a, h
    sbc d
    ld a, 0
    jr c, .made
    inc a
.made:
    ld [wMade], a
    ld a, [wCoinche]
    and a
    jr nz, .contre
    ld a, [wMade]
    and a
    jr z, .down
    ldh a, [hT]                    ; made: the bid and their points; the others their points
    push de
    call AddDelta
    pop de
    ldh a, [hT]
    ld hl, wPoints
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ldh a, [hT]
    call AddDelta
    ldh a, [hT]
    xor 1
    ld hl, wPoints
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ldh a, [hT]
    xor 1
    call AddDelta
    jr .belote
.down:
    ld hl, 160                     ; down: the others 160 and the bid
    add hl, de
    ld d, h
    ld e, l
    ldh a, [hT]
    xor 1
    call AddDelta
    jr .belote
.contre:
    ld h, d                        ; contré x2, surcontré x4: 160 and the bid times that
    ld l, e
    ld a, [wCoinche]
    ld b, a
.double:
    add hl, hl
    dec b
    jr nz, .double
    ld de, 160
    add hl, de
    ld d, h
    ld e, l
    ldh a, [hT]
    ld b, a
    ld a, [wMade]
    and a
    ld a, b
    jr nz, .winner
    xor 1
.winner:
    call AddDelta
.belote:
    ld a, [wBelote]                ; belote's 20 always go to its team
    cp NOBODY
    jr z, .total
    and 1
    ld de, 20
    call AddDelta
.total:
    ld c, 0
.add:
    ld a, c
    ld hl, wDelta
    call TeamWord
    ld a, [hl+]
    ld d, [hl]
    ld e, a
    ld a, c
    ld hl, wScore
    call TeamWord
    ld a, [hl]
    add e
    ld [hl+], a
    ld a, [hl]
    adc d
    ld [hl], a
    inc c
    ld a, c
    cp 2
    jr nz, .add
    ld bc, SCORE_TICKS
    call SetTimer
    ld a, ST_SCORE
    ld [wState], a
    ld a, SND_DEAL
    ld [wSound], a
    ret

; de = the contract's points: the bid times 10, or 250 for capot.
ContractValue:
    ld a, [wBid]
    cp CAPOT
    jr nz, .bid
    ld de, 250
    ret
.bid:
    ld e, a                        ; a * 10 = a * 8 + a * 2
    add a
    add a
    add a
    add e
    add e
    ld e, a
    ld d, 0
    ret

; Team a's wDelta += de.
AddDelta:
    ld hl, wDelta
    call TeamWord
    ld a, [hl]
    add e
    ld [hl+], a
    ld a, [hl]
    adc d
    ld [hl], a
    ret

; The deal's result stays a moment; then a game over (TARGET reached), or the next deal.
ScoreTick:
    call CountDown
    ret nz
    ld b, 0                        ; bit 0: team 0 reached TARGET, bit 1: team 1
    ld hl, wScore
    call ReachedTarget
    jr c, .t1
    set 0, b
.t1:
    ld hl, wScore + 2
    call ReachedTarget
    jr c, .check
    set 1, b
.check:
    ld a, b
    and a
    jr nz, .over
    call NextDealer
    jp StartDeal
.over:
    cp 3
    jr z, .both
    dec a                          ; 1 -> team 0, 2 -> team 1
    jr .won
.both:                             ; the higher score wins; tied, the bidders
    ld hl, wScore
    ld a, [hl+]
    ld e, a
    ld a, [hl+]
    ld d, a
    ld a, [hl+]                    ; team 1 - team 0
    sub e
    ld e, a
    ld a, [hl]
    sbc d
    jr c, .team0
    or e
    ld a, 1
    jr nz, .won
    ld a, [wBidder]
    and 1
    jr .won
.team0:
    xor a
.won:
    ld [wGameWinner], a
    ld hl, wWins                   ; both of the team's players win the round
    call AddA
    inc [hl]
    inc hl
    inc hl
    inc [hl]
    ld b, [hl]
    call Best
    ld c, a
    ld a, b
    cp c
    ld a, ST_OVER
    jr nc, .state
    xor a
    ld [wReady], a
    ld a, ST_WAIT
.state:
    ld [wState], a
    ret

; Carry if the score at hl is below TARGET.
ReachedTarget:
    ld a, [hl+]
    sub LOW(TARGET)
    ld a, [hl]
    sbc HIGH(TARGET)
    ret

; Between games: everyone's START counts; all four, the next game.
WaitTick:
    ld c, 0
.player:
    ld hl, wNew
    call AddC
    bit 3, [hl]
    jr z, .next
    ld a, c
    call BitOf
    ld hl, wReady
    or [hl]
    ld [hl], a
.next:
    inc c
    ld a, c
    cp 4
    jr nz, .player
    ld a, [wReady]
    cp $0F
    ret nz
    call NextDealer
    jp NewGame

; a = round wins that win the match.
Best:
    ld a, [wBest]
    and a
    ret nz
    ld a, WINS_TO_MATCH
    ret

NextDealer:
    ld a, [wDealer]
    inc a
    and 3
    ld [wDealer], a
    ret

; ---------------------------------------------------------------------------- helpers
; hl = player c's hand.
HandOf:
    ld a, c
    add a
    add a
    add a
    ld hl, wHands
    ; fall through
; hl += a
AddA:
    add l
    ld l, a
    ret nc
    inc h
    ret

; hl += c (keeps a)
AddC:
    push af
    ld a, l
    add c
    ld l, a
    jr nc, .done
    inc h
.done:
    pop af
    ret

; hl += a * 2 (team a's word)
TeamWord:
    add a
    jr AddA

; a = 1 << a
BitOf:
    push bc
    ld b, a
    ld a, 1
    inc b
.shift:
    dec b
    jr z, .done
    add a
    jr .shift
.done:
    pop bc
    ret

; a = the suit of card a
SuitOf:
    rrca
    rrca
    rrca
    and 3
    ret

SetTimer:
    ld a, c
    ld [wTimer], a
    ld a, b
    ld [wTimer + 1], a
    ret

; wTimer - 1; z when it reaches 0.
CountDown:
    ld hl, wTimer
    ld a, [hl]
    sub 1
    ld [hl+], a
    ld a, [hl]
    sbc 0
    ld [hl-], a
    or [hl]
    ret

StartClock:
    ld a, TICKS_PER_SEC
    ld [wSecT], a
    ld a, PLAY_SECONDS
    ld [wSecs], a
    ret

; The clock of the player to act; z when their time is up.
TickClock:
    ld hl, wSecT
    dec [hl]
    ret nz
    ld [hl], TICKS_PER_SEC
    ld hl, wSecs
    dec [hl]
    ret

; A beep when it is now my turn.
TurnSound:
    ld a, [wMe]
    ld b, a
    ld a, [wTurn]
    cp b
    ret nz
    ld a, SND_TURN
    ld [wSound], a
    ret

; A buzz if player c is me (a press that does nothing).
NoSound:
    ld a, [wMe]
    cp c
    ret nz
    ld a, SND_NO
    ld [wSound], a
    ret
