#!/usr/bin/env python3
"""Add a game translated from a cartridge ROM you own to this machine's Worker.

    python -m tools.add_game "Dr. Mario.gb" drmario "Dr. Mario" [--hints hints.json]
    python -m tools.add_game rom_maker/duel/build/game.gb duel "Duel" --meta rom_maker/duel/game.json
    python -m tools.add_game --remove drmario

Translates the ROM for the server (src/games/local/<id>.wasm) and rewrites
src/games/local.js, which lists these games for src/games/index.js. Neither is
committed: src/games/local/ is in .gitignore, and git is told to leave local.js as it
is in the repository (`git update-index --skip-worktree`). Restart `wrangler dev` (or
deploy) to pick the game up.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from translator.__main__ import main as translate

ROOT = Path(__file__).resolve().parents[1]
GAMES = ROOT / "src" / "games"
LOCAL = GAMES / "local"
LIST = LOCAL / "games.json"
MODULE = GAMES / "local.js"
GAME_ID = re.compile(r"^[a-z0-9_-]{1,32}$")
BUILT_IN = {"belote", "chess", "coinduel", "dama", "drmario", "skyhop", "tetris"}


def write_module(games):
    lines = [
        "// Written by tools/add_game.py: games translated on this machine from ROMs you own.",
        "// Kept empty in the repository.",
    ]
    for n, g in enumerate(games):
        lines.append(f'import g{n} from "./local/{g["id"]}.wasm";')
    lines.append("export default [")
    for n, g in enumerate(games):
        extra = "".join(f", {k}: {json.dumps(g[k])}" for k in ("result", "start", "players", "minPlayers", "link", "shared", "seedAt", "random", "secret", "teams")
                        if k in g)
        lines.append(f'  {{ id: {json.dumps(g["id"])}, title: {json.dumps(g["title"])}, module: g{n}{extra} }},')
    lines.append("];")
    MODULE.write_text("\n".join(lines) + "\n")
    subprocess.run(["git", "-C", str(ROOT), "update-index", "--skip-worktree", "src/games/local.js"],
                   check=False)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="add_game", description=__doc__.splitlines()[0])
    ap.add_argument("rom", type=Path, nargs="?")
    ap.add_argument("id", nargs="?", help="short name: a-z, 0-9, _ and -")
    ap.add_argument("title", nargs="?", help="name shown on the start page")
    ap.add_argument("--hints", type=Path)
    ap.add_argument("--meta", type=Path, help="game.json from rom_maker: result, start (and players, shared, seedAt, random, secret, teams)")
    ap.add_argument("--remove", metavar="ID")
    args = ap.parse_args(argv)

    LOCAL.mkdir(parents=True, exist_ok=True)
    games = json.loads(LIST.read_text()) if LIST.exists() else []

    if args.remove:
        games = [g for g in games if g["id"] != args.remove]
        (LOCAL / f"{args.remove}.wasm").unlink(missing_ok=True)
    else:
        if not (args.rom and args.id):
            ap.error("give a ROM and an id, or --remove ID")
        if not GAME_ID.fullmatch(args.id) or args.id in BUILT_IN:
            ap.error(f"bad id {args.id!r}: use a-z, 0-9, _ and -, and not {', '.join(sorted(BUILT_IN))}")
        with tempfile.TemporaryDirectory() as tmp:
            wat = Path(tmp) / f"{args.id}.wat"
            cmd = [str(args.rom), "-o", str(wat), "--wasm", "--target", "server"]
            if args.hints:
                cmd += ["--hints", str(args.hints)]
            if translate(cmd) != 0:
                return 1
            (LOCAL / f"{args.id}.wasm").write_bytes(wat.with_suffix(".wasm").read_bytes())
        title = args.title or args.id
        entry = {"id": args.id, "title": title}
        if args.meta:
            meta = json.loads(args.meta.read_text())
            entry.update({k: meta[k] for k in ("result", "start", "players", "minPlayers", "link", "shared", "seedAt", "random", "secret", "teams") if k in meta})
        games = [g for g in games if g["id"] != args.id] + [entry]

    LIST.write_text(json.dumps(games, indent=2) + "\n")
    write_module(games)
    print(f"local games: {', '.join(g['id'] for g in games) or 'none'} (restart wrangler dev to load)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
