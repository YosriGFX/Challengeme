# rom_maker

Everything an AI session needs to make a new two-player game for Challenge Me, from a
description to a translated, tested `.wasm`, in Game Boy assembly (no C compiler).

## Use it

```sh
cd rom_maker
sh tools/setup.sh          # once: downloads RGBDS and wabt into rom_maker/.tools
claude                     # start the session here; it reads CLAUDE.md on its own
```

Then describe the game in your prompt: idea, rules, controls, how a round is won, how
many rounds win the match, the look. The session copies `template/`, writes the game,
builds, translates and plays it on two linked Game Boys, and shows you screenshots.

## What is here

| | |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | instructions for the AI session: workflow, rules, what "done" means |
| [HARDWARE.md](HARDWARE.md) | the engine's "hardware" and the rules the translator needs |
| [ASSEMBLY.md](ASSEMBLY.md) | how to write a Game Boy game in assembly, link and lockstep included |
| [template/](template/) | Coin Duel: a complete, tested two-player game to start from |
| `tools/build.py` | assemble + translate + run two linked Game Boys, screenshots, win counters |
| `tools/run2.mjs` | the two-Game-Boy run on its own |
| `tools/setup.sh` | downloads the tools |

Coin Duel is already on the server game list (`src/games/coinduel.wasm`). Try the
template here: `python3 tools/build.py template`, then open
`template/build/shot_*.png`.

## Add a finished game to the server

From the repository root:

```sh
python -m tools.add_game rom_maker/<name>/build/game.gb <name> "<Title>" --meta rom_maker/<name>/game.json
```

`--meta` carries the win counters and the start script. Restart `npx wrangler dev` and
play on two phones.
