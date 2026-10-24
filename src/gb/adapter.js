// Nintendo's DMG-07 4-Player Adapter, between up to four translated Game Boys, as the
// published protocol describes it (Pan Docs "4-Player Adapter", Shonumi's Dan Docs, and
// bbbbbr's logic-analyzer notes from Den of Snakes). Plain ES module, no imports.
//
// The adapter is the only clock: every Game Boy waits on its external clock (FF02 = $80)
// and, each time the adapter shifts a byte, gets that byte in FF01 and its serial
// interrupt, while the adapter takes whatever the Game Boy had in FF01. So a Game Boy's
// answer to byte k is what it loads into FF01 after receiving byte k, and the adapter
// reads it during byte k + 1.
//
// Ping phase: to each port, packets of 4 bytes, 1.43 ms apart:
//   $FE, STAT, STAT, STAT     STAT = bits 4-7: ports with a Game Boy answering,
//                                    bits 0-2: the receiving port's player number, 1-4
// and each Game Boy answers $88 (to $FE), $88 (to the 1st STAT), RATE, SIZE. A port is
// connected while it answers $88, $88; STAT tells each packet what the one before saw. Packets start 12.2 ms + (RATE & 15) ms apart.
// Any Game Boy answering $AA instead starts the game: the packet after the one it
// answered $AA, $AA, $AA to is $CC x 4 to every port instead of a ping, and the
// transmission phase follows. (Its fourth $AA, in place of SIZE, comes with the first $CC.)
//
// Transmission phase: packets of 4 x SIZE bytes, SIZE (1-4) and RATE being player 1's
// last ping answers. In each packet, each Game Boy's block is its answers to the
// packet's first SIZE bytes; the next packet sends every port all four blocks, player 1
// first (an empty port's block is zeros; the first packet is all zeros). Bytes are
// 0.128 ms + (RATE >> 4) x 0.106 ms + 0.887 ms apart; packets start
// max(17 + (RATE & 15) ms, the bytes' time + 1 ms) apart.
// A Game Boy sending $FF for a whole packet's worth of bytes in a row ends it: every
// port gets one whole packet of $FF, then the ping phase starts again.

const MS = 4194304 / 1000;                // Game Boy cycles per millisecond
const PING_BYTE = 1.43 * MS;
const SLICE = 456;                        // one scanline: how long a byte may be late

export class Adapter {
  // ports: up to 4 GameBoys (machine.js), player 1 first; null or missing = empty port.
  constructor(ports) {
    this.ports = [0, 1, 2, 3].map((i) => ports[i] ?? null);
    this.now = 0;
    this.next = PING_BYTE;                // when the next byte is shifted
    this.ping();
  }

  ping() {
    this.mode = "ping";
    this.at = 0;                          // index of the next byte in the packet
    this.packetStart = this.next;
    this.connected = [false, false, false, false];
    this.answers = [[], [], [], []];      // this ping packet's answers so far, per port
    this.pingRate = this.pingRate ?? 0;
    this.rate = this.rate ?? 0;           // player 1's last RATE and SIZE answers
    this.size = this.size ?? 1;
  }

  // Runs every Game Boy for `cycles`, shifting bytes on the adapter's schedule.
  run(cycles) {
    for (let done = 0; done < cycles;) {
      const n = Math.max(1, Math.min(SLICE, cycles - done, Math.ceil(this.next - this.now)));
      for (const m of this.ports) m?.run(n);
      this.now += n;
      done += n;
      while (this.now >= this.next) this.shift();
    }
  }

  // Shifts one byte to every port and takes one from each.
  shift() {
    const out = this.outgoing();
    const back = this.ports.map((m, i) => (m ? swap(m, out[i]) : 0x00));
    this.receive(back);
  }

