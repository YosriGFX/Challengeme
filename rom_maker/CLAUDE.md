# rom_maker: making a game for Challenge Me

You are in `rom_maker/` of the Challenge Me repository. The person will describe a game
(idea, rules, look, how many players). Your job: write it as a **Game Boy ROM in RGBDS
assembly** for 2-4 players, translate it with the engine, and prove a whole match plays,
all with the tools here.

Challenge Me runs Game Boy games on a server (one per match), translated ahead of time
to WebAssembly; each player's phone shows their own Game Boy and sends buttons. Matches
are played for money, so fairness and the server knowing who won matter.

## Pick the starting point

| Players | Link | Start from | Example game |
| --- | --- | --- | --- |
| exactly 2 | link cable | `template/` | Coin Duel: grab the coin first |
| 2-4 | 4-Player Adapter | `skyhop/` | Sky Hop: climb, the last one on screen wins |

`python3 tools/new.py <name> "<Title>"` copies `template/`; add `--players 4` (or 3)
for `skyhop/`. `<name>`: lowercase a-z 0-9 _ -.

## Read first

1. [HARDWARE.md](HARDWARE.md): what the game runs on, what is not supported, and the
   rules the translator needs (sections 2-5 are required).
2. [ASSEMBLY.md](ASSEMBLY.md): how to write the game in assembly. Sections 8 (cable) or
   9 (adapter), 10 (results) and 12 (bots) are the ones specific to this engine.
3. The example you started from, `main.asm` top to bottom: every game here is built
   the same way, and the link code in it is tested; keep it.

## How to work

1. `sh tools/setup.sh` once if `python3 tools/build.py template` says a tool is missing.
2. `python3 tools/new.py <name> "<Title>" [--players 4]`, then build it once unchanged:
   `python3 tools/build.py <name>`.
3. Change it into the person's game in small steps. After each step:
   `python3 tools/build.py <name> --frames N --script ... --shots ...` and **look at the
   screenshots** (`<name>/build/shot_<frame>.png`: player 1's screen on the left, then
   player 2, 3, 4). Labels and their addresses are in `<name>/build/game.sym`.
4. Change `<name>/bot.mjs` to play your game, and test whole matches:
   `python3 tools/build.py <name> --bot <name>/bot.mjs --frames 30000 --shots ""`.
   It must print `match over, player N wins` with the Game Boys agreeing on every round.
   For adapter games also run `--players 2` and `--players 3`.
5. Fill in `<name>/game.json` (title, players, `result`, `start`) and a short
   `<name>/README.md`: rules, controls, what the counters mean.

Lines like `note: no code at 0048` while translating are normal (unused vectors and
guesses the translator dropped); only `STOPPED` in the run means missing code.

Done means: `tools/build.py` ends with `GB1 ok`, `GB2 ok`, ..., every screen agrees in
every screenshot, the bot plays whole matches to the right winner, and the person has
seen screenshots of the start, play, the end of a round and the end of the match.

## Rules

- **Lockstep.** Every Game Boy runs the whole game from every player's buttons, in the
  same order, so all screens agree without sending game state. Keep the example's link
  code: the cable handshake (START makes player 1), seed and per-frame `Exchange`; or
  the adapter's `SerialIsr` with one tick per packet. Never use `rDIV`, `rLY`, timers or
  frame counts for game decisions once the game runs.
- **Fair**: the same randomness for everybody (shared seed, or button bytes mixed into
  the generator), no advantage for any player number. Everybody sees every screen, so no
  hidden information.
- **Results** (ASSEMBLY.md section 10): round wins at fixed RAM addresses, +1 per round;
  `wins`/`theirs` on the cable, `winsBy` (every player's wins) on the adapter. Between
  rounds, wait until every player presses START. The match length comes from the
  server (`bestAt`, `bestChoices`); the game ends when a player reaches it.
- **Start fast**: boot straight into the match after the link is up; no menus the
  `start` script would have to walk through.
- **Adapter**: never send `$FF` in a game packet; show which player is "you" and
  everybody's score.
- **Translator-friendly** (HARDWARE.md section 4): code only in ROM, no addresses kept or
  computed in RAM, no self-modifying code, only the standard OAM DMA routine in HRAM.
- Stay inside `rom_maker/<name>/`. Do not change the translator, the server, the tools
  or the examples; if the engine seems to lack something, say so to the person.

## Handing over

Tell the person where the files are (`<name>/build/game.gb`, `game.wasm`, `game.json`)
and how to add the game to the server, from the repository root:
`python -m tools.add_game rom_maker/<name>/build/game.gb <name> "<Title>" --meta rom_maker/<name>/game.json`
(HARDWARE.md section 7), then restart `npx wrangler dev`.
