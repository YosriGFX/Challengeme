import { DurableObject } from "cloudflare:workers";
import { GAMES } from "./games/index.js";
import { FrameEncoder, H, W } from "./gb/frames.js";
import { FRAME_CYCLES, FRAME_HZ, GameBoy, runLinked } from "./gb/machine.js";
import { encodeSound, soundState } from "./gb/sound.js";
import { SQL } from "./sql.js";

const PERIOD = 1000 / FRAME_HZ;
const MAX_CATCH_UP = 3;             // frames run at most per tick after a stall
const MAX_UNACKED = 10;             // updates in flight to one phone before we skip frames
const MAX_INPUTS_PER_SECOND = 120;  // a phone sends only on change; more is abuse
const AFTER_MATCH_MS = 6000;        // the end of a match stays on screen this long
const START = 0x80;

// One match: two linked Game Boys that run here, and only here. Each phone is one
// player's screen and controller. Cheating is designed out rather than detected:
// - the game (code and memory) never leaves this object; phones get only pixels;
// - a phone can send only its own seat's buttons, as one byte, rate limited, with
//   impossible d-pad combinations (left+right, up+down) removed;
// - a seat belongs to the first phone that joins it; reconnecting needs its secret
//   token, of which only a SHA-256 hash is stored.
//
// Phone -> here: text {"t":"join","token":...} once, then binary: 1 byte = buttons,
// 2 bytes = ack of frame `seq` (little-endian).
// Here -> phone: text {"t":"seat"|"peer"|"trap"|"result",...}; binary screen updates for both Game
// Boys, each carrying only what changed since the last update of that screen the phone
// was sent (format: gb/frames.js). Seeing the opponent's screen live keeps the other
// player from being a black box; it is still only pixels. Each phone also gets its own
// Game Boy's sound register writes (format: gb/sound.js).
//
// A match runs only while both players are here: phases are "lobby" (Game Boys stopped;
// a player is ready after pressing START, and the game starts once both are online and
// ready, already past its menus), "playing", and "paused" (someone left; the game goes on
// when they are back). A few seconds after a match is decided it returns to the lobby,
// where START again means a rematch. Phones get {"t":"lobby",...} on every change.
export class Match extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = ctx.storage.sql;
    this.sql.exec(SQL.createSeats);
    this.sql.exec(SQL.createMeta);
    this.sql.exec(SQL.createResults);
    this.machines = null;           // [GameBoy, GameBoy], rebuilt after eviction
    this.rule = null;               // how this game shows who won (GAMES[game].result)
    this.wins = [0, 0];             // round wins last seen in each Game Boy's memory
    this.buttons = [0, 0];
    this.taps = [0, 0];             // buttons pressed since the last frame, even if let go
    this.views = [null, null];      // per player: what that phone has been sent, per screen
    this.shades = new Uint8Array(W * H);
    this.rate = new Map();
    this.phase = "lobby";
    this.overAt = 0;                // when the match was decided
    this.timer = null;
    this.next = 0;
  }

  async fetch(request) {
    const player = Number(request.headers.get("X-Player"));
    if (player !== 1 && player !== 2) return new Response(null, { status: 400 });
    const game = request.headers.get("X-Game");
    if (game && Object.hasOwn(GAMES, game)) this.sql.exec(SQL.setGame, game);   // first one wins
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [`p${player}`]);
    server.serializeAttachment({ player, joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const seat = ws.deserializeAttachment();
    if (!seat.joined) {
      let msg = null;
      if (typeof message === "string" && message.length <= 256) {
        try { msg = JSON.parse(message); } catch { /* handled below */ }
      }
      if (msg?.t !== "join") return ws.close(1008, "join first");
      return this.join(ws, seat.player, msg.token);
    }
    if (typeof message === "string" || message.byteLength > 2) return ws.close(1003, "bad message");
    const bytes = new Uint8Array(message);
    if (bytes.length === 1) {
      if (!this.allow(ws)) return;
      if (this.phase === "playing") this.press(seat.player, bytes[0]);
      else if (this.phase === "lobby" && (bytes[0] & START) && !seat.ready) this.setReady(ws, seat);
    } else {
      const view = this.views[seat.player - 1];
      if (view) view.acked = bytes[0] | (bytes[1] << 8);
    }
  }

  async webSocketClose(ws) {
    this.rate.delete(ws);
    const seat = ws.deserializeAttachment();
    if (!seat?.joined || this.joined(seat.player, ws)) return;
    this.press(seat.player, 0);                       // a player who left holds nothing
    this.views[seat.player - 1] = null;
    this.tell(3 - seat.player, { t: "peer", on: false });
    if (this.phase === "playing") {
      this.phase = "paused";
      this.stop();
    }
    this.announce(ws);
  }

  async webSocketError(ws, error) {
    console.error(JSON.stringify({ msg: "ws_error", error: String(error) }));
  }

  async join(ws, player, token) {
    const offered = typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? token : null;
    const fresh = randomHex(32);
    const [offeredHash, freshHash] = await Promise.all([offered && sha256(offered), sha256(fresh)]);
    // No await from here on: checking and claiming the seat cannot interleave.
    const row = this.sql.exec(SQL.seatHash, player).toArray()[0];
    let issued = null;
    if (!row) {
      this.sql.exec(SQL.claimSeat, player, freshHash);
      issued = fresh;
    } else if (offeredHash !== row.token_hash) {
      return ws.close(4003, "seat taken");
    }
    const game = this.sql.exec(SQL.getGame).toArray()[0]?.v;
    if (!game || !Object.hasOwn(GAMES, game)) return ws.close(4004, "unknown game");

    for (const other of this.ctx.getWebSockets(`p${player}`)) {
      if (other !== ws && other.deserializeAttachment()?.joined) other.close(4000, "replaced");
    }
    ws.serializeAttachment({ player, joined: true });
    ws.send(JSON.stringify({ t: "seat", player, game, token: issued, peer: this.joined(3 - player, ws) }));
    this.tell(3 - player, { t: "peer", on: true });
    this.views[player - 1] = { encoders: [new FrameEncoder(0), new FrameEncoder(1)], seq: 0, acked: 0, frameSeq: [-1, -1],
                               soundFresh: true };
    console.log(JSON.stringify({ msg: "join", player, game, claimed: issued !== null }));

    if (this.phase === "paused" && this.joined(3 - player)) {
      this.phase = "playing";
      this.start();
    }
    this.announce();
    if (this.machines) this.sendFrame(player);       // where the game stands
  }

  setReady(ws, seat) {
    ws.serializeAttachment({ ...seat, ready: true });
    this.announce();
    if (![1, 2].every((p) => this.joined(p) && this.ready(p))) return;
    const game = this.sql.exec(SQL.getGame).toArray()[0]?.v;
    if (game && Object.hasOwn(GAMES, game)) this.newMatch(game);
  }

  // Fresh Game Boys, run past the menus at once if the game says how.
  newMatch(game) {
    const { module, result, start } = GAMES[game];
    const [a, b] = this.machines = [new GameBoy(module), new GameBoy(module)];
    for (let f = 0; f < (start?.frames ?? 0); f++) {
      for (const [at, b1, b2] of start.inputs) if (at === f) { a.buttons = b1; b.buttons = b2; }
      runLinked(a, b, FRAME_CYCLES);
    }
    this.buttons = [0, 0];
    this.taps = [0, 0];
    for (const m of this.machines) { m.buttons = 0; m.takeSound(); }
    this.rule = result;
    this.wins = [0, 0];
    this.overAt = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const seat = ws.deserializeAttachment();
      if (seat?.ready) ws.serializeAttachment({ ...seat, ready: false });
    }
    for (const view of this.views) if (view) view.soundFresh = true;
    this.phase = "playing";
    console.log(JSON.stringify({ msg: "match_start", game, skipped: start?.frames ?? 0 }));
    this.announce();
    this.start();
  }

  // Tells both phones who is here and ready, and what the match is doing.
  announce(except) {
    const online = [1, 2].map((p) => this.joined(p, except)), ready = [1, 2].map((p) => this.ready(p, except));
    for (const p of [1, 2]) this.tell(p, { t: "lobby", phase: this.phase, online, ready, played: this.machines !== null });
  }

  start() {
    if (this.timer !== null) return;
    this.next = Date.now();
    this.tick();
  }

  // Keeps the game's state; the object can sleep again once nobody is playing.
  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  tick() {
    const [a, b] = this.machines;
    const now = Date.now();
    for (let n = 0; this.next <= now && n < MAX_CATCH_UP; n++) {
      runLinked(a, b, FRAME_CYCLES);
      this.next += PERIOD;
      if (this.taps[0] | this.taps[1]) {
        this.taps = [0, 0];
        a.buttons = this.buttons[0];
        b.buttons = this.buttons[1];
      }
    }
    if (this.next < now) this.next = now;           // fell behind: drop frames, don't spiral
    this.checkResult();
    const sound = this.machines.map((m) => m.takeSound());
    for (const player of [1, 2]) {
      this.sendFrame(player);
      this.sendSound(player, sound[player - 1]);
    }
    if (this.overAt && Date.now() - this.overAt > AFTER_MATCH_MS) {
      this.timer = null;
      this.phase = "lobby";
      this.overAt = 0;
      this.announce();
      return;
    }
    this.timer = setTimeout(() => this.tick(), Math.max(1, this.next - Date.now()));
  }

  // Sends `player`'s phone what changed on both screens, its own and the other player's.
  sendFrame(player) {
    const own = this.machines[player - 1];
    if (own.trap && !own.trapSent) {
      own.trapSent = true;
      console.error(JSON.stringify({ msg: "trap", player, at: own.trap.at }));
      this.tell(player, { t: "trap", at: own.trap.at });
    }
    const view = this.views[player - 1];
    if (!view) return;
    for (const screen of [player - 1, 2 - player]) {         // own screen first
      const m = this.machines[screen];
      if (m.frameSeq === view.frameSeq[screen]) continue;
      if (((view.seq - view.acked) & 0xffff) >= MAX_UNACKED) return;   // phone is behind
      view.frameSeq[screen] = m.frameSeq;
      const msg = view.encoders[screen].encode(m.shadesInto(this.shades), (view.seq + 1) & 0xffff);
      if (!msg) continue;
      view.seq = (view.seq + 1) & 0xffff;
      this.send(player, msg);
    }
  }

  // Sends `player`'s phone what its own Game Boy wrote to the sound registers; a phone
  // that just joined first gets the registers as they stand.
  sendSound(player, writes) {
    const view = this.views[player - 1];
    if (!view) return;
    const m = this.machines[player - 1];
    if (view.soundFresh) {
      view.soundFresh = false;
      writes = [...soundState(m.u8, writes.length ? writes[0] : m.clock), ...writes];
    }
    if (writes.length === 0) return;
    this.send(player, encodeSound(writes, m.clock));
  }

  // The game itself says who won: each Game Boy counts its player's round wins in RAM,
  // and the other player's. The server reads both (phones never report results); once
  // the two Game Boys agree on a new win, it tells both phones and keeps it in SQLite.
  checkResult() {
    if (!this.rule) return;
    for (const player of [1, 2]) {
      const wins = this.machines[player - 1].u8[this.rule.wins];
      if (wins !== this.machines[2 - player].u8[this.rule.theirs]) continue;   // not agreed yet
      const before = this.wins[player - 1];
      this.wins[player - 1] = wins;
      if (wins !== before + 1 || before >= this.rule.best) continue;   // unchanged, reset, or past the end
      const [wins1, wins2] = this.wins, over = wins >= this.rule.best;
      if (over) this.overAt = Date.now();
      this.sql.exec(SQL.addResult, player, wins1, wins2, over ? 1 : 0, Date.now());
      console.log(JSON.stringify({ msg: "result", winner: player, wins: this.wins, over }));
      for (const p of [1, 2]) this.tell(p, { t: "result", winner: player, wins: this.wins, best: this.rule.best, over });
    }
  }

  press(player, bits) {
    if ((bits & 0x03) === 0x03) bits &= ~0x03;      // right + left
    if ((bits & 0x0c) === 0x0c) bits &= ~0x0c;      // up + down
    this.buttons[player - 1] = bits;
    this.taps[player - 1] |= bits;                  // a tap shorter than a frame still counts
    let held = bits | this.taps[player - 1];
    if ((held & 0x03) === 0x03) held = (held & ~0x03) | (bits & 0x03);   // the latest direction wins
    if ((held & 0x0c) === 0x0c) held = (held & ~0x0c) | (bits & 0x0c);
    if (this.machines) this.machines[player - 1].buttons = held;
  }

  joined(player, except) {
    return this.ctx.getWebSockets(`p${player}`)
      .some((ws) => ws !== except && ws.deserializeAttachment()?.joined);
  }

  ready(player, except) {
    return this.ctx.getWebSockets(`p${player}`)
      .some((ws) => ws !== except && ws.deserializeAttachment()?.ready);
  }

  tell(player, obj) {
    this.send(player, JSON.stringify(obj));
  }

  send(player, data) {
    for (const ws of this.ctx.getWebSockets(`p${player}`)) {
      if (!ws.deserializeAttachment()?.joined) continue;
      try { ws.send(data); } catch { /* closing */ }
    }
  }

  // Token bucket per socket, refilled continuously.
  allow(ws) {
    const now = Date.now();
    const b = this.rate.get(ws) ?? { tokens: MAX_INPUTS_PER_SECOND, at: now };
    b.tokens = Math.min(MAX_INPUTS_PER_SECOND, b.tokens + ((now - b.at) * MAX_INPUTS_PER_SECOND) / 1000);
    b.at = now;
    this.rate.set(ws, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
