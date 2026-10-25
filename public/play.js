// One player's phone: its Game Boy's screen and buttons, with every other player's
// screen floating over it (picture-in-picture), so nobody plays against a black box. The
// games run on the server; this page sends button bytes and draws the updates it receives.
import { FrameDecoder, screen } from "/frames.js";
import { PALETTE } from "/palette.js";
import { BUTTONS, controlsPanel, keyMap, loadBindings, pads, readPads } from "/controls.js";
import { Sound } from "/sound.js";

const params = new URLSearchParams(location.search);
const match = params.get("match") ?? "";
const player = params.get("player");
const game = params.get("game") ?? "";
const seatsWanted = params.get("seats") ?? "";
const bestWanted = params.get("best") ?? "";
const timeWanted = params.get("time") ?? "";
const conn = document.getElementById("conn");
const peer = document.getElementById("peer");

if (!/^[a-z0-9]{6,16}$/.test(match) || !/^[1-4]$/.test(player ?? "") ||
    (game !== "" && !/^[a-z0-9_-]{1,32}$/.test(game)) || !/^[2-4]?$/.test(seatsWanted) ||
    !/^([1-9][0-9]?)?$/.test(bestWanted) || !/^[0-9]{0,4}$/.test(timeWanted)) {
  conn.textContent = "Bad match link.";
  throw new Error("bad match link");
}
const me = Number(player) - 1;
document.getElementById("who").textContent = `Player ${player}`;

// ---- screens: what changed arrives as RFB-style updates (moves and 8 x 8 tiles). The
// server says how many seats the match has; each gets a screen.
const RGBA = new Uint32Array(PALETTE.map(([r, g, b]) => (255 << 24 | b << 16 | g << 8 | r) >>> 0));
const area = document.querySelector(".screens");
let screens = [];

function buildScreens(n) {
  if (screens.length === n) return;
  for (const s of screens) s.fig.remove();
  pips.length = 0;
  screens = Array.from({ length: n }, (_, i) => {
    const fig = document.createElement("figure");
    fig.innerHTML = '<canvas width="160" height="144"></canvas><figcaption></figcaption><span class="resize"></span>';
    fig.querySelector("figcaption").textContent = i === me ? `Player ${i + 1} · you` : `Player ${i + 1}`;
    const ctx = fig.querySelector("canvas").getContext("2d");
    const image = ctx.createImageData(160, 144);
    return { fig, ctx, image, pixels32: new Uint32Array(image.data.buffer), decoder: new FrameDecoder() };
  });
  screens[me].fig.classList.add("own");
  area.append(screens[me].fig);
  screens.filter((_, i) => i !== me).forEach((s, k) => addPip(s.fig, k, n));
  viewButton.hidden = n < 2;
  viewButton.textContent = document.body.classList.contains("solo") ? showLabel() : hideLabel();
}

function drawUpdate(buf) {
  const s = screens[screen(buf)];
  if (!s || !s.decoder.apply(buf)) return false;
  const px = s.decoder.px;
  for (let i = 0; i < px.length; i++) s.pixels32[i] = RGBA[px[i]];
  s.ctx.putImageData(s.image, 0, 0);
  return true;
}

// The other players' screens float over the whole page: drag one anywhere, drag its
// corner dot to resize it. Each one's place is kept as fractions of the window and its
// width as a fraction of the screen area, so they survive rotation and reloads.
const pips = [];
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const pipWidth = (w) => clamp(w, 0.2, 0.8) * Math.min(area.clientWidth, innerWidth);
const PIP_DEFAULTS = [{ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0.5, y: 0 }];

function addPip(fig, slot, seats) {
  const key = slot === 0 ? "pip" : `pip${slot}`;   // slot 0 keeps the 2-player place
  let box = { ...PIP_DEFAULTS[slot], w: seats > 2 ? 0.3 : 0.36 };
  try { box = { ...box, ...JSON.parse(localStorage.getItem(key) ?? "{}") }; } catch { /* default */ }
  fig.classList.add("pip");
  document.body.append(fig);
  const place = () => {
    const w = pipWidth(box.w), h = (w * 144) / 160;
    fig.style.width = `${w}px`;
    fig.style.left = `${Math.max(0, innerWidth - w) * clamp(box.x, 0, 1)}px`;
    fig.style.top = `${Math.max(0, innerHeight - h) * clamp(box.y, 0, 1)}px`;
  };
  const keep = () => {
    try { localStorage.setItem(key, JSON.stringify(box)); } catch { /* not kept */ }
  };
  let gesture = null;
  fig.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fig.setPointerCapture(e.pointerId);
    for (const p of pips) p.fig.style.zIndex = p.fig === fig ? 6 : 5;    // the one touched comes to the front
    gesture = { id: e.pointerId, resize: e.target.classList.contains("resize"), x: e.clientX, y: e.clientY,
                r: fig.getBoundingClientRect(), w: box.w };
  });
  fig.addEventListener("pointermove", (e) => {
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
    place();
  });
  const end = (e) => { if (gesture?.id === e.pointerId) { gesture = null; keep(); } };
  fig.addEventListener("pointerup", end);
  fig.addEventListener("pointercancel", end);
  pips.push({ fig, place });
  place();
}
const placePips = () => { for (const p of pips) p.place(); };
new ResizeObserver(placePips).observe(area);
addEventListener("resize", placePips);

