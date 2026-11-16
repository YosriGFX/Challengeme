// client.test.mjs — the client's input thread (public/input-worker.js), run here with a
// fake WebSocket and a fake clock. It owns the socket: input only on change, reconnects,
// and the check for a dead socket when a phone wakes up.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { read } from './lib.mjs';

const source = read('public/input-worker.js').toString();

function worker() {
  const w = { sockets: [], out: [], timers: [], now: 0 };
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; w.sockets.push(this); }
    send(bytes) { this.sent.push([...bytes]); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({}); }
    open() { this.readyState = 1; this.onopen?.({}); }                 // the test plays the server
    packet(bytes = [2, 0, 0, 1]) { this.onmessage?.({ data: new Uint8Array(bytes).buffer }); }
    drop() { this.readyState = 3; this.onclose?.({}); }
  }
  const box = vm.createContext({
    WebSocket: FakeSocket, Uint8Array,
    postMessage: (m) => w.out.push(m.t),
    setTimeout: (fn, ms) => { const t = { fn, at: w.now + ms }; w.timers.push(t); return t; },
    clearTimeout: (t) => { w.timers = w.timers.filter((x) => x !== t); },
  });
  vm.runInContext(source, box);
  w.post = (m) => box.onmessage({ data: m });
  w.advance = (ms) => {                                               // let the fake clock run
    w.now += ms;
    for (;;) { const due = w.timers.filter((t) => t.at <= w.now).sort((a, b) => a.at - b.at)[0]; if (!due) break; w.timers = w.timers.filter((t) => t !== due); due.fn(); }
  };
  w.last = () => w.sockets[w.sockets.length - 1];
  return w;
}
const IN = 1, SYS = 2, RESYNC = 3;

test('input is sent only when it changes', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x/match/dama/R?t=1' });
  w.last().open();
  for (const b of [0x10, 0x10, 0x10, 0x00, 0x00, 0x18]) w.post({ t: 'in', b });
  assert.deepEqual(w.last().sent, [[IN, 0x10], [IN, 0x00], [IN, 0x18]]);
  w.post({ t: 'sys', c: 1 }); w.post({ t: 'resync' });
  assert.deepEqual(w.last().sent.slice(3), [[SYS, 1], [RESYNC]]);
});

test('a lost socket is reopened after a second, and a held button is sent again', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  w.last().open();
  w.post({ t: 'in', b: 0x18 });
  w.last().drop();
  assert.deepEqual(w.out, ['open', 'close']);
  w.advance(999); assert.equal(w.sockets.length, 1);
  w.advance(1); assert.equal(w.sockets.length, 2);
  w.last().open();
  assert.deepEqual(w.last().sent, [[IN, 0x18]], 'the server starts from "nothing pressed", so the held input is repeated');
});

test('nothing held: a new socket sends nothing', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  w.last().open();
  assert.deepEqual(w.last().sent, []);
});

test('leaving the match closes the socket and stops reconnecting', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  w.last().open();
  w.post({ t: 'close' });
  w.advance(5000);
  assert.equal(w.sockets.length, 1); assert.equal(w.last().readyState, 3);
  w.post({ t: 'wake' }); w.advance(5000);
  assert.equal(w.sockets.length, 1, 'a wake-up outside a match does nothing');
});

test('wake-up with a closed socket: reconnect at once, not after the retry delay', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  w.last().open(); w.last().drop();
  w.post({ t: 'wake' });
  assert.equal(w.sockets.length, 2);
  w.advance(3000);
  assert.equal(w.sockets.length, 2, 'and the old retry timer does not open a third one');
});

test('wake-up with a living socket: one RESYNC, answered, nothing else happens', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  w.last().open();
  w.post({ t: 'wake' });
  assert.deepEqual(w.last().sent, [[RESYNC]]);
  w.advance(100); w.last().packet();                                  // the full dump arrives
  w.advance(5000);
  assert.equal(w.sockets.length, 1); assert.equal(w.last().readyState, 1);
  assert.deepEqual(w.out, ['open', 'pkt']);
});

test('wake-up with a dead socket that still looks open: no answer in 2.5 s, reconnect', () => {
  const w = worker();
  w.post({ t: 'connect', url: 'ws://x' });
  const dead = w.last();
  dead.open();
  dead.close = function () { this.readyState = 2; };                  // a dead socket never finishes closing
  w.post({ t: 'wake' });
  w.advance(2499); assert.equal(w.sockets.length, 1);
  w.advance(1);
  assert.equal(w.sockets.length, 2, 'a new socket was opened');
  assert.deepEqual(w.out, ['open', 'close']);
  dead.packet();                                                      // a late packet from the old socket is ignored
  assert.deepEqual(w.out, ['open', 'close']);
  w.last().open(); w.last().packet();
  assert.deepEqual(w.out, ['open', 'close', 'open', 'pkt']);
});
