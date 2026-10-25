// Runs a translated game on 2-4 Game Boys joined like on the server (link cable for two,
// 4-Player Adapter for more, or when --link=adapter), without phones. Presses buttons
// from a script or a bot, saves screenshots of every screen as PNG, and prints what the
// server would see: traps (code the translator missed) and the round wins.
//
//   node tools/run.mjs game.wasm --players=2 --frames=1200 --script=10:80:0,16:0:0 \
//        --shots=60,600 --out=build/shot --wins=C000:C001
//   node tools/run.mjs game.wasm --players=4 --link=adapter --winsBy=C000 --best=3 \
//        --bestAt=C004 --pokeAt=30 --bot=mygame/bot.mjs --frames=20000
//
// --script: frame:buttons1:buttons2[:buttons3:buttons4] (hex), each holding from that
//           frame on. Buttons: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B, 40 select,
//           80 start.
// --bot:    a module whose default export is called before every frame as
//           bot({ frame, players, ram, press }) and presses buttons for any player:
//           ram(player, "wLabel" | address, offset = 0) reads that player's Game Boy
//           (labels from build/game.sym), press(player, bits) holds its buttons.
//           Players count from 1.
// --shots:  frames to save as <out>_<frame>.png (players 1-4 side by side).
// --wins=MINE:THEIRS (two players, each Game Boy counts its own player's wins and the
//           other's) or --winsBy=ADDR (every Game Boy keeps every player's wins from
//           ADDR on). With --best, the run stops once the match is decided.
// --bestAt=ADDR --pokeAt=FRAME: writes --best there on every Game Boy at that frame, as
//           the server does after the start script.
// --seedAt=ADDR: writes two random bytes there on every Game Boy at --pokeAt, as the
//           server does (game.json "seedAt"); --seed=N makes them the same every run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { FRAME_CYCLES, GameBoy, runLinked } from "../../src/gb/machine.js";
import { Adapter } from "../../src/gb/adapter.js";

const args = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, "").split("=")));
const file = process.argv[2];
const hex = (v) => (v === undefined ? undefined : parseInt(v, 16));
const players = Number(args.players ?? 2);
const link = args.link ?? (players > 2 ? "adapter" : "cable");
const frames = Number(args.frames ?? 600);
const script = (args.script ?? "").split(",").filter(Boolean).map((s) => s.split(":").map((v, i) => (i ? parseInt(v, 16) : Number(v))));
const shots = new Set((args.shots ?? "").split(",").filter(Boolean).map(Number));
const out = args.out ?? "shot";
const [winsAt, theirsAt] = (args.wins ?? "").split(":").map(hex);
const winsBy = hex(args.winsBy), best = Number(args.best ?? 0), bestAt = hex(args.bestAt), pokeAt = Number(args.pokeAt ?? 0);
const seedAt = hex(args.seedAt);
const seedBytes = args.seed === undefined ? [Math.random() * 256, Math.random() * 256].map(Math.floor)
  : [Number(args.seed) & 0xff, (Number(args.seed) >> 8) & 0xff];

const symFile = args.sym ?? file.replace(/\.wasm$/, ".sym");
const sym = existsSync(symFile) ? Object.fromEntries(readFileSync(symFile, "utf8").split("\n")
  .map((l) => l.match(/^[0-9a-f]+:([0-9a-f]{4}) (\S+)/i)).filter(Boolean).map((m) => [m[2], parseInt(m[1], 16)])) : {};

const module = new WebAssembly.Module(readFileSync(file));
const gbs = Array.from({ length: players }, () => new GameBoy(module));
const linked = link === "adapter" ? new Adapter(gbs) : { run: (c) => runLinked(gbs[0], gbs[1], c) };
if (link !== "adapter" && players !== 2) throw new Error("the link cable joins exactly two Game Boys");

const address = (name) => {
  if (typeof name === "number") return name;
  if (!(name in sym)) throw new Error(`no label ${name} in ${symFile}`);
  return sym[name];
};
const ram = (player, name, offset = 0) => gbs[player - 1].u8[address(name) + offset];
const press = (player, bits) => { gbs[player - 1].buttons = bits; };
const bot = args.bot ? (await import(pathToFileURL(args.bot).href)).default : null;

const SHADES = [[224, 248, 208], [136, 192, 112], [52, 104, 86], [8, 24, 32]];
const log = [];
let last = null, decided = 0;

function wins() {
  if (winsBy !== undefined) {
    const each = gbs.map((m) => Array.from({ length: players }, (_, p) => m.u8[winsBy + p]));
    const agreed = each.every((w) => w.join() === each[0].join());
    return { text: `wins ${each[0].join(" ")}${agreed ? "" : ` (Game Boys disagree: ${each.map((w) => w.join(" ")).join(" | ")})`}`,
             counts: agreed ? each[0] : null };
  }
  if (winsAt === undefined) return null;
  const [a, b] = gbs;
  const agreed = a.u8[winsAt] === b.u8[theirsAt] && b.u8[winsAt] === a.u8[theirsAt];
  return { text: `GB1 wins ${a.u8[winsAt]} theirs ${a.u8[theirsAt]} | GB2 wins ${b.u8[winsAt]} theirs ${b.u8[theirsAt]}`,
           counts: agreed ? [a.u8[winsAt], b.u8[winsAt]] : null };
}

for (let f = 0; f <= frames; f++) {
  for (const [at, ...bits] of script) if (at === f) gbs.forEach((m, i) => { m.buttons = bits[i] ?? 0; });
  if (bestAt !== undefined && best && f === pokeAt) gbs.forEach((m) => { m.u8[bestAt] = best; });
  if (seedAt !== undefined && f === pokeAt) gbs.forEach((m) => { m.u8[seedAt] = seedBytes[0]; m.u8[seedAt + 1] = seedBytes[1]; });
  if (bot) bot({ frame: f, gbs, ram, press, players });
  if (shots.has(f)) savePng(`${out}_${f}.png`);
  const w = wins();
  if (w && w.text !== last) {
    log.push(`frame ${f}: ${w.text}`);
    last = w.text;
    const top = w.counts ? Math.max(...w.counts) : 0;
    if (best && top >= best && !decided) {
      decided = f;
      log.push(`frame ${f}: match over, player ${w.counts.indexOf(top) + 1} wins`);
    }
  }
  if (gbs.some((m) => m.trap)) break;
  if (decided && f >= decided + 120 && !shots.size) break;    // a moment of the end screen
  linked.run(FRAME_CYCLES);
}

console.log(log.join("\n"));
gbs.forEach((m, i) => {
  console.log(m.trap ? `GB${i + 1} STOPPED: no translated code at ${m.trap.at} (see ../TRANSLATOR.md section 4)` : `GB${i + 1} ok`);
});
if (link === "adapter") console.log(`adapter: ${linked.mode === "xfer" ? "game packets" : linked.mode}`);
process.exitCode = gbs.some((m) => m.trap) ? 1 : 0;

function savePng(path) {
  const w = 164 * players - 4, h = 144;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  const screens = gbs.map((m) => m.shadesInto(new Uint8Array(160 * 144)));
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      const n = Math.floor(x / 164), c = x % 164;
      const s = c < 160 ? screens[n][y * 160 + c] : -1;
      raw.set(s < 0 ? [200, 30, 30] : SHADES[s], row + 1 + x * 3);
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
