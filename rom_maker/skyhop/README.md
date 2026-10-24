# Sky Hop

Two to four players, one Game Boy each, on the 4-Player Adapter.

- **Play:** everybody bounces automatically; LEFT and RIGHT steer (the screen wraps
  around at the sides). Land on a platform while falling to bounce higher.
- **Out:** the screen climbs by itself, a little faster over time, and keeps the highest
  player in view. Whoever drops below the bottom of the screen is out.
- **Round:** the last player left wins it (all out at once: nobody). Then everybody's
  START starts the next round.
- **Match:** the first to the chosen number of round wins (1-9, default 3).
- **Screen:** your player is drawn darker; the bottom line shows every player's wins,
  with an arrow at yours.

RAM for the server: `$C000-$C003` round wins of players 1-4 (the same on every Game
Boy), `$C004` round wins for the match, written by the server.
