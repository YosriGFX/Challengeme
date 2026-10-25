# Chess

Two players, one Game Boy each, on the link cable. Each screen shows the board from its
own player's side, both chess clocks and both players' wins.

- **Moves:** the d-pad moves your cursor; A on one of your pieces picks it (dots show
  where it can go), A on a dot moves it, B lets go. A pawn reaching the last rank asks
  for its new piece: left / right to choose queen, rook, bishop or knight, A to play
  it, B to take the move back.
- **Rules:** every legal move: castling, en passant, promotion, no move that leaves your
  own king in check.
- **Clocks:** 5 minutes each (`CLOCK_MINUTES`); the clock of the side to move runs and
  is drawn inverted. Running out loses, unless the other player has only a king, or a
  king and one bishop or knight: then it is a draw.
- **Win:** checkmate, the other player resigning, or their time running out.
- **Draw:** stalemate, the same position a third time (same side to move, castling
  rights and en passant chances), 50 moves each without a capture or pawn move, no
  pieces left that can mate (a king and at most one bishop or knight, or only bishops
  all on one colour of square), or a draw offer taken.
- **SELECT menu:** A offers a draw, or takes the other player's offer (their screen
  says so); B asks "resign?" and A confirms. An offer stands until the other player
  moves.
- **Match:** a checkmate, resignation or time win is a round win; draws count for
  nobody. The first to the chosen number of round wins takes the match (the server
  writes it; 1 without one). Between games both players press START.
- **Colours:** the server writes two random bytes to `$C003` (`seedAt` in game.json)
  that pick who plays white in the first game; then colours swap every game.

RAM for the server: `$C000` my round wins, `$C001` theirs, `$C002` round wins for the
match, `$C003-$C004` the random bytes.

## How it fits in a frame

Both Game Boys run the whole game from both players' buttons (lockstep), so each frame
must do a bounded amount of work:

- **Legal moves** are found over several frames (`GenStep`): all pseudo-legal moves
  first, then a few full legality tests per frame. Most moves skip the full test: a
  piece that is not on a line with its own king (the `Aligned` table) cannot uncover a
  check when the king is not in check.
- **End checks** get a frame of their own (`EndChecks`): mate, stalemate, 50 moves,
  repetition (32-bit Zobrist keys, `make_zobrist.py`, one per position since the last
  capture or pawn move) and dead positions.
- **The screen** is built in RAM (`wWant`) and only changed tiles are copied in VBlank,
  a fixed 40 per frame, so `Draw` always takes the same time.

## Files

- `main.asm`: the game. `tiles.asm` and `zobrist.asm` are written by `make_tiles.py`
  (pieces drawn as text, the font) and `make_zobrist.py`.
- `game.json`: results, start script and `seedAt` for the server.
- `bot.mjs`: both players pick random legal moves; a whole match:
  `python3 tools/build.py chess --bot chess/bot.mjs --frames 100000 --shots ""`.

The rules were checked against chess.js move by move, over whole bot games: the legal
move list, check, the 50-move count, every kind of ending, and promotions to each piece.
