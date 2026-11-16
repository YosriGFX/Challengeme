// engine.test.mjs — the engine itself: wire protocol, client memory map, per-view streams,
// and the match host. No game rules here (see dama.test.mjs and carts.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart, PPU, conn, read, F, W, OP, IN } from './lib.mjs';
import { Match } from '../host/match.mjs';

const CARTS = ['dama', 'pong', 'flap', 'keys'];
// everything a client holds, region by region
const state = (ppu) => ({
  ops: ppu.ops.join(), strings: ppu.mem(ppu.x.ppu_strs(), 256).join(), palette: ppu.pal.join(),
  labels: ppu.mem(ppu.x.ppu_labels(), 24).join(), tick: ppu.tick, sounds: ppu.mem(ppu.x.ppu_sfx(), 128).join(),
  music: ppu.mem(ppu.x.ppu_music(), 4 * 131).join(), frame: ppu.frame,
});
const frame = [W.FRAME, 0, 0];

// ---------------------------------------------------------------- the stream
test('join: one full dump that sets up the whole client memory map', () => {
  for (const id of CARTS) {
    const g = new Cart(`dist/${id}.wasm`);
    const p = g.packet(0, 1);
    assert.deepEqual([...p.subarray(0, 4)], [W.FRAME, 0, 0, W.RESET], `${id}: tick stamp, then RESET`);
    assert.ok(p.length < 4096, `${id}: full dump is ${p.length} B`);
    const ppu = new PPU();
    const flags = ppu.apply(p);
    assert.equal(flags & F.ERROR, 0);
    assert.equal(flags & (F.DRAW | F.TRANS | F.RESET), F.DRAW | F.TRANS | F.RESET);
    assert.deepEqual(ppu.pal.slice(0, 3), [0, 0, 0], 'role 0 is black');
    assert.ok(ppu.pal.slice(3).some(Boolean), 'the palette arrived');
    assert.ok(ppu.count(OP.TEXT) > 0);
  }
});

test('an idle screen costs zero bytes', () => {
  for (const id of CARTS) {
    const g = new Cart(`dist/${id}.wasm`);
    g.join(0);                                                        // one player waiting for the other
    for (let i = 0; i < 100; i++) {
      assert.equal(g.x.con_flush(0, 0), 0, `${id}: nothing changed, nothing sent`);
      g.x.con_tick();
    }
  }
});

test('every packet starts with the tick it belongs to', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0); g.join(1);
  for (let i = 1; i <= 200; i++) {
    g.x.con_tick();
    const p = g.packet(0);
    if (!p) continue;
    assert.equal(p[0], W.FRAME);
    assert.equal(p[1] | (p[2] << 8), i);
    g.views[0].apply(p);
    assert.equal(g.views[0].frame, i);
  }
});

test('a small change is one slot: 14 bytes on the wire', () => {
  const g = new Cart('tests/build/six.wasm');
  g.join(0);
  g.x.con_tick();                                                     // six.c moves one line per tick
  const small = g.packet(0);
  assert.deepEqual([...small.subarray(3, 5)], [W.OPS_LIST, 1]);
  assert.equal(small.length, 3 + 2 + 9, 'FRAME + list header + one slot');
});

test('a big change is sent as a dirty mask', () => {
  const g = new Cart('dist/dama.wasm');
  const p = g.packet(0, 1);                                           // the whole board: far more than 32 slots
  let k = 3 + 1;                                                      // after FRAME and RESET
  assert.equal(p[k], W.BEGIN);
  while (p[k] !== W.END) k += p[k] === W.BEGIN ? 1 : p[k] === W.PAL ? 5 : p[k] === W.LABEL ? 10 : p[k] === W.TICK ? 2 : p[k] === W.SFXDEF ? 10 : 5 + p[k + 3] * 4;
  assert.equal(p[k + 1], W.OPS_MASK);
});

