// Translated games, bundled into the Worker at deploy time (Workers cannot compile
// WebAssembly from bytes). They never reach a browser: players only get pixels.
//
// hello and linkdemo are our own homebrew ROMs; drmario is translated from the owner's
// cartridge ROM (only the .wasm is here, not the ROM). More games can be added on one
// machine with `python -m tools.add_game <rom.gb> <id> "<title>"`, which writes them to
// ./local/ and ./local.js; neither is committed.
import drmario from "./drmario.wasm";
import hello from "./hello.wasm";
import linkdemo from "./linkdemo.wasm";
import local from "./local.js";

const BUILT_IN = [
  { id: "drmario", title: "Dr. Mario (2 players)", module: drmario },
  { id: "linkdemo", title: "Link demo (2 players)", module: linkdemo },
  { id: "hello", title: "Hello World", module: hello },
];

// id -> { title, module }
export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module }) => [id, Object.freeze({ title, module })]),
));
