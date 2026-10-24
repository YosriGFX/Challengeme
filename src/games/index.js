// Translated games, bundled into the Worker at deploy time (Workers cannot compile
// WebAssembly from bytes). They never reach a browser: players only get pixels.
// Build one with:  python -m translator roms/<name>.gb -o build/<name>.wat --wasm
//                  cp build/<name>.wasm src/games/
import hello from "./hello.wasm";
import linkdemo from "./linkdemo.wasm";

export const GAMES = Object.freeze({ hello, linkdemo });
