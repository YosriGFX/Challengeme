// Dev-only check of the screen update format: encodes frame sequences with the server's
// encoder, decodes them with the phone's decoder, and reports sizes as JSON.
//   node frames_roundtrip.mjs [game.wasm]
import { readFileSync } from "node:fs";
import { FrameEncoder, H, W } from "../../src/gb/frames.js";
import { FRAME_CYCLES, GameBoy, memoryPages } from "../../src/gb/machine.js";
import { FrameDecoder } from "../../public/frames.js";

let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16);

function check(name, frames) {
  const enc = new FrameEncoder(), dec = new FrameDecoder();
  const sizes = [];
  let ok = true, moves = 0;
  frames.forEach((f, i) => {
    const msg = enc.encode(f, i);
    if (msg) {
      dec.apply(msg);
      sizes.push(msg.length);
      if (msg[3] || msg[4]) moves++;
    } else sizes.push(0);
    if (!dec.px.every((v, j) => v === f[j])) ok = false;
  });
  return { name, ok, sizes, moves };
}

// A busy picture: 8x8 checker cells of varying shades plus noise.
const scene = new Uint8Array(W * 3 * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) {
  scene[y * W * 3 + x] = ((x >> 3) + (y >> 2)) % 4 === 0 ? rand() & 3 : ((x >> 4) + (y >> 3)) & 3;
}
const view = (sx, sy) => {
  const f = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = scene[((y + sy) % H) * W * 3 + x + sx];
  return f;
};
const noise = () => Uint8Array.from({ length: W * H }, () => (Math.random() * 4) | 0);

const results = [
  check("still", [view(0, 0), view(0, 0), view(0, 0)]),
  check("scroll-x", [0, 1, 2, 3, 5, 8, 13].map((x) => view(x, 0))),
  check("scroll-y", [0, 1, 2, 4, 7].map((y) => view(0, y))),
  check("noise", [noise(), noise(), noise()]),
  check("one-pixel", (() => { const a = view(0, 0), b = view(0, 0); b[77 * W + 33] ^= 1; return [a, b]; })()),
];
const wasm = process.argv[2];
if (wasm) {
  const bytes = readFileSync(wasm);
  const gb = new GameBoy(new WebAssembly.Module(bytes), memoryPages(bytes));
  const frames = [];
  for (let i = 0; i < 4; i++) { gb.run(FRAME_CYCLES); frames.push(gb.shadesInto(new Uint8Array(W * H))); }
  results.push(check("game", frames));
}
console.log(JSON.stringify(results));
