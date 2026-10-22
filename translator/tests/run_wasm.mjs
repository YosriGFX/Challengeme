// Dev-only harness: instantiates a translated .wasm with shared memory, runs N frames,
// and prints the CPU state plus requested memory ranges as JSON.
//   node run_wasm.mjs game.wasm <frames> [hexStart:len ...]
import { readFileSync } from "node:fs";

const [file, frames = "1", ...ranges] = process.argv.slice(2);
const bytes = readFileSync(file);
const mod = new WebAssembly.Module(bytes);
// The module imports a fixed-size shared memory; find the size it declares.
let mem, inst;
for (const pages of [8, 16, 32, 64, 128, 256]) {
  try {
    mem = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    inst = new WebAssembly.Instance(mod, { env: { mem } });
    break;
  } catch { inst = null; }
}
const x = inst.exports;
x.reset();
let trap = null;
try {
  for (let i = 0; i < Number(frames); i++) x.run_frame(70224);
} catch (e) {
  trap = { message: e.message, pc: x.PC.value };
}
const u8 = new Uint8Array(mem.buffer);
const regs = {};
for (const r of ["A", "B", "C", "D", "E", "H", "L", "SP", "PC", "ZF", "NF", "HF", "CF", "IME", "CYC"]) regs[r] = x[r].value;
const dump = {};
for (const r of ranges) {
  const [s, n] = r.split(":");
  dump[s] = Array.from(u8.subarray(parseInt(s, 16), parseInt(s, 16) + Number(n)));
}
const frameSeq = new Int32Array(mem.buffer, 0x10000, 1)[0];
console.log(JSON.stringify({ regs, trap, frameSeq, dump }));
