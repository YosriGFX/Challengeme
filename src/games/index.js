// Translated games, bundled into the Worker at deploy time (Workers cannot compile
// WebAssembly from bytes). They never reach a browser: players only get pixels.
//
// Only games for two players or more whose result the server reads (round wins, so the
// match time limit works too). coinduel and skyhop are our own homebrew ROMs
// (rom_maker/template and rom_maker/skyhop); tetris and drmario are translated from the
// owner's cartridge ROMs (only the .wasm is here, not the ROM). More games can be added on
// one machine with `python -m tools.add_game <rom.gb> <id> "<title>"`, which writes them
// to ./local/ and ./local.js; neither is committed. See TRANSLATOR.md.
import coinduel from "./coinduel.wasm";
import drmario from "./drmario.wasm";
import local from "./local.js";
import skyhop from "./skyhop.wasm";
import tetris from "./tetris.wasm";

// `result` (optional) lets the server decide rounds from the game's own memory. In
// 2-player mode each Game Boy counts the rounds its player won at RAM address `wins`, and
// the other player's at `theirs`; a round counts once both Game Boys agree. Or, for any
// number of players, every Game Boy keeps every player's round wins from `winsBy` on
// (player 1 first); a round counts once all agree. `best` is the
// number of round wins that ends the match. Phones never report results. A game that
// reads its `best` from RAM gives the address as `bestAt` and the numbers players may
// pick as `bestChoices`: whoever opens the match picks one, and the server writes it to
// every Game Boy right after the `start` script.
//
// `start` (optional) skips the menus: when all players are ready, the server runs the
// game `frames` frames ahead at once, pressing buttons as it goes: each [frame, player 1,
// player 2, ...] sets every Game Boy's buttons from that frame on. Players start in the match.
//
// `shared: true` marks games that show every player on each Game Boy's own screen: phones
// then start with the other players' screens hidden.
//
// `players` (default 2) is the most seats a match can have, `minPlayers` (default the
// same) the fewest; whoever opens the match picks within that. Two Game Boys are joined
// by a link cable, more by the 4-Player Adapter; `link: "adapter"` uses the adapter for
// two as well (games written for it, like Sky Hop).
const BUILT_IN = [
  { id: "skyhop", title: "Sky Hop (2-4 players)", module: skyhop, players: 4, minPlayers: 2, link: "adapter", shared: true,
    result: { winsBy: 0xc000, best: 3, bestAt: 0xc004, bestChoices: [1, 2, 3, 4, 5, 7, 9] },
    // START on player 1 starts the game on the adapter
    start: { frames: 30, inputs: [[10, 0x80, 0, 0, 0], [16, 0, 0, 0, 0]] } },
  { id: "tetris", title: "Tetris (2 players)", module: tetris, result: { wins: 0xffd7, theirs: 0xffd8, best: 4 },
    // 2PLAYER, then Start through game type, music A and the height screen
    start: { frames: 700, inputs: [[300, 0x01, 0], [306, 0, 0], [320, 0x80, 0], [326, 0, 0], [500, 0x80, 0],
                                   [506, 0, 0], [650, 0x80, 0], [656, 0, 0]] } },
  { id: "drmario", title: "Dr. Mario (2 players)", module: drmario, result: { wins: 0xd000, theirs: 0xd001, best: 3 },
    // 2 PLAYER GAME, then Start on the settings (virus level 0, speed MED, music CHILL)
    start: { frames: 380, inputs: [[280, 0x08, 0], [286, 0, 0], [300, 0x80, 0], [306, 0, 0], [360, 0x80, 0], [366, 0, 0]] } },
  { id: "coinduel", title: "Coin Duel (2 players)", module: coinduel, shared: true, result: { wins: 0xc000, theirs: 0xc001, best: 5, bestAt: 0xc002, bestChoices: [1, 2, 3, 4, 5, 7, 9] },
    // START on player 1 makes the handshake
    start: { frames: 30, inputs: [[10, 0x80, 0], [16, 0, 0]] } },
];

// id -> { title, module, result, start, players, minPlayers, link, shared }
// Match time limits the opener can pick, in seconds (0 = none), for games whose result
// the server reads: when time is up, the most round wins takes the match.
export const TIME_CHOICES = Object.freeze([0, 60, 120, 180, 240, 300, 600]);

export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module, result = null, start = null, players = 2, minPlayers = players,
                                link = players > 2 ? "adapter" : "cable", shared = false }) =>
    [id, Object.freeze({ title, module, result, start, players, minPlayers, link, shared })]),
));
