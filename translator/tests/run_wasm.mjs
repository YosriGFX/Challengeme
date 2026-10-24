// Dev-only harness: runs translated .wasm files with shared memory and prints the CPU
// state, memory ranges and (with --fb) the front framebuffer as JSON. It uses the same
// machine module as the browser worker.
//   node run_wasm.mjs game.wasm <frames> [hexStart:len ...] [--fb] [--buttons=HEX]
//   node run_wasm.mjs --link a.wasm b.wasm <frames> [hexStart:len ...] [--buttons=HEX]
// --buttons / --buttons2 hold the joypad bits of the first / second machine
// (bit 0 Right ... bit 7 Start).
import { readFileSync } from "node:fs";
import { FRAME_CYCLES, GameBoy, memoryPages, runLinked } from "../../public/gb/machine.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const pos = args.filter((a) => !a.startsWith("--"));
const buttons = [...flags].find((f) => f.startsWith("--buttons="));
const buttons2 = [...flags].find((f) => f.startsWith("--buttons2="));
const linked = flags.has("--link");
const files = pos.splice(0, linked ? 2 : 1);
const [frames = "1", ...ranges] = pos;

const machines = files.map((f) => {
  const bytes = readFileSync(f);
  return new GameBoy(new WebAssembly.Module(bytes), memoryPages(bytes));
});
if (buttons) machines[0].buttons = parseInt(buttons.split("=")[1], 16);
if (buttons2) machines[1].buttons = parseInt(buttons2.split("=")[1], 16);

for (let i = 0; i < Number(frames); i++) {
  if (linked) runLinked(machines[0], machines[1], FRAME_CYCLES);
  else machines[0].run(FRAME_CYCLES);
}

const report = (m) => {
  const regs = {};
  for (const r of ["A", "B", "C", "D", "E", "H", "L", "SP", "PC", "ZF", "NF", "HF", "CF", "IME", "CYC", "BANK", "LY"]) {
    regs[r] = m.x[r].value;
  }
  const dump = {};
  for (const r of ranges) {
    const [s, n] = r.split(":");
    dump[s] = Array.from(m.u8.subarray(parseInt(s, 16), parseInt(s, 16) + Number(n)));
  }
  const out = { regs, trap: m.trap, frameSeq: m.frameSeq, dump };
  if (flags.has("--fb")) out.fb = Buffer.from(m.pixels).toString("hex");
  return out;
};
console.log(JSON.stringify(linked ? { machines: machines.map(report) } : report(machines[0])));