test('mask and list encode the same thing: 31 slots use the list, 32 use the mask', () => {
  const build = (n, useMask) => {
    const body = [];
    if (useMask) {
      const mask = new Uint8Array(32);
      for (let s = 0; s < n; s++) mask[(s * 7 % 256) >> 3] |= 1 << ((s * 7 % 256) & 7);
      body.push(W.OPS_MASK, ...mask);
      for (let s = 0; s < 256; s++) if (mask[s >> 3] & (1 << (s & 7))) body.push(OP.RECT, 0x21, s, 1, 2, 3, 0, 0);
    } else {
      body.push(W.OPS_LIST, n);
      for (let s = 0; s < n; s++) body.push(s * 7 % 256, OP.RECT, 0x21, s * 7 % 256, 1, 2, 3, 0, 0);
    }
    return new Uint8Array([...frame, ...body]);
  };
  const a = new PPU(), b = new PPU();
  assert.equal(a.apply(build(32, false)) & F.ERROR, 0);
  assert.equal(b.apply(build(32, true)) & F.ERROR, 0);
  assert.deepEqual([...a.ops], [...b.ops]);
  assert.ok(build(32, true).length < build(32, false).length, 'the mask is smaller from 32 slots');
  assert.ok(build(31, true).length >= build(31, false).length, 'the list is not larger below that');
});

// The property everything rests on: a client that received only deltas holds exactly the
// same memory as a client that just joined and received one full dump.
test('deltas and a full dump always agree (random play, all cartridges, all views)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
  for (const id of CARTS) {
    const g = new Cart(`dist/${id}.wasm`);
    g.join(0); g.join(1); g.join(2);
    for (let step = 0; step < 6000; step++) {
      const what = rnd(100);
      if (what < 60) g.tick();
      else if (what < 97) g.input(rnd(2), rnd(256));
      else if (what < 98) g.sys(rnd(2), 1);
      else if (what < 99) { const v = rnd(3); g.leave(v); g.join(v); }
      else g.input(rnd(2), 0);
      if (step % 250 === 249) {
        for (const v of [0, 1, 2]) {
          const fresh = new PPU();
          assert.equal(fresh.apply(g.packet(v, 1)) & F.ERROR, 0);
          assert.deepEqual([...g.views[v].ops], [...fresh.ops], `${id} view ${v} step ${step}: OP buffer`);
          for (let s = 0; s < 16; s++) assert.equal(g.views[v].str(s), fresh.str(s), `${id} view ${v}: string ${s}`);
          assert.deepEqual(g.views[v].pal, fresh.pal);
          for (const b of [2, 3, 4]) assert.equal(g.views[v].label(b), fresh.label(b), `${id} view ${v}: label ${b}`);
          assert.equal(g.views[v].tick, fresh.tick);
          g.views[v] = fresh;                                         // the cart now believes this view was just reset
        }
      }
    }
    assert.equal(g.errors, 0, `${id}: the PPU accepted every packet`);
    assert.ok(g.hz <= 60);
  }
});

test('no packet is ever larger than the wire limit, even a full dump of a full screen', () => {
  for (const id of [...CARTS.map((c) => `dist/${c}.wasm`), 'tests/build/six.wasm']) {
    const g = new Cart(id);
    for (let v = 0; v < g.players; v++) g.join(v);
    let max = 0;
    for (let i = 0; i < 2000; i++) {
      g.x.con_tick();
      if (i % 7 === 0) g.x.con_input(i % g.players, (i * 37) & 255);
      for (let v = 0; v <= g.players; v++) max = Math.max(max, g.x.con_flush(v, i % 50 === 0 ? 1 : 0));
    }
    assert.ok(max > 0 && max <= 4096, `${id}: largest packet ${max} B`);
  }
});

