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

const BUILT_IN = [
  { id: "tetris", title: "Tetris (2 players)", module: tetris },
  { id: "drmario", title: "Dr. Mario (2 players)", module: drmario },
  { id: "rcproam", title: "Super R.C. Pro-Am (2 players)", module: rcproam },
  { id: "f1pole", title: "F-1 Pole Position (1 player each)", module: f1pole },
  { id: "linkdemo", title: "Link demo (2 players)", module: linkdemo },
  { id: "hello", title: "Hello World", module: hello },
];

// id -> { title, module }
export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module }) => [id, Object.freeze({ title, module })]),
));
