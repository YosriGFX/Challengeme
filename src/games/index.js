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
const BUILT_IN = [
  { id: "tetris", title: "Tetris (2 players)", module: tetris, result: { wins: 0xffd7, theirs: 0xffd8, best: 4 } },
  { id: "drmario", title: "Dr. Mario (2 players)", module: drmario, result: { wins: 0xd000, theirs: 0xd001, best: 3 } },
  { id: "rcproam", title: "Super R.C. Pro-Am (2 players)", module: rcproam },
  { id: "f1pole", title: "F-1 Pole Position (1 player each)", module: f1pole },
  { id: "linkdemo", title: "Link demo (2 players)", module: linkdemo },
  { id: "hello", title: "Hello World", module: hello },
];

// id -> { title, module, result }
export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module, result = null }) => [id, Object.freeze({ title, module, result })]),
));