// Show or hide the other players' screens. Games that already show every player on one
// screen start hidden; the choice is remembered separately for those and the others.
const viewButton = document.getElementById("view");
let soloKey = "solo";
const hideLabel = () => (screens.length > 2 ? "Hide others" : "Hide other");
const showLabel = () => (screens.length > 2 ? "Show others" : "Show other");
function setSolo(solo) {
  document.body.classList.toggle("solo", solo);
  viewButton.textContent = solo ? showLabel() : hideLabel();
  try { localStorage.setItem(soloKey, solo ? "1" : "0"); } catch { /* not kept */ }
}
function restoreSolo(shared) {
  soloKey = shared ? "solo-shared" : "solo";
  let kept = null;
  try { kept = localStorage.getItem(soloKey); } catch { /* default */ }
  setSolo(kept === null ? shared : kept === "1");
}
viewButton.addEventListener("click", () => setSolo(!document.body.classList.contains("solo")));
restoreSolo(false);

// ---- lobby: the server starts the match once every player is online and pressed START.
// A player who goes offline pauses it from their 30 s budget; out of time, they lose.
const lobby = document.getElementById("lobby");
const lobbyList = lobby.querySelector("ul");
let phase = null, countdown = null;

function showLobby({ phase: next, online, ready, played, pause }) {
  if (next === "playing" && phase !== "playing") sound.reset();   // a new match
  phase = next;
  if (next === "lobby") clock.hidden = true;
  lobby.classList.toggle("show", next !== "playing");
  document.body.classList.toggle("lobby", next === "lobby" && !ready[me]);
  const here = online.filter(Boolean).length;
  peer.textContent = online.length > 2 ? `${here} of ${online.length} online`
    : online[1 - me] ? "2 players" : "waiting for the other player";
  peer.hidden = next === "playing" && here === online.length;   // room in the header for the match clock
  let title, hint;
  clearInterval(countdown);
  if (next === "paused" && pause) {
    const end = Date.now() + pause.left;
    const tickDown = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      lobby.querySelector("p").textContent =
        `Player ${pause.player} is offline. They lose the match in ${left} s unless they are back.`;
    };
    lobby.querySelector("strong").textContent = "Paused";
    tickDown();
    countdown = setInterval(tickDown, 250);
    title = null;
  } else if (!ready[me]) {
    title = played ? "Rematch?" : "Ready?";
    hint = "Press START when you are ready.";
  } else {
    const missing = online.map((on, i) => (on ? null : i + 1)).filter(Boolean);
    const waiting = ready.map((r, i) => (r || !online[i] ? null : i + 1)).filter(Boolean);
    title = "Ready!";
    hint = missing.length ? `Waiting for ${players(missing)} to join.` : `Waiting for ${players(waiting)} to press START.`;
  }
  if (title) {
    lobby.querySelector("strong").textContent = title;
    lobby.querySelector("p").textContent = hint;
  }
  while (lobbyList.children.length < online.length) {
    lobbyList.append(Object.assign(document.createElement("li"), { innerHTML: "<span></span><span></span>" }));
  }
  while (lobbyList.children.length > online.length) lobbyList.lastElementChild.remove();
  online.forEach((on, i) => {
    const li = lobbyList.children[i];
    li.className = `${on ? "on" : ""} ${on && ready[i] && next === "lobby" ? "ready" : ""}`;
    li.firstElementChild.textContent = `Player ${i + 1}${i === me ? " (you)" : ""}`;
    li.lastElementChild.textContent = !on ? "offline" : next === "lobby" ? (ready[i] ? "ready" : "online") : "online";
  });
}