// ---------------------------------------------------------------- the client memory map
test('PPU: a malformed packet is dropped whole, nothing is half-applied', () => {
  const ppu = new PPU();
  const good = new Cart('dist/dama.wasm').packet(0, 1);
  assert.equal(ppu.apply(good) & F.ERROR, 0);
  const before = state(ppu);
  const op = [OP.RECT, 0x21, 1, 2, 3, 4, 0, 0];
  const bad = {
    'unknown record': [...frame, 0x7F],
    'unknown record after valid changes': [...frame, W.OPS_LIST, 1, 5, ...op, W.STR, 0, 2, 72, 73, 0x99],
    'truncated FRAME': [W.FRAME, 1],
    'OPS_LIST shorter than its count': [...frame, W.OPS_LIST, 3, 5, ...op],
    'OPS_MASK shorter than its mask': [...frame, W.OPS_MASK, ...new Array(32).fill(0xFF), ...op],
    'STR id out of range': [...frame, W.STR, 16, 1, 65],
    'STR too long': [...frame, W.STR, 0, 17, ...new Array(17).fill(65)],
    'STR truncated': [...frame, W.STR, 0, 5, 65, 66],
    'PAL outside a transition': [...frame, W.PAL, 1, 255, 0, 0],
    'PAL for role 0 (black)': [...frame, W.BEGIN, W.PAL, 0, 255, 255, 255, W.END],
    'PAL for role 8': [...frame, W.BEGIN, W.PAL, 8, 1, 2, 3, W.END],
    'LABEL outside a transition': [...frame, W.LABEL, 2, 65, 0, 0, 0, 0, 0, 0, 0],
    'LABEL for button 1 (HOME)': [...frame, W.BEGIN, W.LABEL, 1, 72, 79, 77, 69, 0, 0, 0, 0, W.END],
    'LABEL for button 5': [...frame, W.BEGIN, W.LABEL, 5, 65, 0, 0, 0, 0, 0, 0, 0, W.END],
    'TICK outside a transition': [...frame, W.TICK, 60],
    'TICK above 60 Hz': [...frame, W.BEGIN, W.TICK, 61, W.END],
    'SFXDEF outside a transition': [...frame, W.SFXDEF, 0, 0, 0, 60, 8, 0, 0, 5, 1],
    'SFXDEF id out of range': [...frame, W.BEGIN, W.SFXDEF, 16, 0, 0, 60, 8, 0, 0, 5, 1, W.END],
    'MUSDEF id out of range': [...frame, W.BEGIN, W.MUSDEF, 4, 10, 1, 4, 60, 0, 0, 0, W.END],
    'MUSDEF with too many steps': [...frame, W.BEGIN, W.MUSDEF, 0, 10, 33, 4, ...new Array(33 * 4).fill(60), W.END],
    'BEGIN without END': [...frame, W.BEGIN, W.TICK, 30],
    'END without BEGIN': [...frame, W.END],
    'SFX truncated': [...frame, W.SFX],
    'MUSIC truncated': [...frame, W.MUSIC, 1],
  };
  for (const [name, bytes] of Object.entries(bad)) {
    assert.equal(ppu.apply(new Uint8Array(bytes)) & F.ERROR, F.ERROR, name);
    const after = state(ppu);
    for (const region of Object.keys(before)) assert.equal(after[region], before[region], `${name}: ${region} untouched`);
  }
  assert.equal(ppu.apply(new Uint8Array(5000)), F.ERROR, 'a packet over the limit is refused');
});

test('PPU: random garbage never crashes it and never touches black', () => {
  const ppu = new PPU();
  let seed = 99;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 16; };
  const kinds = Object.values(W);
  let accepted = 0;
  for (let n = 0; n < 60000; n++) {
    const len = rnd() % 80;
    const p = new Uint8Array(len);
    for (let i = 0; i < len; i++) p[i] = rnd() % 4 ? rnd() & 255 : kinds[rnd() % kinds.length];
    const flags = ppu.apply(p);                                       // a trap here would throw
    if (!(flags & F.ERROR)) accepted++;
    assert.deepEqual(ppu.pal.slice(0, 3), [0, 0, 0]);
    assert.ok(ppu.tick <= 60);
  }
  assert.ok(accepted > 100, `${accepted} random packets happened to be valid`);
  for (let s = 0; s < 16; s++) assert.match(ppu.str(s), /^[\x20-\x7E]*$/, 'strings stay printable ASCII');
  for (const b of [2, 3, 4]) assert.match(ppu.label(b), /^[\x20-\x7E]*$/, 'labels stay printable ASCII');
});

test('PPU: transition regions change only at END, all at once', () => {
  const ppu = new PPU();
  const t = [...frame, W.BEGIN, W.PAL, 1, 10, 20, 30, W.LABEL, 2, 71, 79, 0, 0, 0, 0, 0, 0, W.TICK, 30, W.END];
  assert.equal(ppu.apply(new Uint8Array(t.slice(0, -1))) & F.ERROR, F.ERROR);   // no END: nothing
  assert.deepEqual(ppu.pal.slice(3, 6), [0, 0, 0]); assert.equal(ppu.tick, 0);
  const flags = ppu.apply(new Uint8Array(t));
  assert.equal(flags & (F.ERROR | F.TRANS), F.TRANS);
  assert.deepEqual(ppu.pal.slice(3, 6), [10, 20, 30]); assert.equal(ppu.label(2), 'GO'); assert.equal(ppu.tick, 30);
});

