# Belote

Belote as it is played in Tunisia (coinche, called belote there) for four players, one
Game Boy each, on the 4-Player Adapter, in two teams: players 1 and 3 against 2 and 4.
Partners sit opposite. Each screen shows only its own player's hand: the server sends
each phone nothing but its own screen.

- **Deal:** 32 cards, 8 each, shuffled with fresh random bytes from the server for
  every deal. The dealer moves one seat on after every deal; the first one is random.
- **Bidding** starts at the dealer's left. On your turn, up / down picks the points
  (90 to 160 in tens), left / right the trump suit, A bids, B passes. Each bid must be
  higher than the last.
- **Capot** (all 8 tricks) is the highest bid: START calls it with the suit you have
  picked, at any moment of the bidding, even out of turn. The first press wins (presses
  in the same 1/60 s are taken in a random order). Nothing can follow a capot, and
  nobody can contrer it.
- **Contrer:** after a bid, either opponent may press SELECT at any moment (x2). The
  bidding team then has 4 seconds to surcontrer with SELECT (x4), and the bidding ends.
- Three passes after a bid end the bidding. Four passes without one: the next player
  deals again.
- **Play:** left / right picks a card, A plays it; the cards you may not play are grey.
  Follow the suit led. Without it, play a trump, higher than any trump on the table if
  you can (if you cannot, any trump), unless your partner is winning the trick: then
  play anything. When trump is led, play a higher trump if you can. The best trump, or
  else the best card of the suit led, takes the trick; its taker leads next.
- **Points:** trump J 20, 9 14, A 11, 10 10, K 4, Q 3; other suits A 11, 10 10, K 4, Q 3,
  J 2; 10 more for the last trick (162 in all). A team that takes all 8 tricks counts
  250. King and queen of trump in one hand: belote and rebelote (shown when played),
  20 for that team.
- **Score:** the bidders make their contract with at least the points they bid (their
  belote counts), or for capot by taking every trick. Made: they score the bid plus
  their points, the others their points. Down: the others score 160 plus the bid.
  Contré (x2) or surcontré (x4): the winning team scores 160 plus the bid times 2 or 4,
  the other nothing. Belote's 20 always go to its team.
- **Game:** to 1000 points (`TARGET`); if both teams pass it in the same deal, the higher
  wins (tied: the bidders). A game is a round win for both players of the team. Then
  all four press START for the next game.
- **Match:** the first team to the chosen number of games (1-3, the server writes it).
- **Clock:** 20 seconds to bid or to play (`PLAY_SECONDS`); then the game passes for
  you, or plays the first card you may play.

RAM for the server: `$C000-$C003` round wins of players 1-4 (teammates the same), `$C004`
games for the match, `$C005` the request number for random bytes, `$C0C0-$C0FF` where
the server writes them (`random` in game.json).

## How it works

- **Lockstep**, like [skyhop/](../skyhop/): one game tick per adapter packet (`Tick` in
  `game.asm`), from the same four button bytes on every Game Boy. Every Game Boy knows
  every hand; `render.asm` draws only its own player's.
- **Fair deals:** a deal asks the server for 64 random bytes (a new number at `$C005`),
  waits 30 ticks so every Game Boy has them, and shuffles with them (Fisher-Yates;
  `RandBelow` skips the few byte values that would favour some cards).
- **The screen** is built in RAM (`wWant`) and only changed tiles are copied in VBlank.

## Files

- `main.asm`: RAM, start, the adapter link and the main loop; `game.asm` the rules;
  `render.asm` the screen; `util.asm` drawing, sound and helpers. `tiles.asm` is written
  by `make_tiles.py` (cards, the font with the suits as `s h d c`).
- `game.json`: results, teams, `secret`, `random` and the start script for the server.
- `bot.mjs`: four players bid (by hand strength), contre, call capot now and then and
  play random cards they may play; a whole match:
  `python3 tools/build.py belote --bot belote/bot.mjs --frames 200000 --shots ""`.

The rules were checked over whole bot matches against a separate implementation: every
deal against the server's bytes, every card played or refused (players also tried cards
they may not play), every trick's taker, every deal's points and score, how each bidding
ended, timeouts, and every game's end.
