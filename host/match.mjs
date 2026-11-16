// match.mjs — one running match: the "CPU". Host-agnostic.
//
// It instantiates a cartridge .wasm and only moves bytes between sockets and
// the cartridge. The same file runs in the local simulator (Node) and inside
// a Cloudflare Durable Object. No Node or Cloudflare APIs are used here.
//
// A connection is any object with send(Uint8Array) and close().

const C_IN = 0x01, C_SYS = 0x02, C_RESYNC = 0x03;

export class Match {
  // wasm: a WebAssembly.Module, or the bytes of one
  static async create(wasm) {
    const result = await WebAssembly.instantiate(wasm, {});
    return new Match(result.instance ?? result);
  }

  constructor(instance) {
    this.x = instance.exports;
    this.x.con_init();
    this.players = this.x.con_players();
    this.seats = new Array(this.players).fill(null);   // seat -> { conn, token }
    this.spectators = new Set();
    this.hz = 0;
    this.timer = null;
    this.onEmpty = null;
  }

  // Seat a connection. Returns the view index (seat number, or `players` for a spectator).
  join(conn, token) {
    let seat = this.seats.findIndex((s) => s && s.token === token);          // reconnect
    if (seat < 0) seat = this.seats.findIndex((s) => !s);                    // free seat
    if (seat < 0) seat = this.seats.findIndex((s) => s && !s.conn);          // seat of someone who left
    if (seat < 0) {
      conn.view = this.players;
      this.spectators.add(conn);
      this.#flush(new Set([conn]));
      return conn.view;
    }
    const old = this.seats[seat]?.conn;
    if (old && old !== conn) { old.view = -1; try { old.close(); } catch {} }
    this.seats[seat] = { conn, token };
    conn.view = seat;
    this.x.con_presence(seat, 1);
    this.#flush(new Set([conn]));
    return seat;
  }

  leave(conn) {
    if (conn.view === this.players) this.spectators.delete(conn);
    else if (conn.view >= 0 && this.seats[conn.view]?.conn === conn) {
      this.seats[conn.view].conn = null;
      this.x.con_presence(conn.view, 0);
      this.#flush();
    }
    if (this.isEmpty()) { this.#setTick(0); this.onEmpty?.(); }
  }

  isEmpty() { return this.spectators.size === 0 && this.seats.every((s) => !s || !s.conn); }

  // A binary message from a client. Inputs are processed immediately, never waiting for a tick.
  message(conn, bytes) {
    if (bytes.length < 1) return;
    const seated = conn.view >= 0 && conn.view < this.players;
    if (bytes[0] === C_IN && bytes.length >= 2 && seated) this.x.con_input(conn.view, bytes[1]);
    else if (bytes[0] === C_SYS && bytes.length >= 2 && seated) this.x.con_sys(conn.view, bytes[1]);
    else if (bytes[0] === C_RESYNC) return this.#flush(new Set([conn]));
    else return;
    this.#flush();
  }

  tick() { this.x.con_tick(); this.#flush(); }

  // Send every view its changes. Connections in `full` get a full dump instead.
  #flush(full = new Set()) {
    for (let v = 0; v < this.players; v++) {
      const conn = this.seats[v]?.conn;
      if (conn) this.#send(v, [conn], full.has(conn));
    }
    if (this.spectators.size) {
      const anyFull = [...this.spectators].some((c) => full.has(c));
      this.#send(this.players, this.spectators, anyFull);     // spectators share one view
    }
    this.#setTick(this.x.con_tick_hz());
  }

  #send(view, conns, full) {
    const len = this.x.con_flush(view, full ? 1 : 0);
    if (!len) return;
    const ptr = this.x.con_packet();
    const packet = new Uint8Array(this.x.memory.buffer, ptr, len).slice();   // copy out of wasm memory
    for (const c of conns) { try { c.send(packet); } catch {} }
  }

  // The cartridge sets its own tick rate (0 = event-only, no timer at all).
  #setTick(hz) {
    if (hz === this.hz) return;
    this.hz = hz;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (hz > 0) {
      const step = 1000 / hz;
      let next = Date.now() + step;
      this.timer = setInterval(() => {
        let n = 0;
        while (Date.now() >= next && n++ < 5) { this.tick(); next += step; }   // catch up, but never spiral
        if (Date.now() - next > 250) next = Date.now() + step;
      }, Math.max(1, Math.min(step, 1000) / 2));
    }
  }
}
