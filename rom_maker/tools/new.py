#!/usr/bin/env python3
"""Start a new game from one of the two examples, from rom_maker/:

    python3 tools/new.py mygame "My Game"              # 2 players, link cable (Coin Duel)
    python3 tools/new.py mygame "My Game" --players 4  # 2-4 players, 4-Player Adapter (Sky Hop)

Copies template/ (two players) or skyhop/ (three or four) to <name>/ without its build,
and sets the title, the cartridge title and the player counts in <name>/game.json. Then
change <name>/main.asm into your game and build it with tools/build.py <name>.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

MAKER = Path(__file__).resolve().parent.parent
NAME = re.compile(r"^[a-z0-9_-]{1,32}$")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("name", help="folder and game id: a-z, 0-9, _ and -")
    ap.add_argument("title", help="name shown on the start page")
    ap.add_argument("--players", type=int, default=2, choices=(2, 3, 4),
                    help="most players: 2 = link cable (Coin Duel), 3-4 = 4-Player Adapter (Sky Hop)")
    args = ap.parse_args()

    if not NAME.fullmatch(args.name):
        sys.exit(f"bad name {args.name!r}: use a-z, 0-9, _ and -")
    dest = MAKER / args.name
    if dest.exists():
        sys.exit(f"{dest.relative_to(MAKER)}/ already exists")
    base = MAKER / ("template" if args.players == 2 else "skyhop")
    shutil.copytree(base, dest, ignore=shutil.ignore_patterns("build"))

    meta = json.loads((dest / "game.json").read_text())
    meta["title"] = args.title
    if args.players > 2:
        meta["players"], meta["minPlayers"], meta["link"] = args.players, 2, "adapter"
    (dest / "game.json").write_text(json.dumps(meta) + "\n")
    print(f"{dest.relative_to(MAKER)}/ from {base.name}/ ({'2 players, link cable' if args.players == 2 else f'2-{args.players} players, 4-Player Adapter'})")
    print(f"next: edit {args.name}/main.asm, then python3 tools/build.py {args.name}")


if __name__ == "__main__":
    main()
