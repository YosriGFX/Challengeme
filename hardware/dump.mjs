// dump.mjs — one packet for the reference client: the full dump player 1 would get from
// a match of <cart> after <ticks> ticks with every seat taken.   node hardware/dump.mjs pong 240 > pong.bin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cart = 'dama', ticks = '0'] = process.argv.slice(2);
const x = (await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'dist', cart + '.wasm')), {})).instance.exports;
x.con_init();
for (let p = 0; p < x.con_players(); p++) x.con_presence(p, 1);
x.con_input(0, 0x10, 256); x.con_input(0, 0, 256);            // A: starts the games that wait for it
for (let i = 0; i < Number(ticks); i++) x.con_tick();
const len = x.con_flush(0, 1);
process.stdout.write(new Uint8Array(x.memory.buffer, x.con_packet(), len));
