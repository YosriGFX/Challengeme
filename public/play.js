// One player's phone: its Game Boy's screen and buttons, with the other player's screen
// floating over it (picture-in-picture), so the other player is never a black box. The
// games run on the server; this page sends button bytes and draws the updates it receives.
import { FrameDecoder, screen } from "/frames.js";
import { PALETTE } from "/palette.js";
import { BUTTONS, controlsPanel, keyMap, loadBindings, pads, readPads } from "/controls.js";
import { Sound } from "/sound.js";

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

// ---- screens: what changed arrives as RFB-style updates (moves and 8 x 8 tiles)
const RGBA = new Uint32Array(PALETTE.map(([r, g, b]) => (255 << 24 | b << 16 | g << 8 | r) >>> 0));
const screens = [1, 2].map((n) => {
  const ctx = document.getElementById(`screen${n}`).getContext("2d");
  const image = ctx.createImageData(160, 144);
  return { ctx, image, pixels32: new Uint32Array(image.data.buffer), decoder: new FrameDecoder() };
});
const own = document.getElementById(`fig${player}`);
const pip = document.getElementById(`fig${3 - player}`);
own.classList.add("own");
pip.classList.add("pip");
own.querySelector("figcaption").textContent = `Player ${player} · you`;
own.parentElement.prepend(own);

function drawUpdate(buf) {
  const s = screens[screen(buf)];
  if (!s || !s.decoder.apply(buf)) return false;
  const px = s.decoder.px;
  for (let i = 0; i < px.length; i++) s.pixels32[i] = RGBA[px[i]];
  s.ctx.putImageData(s.image, 0, 0);
  return true;
}

// The other player's screen floats over the whole page: drag it anywhere, drag the corner
// dot to resize it. Its place is kept as fractions of the window and its width as a
// fraction of the screen area, so they survive rotation and reloads.
const area = pip.parentElement;
const PIP_KEY = "pip";
let box = { x: 1, y: 0, w: 0.36 };                    // x, y: 0 = left/top edge, 1 = right/bottom
try { box = { ...box, ...JSON.parse(localStorage.getItem(PIP_KEY) ?? "{}") }; } catch { /* default */ }
document.body.append(pip);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const pipWidth = (w) => clamp(w, 0.2, 0.8) * Math.min(area.clientWidth, innerWidth);
function placePip() {
  const w = pipWidth(box.w), h = (w * 144) / 160;
  pip.style.width = `${w}px`;
  pip.style.left = `${Math.max(0, innerWidth - w) * clamp(box.x, 0, 1)}px`;
  pip.style.top = `${Math.max(0, innerHeight - h) * clamp(box.y, 0, 1)}px`;
}
function keepPip() {
  try { localStorage.setItem(PIP_KEY, JSON.stringify(box)); } catch { /* not kept */ }
}

let gesture = null;
pip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  pip.setPointerCapture(e.pointerId);
  gesture = { id: e.pointerId, resize: e.target.classList.contains("resize"), x: e.clientX, y: e.clientY,
              r: pip.getBoundingClientRect(), w: box.w };
});
pip.addEventListener("pointermove", (e) => {
  if (gesture?.id !== e.pointerId) return;
  const { r } = gesture, dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
  let left = r.left + dx, top = r.top + dy, w = r.width;
  if (gesture.resize) {
    box.w = clamp((gesture.w * (r.width + Math.max(dx, (dy * 160) / 144))) / r.width, 0.2, 0.8);
    w = pipWidth(box.w);
    left = r.left;
    top = r.top;
  }
  const h = (w * 144) / 160;
  box.x = innerWidth > w ? clamp(left / (innerWidth - w), 0, 1) : 0;
  box.y = innerHeight > h ? clamp(top / (innerHeight - h), 0, 1) : 0;
  placePip();
});
const endGesture = (e) => { if (gesture?.id === e.pointerId) { gesture = null; keepPip(); } };
pip.addEventListener("pointerup", endGesture);
pip.addEventListener("pointercancel", endGesture);
new ResizeObserver(placePip).observe(area);
addEventListener("resize", placePip);
placePip();

// Show or hide the other player's screen.
const viewButton = document.getElementById("view");
function setSolo(solo) {
  document.body.classList.toggle("solo", solo);
  viewButton.textContent = solo ? "Show other" : "Hide other";
  try { localStorage.setItem("solo", solo ? "1" : "0"); } catch { /* not kept */ }
}
viewButton.addEventListener("click", () => setSolo(!document.body.classList.contains("solo")));
try { setSolo(localStorage.getItem("solo") === "1"); } catch { setSolo(false); }

// ---- lobby: the server starts the match once both players are online and pressed START;
// once started it never pauses
const lobby = document.getElementById("lobby");
let phase = null;

function showLobby({ phase: next, online, ready, played }) {
  const me = Number(player) - 1, other = 1 - me;
  if (next === "playing" && phase !== "playing") sound.reset();   // a new match
  phase = next;
  lobby.classList.toggle("show", next !== "playing");
  document.body.classList.toggle("lobby", next === "lobby" && !ready[me]);
  let title, hint;
  if (!ready[me]) {
    title = played ? "Rematch?" : "Ready?";
    hint = "Press START when you are ready.";
  } else {
    title = "Ready!";
    hint = online[other] ? `Waiting for player ${other + 1} to press START.` : `Waiting for player ${other + 1} to join.`;
  }
  lobby.querySelector("strong").textContent = title;
  lobby.querySelector("p").textContent = hint;
  for (const i of [0, 1]) {
    const li = document.getElementById(`lobby${i + 1}`);
    li.className = `${online[i] ? "on" : ""} ${online[i] && ready[i] && next === "lobby" ? "ready" : ""}`;
    li.firstElementChild.textContent = `Player ${i + 1}${i === me ? " (you)" : ""}`;
    li.lastElementChild.textContent = !online[i] ? "offline" : next === "lobby" ? (ready[i] ? "ready" : "online") : "online";
  }
}