function players(list) {
  if (list.length === 1) return `player ${list[0]}`;
  return `players ${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

// ---- results: only the server decides them (it reads the game's own memory); this page
// just shows what it is told, over the screens rather than in them.
const result = document.getElementById("result");
const CONFETTI = ["#6cd38a", "#f4d35e", "#e07a6a", "#5fa8f5", "#c792ea", "#ffffff"];
let resultTimer;

// ---- match clock: the server counts the time limit down in frames played.
const clock = document.getElementById("clock");
function showClock({ left, sudden }) {
  clock.hidden = false;
  clock.className = sudden || left <= 30 ? "low" : "";
  clock.textContent = sudden ? "Sudden death" : `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function showResult({ winner, wins, best, over, forfeit, time }) {
  if (forfeit && !winner && forfeit !== Number(player)) {      // more than two players: nobody won
    result.className = "show over";
    result.querySelector("strong").textContent = "MATCH OVER";
    result.querySelector("span").textContent = `Player ${forfeit} was offline too long`;
    for (const old of result.querySelectorAll("i")) old.remove();
    clearTimeout(resultTimer);
    resultTimer = setTimeout(() => { result.className = ""; }, 6000);
    return;
  }
  const won = winner === Number(player);
  const score = wins.length > 2
    ? wins.map((w, i) => (i === me ? `you ${w}` : `P${i + 1} ${w}`)).join(" · ")
    : `${wins[me] ?? 0} – ${wins[1 - me] ?? 0}`;
  result.className = `show ${won ? "win" : "lose"}${over ? " over" : ""}`;
  result.querySelector("strong").textContent = won ? "YOU WIN" : "YOU LOSE";
  result.querySelector("span").textContent = forfeit
    ? (won ? `Player ${forfeit} was offline too long` : "You were offline too long")
    : over
      ? `${time ? "Time up · " : ""}${won ? "Match won" : "Match lost"} ${score}`
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
// Safari ignores user-scalable=no: stop its pinch and double-tap zoom here too. A second
// finger (d-pad and A at once) must never start a pinch.
for (const type of ["gesturestart", "gesturechange", "gestureend", "dblclick"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener("touchstart", (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("touchmove", (e) => { if (e.touches.length > 1 || e.scale !== undefined && e.scale !== 1) e.preventDefault(); },
                          { passive: false });
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

// ---- invite: player 1 shares the other seats' links, once the server says how many
const invite = document.getElementById("invite");
function showInvites(seats) {
  if (player !== "1") return;
  invite.replaceChildren(...Array.from({ length: seats - 1 }, (_, i) => {
    const link = `${location.origin}/play.html?${new URLSearchParams({ match, player: String(i + 2) })}`;
    const row = document.createElement("div");
    row.innerHTML = '<span></span><button type="button">Share</button>';
    row.firstElementChild.textContent = `Player ${i + 2}: ${link}`;
    row.lastElementChild.addEventListener("click", async () => {
      try {
        if (navigator.share) await navigator.share({ title: `Challenge Me · player ${i + 2}`, url: link });
        else await navigator.clipboard.writeText(link);
      } catch { /* cancelled */ }
    });
    return row;
  }));
  invite.classList.add("show");
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

// Reconnects on its own, and at once when the network or the page comes back (a phone
// call can cut mobile data for a while). A link that died without closing (common when
// a phone switches networks) is noticed when nothing, not even a pong, arrives for a while.
const PING_MS = 4000;
const DEAD_MS = 9000;

function connect() {
  let retry = 0, ping, timer, heard = 0;
  const open = () => {
    clearTimeout(timer);
    const q = new URLSearchParams({ player });
    if (game) q.set("game", game);
    if (game && seatsWanted) q.set("seats", seatsWanted);
    if (game && bestWanted) q.set("best", bestWanted);
    if (game && timeWanted) q.set("time", timeWanted);
    const sock = ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/match/${match}?${q}`);
    sock.binaryType = "arraybuffer";
    sock.addEventListener("open", () => {
      if (sock !== ws) return;
      heard = Date.now();
      sock.send(JSON.stringify({ t: "join", token: savedToken() }));
      clearInterval(ping);
      ping = setInterval(() => {
        if (Date.now() - heard > DEAD_MS) reopen();
        else sock.send("ping");
      }, PING_MS);
    });
    sock.addEventListener("message", (e) => {
      if (sock !== ws) return;
      heard = Date.now();
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
        buildScreens(msg.seats ?? 2);
        restoreSolo(msg.shared === true);
        showInvites(msg.seats ?? 2);
        for (const s of screens) s.decoder.px.fill(0);   // the server starts again from blank
        sound.reset();
        joined = true;
        retry = 0;
        sent = -1;
        status(msg.game, "on");
        send();                                       // the server starts from our state
      } else if (msg.t === "lobby") {
        showLobby(msg);
      } else if (msg.t === "result") {
        showResult(msg);
        if (msg.over) clock.hidden = true;
      } else if (msg.t === "clock") {
        showClock(msg);
      } else if (msg.t === "trap") {
        status(`stopped at ${msg.at}`, "bad");
      }
    });
    sock.addEventListener("close", (e) => {
      if (sock !== ws) return;                      // a link we already gave up on
      clearInterval(ping);
      joined = false;
      const final = { 4000: "opened on another tab", 4003: `player ${player} is taken`, 4004: "unknown game",
                      4005: `this match has no player ${player}` }[e.code];
      if (final) { status(final, "bad"); return; }
      status("reconnecting…", "bad");
      timer = setTimeout(open, Math.min(3000, 250 * 2 ** retry++) * (0.5 + Math.random()));
    });
  };
  // Drop the current link without waiting for it to close, and open a new one now.
  const reopen = () => {
    const old = ws;
    clearInterval(ping);
    joined = false;
    status("reconnecting…", "bad");
    retry = 0;
    open();
    try { old.close(); } catch { /* already gone */ }
  };
  const check = () => {
    if (document.hidden) return;
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) reopen();
    else if (ws.readyState === WebSocket.OPEN && Date.now() - heard > DEAD_MS) reopen();
  };
  addEventListener("online", check);
  addEventListener("pageshow", check);
  document.addEventListener("visibilitychange", check);
  open();
}
connect();
