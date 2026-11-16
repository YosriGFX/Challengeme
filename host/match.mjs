// match.mjs — one running match: the CPU. It instantiates a cartridge and moves bytes
// between it and the players' sockets. Nothing else: it never looks inside a packet.
//
// The same file runs in the local simulator (Node.js) and inside a Cloudflare Durable
// Object, so it uses no API of either. A connection is any object with
// send(Uint8Array) and close().

const C_IN = 0x01, C_SYS = 0x02, C_RESYNC = 0x03;
const LOG_SEAT = 0, LOG_IN = 1, LOG_SYS = 2, LOG_MAX = 100000;

export class Match {
  // wasm: a WebAssembly.Module, or the bytes of one
  static async create(wasm) {
    const made = await WebAssembly.instantiate(wasm, {});
    return new Match(made.instance ?? made);
  }

  constructor(instance) {
    this.x = instance.exports;
    this.x.con_init();
    this.players = this.x.con_players();
    this.seats = new Array(this.players).fill(null);     // seat -> { id, conn }, conn = null while away
    this.watchers = new Set();                            // spectators: they share one view
    this.hz = 0;
    this.timer = null;
    this.onEmpty = null;                                  // called when the last connection has left
    this.ticks = 0;                                       // ticks since the match was made
    this.log = [];                                        // everything that went in: [tick, kind, seat, a, b]
  }

  // The match as a record: what went into the cartridge and on which tick, and a
  // fingerprint of what every player sees now. The cartridge is deterministic, so anyone
  // with the same .wasm can run the record again and must get the same fingerprint.
  // result: 255 while the match runs, then the winning seat, or the number of seats for a draw.
  record() { return { ticks: this.ticks, log: this.log, complete: this.log.length < LOG_MAX, digest: this.x.con_digest() >>> 0, result: this.x.con_result() }; }

  // Run a record again on a fresh cartridge. Returns the fingerprint it ends with.
  static async replay(wasm, rec) {
    const m = await Match.create(wasm);
    const run = (to) => { while (m.ticks < to) { m.x.con_tick(); m.ticks++; } };
    for (const [tick, kind, seat, a, b] of rec.log) {
      run(tick);
      if (kind === LOG_SEAT) m.x.con_presence(seat, a);
      else if (kind === LOG_IN) m.x.con_input(seat, a, b);
      else if (kind === LOG_SYS) m.x.con_sys(seat, a);
    }
    run(rec.ticks);
    return m.x.con_digest() >>> 0;
  }
  #note(kind, seat, a, b = 0) { if (this.log.length < LOG_MAX) this.log.push([this.ticks, kind, seat, a, b]); }

  // Seat a connection. `id` says who it is: the same id always gets its own seat back.
  // Returns the view: the seat number, or `players` for a spectator.
  join(conn, id) {
    let seat = this.seats.findIndex((s) => s && s.id === id);            // coming back
    if (seat < 0) seat = this.seats.findIndex((s) => !s);                // a seat nobody has had
    if (seat < 0) seat = this.seats.findIndex((s) => s && !s.conn);      // the seat of someone who left
    if (seat < 0) {
      conn.view = this.players;
      this.watchers.add(conn);
      this.#flush(true, conn);
      return conn.view;
    }
    const old = this.seats[seat]?.conn;
    if (old && old !== conn) { old.view = -1; try { old.close(); } catch {} }
    this.seats[seat] = { id, conn };
    conn.view = seat;
    this.x.con_presence(seat, 1);
    this.#note(LOG_SEAT, seat, 1);
    this.#flush(true, conn);
    return seat;
  }

  leave(conn) {
    if (conn.view === this.players) this.watchers.delete(conn);
    else if (conn.view >= 0 && this.seats[conn.view]?.conn === conn) {
      this.seats[conn.view].conn = null;
      this.x.con_presence(conn.view, 0);
      this.#note(LOG_SEAT, conn.view, 0);
      this.#flush(true);
    }
    conn.view = -1;
    if (this.isEmpty()) { this.#clock(0); this.onEmpty?.(); }
  }

  isEmpty() { return this.watchers.size === 0 && this.seats.every((s) => !s || !s.conn); }

  // A binary message from a client. Input is handled at once, never held for a tick.
  message(conn, bytes) {
    const seated = conn.view >= 0 && conn.view < this.players;
    if (bytes[0] === C_RESYNC) return this.#flush(true, conn);
    if (!seated || bytes.length < 2) return;
    const shown = bytes.length > 2 ? bytes[2] : 256;
    if (bytes[0] === C_IN) { this.x.con_input(conn.view, bytes[1], shown); this.#note(LOG_IN, conn.view, bytes[1], shown); }
    else if (bytes[0] === C_SYS) { this.x.con_sys(conn.view, bytes[1]); this.#note(LOG_SYS, conn.view, bytes[1]); }
    else return;
    this.#flush(true);
  }

  tick() { this.x.con_tick(); this.ticks++; this.#flush(false); }

  // Give every view what changed for it. mid: this is not the flush of a tick (the client
  // must not read the server's clock from when it arrives). `whole` is one connection that
  // gets a full dump.
  #flush(mid, whole = null) {
    for (let v = 0; v < this.players; v++) {
      const conn = this.seats[v]?.conn;
      if (conn) this.#send(v, [conn], conn === whole, mid);
    }
    if (this.watchers.size) this.#send(this.players, this.watchers, this.watchers.has(whole), mid);
    this.#clock(this.x.con_tick_hz());
  }

  #send(view, conns, full, mid) {
    const len = this.x.con_flush(view, (full ? 1 : 0) | (mid ? 2 : 0));
    if (!len) return;                                                    // nothing changed: nothing is sent
    const packet = new Uint8Array(this.x.memory.buffer, this.x.con_packet(), len).slice();
    for (const c of conns) { try { c.send(packet); } catch {} }
  }

  // The cartridge sets its own tick rate. At 0 there is no timer at all.
  #clock(hz) {
    if (this.isEmpty()) hz = 0;
    if (hz === this.hz) return;
    this.hz = hz;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!hz) return;
    const step = 1000 / hz;
    let due = Date.now() + step;
    this.timer = setInterval(() => {
      for (let n = 0; n < 5 && Date.now() >= due; n++) { this.tick(); due += step; }      // catch up, never spiral
      if (Date.now() - due > 250) due = Date.now() + step;
    }, Math.max(1, step / 2));
  }
}
