// One player's phone: the screen of their Game Boy and its buttons. The game runs on
// the server; this page sends button bytes and draws the pixel rows it receives.
const BUTTONS = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 };
const KEYS = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up", ArrowDown: "down",
               KeyX: "a", KeyZ: "b", ShiftRight: "select", Enter: "start" };
const SHADES = [[0xe0, 0xf8, 0xd0], [0x88, 0xc0, 0x70], [0x34, 0x68, 0x56], [0x08, 0x18, 0x20]];
const ROW = 40, ROWS = 144, MASK = 18;

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

// ---- screen
const ctx = document.getElementById("screen").getContext("2d");
const image = ctx.createImageData(160, 144);
for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;

function drawFrame(buf) {
  const mask = buf.subarray(3, 3 + MASK);
  const px = image.data;
  let p = 3 + MASK;
  for (let r = 0; r < ROWS; r++) {
    if (!(mask[r >> 3] & (1 << (r & 7)))) continue;
    let o = r * 640;
    for (let i = 0; i < ROW; i++) {
      const byte = buf[p++];
      for (let shift = 6; shift >= 0; shift -= 2) {
        const c = SHADES[(byte >> shift) & 3];
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
        o += 4;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
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
        if (buf[0] !== 1) return;
        drawFrame(buf);
        ws.send(buf.subarray(1, 3));                  // ack: frame seq
        return;
      }
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.t === "seat") {
        if (msg.token) saveToken(msg.token);
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
