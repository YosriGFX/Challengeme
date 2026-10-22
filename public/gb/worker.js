// Runs the two Game Boys of a match off the main thread, at the DMG's 59.73 Hz.
// The translated game is native WebAssembly; this file only paces frames. Pixels and
// joypad bits live in each machine's SharedArrayBuffer, which the page reads directly.
import { FRAME_CYCLES, FRAME_HZ, GameBoy, memoryPages, runLinked } from "./machine.js";

const PERIOD = 1000 / FRAME_HZ;
const MAX_CATCH_UP = 4;                 // frames run at most per tick after a stall

let machines = null;
let next = 0;

self.onmessage = async (e) => {
  if (e.data?.t !== "load" || machines) return;
  try {
    const res = await fetch(e.data.url);
    if (!res.ok) throw new Error(`${e.data.url}: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const pages = memoryPages(bytes);
    machines = [new GameBoy(module, pages), new GameBoy(module, pages)];
  } catch (err) {
    self.postMessage({ t: "error", message: String(err?.message ?? err) });
    return;
  }
  self.postMessage({ t: "ready", buffers: machines.map((m) => m.buffer) });
  next = performance.now();
  tick();
};

function tick() {
  const [a, b] = machines;
  const now = performance.now();
  for (let n = 0; next <= now && n < MAX_CATCH_UP; n++) {
    runLinked(a, b, FRAME_CYCLES);
    next += PERIOD;
  }
  if (next < now) next = now;             // fell too far behind: drop frames, don't spiral
  machines.forEach((m, player) => {
    if (m.trap && !m.trapReported) {
      m.trapReported = true;
      self.postMessage({ t: "trap", player, ...m.trap });
    }
  });
  setTimeout(tick, Math.max(0, next - performance.now()));
}
