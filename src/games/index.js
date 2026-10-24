// Translated games, bundled into the Worker at deploy time (Workers cannot compile
// WebAssembly from bytes). They never reach a browser: players only get pixels.
//
// hello and linkdemo are our own homebrew ROMs. The others are translated from the
// owner's cartridge ROMs (only the .wasm is here, not the ROM). More games can be added on
// one machine with `python -m tools.add_game <rom.gb> <id> "<title>"`, which writes them
// to ./local/ and ./local.js; neither is committed. See TRANSLATOR.md.
import drmario from "./drmario.wasm";
import f1pole from "./f1pole.wasm";
import hello from "./hello.wasm";
import linkdemo from "./linkdemo.wasm";
import local from "./local.js";
import rcproam from "./rcproam.wasm";
import tetris from "./tetris.wasm";

// `result` (optional) lets the server decide rounds from the game's own memory. In
// 2-player mode each Game Boy counts the rounds its player won at RAM address `wins`, and
// the other player's at `theirs`; a round counts once both Game Boys agree. `best` is the
// number of round wins that ends the match. Phones never report results.
//
// `start` (optional) skips the menus: when all players are ready, the server runs the
// game `frames` frames ahead at once, pressing buttons as it goes: each [frame, player 1,
// player 2, ...] sets every Game Boy's buttons from that frame on. Players start in the match.
//
// `players` (default 2) is the most seats a match can have, `minPlayers` (default the
// same) the fewest; whoever opens the match picks within that. Two Game Boys are joined
// by a link cable, more by the 4-Player Adapter; `link: "adapter"` uses the adapter for
// two as well (games written for it, like F-1 Pole Position).
const BUILT_IN = [
  { id: "tetris", title: "Tetris (2 players)", module: tetris, result: { wins: 0xffd7, theirs: 0xffd8, best: 4 },
    // 2PLAYER, then Start through game type, music A and the height screen
    start: { frames: 700, inputs: [[300, 0x01, 0], [306, 0, 0], [320, 0x80, 0], [326, 0, 0], [500, 0x80, 0],
                                   [506, 0, 0], [650, 0x80, 0], [656, 0, 0]] } },
  { id: "drmario", title: "Dr. Mario (2 players)", module: drmario, result: { wins: 0xd000, theirs: 0xd001, best: 3 },
    // 2 PLAYER GAME, then Start on the settings (virus level 0, speed MED, music CHILL)
    start: { frames: 380, inputs: [[280, 0x08, 0], [286, 0, 0], [300, 0x80, 0], [306, 0, 0], [360, 0x80, 0], [366, 0, 0]] } },
  { id: "rcproam", title: "Super R.C. Pro-Am (2 players)", module: rcproam,
    // Start on the title: both cars on the grid, just before the countdown
    start: { frames: 900, inputs: [[800, 0x80, 0], [806, 0, 0]] } },
  { id: "f1pole", title: "F-1 Pole Position (1 player each)", module: f1pole },   // 4 players on the adapter: on hold
  { id: "linkdemo", title: "Link demo (2 players)", module: linkdemo },
  { id: "hello", title: "Hello World", module: hello },
];

// id -> { title, module, result, start, players, minPlayers, link }
export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module, result = null, start = null, players = 2, minPlayers = players,
                                link = players > 2 ? "adapter" : "cable" }) =>
    [id, Object.freeze({ title, module, result, start, players, minPlayers, link })]),
));
