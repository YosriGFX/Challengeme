import { DurableObject } from "cloudflare:workers";
import { GAMES } from "./games/index.js";
import { FrameEncoder, H, W } from "./gb/frames.js";
import { Adapter } from "./gb/adapter.js";
import { FRAME_CYCLES, FRAME_HZ, GameBoy, runLinked } from "./gb/machine.js";
import { encodeSound, soundState } from "./gb/sound.js";
import { SQL } from "./sql.js";

const PERIOD = 1000 / FRAME_HZ;
const MAX_CATCH_UP = 3;             // frames run at most per tick after a stall
const MAX_UNACKED = 10;             // updates in flight to one phone before we skip frames
const MAX_INPUTS_PER_SECOND = 120;  // a phone sends only on change; more is abuse
const AFTER_MATCH_MS = 6000;        // the end of a match stays on screen this long
const PAUSE_BUDGET_MS = 30_000;     // per player and match: offline time the game waits
const SILENT_MS = 10_000;           // a phone pings every 4 s; this long without one is gone
const START = 0x80;
const MAX_SEATS = 4;

// One match: two to four linked Game Boys that run here, and only here (two on a link
// cable, or up to four on the 4-Player Adapter, gb/adapter.js). Each phone is one
// player's screen and controller. Cheating is designed out rather than detected:
// - the game (code and memory) never leaves this object; phones get only pixels;
// - a phone can send only its own seat's buttons, as one byte, rate limited, with
//   impossible d-pad combinations (left+right, up+down) removed;
// - a seat belongs to the first phone that joins it; reconnecting needs its secret
//   token, of which only a SHA-256 hash is stored.
//
// Phone -> here: text {"t":"join","token":...} once, then binary: 1 byte = buttons,
// 2 bytes = ack of frame `seq` (little-endian).
// Here -> phone: text {"t":"seat"|"lobby"|"trap"|"result",...}; binary screen updates for
// every Game Boy, each carrying only what changed since the last update of that screen
// the phone was sent (format: gb/frames.js). Seeing the opponents' screens live keeps
// them from being a black box; it is still only pixels. Each phone also gets its own
// Game Boy's sound register writes (format: gb/sound.js).
//
// The number of seats is the game's (`players`), or what the player who opened the match
// chose within the game's range. A match starts only when every seat is taken: phases are
// "lobby" (Game Boys stopped; a player is ready after pressing START, and the game starts
// once all are online and ready, already past its menus), "playing" and "paused". Matches are played for money,
// so going offline (a phone call can cut mobile data) pauses the game only from that
// player's own budget of 30 s per match: back in time, the game goes on; still offline
// when the budget runs out, that player loses the match (with more than two players, the
// match ends there and only that player has lost). A few seconds after a match is
// decided it returns to the lobby, where START again means a rematch. Phones get
// {"t":"lobby",...} on every change.
export class Match extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.sql = ctx.storage.sql;
    this.sql.exec(SQL.createSeats);
    this.sql.exec(SQL.createMeta);
    this.sql.exec(SQL.createResults);
    this.n = 2;                     // seats in this match, known once the game is
    this.machines = null;           // a GameBoy per seat, rebuilt after eviction
    this.link = null;               // what connects them: { run(cycles) }
    this.rule = null;               // how this game shows who won (GAMES[game].result)
    this.wins = [0, 0];             // round wins last seen in each Game Boy's memory
    this.buttons = new Array(MAX_SEATS).fill(0);
    this.taps = new Array(MAX_SEATS).fill(0);   // buttons pressed since the last frame, even if let go
    this.views = new Array(MAX_SEATS).fill(null);   // per player: what that phone has been sent, per screen
    this.shades = new Uint8Array(W * H);
    this.rate = new Map();
    this.phase = "lobby";
    this.overAt = 0;                // when the match was decided
    this.budget = new Array(MAX_SEATS).fill(PAUSE_BUDGET_MS);
    this.pause = null;              // { player, since, timer } while one player is away
    this.missed = null;             // a forfeit result its offline loser has not seen yet
    this.checkedAt = 0;
    this.timer = null;
    this.next = 0;
    this.game();
  }

  async fetch(request) {
    const player = Number(request.headers.get("X-Player"));
    if (!(player >= 1 && player <= MAX_SEATS)) return new Response(null, { status: 400 });
    const game = request.headers.get("X-Game"), seats = Number(request.headers.get("X-Seats"));
    const best = Number(request.headers.get("X-Best"));
    if (game && Object.hasOwn(GAMES, game) && this.sql.exec(SQL.getGame).toArray().length === 0) {
      this.sql.exec(SQL.setGame, game);                           // whoever opens the match chooses
      if (seats) this.sql.exec(SQL.setSeats, String(seats));
      if (best) this.sql.exec(SQL.setBest, String(best));
      this.game();
    }
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
    this.leave(ws, seat.player);
  }

  leave(ws, player) {
    this.press(player, 0);                            // a player who left holds nothing
    this.views[player - 1] = null;
    if (this.phase === "playing") this.pauseFor(player);
    this.announce(ws);
  }

  // A link can die without closing (a phone switching networks): drop a phone that has
  // not pinged for a while, so its pause starts now rather than minutes later.
  dropSilent() {
    const now = Date.now();
    if (now - this.checkedAt < 1000) return;
    this.checkedAt = now;
    for (const ws of this.ctx.getWebSockets()) {
      const seat = ws.deserializeAttachment();
      if (!seat?.joined) continue;
      const last = Math.max(this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, seat.at ?? 0);
      if (now - last < SILENT_MS) continue;
      ws.serializeAttachment({ ...seat, joined: false });
      try { ws.close(4001, "no answer"); } catch { /* already gone */ }
      console.log(JSON.stringify({ msg: "silent", player: seat.player }));
      if (!this.joined(seat.player, ws)) this.leave(ws, seat.player);
    }
  }

  // `player` is away: wait for them from their pause budget, or end the match.
  pauseFor(player) {
    if (this.budget[player - 1] <= 0) return this.forfeit(player);
    this.stop();
    this.phase = "paused";
    this.pause = { player, since: Date.now(), timer: setTimeout(() => this.forfeit(player), this.budget[player - 1]) };
    console.log(JSON.stringify({ msg: "pause", player, budget: this.budget[player - 1] }));
  }

  resume() {
    const { player, since, timer } = this.pause;
    clearTimeout(timer);
    this.budget[player - 1] = Math.max(0, this.budget[player - 1] - (Date.now() - since));
    this.pause = null;
    this.phase = "playing";
    const away = this.seats().find((p) => !this.joined(p));
    if (away) return this.pauseFor(away);             // someone else left meanwhile
    this.start();
  }

  // Out of pause time while offline: that player loses the match. With two players the
  // other one wins it; with more, the match ends without a winner.
  forfeit(player) {
    if (this.pause) clearTimeout(this.pause.timer);
    this.pause = null;
    this.stop();
    const winner = this.n === 2 ? 3 - player : 0, [wins1 = 0, wins2 = 0] = this.wins;
    this.sql.exec(SQL.addResult, winner, wins1, wins2, 1, Date.now(), "forfeit");
    console.log(JSON.stringify({ msg: "forfeit", player, winner }));
    const msg = { t: "result", winner, wins: this.wins, best: this.rule?.best ?? 0, over: true, forfeit: player };
    for (const p of this.seats()) this.tell(p, msg);
    this.missed = { player, msg };                   // the loser is offline: tell them when back
    this.phase = "lobby";
    this.overAt = 0;
    this.announce();
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
    const game = this.game();
    if (!game) return ws.close(4004, "unknown game");
    if (player > this.n) return ws.close(4005, "no such seat");

    for (const other of this.ctx.getWebSockets(`p${player}`)) {
      if (other !== ws && other.deserializeAttachment()?.joined) other.close(4000, "replaced");
    }
    ws.serializeAttachment({ player, joined: true, at: Date.now() });
    ws.send(JSON.stringify({ t: "seat", player, game, seats: this.n, token: issued }));
    this.views[player - 1] = { encoders: this.seats().map((p) => new FrameEncoder(p - 1)), seq: 0, acked: 0,
                               frameSeq: this.seats().map(() => -1), soundFresh: true };
    console.log(JSON.stringify({ msg: "join", player, game, claimed: issued !== null }));

    if (this.phase === "paused" && this.pause.player === player) this.resume();
    else if (this.phase === "playing") this.start();
    this.announce();
    if (this.missed?.player === player) {
      ws.send(JSON.stringify(this.missed.msg));
      this.missed = null;
    }
    if (this.machines) this.sendFrame(player);       // where the game stands
  }

  // The game this match plays, or null; sets this.n, its number of seats.
  game() {
    const id = this.sql.exec(SQL.getGame).toArray()[0]?.v;
    if (!id || !Object.hasOwn(GAMES, id)) return null;
    const { players, minPlayers } = GAMES[id];
    const chosen = Number(this.sql.exec(SQL.getSeats).toArray()[0]?.v ?? players);
    this.n = Number.isInteger(chosen) && chosen >= minPlayers && chosen <= players ? chosen : players;
    return id;
  }

  // The game's result rule, with the round wins this match's opener picked, if allowed.
  ruleFor(result) {
    if (!result?.bestAt) return result;
    const best = Number(this.sql.exec(SQL.getBest).toArray()[0]?.v);
    return result.bestChoices.includes(best) ? { ...result, best } : result;
  }

  seats() {
    return Array.from({ length: this.n }, (_, i) => i + 1);
  }

  setReady(ws, seat) {
    ws.serializeAttachment({ ...seat, ready: true });
    this.announce();
    if (!this.seats().every((p) => this.joined(p) && this.ready(p))) return;
    const game = this.game();
    if (game) this.newMatch(game);
  }

  // Fresh Game Boys, run past the menus at once if the game says how.
  newMatch(game) {
    const { module, result, start, link } = GAMES[game];
    const machines = this.machines = this.seats().map(() => new GameBoy(module));
    this.link = link === "adapter" || this.n > 2 ? new Adapter(machines)
      : { run: (cycles) => runLinked(machines[0], machines[1], cycles) };
    for (let f = 0; f < (start?.frames ?? 0); f++) {
      for (const [at, ...bits] of start.inputs) if (at === f) machines.forEach((m, i) => { m.buttons = bits[i] ?? 0; });
      this.link.run(FRAME_CYCLES);
    }
    this.buttons.fill(0);
    this.taps.fill(0);
    for (const m of this.machines) { m.buttons = 0; m.takeSound(); }
    this.rule = this.n === 2 ? this.ruleFor(result) : null;
    if (this.rule?.bestAt) for (const m of machines) m.u8[this.rule.bestAt] = this.rule.best;
    this.wins = [0, 0];
    this.overAt = 0;
    this.missed = null;
    this.budget.fill(PAUSE_BUDGET_MS);
    for (const ws of this.ctx.getWebSockets()) {
      const seat = ws.deserializeAttachment();
      if (seat?.ready) ws.serializeAttachment({ ...seat, ready: false });
    }
    for (const view of this.views) if (view) view.soundFresh = true;
    this.phase = "playing";
    console.log(JSON.stringify({ msg: "match_start", game, skipped: start?.frames ?? 0, best: this.rule?.best }));
    this.announce();
    this.start();
  }

  // Tells every phone who is here and ready, and what the match is doing.
  announce(except) {
    const seats = this.seats();
    const online = seats.map((p) => this.joined(p, except)), ready = seats.map((p) => this.ready(p, except));
    const pause = this.pause &&
      { player: this.pause.player, left: this.budget[this.pause.player - 1] - (Date.now() - this.pause.since) };
    for (const p of seats) {
      this.tell(p, { t: "lobby", phase: this.phase, online, ready, played: this.machines !== null, pause });
    }
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
    const now = Date.now();
    for (let n = 0; this.next <= now && n < MAX_CATCH_UP; n++) {
      this.link.run(FRAME_CYCLES);
      this.next += PERIOD;
      this.machines.forEach((m, i) => {
        if (this.taps[i]) { this.taps[i] = 0; m.buttons = this.buttons[i]; }
      });
    }
    if (this.next < now) this.next = now;           // fell behind: drop frames, don't spiral
    this.checkResult();
    this.dropSilent();
    if (this.phase !== "playing") return;            // someone went silent: paused or over
    const sound = this.machines.map((m) => m.takeSound());
    for (const player of this.seats()) {
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

  // Sends `player`'s phone what changed on every screen, its own first.
  sendFrame(player) {
    const own = this.machines[player - 1];
    if (own.trap && !own.trapSent) {
      own.trapSent = true;
      console.error(JSON.stringify({ msg: "trap", player, at: own.trap.at }));
      this.tell(player, { t: "trap", at: own.trap.at });
    }
    const view = this.views[player - 1];
    if (!view) return;
    const others = this.machines.map((_, i) => i).filter((i) => i !== player - 1);
    for (const screen of [player - 1, ...others]) {
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
      this.sql.exec(SQL.addResult, player, wins1, wins2, over ? 1 : 0, Date.now(), "game");
      console.log(JSON.stringify({ msg: "result", winner: player, wins: this.wins, over }));
      for (const p of this.seats()) this.tell(p, { t: "result", winner: player, wins: this.wins, best: this.rule.best, over });
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
