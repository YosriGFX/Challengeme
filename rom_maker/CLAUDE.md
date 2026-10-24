# rom_maker: making a game for Challenge Me

You are in `rom_maker/` of the Challenge Me repository. The person will describe a game
(idea, rules, look). Your job: write it as a **two-player Game Boy ROM in RGBDS
assembly**, translate it with the engine, and prove it plays, all with the tools here.

Challenge Me runs Game Boy games on a server (one per match), translated ahead of time
to WebAssembly; each player's phone shows their own Game Boy and sends buttons. Matches
are played for money, so fairness and the server knowing who won matter.

## Read first

1. [HARDWARE.md](HARDWARE.md): what the game runs on, what is not supported, and the
   rules the translator needs (sections 2-5 are required).
2. [ASSEMBLY.md](ASSEMBLY.md): how to write the game in assembly, link and lockstep.
3. [template/main.asm](template/main.asm): a complete game built exactly that way.

## How to work

1. `sh tools/setup.sh` once if `python3 tools/build.py template` says a tool is missing.
2. Copy the template: `cp -r template <name>` (lowercase, a-z 0-9 _ -), and build it once
   to see it work: `python3 tools/build.py <name>`.
3. Change it into the person's game, in small steps. After each step:
   `python3 tools/build.py <name> --frames N --script ... --shots ...` and **look at the
   screenshots** (`<name>/build/shot_<frame>.png`: player 1 left, player 2 right).
4. Test a whole match: script the buttons, or write a small Node script like
   `tools/run2.mjs` that plays both sides from the game's RAM (positions in
   `build/game.sym`). The match must end, with each Game Boy's win counters agreeing
   (GB1 "wins" = GB2 "theirs").
5. Fill in `<name>/game.json` (title, `result`, `start`) and a short `<name>/README.md`:
   rules, controls, what the counters mean.

Lines like `note: no code at 0048` while translating are normal (unused vectors and
guesses the translator dropped); only `STOPPED` in the run means missing code.

Done means: `tools/build.py` ends with `GB1 ok` and `GB2 ok`, both screens agree in every
screenshot, a full match finishes with the right winner, and the person has seen
screenshots of title, play and the end of a match.

## Rules

- **Two players**, one Game Boy each, joined by the link cable. Keep the template's
  handshake (START makes player 1), seed and per-frame `Exchange`; run all game logic
  from both players' inputs in lockstep (ASSEMBLY.md section 8).
- **Fair**: same randomness for both (the shared seed), no advantage for player 1 or 2.
  Both players see both screens, so no hidden information.
- **Results**: round wins at fixed RAM addresses, "mine" and "theirs" on each Game Boy,
  +1 per round (ASSEMBLY.md section 9), then a pause of about 3.5 s before the next
  round. The game ends when one side reaches `best`.
- **Start fast**: boot straight into the match after the handshake; no menus the
  `start` script would have to walk through.
- **Translator-friendly** (HARDWARE.md section 4): code only in ROM, no addresses kept or
  computed in RAM, no self-modifying code, only the standard OAM DMA routine in HRAM.
- Stay inside `rom_maker/<name>/`. Do not change the translator, the server or the
  template; if the engine seems to lack something, say so to the person.
- More than two players is on hold; do not write 4-player games unless the person says
  otherwise.

## Handing over

Tell the person where the files are (`<name>/build/game.gb`, `game.wasm`, `game.json`)
and how to add the game to the server, from the repository root:
`python -m tools.add_game rom_maker/<name>/build/game.gb <name> "<Title>" --meta rom_maker/<name>/game.json`
(HARDWARE.md section 7).