// ---- results: only the server decides them (it reads the game's own memory); this page
// just shows what it is told, over the screens rather than in them.
const result = document.getElementById("result");
const CONFETTI = ["#6cd38a", "#f4d35e", "#e07a6a", "#5fa8f5", "#c792ea", "#ffffff"];
let resultTimer;

function showResult({ winner, wins, best, over }) {
  const me = Number(player) - 1, won = winner === Number(player);
  const score = `${wins[me]} – ${wins[1 - me]}`;
  result.className = `show ${won ? "win" : "lose"}${over ? " over" : ""}`;
  result.querySelector("strong").textContent = won ? "YOU WIN" : "YOU LOSE";
  result.querySelector("span").textContent = over
    ? `${won ? "Match won" : "Match lost"} ${score}`
    : `${won ? "Round won" : "Round lost"} · ${score} · first to ${best}`;
  for (const old of result.querySelectorAll("i")) old.remove();
  const count = won ? (over ? 140 : 70) : (over ? 50 : 24);   // confetti when you win, grey rain when you lose
  for (let n = 0; n < count; n++) {
    const bit = document.createElement("i");
    bit.style.left = `${Math.random() * 100}%`;
    if (won) bit.style.background = CONFETTI[n % CONFETTI.length];
    bit.style.setProperty("--t", `${(won ? 1.8 : 1.2) + Math.random() * 1.6}s`);
    bit.style.setProperty("--d", `${Math.random() * (over ? 1.5 : 0.6)}s`);
    bit.style.setProperty("--dx", `${won ? (Math.random() - 0.5) * 160 : 0}px`);
    bit.style.setProperty("--r", `${won ? (Math.random() - 0.5) * 1440 : 0}deg`);
    result.append(bit);
  }
  navigator.vibrate?.(won ? [40, 60, 40, 60, 120] : [200]);
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => { result.className = ""; }, over ? 6000 : 3500);
}

// ---- buttons: each finger (pointer) holds at most one button; sliding moves it
const held = new Map();
let keys = 0, pad = 0, state = 0, sent = -1, ws = null, joined = false;

function update() {
  let bits = keys | pad;
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
// ---- sound: starts on the first tap or key press (browsers allow no sooner)
const sound = new Sound();
const soundButton = document.getElementById("sound");
const showSound = () => { soundButton.textContent = sound.muted ? "🔇" : "🔊"; };
showSound();
soundButton.addEventListener("click", () => { sound.setMuted(!sound.muted); showSound(); });
for (const type of ["pointerdown", "pointerup", "touchend", "keydown"]) {
  addEventListener(type, () => sound.unlock(), { capture: true, passive: true });
}

// ---- keyboard and gamepad, as set in the Controls panel (controls.js)
let bindings = loadBindings(), keymap = keyMap(bindings);
const down = new Set();                               // key codes held
const settings = document.getElementById("settings");
const panel = controlsPanel(settings, bindings, (b) => { bindings = b; keymap = keyMap(b); });
document.getElementById("controls").addEventListener("click", () => {
  down.clear(); keys = 0; pad = 0; update();          // nothing stays held while setting
  panel.open();
});

function setKey(e, on) {
  if (settings.open || !keymap.has(e.code) || (on && (e.ctrlKey || e.metaKey || e.altKey))) return;
  e.preventDefault();
  if (on) down.add(e.code); else down.delete(e.code);
  keys = 0;
  for (const code of down) keys |= keymap.get(code) ?? 0;
  update();
}
addEventListener("keydown", (e) => setKey(e, true));
addEventListener("keyup", (e) => setKey(e, false));
addEventListener("blur", () => { held.clear(); down.clear(); keys = 0; update(); });

// Gamepads have no events for presses: read them every animation frame while one is
// connected. All connected pads drive this player.
const padIcon = document.getElementById("pads");
let polling = false;
function pollPads() {
  const now = pads(), bits = settings.open ? 0 : readPads(now, bindings);
  if (bits !== pad) { pad = bits; update(); }
  polling = now.length > 0;
  if (polling) requestAnimationFrame(pollPads);
}
function padsChanged(e) {
  const n = pads().length;
  padIcon.textContent = n ? "🎮" : "";
  padIcon.title = n ? `${e.gamepad.id} connected` : "";
  if (n && !polling) { polling = true; requestAnimationFrame(pollPads); }
  if (!n) { pad = 0; update(); }
}
addEventListener("gamepadconnected", padsChanged);
addEventListener("gamepaddisconnected", padsChanged);

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
        if (Sound.is(buf)) { sound.feed(buf); return; }
        if (drawUpdate(buf)) ws.send(buf.subarray(1, 3));   // ack: update seq
        return;
      }
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.t === "seat") {
        if (msg.token) saveToken(msg.token);
        for (const s of screens) s.decoder.px.fill(0);   // the server starts again from blank
        sound.reset();
        joined = true;
        retry = 0;
        sent = -1;
        status(msg.game, "on");
        peer.textContent = msg.peer ? "2 players" : "waiting for the other player";
        send();                                       // the server starts from our state
      } else if (msg.t === "peer") {
        peer.textContent = msg.on ? "2 players" : "other player left";
      } else if (msg.t === "lobby") {
        showLobby(msg);
      } else if (msg.t === "result") {
        showResult(msg);
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
