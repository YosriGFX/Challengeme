# rom_maker

Everything an AI session needs to make a new game for Challenge Me, for 2-4 players, from
a description to a translated, tested `.wasm`, in Game Boy assembly (no C compiler).

## Use it

```sh
cd rom_maker
sh tools/setup.sh          # once: downloads RGBDS and wabt into rom_maker/.tools
claude                     # start the session here; it reads CLAUDE.md on its own
```

Then describe the game in your prompt: idea, rules, controls, how many players, how a
round is won, the look. The session starts from the right example, writes the game,
builds, translates and plays it on linked Game Boys with bots, and shows you
screenshots.

## What is here

| | |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | instructions for the AI session: workflow, rules, what "done" means |
| [HARDWARE.md](HARDWARE.md) | the engine's "hardware", the 4-Player Adapter, the rules the translator needs |
| [ASSEMBLY.md](ASSEMBLY.md) | how to write a Game Boy game in assembly: link cable, adapter, results, bots |
| [template/](template/) | Coin Duel: a complete, tested 2-player game (link cable) |
| [skyhop/](skyhop/) | Sky Hop: a complete, tested 2-4 player game (4-Player Adapter) |
| `tools/new.py` | starts a new game from the right example |
| `tools/build.py` | assemble + translate + run linked Game Boys, screenshots, round wins, bots |
| `tools/run.mjs` | the run on its own: 2-4 Game Boys, cable or adapter, script or bot |
| `tools/setup.sh` | downloads the tools |

Try the examples: `python3 tools/build.py template` and `python3 tools/build.py skyhop`,
then open `template/build/shot_*.png` and `skyhop/build/shot_*.png`. A whole match with
bots: `python3 tools/build.py skyhop --bot skyhop/bot.mjs --frames 30000 --shots ""`.
Both examples are also on the server's game list (`src/games/coinduel.wasm`,
`skyhop.wasm`).

## Add a finished game to the server

From the repository root:

```sh
python -m tools.add_game rom_maker/<name>/build/game.gb <name> "<Title>" --meta rom_maker/<name>/game.json
```

`--meta` carries the players, link, win counters and the start script. Restart
`npx wrangler dev` and play on the phones.
