// Translated games, bundled into the Worker at deploy time (Workers cannot compile
// WebAssembly from bytes). They never reach a browser: players only get pixels.
//
// The games here are our own homebrew ROMs. Games made from cartridges you own are added
// on your machine with `python -m tools.add_game <rom.gb> <id> "<title>"`, which writes
// them to ./local/ and ./local.js; neither is committed.
import hello from "./hello.wasm";
import linkdemo from "./linkdemo.wasm";
import local from "./local.js";

const BUILT_IN = [
  { id: "linkdemo", title: "Link demo (2 players)", module: linkdemo },
  { id: "hello", title: "Hello World", module: hello },
];

// id -> { title, module }
export const GAMES = Object.freeze(Object.fromEntries(
  [...local, ...BUILT_IN].map(({ id, title, module }) => [id, Object.freeze({ title, module })]),
));
