// carts.test.mjs — Pong, Flap and Keys played from start to finish by small bots.
// A bot sees only what its own PPU holds (its own view) and answers with the input byte,
// exactly like a player. Fairness as the console defines it is checked too: both players
// always get the same generated content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart, OP, IN } from './lib.mjs';

const find = (v, opcode, from = 0, to = 256) => { for (let s = from; s < to; s++) { const o = v.op(s); if (o[0] === opcode) return o; } return null; };
const slots = (v, from, to) => v.ops.slice(from * 8, to * 8).join();

// ---------------------------------------------------------------- PONG
// slots: 0-7 center line, 8-9 scores, 10 player 1's paddle, 11 player 2's paddle, 12 ball
function pongBot(g, p) {
  const v = g.views[p], ball = v.op(12), pad = v.op(10 + p);
  if (ball[0] !== OP.CIRC) return 0;
  const d = ball[2] - (pad[2] + 20);
  return d > 3 ? IN.R : d < -3 ? IN.L : 0;
}

test('pong: waits for two players with no timer, then runs at 60 Hz', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0);
  assert.equal(g.hz, 0);
  assert.ok(g.views[0].texts().includes('WAITING FOR P2'));
  g.join(1);
  assert.equal(g.hz, 60); assert.equal(g.views[0].tick, 60);
  assert.ok(g.views[0].texts().includes('READY'));
});

test('pong: each player sees their own paddle at the bottom, and the same ball mirrored', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0); g.join(1);
  assert.equal(g.views[0].op(10)[3], 236); assert.equal(g.views[1].op(11)[3], 235);
  assert.ok(g.views[0].op(11)[3] < 30 && g.views[1].op(10)[3] < 30, 'the rival is at the top');
  let seen = 0;
  for (let i = 0; i < 600; i++) {
    g.input(0, pongBot(g, 0)); g.input(1, pongBot(g, 1));
    g.tick();
    const a = g.views[0].op(12), b = g.views[1].op(12);
    if (a[0] !== OP.CIRC) continue;
    assert.deepEqual([b[2], b[3]], [255 - a[2], 255 - a[3]]);
    seen++;
  }
  assert.ok(seen > 400);
  // stick right moves your paddle to your right, for both players
  for (const p of [0, 1]) {
    const x0 = g.views[p].op(10 + p)[2];
    g.input(p, IN.R); g.tick(5); g.input(p, 0);
    assert.ok(g.views[p].op(10 + p)[2] > x0 || x0 >= 215, `player ${p + 1}`);
  }
});

test('pong: a full match to 5, then REMATCH needs both players', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0); g.join(1);
  let ticks = 0;
  while (g.hz && ticks < 60 * 300) {
    g.input(0, pongBot(g, 0));                                        // player 2 never moves
    g.tick();
    ticks++;
  }
  assert.equal(g.hz, 0, `the match ended (after ${ticks} ticks)`);
  assert.equal(g.views[0].str(0), '5'); assert.ok(Number(g.views[0].str(1)) < 5);
  assert.ok(g.views[0].texts().includes('YOU WIN')); assert.ok(g.views[1].texts().includes('YOU LOSE'));
  assert.equal(g.views[0].label(2), 'REMATCH');
  assert.ok(g.views[0].sfx.length > 5, 'paddle, wall and point sounds were sent');
  g.tap(0, IN.act(2));
  assert.equal(g.hz, 0);
  assert.ok(g.views[0].texts().includes('REMATCH SENT')); assert.ok(g.views[1].texts().includes('REMATCH?'));
  g.tap(1, IN.act(2));
  assert.equal(g.hz, 60); assert.equal(g.views[0].str(0), '0'); assert.equal(g.views[0].label(2), '');
  assert.equal(g.errors, 0);
});

test('pong: a moving ball costs one slot per frame (14 bytes)', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0); g.join(1);
  g.tick(70);                                                         // past READY
  const sizes = [];
  for (let i = 0; i < 20; i++) sizes.push(g.tick()[0]);
  assert.ok(sizes.filter((n) => n === 14).length >= 15, `frame sizes: ${sizes.join(' ')}`);
});