  outgoing() {
    if (this.mode === "ping") {
      if (this.at === 0) return [0xfe, 0xfe, 0xfe, 0xfe];
      const bits = this.connected.reduce((s, c, i) => s | (c ? 0x10 << i : 0), 0);
      return [1, 2, 3, 4].map((p) => bits | p);
    }
    if (this.mode === "start") return [0xcc, 0xcc, 0xcc, 0xcc];
    if (this.mode === "end") return [0xff, 0xff, 0xff, 0xff];
    const b = this.sending[this.at];
    return [b, b, b, b];
  }

  receive(back) {
    const at = this.at;
    if (this.mode === "ping") {
      // The answer to byte k arrives with byte k + 1: SIZE comes with the next $FE.
      for (let i = 0; i < 4; i++) {
        const a = this.answers[i];
        if (at === 0) {
          if (a.length === 3 && a[0] === 0x88 && a[1] === 0x88 && i === 0) {
            if (a[2]) this.rate = a[2];
            if (back[0] >= 1 && back[0] <= 4) this.size = back[0];
          }
          this.answers[i] = [];
        } else {
          a.push(back[i]);
          if (at === 3 && i === 0 && a[0] === 0x88 && a[1] === 0x88 && back[0]) this.pingRate = back[0];
        }
      }
      if (at === 3 && this.answers.some((a) => a.every((b) => b === 0xaa))) return this.startTransmission();
      if (at === 3) this.connected = this.answers.map((a) => a[0] === 0x88 && a[1] === 0x88);
      this.at = (at + 1) & 3;
      this.next += PING_BYTE;
      if (this.at === 0) {
        this.packetStart += (12.2 + (this.pingRate & 15)) * MS;
        this.next = Math.max(this.next, this.packetStart);
      }
      return;
    }
    if (this.mode === "start") {
      this.next += PING_BYTE;
      if (++this.at === 4) this.transmission();
      return;
    }
    const total = 4 * this.size;
    if (this.mode === "xfer") {
      for (let i = 0; i < 4; i++) {
        if (at >= 1 && at <= this.size) this.blocks[i * this.size + at - 1] = back[i];
        this.ff[i] = back[i] === 0xff ? this.ff[i] + 1 : 0;
      }
      if (this.ff.some((n) => n >= total)) {
        this.mode = "end";
        this.at = 0;
        this.next += this.byteGap;
        return;
      }
    }
    this.next += this.byteGap;
    if (++this.at < total) return;
    this.packetStart += this.packetTime;
    this.next = Math.max(this.next, this.packetStart);
    if (this.mode === "end") return this.ping();
    this.at = 0;
    this.sending = this.blocks;
    this.blocks = new Uint8Array(total);
  }

  // The $CC packet takes the place of the next ping packet, at its time.
  startTransmission() {
    this.mode = "start";
    this.at = 0;
    this.packetStart += (12.2 + (this.pingRate & 15)) * MS;
    this.next = Math.max(this.next + PING_BYTE, this.packetStart);
  }

  transmission() {
    const total = 4 * this.size, rate = this.rate;
    this.mode = "xfer";
    this.at = 0;
    this.byteGap = (0.128 + (rate >> 4) * 0.106 + 0.887) * MS;
    this.packetTime = Math.max((17 + (rate & 15)) * MS, this.byteGap * total + MS);
    this.sending = new Uint8Array(total);
    this.blocks = new Uint8Array(total);
    this.ff = [0, 0, 0, 0];
    this.packetStart += this.packetTime;         // one packet's time after the $CC packet
    this.next = Math.max(this.next, this.packetStart);
  }
}

// One byte through one port. A Game Boy waiting on the external clock swaps FF01 with
// the adapter and gets its serial interrupt. One that is not waiting shifts nothing:
// the adapter then reads its output line, the top bit of FF01, eight times.
function swap(m, byte) {
  if (m.trap) return 0x00;
  const u8 = m.u8;
  if ((u8[0xff02] & 0x81) !== 0x80) return u8[0xff01] & 0x80 ? 0xff : 0x00;
  const back = u8[0xff01];
  u8[0xff01] = byte;
  u8[0xff02] &= 0x7f;
  u8[0xff0f] |= 0x08;
  return back;
}