test('runtime: palette, labels, tick and sounds are ignored outside a transition', () => {
  // six.c only writes them inside transitions; a client never sees a stray record.
  const g = new Cart('tests/build/six.wasm');
  g.join(0);
  for (let i = 0; i < 50; i++) {
    g.x.con_tick(); g.x.con_input(0, i & 1 ? IN.A : 0);
    const p = g.packet(0);
    if (!p) continue;
    let inside = false;
    for (let k = 0; k < p.length;) {
      const t = p[k];
      if (t === W.BEGIN) inside = true;
      if (t === W.END) inside = false;
      if (t >= W.PAL && t <= W.MUSDEF) assert.ok(inside, 'a transition record outside BEGIN..END');
      k += t === W.FRAME ? 3 : t === W.OPS_LIST ? 2 + p[k + 1] * 9 : t === W.STR ? 3 + p[k + 2] : t === W.PAL ? 5 : t === W.LABEL ? 10 :
           t === W.TICK ? 2 : t === W.SFXDEF ? 10 : t === W.MUSDEF ? 5 + p[k + 3] * 4 : t === W.SFX ? 2 : t === W.MUSIC ? 3 : 1;
    }
  }
});

// ---------------------------------------------------------------- per-view streams
test('six seats: every player gets a private view, and a spectator gets a neutral one', () => {
  const g = new Cart('tests/build/six.wasm');
  assert.equal(g.players, 6);
  for (let v = 0; v <= 6; v++) g.join(v);
  for (let p = 0; p < 6; p++) {
    assert.equal(g.views[p].str(0), String(10 + p * 7).padStart(3, '0'), `player ${p + 1} sees their own number`);
    assert.equal(g.views[p].count(OP.CIRC), 6, 'and everybody at the table');
    assert.equal(g.views[p].op(11)[2], 20 + p * 36, 'and the frame around their own seat');
  }
  assert.equal(g.views[6].str(0), 'WATCHING');
  assert.equal(g.views[6].op(11)[0], OP.NOP);
});

test('six seats: a player\'s secret never travels to anyone else', () => {
  const g = new Cart('tests/build/six.wasm');
  for (let v = 0; v <= 6; v++) g.join(v);
  for (let round = 0; round < 20; round++) {
    const p = round % 6;
    const sizes = g.input(p, IN.A);                                   // changes only p's secret
    for (let v = 0; v <= 6; v++) {
      if (v === p) assert.ok(sizes[v] > 0); else assert.equal(sizes[v], 0, `view ${v} got bytes for player ${p + 1}'s change`);
    }
    assert.deepEqual(g.input(p, 0).filter(Boolean), [], 'the release changes nothing');
  }
  for (let p = 0; p < 6; p++) assert.equal(g.views[p].sfx.length, p < 2 ? 4 : 3, 'a sound for one view plays only there');
  g.tap(3, IN.B);
  for (let v = 0; v <= 6; v++) assert.equal(g.views[v].sfx.length, (v < 2 ? 4 : v < 6 ? 3 : 0) + 1, 'a sound for all views plays everywhere');
});

test('a transition reaches every view exactly once', () => {
  const g = new Cart('tests/build/six.wasm');
  for (let v = 0; v <= 6; v++) g.join(v);
  assert.equal(g.hz, 0);
  g.tap(2, IN.act(4));                                                // six.c: button 4 switches to 30 Hz
  assert.equal(g.hz, 30);
  for (let v = 0; v <= 6; v++) assert.equal(g.views[v].tick, 30, `view ${v}`);
  const sizes = g.flush();
  assert.deepEqual(sizes.filter(Boolean), [], 'and is not sent twice');
});

// ---------------------------------------------------------------- the match host
const wasm = (id) => read(`dist/${id}.wasm`);