test('pong: resign from HOME ends the match for the other player', () => {
  const g = new Cart('dist/pong.wasm');
  g.join(0); g.join(1);
  g.tick(100); g.sys(1, 1);
  assert.ok(g.views[0].texts().includes('YOU WIN')); assert.equal(g.hz, 0);
});

// ---------------------------------------------------------------- FLAP
// slots: 10-25 pipes (4 per pipe: top, lip, bottom, lip), 40-43 rival bird, 44-47 your bird
function flapBot(g, p, last) {
  const v = g.views[p], me = v.op(44);
  if (me[0] !== OP.CIRC) return 0;
  let best = null;
  for (let k = 0; k < 4; k++) {                                       // the nearest pipe not yet behind the bird
    const top = v.op(10 + k * 4), bot = v.op(12 + k * 4);
    if (bot[0] !== OP.RECT) continue;
    const x = bot[2];
    if (x + 26 < 72) continue;
    if (!best || x < best.x) best = { x, mid: ((top[0] === OP.RECT ? top[5] : 0) + bot[3]) / 2 };
  }
  const target = best ? best.mid : 110;
  return me[3] > target + 8 && !last ? IN.A : 0;
}

test('flap: both players fly through the same pipes at the same time', () => {
  const g = new Cart('dist/flap.wasm');
  g.join(0); g.join(1);
  assert.equal(g.hz, 60);
  let last = [0, 0], frames = 0;
  for (let i = 0; i < 1500 && g.hz; i++) {
    for (const p of [0, 1]) { last[p] = flapBot(g, p, last[p]); g.input(p, last[p]); }
    g.tick();
    assert.equal(slots(g.views[0], 10, 26), slots(g.views[1], 10, 26), `tick ${i}: the pipes are the same`);
    if (find(g.views[0], OP.RECT, 10, 26)) frames++;
  }
  assert.ok(frames > 1000, 'pipes were on screen');
  assert.ok(Number(g.views[0].str(0).slice(3)) >= 5, `both bots are still flying: ${g.views[0].str(0)} / ${g.views[0].str(1)}`);
  assert.equal(g.views[0].str(0), g.views[1].str(0));
  assert.equal(g.errors, 0);
});

test('flap: each pipe passed is a point; the match ends when the survivor leads', () => {
  const g = new Cart('dist/flap.wasm');
  g.join(0); g.join(1);
  let last = [0, 0], ticks = 0;
  const score = (p) => Number(g.views[0].str(p).slice(3));
  while (g.hz && ticks++ < 60 * 120) {
    last[0] = flapBot(g, 0, last[0]); g.input(0, last[0]);
    last[1] = score(1) < 4 ? flapBot(g, 1, last[1]) : 0;              // player 2 stops flapping after 4 pipes
    g.input(1, last[1]);
    g.tick();
  }
  assert.equal(g.hz, 0, 'the match ended');
  assert.equal(score(1), 4);
  assert.equal(score(0), 5, 'it ended as soon as the survivor passed one more pipe');
  assert.ok(g.views[0].texts().includes('YOU WIN')); assert.ok(g.views[1].texts().includes('YOU LOSE'));
  assert.equal(g.views[1].label(2), 'REMATCH');
});

test('flap: your own flap is not echoed back as a sound, the rival\'s is', () => {
  const g = new Cart('dist/flap.wasm');
  g.join(0); g.join(1);
  g.tick(101);                                                        // GET READY, then GO
  const before = [g.views[0].sfx.length, g.views[1].sfx.length];
  g.tap(0, IN.A);
  assert.equal(g.views[0].sfx.length, before[0], 'the player who flapped hears their own click locally');
  assert.equal(g.views[1].sfx.length, before[1] + 1);
});

