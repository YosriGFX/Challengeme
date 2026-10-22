// Host screen: shows both Game Boys of a match and feeds them joypad bits from the
// players' phones (through the match's Durable Object) or from this keyboard.
// It only displays pixels the WebAssembly wrote; it never draws or processes them.
import { BUTTONS, frameSeq, frontPixels, setButtons } from "/gb/machine.js";

const GAME_ID = /^[a-z0-9_-]{1,32}$/;
const MATCH_ID = /^[a-z0-9]{6,16}$/;

const params = new URLSearchParams(location.search);
const game = GAME_ID.test(params.get("game") ?? "") ? params.get("game") : "linkdemo";
let match = params.get("match");
if (!MATCH_ID.test(match ?? "")) {
  match = randomId();
  params.set("match", match);
  history.replaceState(null, "", `?${params}`);
}

const KEYMAPS = [
  { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
    KeyX: "a", KeyZ: "b", ShiftRight: "select", Enter: "start" },
  { KeyD: "right", KeyA: "left", KeyW: "up", KeyS: "down",
    KeyH: "a", KeyG: "b", KeyT: "select", KeyY: "start" },
];

const status = document.getElementById("status");
const players = [1, 2].map((n) => {
  const canvas = document.getElementById(`screen${n}`);
  const ctx = canvas.getContext("2d");
  const link = document.getElementById(`join${n}`);
  link.href = link.textContent = `${location.origin}/pad.html?match=${match}&player=${n}`;
  return { ctx, image: ctx.createImageData(160, 144), padLabel: document.getElementById(`pad${n}`),
           buffer: null, seq: -1, keys: 0, pad: 0 };
});

const worker = new Worker("/gb/worker.js", { type: "module" });
worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.t === "ready") {
    msg.buffers.forEach((buffer, i) => { players[i].buffer = buffer; pushButtons(players[i]); });
    status.textContent = `Game: ${game} · match ${match}`;
    requestAnimationFrame(draw);
  } else if (msg.t === "trap") {
    status.textContent = `Player ${msg.player + 1} stopped: no translated code at ${msg.at} (add it to the hints file)`;
  } else if (msg.t === "error") {
    status.textContent = `Could not start ${game}: ${msg.message}`;
  }
};
worker.postMessage({ t: "load", url: `/games/${game}.wasm` });

// Copies each new frame from shared memory to its canvas.
function draw() {
  for (const p of players) {
    const seq = frameSeq(p.buffer);
    if (seq === p.seq) continue;
    p.seq = seq;
    p.image.data.set(frontPixels(p.buffer));
    p.ctx.putImageData(p.image, 0, 0);
  }
  requestAnimationFrame(draw);
}

function pushButtons(p) {
  if (p.buffer) setButtons(p.buffer, p.keys | p.pad);
}

function onKey(e, down) {
  for (let i = 0; i < 2; i++) {
    const name = KEYMAPS[i][e.code];
    if (!name) continue;
    e.preventDefault();
    const p = players[i];
    p.keys = down ? p.keys | BUTTONS[name] : p.keys & ~BUTTONS[name];
    pushButtons(p);
  }
}
addEventListener("keydown", (e) => onKey(e, true));
addEventListener("keyup", (e) => onKey(e, false));
addEventListener("blur", () => players.forEach((p) => { p.keys = 0; pushButtons(p); }));

function showPad(player, on) {
  const p = players[player - 1];
  p.padLabel.textContent = on ? "phone connected" : "phone not connected";
  p.padLabel.classList.toggle("on", on);
  if (!on) { p.pad = 0; pushButtons(p); }
}

// The match relay: phones send one byte of buttons; we get [player, buttons].
function connect() {
  let retry = 0, ping;
  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/match/${match}?role=host`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => { retry = 0; ping = setInterval(() => ws.send("ping"), 25_000); });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        const [player, bits] = new Uint8Array(e.data);
        if (player === 1 || player === 2) { players[player - 1].pad = bits; pushButtons(players[player - 1]); }
        return;
      }
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.t === "pads") [1, 2].forEach((n) => showPad(n, msg.on.includes(n)));
      if (msg.t === "pad") showPad(msg.player, msg.on);
    });
    ws.addEventListener("close", () => {
      clearInterval(ping);
      [1, 2].forEach((n) => showPad(n, false));
      setTimeout(open, Math.min(10_000, 250 * 2 ** retry++) * (0.5 + Math.random()));
    });
  };
  open();
}
connect();

function randomId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join("");
}