test('host: two seats, then spectators who share one view', async () => {
  const m = await Match.create(wasm('dama'));
  const a = conn(), b = conn(), s1 = conn(), s2 = conn();
  assert.equal(m.join(a, 'A'), 0); assert.equal(m.join(b, 'B'), 1);
  assert.equal(m.join(s1, 'S1'), 2); assert.equal(m.join(s2, 'S2'), 2);
  assert.ok(a.ppu.texts().includes('YOUR TURN')); assert.ok(b.ppu.texts().includes('P1 TURN'));
  assert.ok(s1.ppu.texts().includes('P1 TURN'));
  assert.deepEqual([...s1.ppu.ops], [...s2.ppu.ops]);
  // a spectator cannot play
  const before = a.packets.length;
  m.message(s1, new Uint8Array([0x01, IN.A])); m.message(s1, new Uint8Array([0x02, 1]));
  assert.equal(a.packets.length, before);
  assert.ok(!a.ppu.texts().includes('YOU WIN'));
  for (const c of [a, b, s1, s2]) { assert.equal(c.errors, 0); m.leave(c); }
  assert.ok(m.isEmpty());
});

test('host: the same token gets its seat back with a full dump, and the old socket is closed', async () => {
  const m = await Match.create(wasm('dama'));
  const a = conn(), b = conn();
  m.join(a, 'A'); m.join(b, 'B');
  m.message(a, new Uint8Array([0x01, IN.R])); m.message(a, new Uint8Array([0x01, 0]));
  const a2 = conn();
  assert.equal(m.join(a2, 'A'), 0);
  assert.ok(a.closed, 'the old socket was closed');
  assert.equal(a2.packets[0][3], W.RESET);
  assert.deepEqual([...a2.ppu.ops], [...a.ppu.ops], 'the new socket sees the same picture');
  m.leave(a);                                                         // the old socket closing later must not free the seat
  assert.ok(!b.ppu.texts().includes('P1 IS AWAY'));
  m.leave(a2);
  assert.ok(b.ppu.texts().includes('P1 IS AWAY'));
  m.leave(b);
});

test('host: a player who left keeps the seat for their token; a stranger gets it only if nobody else is free', async () => {
  const m = await Match.create(wasm('dama'));
  const a = conn(), b = conn();
  m.join(a, 'A'); m.join(b, 'B');
  m.leave(b);
  const b2 = conn();
  assert.equal(m.join(b2, 'B'), 1, 'B comes back to seat 2');
  m.leave(a); m.leave(b2);
});

test('host: RESYNC answers with a full dump; junk messages are ignored', async () => {
  const m = await Match.create(wasm('pong'));
  const a = conn();
  m.join(a, 'A');
  const n = a.packets.length;
  m.message(a, new Uint8Array([0x03]));
  assert.equal(a.packets.length, n + 1); assert.equal(a.packets[n][3], W.RESET);
  for (const junk of [[], [0x01], [0x02], [0x09, 1, 2], [0xFF]]) m.message(a, new Uint8Array(junk));
  assert.equal(a.packets.length, n + 1);
  m.leave(a);
});

test('host: inputs are answered at once, without waiting for a tick', async () => {
  const m = await Match.create(wasm('dama'));
  const a = conn(), b = conn();
  m.join(a, 'A'); m.join(b, 'B');
  const n = a.packets.length;
  m.message(a, new Uint8Array([0x01, IN.R]));
  assert.equal(a.packets.length, n + 1, 'the cursor packet was sent inside the same call');
  m.leave(a); m.leave(b);
});

test('host: the timer follows the cartridge\'s tick rate and stops when the match is empty', async () => {
  const m = await Match.create(wasm('pong'));
  let empty = 0;
  m.onEmpty = () => empty++;
  const a = conn(), b = conn();
  m.join(a, 'A');
  assert.equal(m.hz, 0, 'waiting for player 2: no timer at all');
  m.join(b, 'B');
  assert.equal(m.hz, 60);
  let ticks = 0;
  const tick = m.tick.bind(m);
  m.tick = () => { ticks++; tick(); };
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 500));
  const hz = ticks / ((Date.now() - t0) / 1000);
  assert.ok(hz > 54 && hz < 66, `measured ${hz.toFixed(1)} Hz`);
  m.leave(a); m.leave(b);
  assert.equal(empty, 1); assert.equal(m.timer, null);
});
