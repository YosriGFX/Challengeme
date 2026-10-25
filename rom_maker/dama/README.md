# Dama

Draughts (checkers) for two players, one Game Boy each, on the link cable: 8x8, men
one step at a time, flying kings (the rules of Brazilian draughts). Each screen
shows the board from its own player's side, both clocks, how many pieces each side has
left, and both players' wins.

- **Moves:** the d-pad moves your cursor. A on one of your pieces picks it, and dots
  show where it can go. A on a dot moves it there. B lets go. In a capture of several
  jumps, A on each landing square in turn ("NEXT JUMP"). B takes the jumps back.
- **Men** move one square diagonally forward. They capture by jumping an enemy piece
  next to them, forward or backward, onto the empty square behind it.
- **Kings:** a man that ends its move on the far row becomes a king (two stacked discs).
  A king flies: it moves any number of empty squares along a diagonal. It captures a
  piece any distance away along a diagonal, landing on any empty square beyond it.
- **Captures are forced, and the longest one too:** when you can take, you must, and
  you must take the most pieces you can (kings count as one). Jumped pieces come off
  only when the move ends, so no piece can be jumped twice, and a jumped piece still
  blocks the way. A man that only passes the far row in the middle of a capture stays
  a man.
- **Clocks:** 5 minutes each (`CLOCK_MINUTES`). The clock of the side to move runs and
  is drawn inverted. Running out loses.
- **Win:** the other side has no pieces left, or cannot move, or resigns, or runs out
  of time.
- **Draw:** the same position a third time with the same side to move; 25 moves each
  with only kings moving and nothing taken; a lone king against three pieces with at
  least one king holding out 16 moves each, or against one or two pieces with a king,
  5 moves each; a draw offer taken.
- **SELECT menu:** A offers a draw, or takes the other player's offer (their screen
  says so). B asks "resign?" and A confirms. An offer stands until the other player
  moves.
- **Match:** a win is a round win; draws count for nobody. The first to the chosen
  number of round wins takes the match (the server writes it; 1 without one). Between
  games both players press START.
- **Colours:** the server writes two random bytes to `$C003` (`seedAt` in game.json)
  that pick who plays white, the side that moves first, in the first game. Then
  colours swap every game.

RAM for the server: `$C000` my round wins, `$C001` theirs, `$C002` round wins for the
match, `$C003-$C004` the random bytes.

## How it fits in a frame

Both Game Boys run the whole game from both players' buttons (lockstep), so each frame
does a bounded amount of work (see [chess/](../chess/) for the same ideas):

- **Captures** are found by a depth-first search over the jumps, one piece per frame
  (`GenStep`, `SearchTakes`). Jumped pieces are marked `TAKEN` while the search is on
  them. Only the longest captures are kept, with every landing square so a player
  can pick among captures that end on the same square. Plain moves come in one more
  frame (`GenQuiet`) when there is no capture.
- **End checks** get a frame of their own (`EndChecks`): no move, no pieces, the draw
  counts and repetition (32-bit Zobrist keys, `make_zobrist.py`, one per position
  since the last capture or man move).
- **The screen** is built in RAM (`wWant`) and only changed tiles are copied in VBlank,
  a fixed 40 per frame.

## Files

- `main.asm`: the game. `tiles.asm` and `zobrist.asm` are written by `make_tiles.py`
  (pieces drawn as text, the font) and `make_zobrist.py`.
- `game.json`: results, start script and `seedAt` for the server.
- `bot.mjs`: both players pick random legal moves; a whole match:
  `python3 tools/build.py dama --bot dama/bot.mjs --frames 100000 --shots ""`.

The rules were checked against pydraughts (its Brazilian variant: these rules on 8x8),
position by position over whole bot games: every legal move and what it takes, and
every kind of ending, the draw counts included.
