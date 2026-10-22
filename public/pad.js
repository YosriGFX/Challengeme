// Phone controller: sends this player's buttons to the match as one byte whenever
// they change (bit 0 Right, 1 Left, 2 Up, 3 Down, 4 A, 5 B, 6 Select, 7 Start).
import { BUTTONS } from "/gb/machine.js";

const params = new URLSearchParams(location.search);
const match = params.get("match") ?? "";
const player = params.get("player");
const conn = document.getElementById("conn");
document.getElementById("who").textContent = `Player ${player}`;

if (!/^[a-z0-9]{6,16}$/.test(match) || (player !== "1" && player !== "2")) {
  conn.textContent = "Open the link shown on the game screen.";
  throw new Error("bad match link");
}

// Each finger (pointer) holds at most one button; sliding a finger moves it.
const held = new Map();
let state = 0, sent = -1, ws = null;

function buttonAt(x, y) {
  return document.elementFromPoint(x, y)?.closest("[data-key]") ?? null;
}

function update() {
  let bits = 0;
  for (const el of held.values()) bits |= BUTTONS[el.dataset.key];
  for (const el of document.querySelectorAll("[data-key]")) {
    el.classList.toggle("down", (bits & BUTTONS[el.dataset.key]) !== 0);
  }
  if (bits & ~state) navigator.vibrate?.(8);
  state = bits;
  send();
}

function send() {
  if (ws?.readyState === WebSocket.OPEN && state !== sent) {
    ws.send(new Uint8Array([state]));
    sent = state;
  }
}

function press(e) {
  e.preventDefault();
  const el = buttonAt(e.clientX, e.clientY);
  if (el) held.set(e.pointerId, el); else held.delete(e.pointerId);
  update();
}
function release(e) {
  held.delete(e.pointerId);
  update();
}
document.addEventListener("pointerdown", press);
document.addEventListener("pointermove", (e) => { if (held.has(e.pointerId) || e.buttons) press(e); });
document.addEventListener("pointerup", release);
document.addEventListener("pointercancel", release);
document.addEventListener("contextmenu", (e) => e.preventDefault());
addEventListener("blur", () => { held.clear(); update(); });

function connect() {
  let retry = 0, ping;
  const open = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/match/${match}?role=pad&player=${player}`);
    ws.addEventListener("open", () => {
      retry = 0;
      conn.textContent = "connected";
      conn.classList.add("on");
      sent = -1;
      send();                                   // the host starts from our current state
      ping = setInterval(() => ws.send("ping"), 25_000);
    });
    ws.addEventListener("close", (e) => {
      clearInterval(ping);
      conn.classList.remove("on");
      if (e.code === 4000) { conn.textContent = "another phone took this player"; return; }
      conn.textContent = "reconnecting…";
      setTimeout(open, Math.min(10_000, 250 * 2 ** retry++) * (0.5 + Math.random()));
    });
  };
  open();
}
connect();
