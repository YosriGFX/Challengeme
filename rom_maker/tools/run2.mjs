// Runs a translated game on two Game Boys joined by a link cable, as the server does,
// without phones. Presses buttons from a script, saves screenshots of both screens as
// PNG, and prints what the server would see: traps (code the translator missed) and the
// two win counters of each Game Boy.
//
//   node tools/run2.mjs game.wasm --frames=1200 --script=10:80:0,16:0:0 --shots=60,600 \
//        --out=build/shot --wins=C000:C001
//
// --script: frame:buttons1:buttons2 (hex), each holding from that frame on.
//           Buttons: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B, 40 select, 80 start.
// --shots:  frames to save as <out>_<frame>.png (player 1's screen left, player 2's right).
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { FRAME_CYCLES, GameBoy, runLinked } from "../../src/gb/machine.js";

const args = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, "").split("=")));
const file = process.argv[2];
const frames = Number(args.frames ?? 600);
const script = (args.script ?? "").split(",").filter(Boolean).map((s) => s.split(":").map((v, i) => (i ? parseInt(v, 16) : Number(v))));
const shots = new Set((args.shots ?? "").split(",").filter(Boolean).map(Number));
const out = args.out ?? "shot";
const [winsAt, theirsAt] = (args.wins ?? "C000:C001").split(":").map((h) => parseInt(h, 16));

const module = new WebAssembly.Module(readFileSync(file));
const a = new GameBoy(module), b = new GameBoy(module);
const SHADES = [[224, 248, 208], [136, 192, 112], [52, 104, 86], [8, 24, 32]];
const shade = new Uint8Array(160 * 144);
const log = [];
let last = null;

for (let f = 0; f <= frames; f++) {
  for (const [at, b1, b2] of script) if (at === f) { a.buttons = b1; b.buttons = b2; }
  if (shots.has(f)) savePng(`${out}_${f}.png`);
  const now = [a.u8[winsAt], a.u8[theirsAt], b.u8[winsAt], b.u8[theirsAt]].join(",");
  if (now !== last) { log.push(`frame ${f}: GB1 wins ${a.u8[winsAt]} theirs ${a.u8[theirsAt]} | GB2 wins ${b.u8[winsAt]} theirs ${b.u8[theirsAt]}`); last = now; }
  if (a.trap || b.trap) break;
  runLinked(a, b, FRAME_CYCLES);
}

console.log(log.join("\n"));
for (const [n, m] of [[1, a], [2, b]]) {
  console.log(m.trap ? `GB${n} STOPPED: no translated code at ${m.trap.at} (see TRANSLATOR.md section 4)` : `GB${n} ok`);
}
process.exitCode = a.trap || b.trap ? 1 : 0;

function savePng(path) {
  const w = 160 * 2 + 4, h = 144;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const screens = [a.shadesInto(new Uint8Array(160 * 144)), b.shadesInto(shade)];
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const s = x < 160 ? screens[0][y * 160 + x] : x >= 164 ? screens[1][y * 160 + x - 164] : -1;
      const [r, g, bl] = s < 0 ? [200, 30, 30] : SHADES[s];
      raw.set([r, g, bl], row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
                                     chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