test('flap: new pipes every match', () => {
  const g = new Cart('dist/flap.wasm');
  g.join(0); g.join(1);
  const pipes = () => { g.tick(260); return slots(g.views[0], 10, 26); };
  const first = pipes();
  g.sys(0, 1);
  g.tap(0, IN.act(2)); g.tap(1, IN.act(2));
  assert.equal(g.hz, 60);
  assert.notEqual(pipes(), first);
});

// ---------------------------------------------------------------- KEYS
// slots: 10-39 tiles. A tile on the hit line is 18 units tall with its center at y = 214.
const LANE_X = [44, 100, 156, 212];
const LANE_IN = [IN.L, IN.R, IN.B, IN.A];
function keysBot(g, p) {
  const v = g.views[p];
  let byte = 0;
  for (let s = 10; s < 40; s++) {
    const o = v.op(s);
    if (o[0] !== OP.RECT || ((o[1] >> 3) & 3) !== 3) continue;        // full brightness = still to hit
    if (o[3] + o[5] / 2 < 213) continue;                              // not on the line yet
    const lane = LANE_X.findIndex((x) => Math.abs(o[2] + o[4] / 2 - x) < 14);
    if (lane >= 0) byte |= LANE_IN[lane];
  }
  return byte;
}

test('keys: both players get the same song at the same time', () => {
  const g = new Cart('dist/keys.wasm');
  g.join(0); g.join(1);
  let tiles = 0;
  for (let i = 0; i < 1500; i++) {
    g.tick();
    assert.equal(slots(g.views[0], 10, 40), slots(g.views[1], 10, 40), `tick ${i}`);
    if (find(g.views[0], OP.RECT, 10, 40)) tiles++;
  }
  assert.ok(tiles > 1000);
});

test('keys: hitting every tile on the line wins, and every hit plays its note only for you', () => {
  const g = new Cart('dist/keys.wasm');
  g.join(0); g.join(1);
  let ticks = 0, perfect = 0, combo = 0, held = 0;
  while (g.hz && ticks++ < 60 * 90) {
    const want = held ? 0 : keysBot(g, 0);                            // press for one tick, then let go
    if (want !== held) { g.input(0, want); held = want; }
    g.tick();
    if (g.views[0].texts().includes('PERFECT')) perfect++;
    combo = Math.max(combo, Number(g.views[0].str(1).slice(1)) || 0);
  }
  assert.equal(g.hz, 0, 'the song ended');
  const mine = Number(g.views[0].str(0)), rival = g.views[1].str(0);
  assert.ok(mine > 200, `score ${mine}`);
  assert.equal(rival, '0000', 'the idle player scored nothing');
  assert.ok(perfect > 100); assert.ok(combo >= 30, `best combo ${combo}`);
  assert.ok(g.views[0].texts().includes('YOU WIN')); assert.ok(g.views[1].texts().includes('YOU LOSE'));
  const notes = g.views[0].sfx.filter((id) => id < 8).length;
  assert.ok(notes > 50, `${notes} notes played for the player who hit them`);
  assert.equal(g.views[1].sfx.filter((id) => id < 8).length, 0, 'and none for the other player');
  assert.equal(g.errors, 0);
});

test('keys: pressing with nothing there is a miss and breaks the combo', () => {
  const g = new Cart('dist/keys.wasm');
  g.join(0); g.join(1);
  g.tick(30);
  g.tap(0, IN.A);
  assert.ok(g.views[0].texts().includes('MISS'));
  assert.ok(!g.views[1].texts().includes('MISS'), 'your judgement is yours alone');
  assert.equal(g.views[0].str(0), '0000');
});

test('keys: a new song every match', () => {
  const g = new Cart('dist/keys.wasm');
  g.join(0); g.join(1);
  const song = () => { let s = ''; for (let i = 0; i < 600; i++) { g.tick(); s += slots(g.views[0], 10, 40).length + ','; } return s; };
  const first = song();
  g.sys(0, 1);
  g.tap(0, IN.act(2)); g.tap(1, IN.act(2));
  assert.equal(g.hz, 60);
  assert.notEqual(song(), first);
});
