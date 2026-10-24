// One player's phone: the screen of their Game Boy and its buttons. The game runs on
// the server; this page sends button bytes and draws the screen updates it receives.
import { FrameDecoder } from "/frames.js";
import { PALETTE } from "/palette.js";

const BUTTONS = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };
const KEYS = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
               KeyX: "a", KeyZ: "b", ShiftRight: "select", Enter: "start" };

const params = new URLSearchParams(location.search);
const match = params.get("match") ?? "";
const player = params.get("player");
const game = params.get("game") ?? "";
const conn = document.getElementById("conn");
const peer = document.getElementById("peer");

if (!/^[a-z0-9]{6,16}$/.test(match) || (player !== "1" && player !== "2") ||
    (game !== "" && !/^[a-z0-9_-]{1,32}$/.test(game))) {
  conn.textContent = "Bad match link.";
  throw new Error("bad match link");
}
document.getElementById("who").textContent = `Player ${player}`;

// ---- screen: what changed arrives as RFB-style updates (moves and 8 x 8 tiles)
const ctx = document.getElementById("screen").getContext("2d");
const image = ctx.createImageData(160, 144);
const decoder = new FrameDecoder();
const RGBA = new Uint32Array(PALETTE.map(([r, g, b]) => (255 << 24 | b << 16 | g << 8 | r) >>> 0));
const pixels32 = new Uint32Array(image.data.buffer);

function drawUpdate(buf) {
  if (!decoder.apply(buf)) return false;
  const px = decoder.px;
  for (let i = 0; i < px.length; i++) pixels32[i] = RGBA[px[i]];
  ctx.putImageData(image, 0, 0);
  return true;
}

// ---- buttons: each finger (pointer) holds at most one button; sliding moves it
const held = new Map();
let keys = 0, state = 0, sent = -1, ws = null, joined = false;

function update() {
  let bits = keys;
  for (const el of held.values()) bits |= BUTTONS[el.dataset.key];
  for (const el of document.querySelectorAll("[data-key]")) {
    el.classList.toggle("down", (bits & BUTTONS[el.dataset.key]) !== 0);
  }
  if (bits & ~state) navigator.vibrate?.(8);
  state = bits;
  send();
}

function send() {
  if (ws?.readyState === WebSocket.OPEN && joined && state !== sent) {
    ws.send(new Uint8Array([state]));
    sent = state;
  }
}

function press(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-key]") ?? null;
  if (!el && !held.has(e.pointerId)) return;
  e.preventDefault();
  if (el) held.set(e.pointerId, el); else held.delete(e.pointerId);
  update();
}
function release(e) {
  if (held.delete(e.pointerId)) update();
}
document.addEventListener("pointerdown", press);
document.addEventListener("pointermove", (e) => { if (held.has(e.pointerId)) press(e); });
document.addEventListener("pointerup", release);
document.addEventListener("pointercancel", release);
document.addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("keydown", (e) => { if (KEYS[e.code]) { e.preventDefault(); keys |= BUTTONS[KEYS[e.code]]; update(); } });
addEventListener("keyup", (e) => { if (KEYS[e.code]) { e.preventDefault(); keys &= ~BUTTONS[KEYS[e.code]]; update(); } });
addEventListener("blur", () => { held.clear(); keys = 0; update(); });

// ---- invite (player 1 shares player 2's link)
if (player === "1") {
  const link = `${location.origin}/play.html?${new URLSearchParams({ match, player: "2" })}`;
  document.getElementById("invite-link").textContent = `Player 2: ${link}`;
  document.getElementById("invite").classList.add("show");
  document.getElementById("share").addEventListener("click", async () => {
    try {
      if (navigator.share) await navigator.share({ title: "Challenge Me", url: link });
      else await navigator.clipboard.writeText(link);
    } catch { /* cancelled */ }
  });
}

// ---- connection
const TOKEN_KEY = `seat:${match}:${player}`;

function savedToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function saveToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: no reconnect */ }
}

function status(text, cls) {
  conn.textContent = text;
  conn.className = cls ?? "";
}

function connect() {
  let retry = 0, ping;
  const open = () => {
    const q = new URLSearchParams({ player });
    if (game) q.set("game", game);
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/match/${match}?${q}`);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "join", token: savedToken() }));
      ping = setInterval(() => ws.send("ping"), 25_000);
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string") {
        const buf = new Uint8Array(e.data);
        if (drawUpdate(buf)) ws.send(buf.subarray(1, 3));   // ack: update seq
        return;
      }
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.t === "seat") {
        if (msg.token) saveToken(msg.token);
        decoder.px.fill(0);                           // the server starts again from blank
        joined = true;
        retry = 0;
        sent = -1;
        status(msg.game, "on");
        peer.textContent = msg.peer ? "2 players" : "waiting for the other player";
        send();                                       // the server starts from our state
      } else if (msg.t === "peer") {
        peer.textContent = msg.on ? "2 players" : "other player left";
      } else if (msg.t === "trap") {
        status(`stopped at ${msg.at}`, "bad");
      }
    });
    ws.addEventListener("close", (e) => {
      clearInterval(ping);
      joined = false;
      const final = { 4000: "opened on another tab", 4003: `player ${player} is taken`, 4004: "unknown game" }[e.code];
      if (final) { status(final, "bad"); return; }
      status("reconnecting…", "bad");
      setTimeout(open, Math.min(10_000, 250 * 2 ** retry++) * (0.5 + Math.random()));
    });
  };
  open();
}
connect();
