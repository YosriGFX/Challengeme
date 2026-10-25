#!/usr/bin/env python3
"""Build, translate and test a game in one go, from rom_maker/:

    python3 tools/build.py mygame                     # mygame/main.asm -> mygame/build/
    python3 tools/build.py mygame --frames 1500 --script 10:80:0,16:0:0,200:01:02 --shots 60,300,900
    python3 tools/build.py mygame --bot mygame/bot.mjs --frames 30000   # a whole match

1. Assembles <game>/main.asm with RGBDS (main.asm INCLUDEs every other file) into
   <game>/build/game.gb, with a symbol file game.sym (labels -> addresses).
2. Translates it with the engine's translator into game.wasm, the file the server runs.
3. Runs it on linked Game Boys like the server (tools/run.mjs): as many as game.json's
   "players" (or --players), joined by the link cable (two) or the 4-Player Adapter
   ("link": "adapter", or more than two). Presses the buttons of --script, or lets
   --bot play, saves --shots as PNG, prints the round wins and any trap.

Exit code 0 means: assembled, translated, and every Game Boy ran without a trap.
--script defaults to the game's start script in <game>/game.json if there is one.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAKER = HERE.parent
ROOT = MAKER.parent                 # the Challenge Me repository (translator/, src/)
LOCAL_TOOLS = MAKER / ".tools"      # where tools/setup.sh puts RGBDS and wabt


def tool(name):
    for d in (LOCAL_TOOLS / "rgbds", LOCAL_TOOLS / "wabt" / "bin"):
        if (d / name).exists():
            return str(d / name)
    found = shutil.which(name)
    if not found:
        sys.exit(f"{name} not found: run tools/setup.sh (or install RGBDS and wabt)")
    return found


def run(cmd, **kw):
    print("$", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        sys.exit(r.returncode)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("game", type=Path, help="folder with main.asm")
    ap.add_argument("--title", help="cartridge title (default: folder name)")
    ap.add_argument("--frames", type=int, default=900)
    ap.add_argument("--script", help="frame:buttons1:buttons2[:buttons3:buttons4],... in hex (01 right "
                                     "02 left 04 up 08 down 10 A 20 B 40 select 80 start)")
    ap.add_argument("--shots", default="60,300,600,900")
    ap.add_argument("--wins", default=None, help="win counter addresses, e.g. C000:C001 (default: game.json)")
    ap.add_argument("--players", type=int, help="Game Boys to run (default: game.json players, or 2)")
    ap.add_argument("--best", type=int, help="round wins for the match (default: game.json result.best)")
    ap.add_argument("--bot", help="a bot module that plays (see tools/run.mjs)")
    ap.add_argument("--seed", type=int, help="the random bytes for game.json seedAt (default: random)")
    args = ap.parse_args()

    game = args.game.resolve()
    build = game / "build"
    build.mkdir(exist_ok=True)
    meta = json.loads((game / "game.json").read_text()) if (game / "game.json").exists() else {}
    title = (args.title or meta.get("title") or game.name).upper()[:15]
    rom = build / "game.gb"

    # 1. Assemble
    run([tool("rgbasm"), "-Wall", "-I", str(game), "-o", str(build / "main.o"), str(game / "main.asm")])
    run([tool("rgblink"), "-p", "0xFF", "-n", str(build / "game.sym"), "-m", str(build / "game.map"),
         "-o", str(rom), str(build / "main.o")])
    run([tool("rgbfix"), "-v", "-p", "0xFF", "-t", title, str(rom)])

    # 2. Translate
    env = dict(os.environ, PYTHONPATH=str(ROOT))
    run([sys.executable, "-m", "translator", str(rom), "-o", str(build / "game.wat"), "--wasm",
         "--wat2wasm", tool("wat2wasm")], cwd=ROOT, env=env)

    # 3. Run the linked Game Boys
    players = args.players or meta.get("players", 2)
    link = meta.get("link") or ("adapter" if players > 2 else "cable")
    start = meta.get("start")
    script = args.script
    if script is None and start:
        script = ",".join(":".join([str(f)] + [f"{b:02X}" for b in bits]) for f, *bits in start["inputs"])
    cmd = ["node", str(HERE / "run.mjs"), str(build / "game.wasm"), f"--players={players}", f"--link={link}",
           f"--frames={args.frames}", f"--shots={args.shots}", f"--out={build / 'shot'}"]
    result = meta.get("result") or {}
    if args.wins:
        cmd.append(f"--wins={args.wins}")
    elif "winsBy" in result:
        cmd.append(f"--winsBy={result['winsBy']:04X}")
    elif "wins" in result:
        cmd.append(f'--wins={result["wins"]:04X}:{result["theirs"]:04X}')
    best = args.best or result.get("best")
    if best:
        cmd.append(f"--best={best}")
    if best and "bestAt" in result:
        cmd += [f"--bestAt={result['bestAt']:04X}", f"--pokeAt={start['frames'] if start else 0}"]
    if "seedAt" in meta:
        cmd += [f"--seedAt={meta['seedAt']:04X}", f"--pokeAt={start['frames'] if start else 0}"]
        if args.seed is not None:
            cmd.append(f"--seed={args.seed}")
    if script:
        cmd.append(f"--script={script}")
    if args.bot:
        cmd.append(f"--bot={Path(args.bot).resolve()}")
    run(cmd)
    print(f"\nok: {rom.relative_to(MAKER)} and {(build / 'game.wasm').relative_to(MAKER)}; "
          f"screenshots in {build.relative_to(MAKER)}/shot_*.png")


if __name__ == "__main__":
    main()
