// browser.mjs — the whole console in real browsers: two emulated phones (touch screens)
// playing against each other. Optional: it needs Playwright (`npm i playwright`, or a
// global install). The other tests in tests/ need only Node.js.
//
//   node tests/e2e/browser.mjs                       starts its own simulators
//   node tests/e2e/browser.mjs http://localhost:8787 tests a server you started (e.g. wrangler dev)
//
// The phones are Chromium with an iPhone-sized touch screen. That is NOT Safari: zoom,
// audio unlock and frame pacing on a real iPhone still have to be tried by hand.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); }
catch { console.log('Playwright is not installed: skipping the browser tests (npm i playwright).'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const given = process.argv[2];
const sims = [];
function sim(port, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'host/sim.mjs')], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    sims.push(p);
    p.stdout.on('data', (d) => { if (String(d).includes('games:')) resolve('http://127.0.0.1:' + port); });
    p.on('exit', (code) => reject(new Error('simulator exited ' + code)));
  });
}
process.on('exit', () => { for (const p of sims) p.kill(); });
const port0 = 20000 + (process.pid * 7) % 20000;
const BASE = given || await sim(port0);
const JITTER = given ? null : await sim(port0 + 1, { JITTER_MS: '40' });

const browser = await chromium.launch();
const problems = [];
let passed = 0, failed = 0, roomN = Date.now() % 100000;
const ok = (cond, what) => { if (cond) { passed++; console.log('  ok   ' + what); } else { failed++; console.log('  FAIL ' + what); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) { passed++; console.log('  ok   ' + what); return v; }
    if (Date.now() - t0 > ms) { failed++; console.log('  FAIL ' + what); return null; }
    await sleep(50);
  }
}

// One phone: its own browser context, a touch screen, and helpers that talk to it the way
// fingers do (raw touch points, so two fingers at once are possible).
async function phone(base = BASE) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('page error: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) problems.push('console: ' + m.text()); });   // 404 = the leak checks below
  const cdp = await ctx.newCDPSession(page);
  const touches = new Map();
  const sync = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...touches].map(([id, p]) => ({ id, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 })) });
  const center = async (sel) => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; };
  const ph = {
    page, ctx, center,
    async down(id, x, y) { touches.set(id, { x, y }); await sync('touchStart'); },
    async move(id, x, y) { touches.set(id, { x, y }); await sync('touchMove'); },
    async up(id) { touches.delete(id); await sync(touches.size ? 'touchMove' : 'touchEnd'); },
    async tap(sel, hold = 40) { const c = await center(sel); await ph.down(1, c.x, c.y); await sleep(hold); await ph.up(1); await sleep(30); },
    // push the stick in a direction (dx, dy in -1..1) and let go
    async stick(dx, dy, hold = 60) { const c = await center('#stick'); await ph.down(2, c.x + dx * c.w * 0.3, c.y + dy * c.h * 0.3); await sleep(hold); await ph.up(2); await sleep(40); },
    state: () => page.evaluate(() => {
      const R = window.opDebug.mem, texts = [];
      const str = (id) => { let s = ''; for (let i = 0; i < 16 && R.strs[id * 16 + i]; i++) s += String.fromCharCode(R.strs[id * 16 + i]); return s; };
      for (let s = 0; s < 256; s++) if (R.ops[s * 8] === 7) texts.push(str(R.ops[s * 8 + 6] & 15));
      return { texts, byte: window.opDebug.byte, net: document.getElementById('net').textContent, stats: document.getElementById('stats').textContent,
               labels: [2, 3, 4].map((b) => document.getElementById('l' + b).textContent), home: !document.getElementById('home').hidden,
               lobby: !document.getElementById('lobby').hidden, scale: window.visualViewport ? window.visualViewport.scale : 1, settings: { ...window.opDebug.settings } };
    }),
    op: (slot) => page.evaluate((s) => Array.from(window.opDebug.mem.ops.subarray(s * 8, s * 8 + 8)), slot),
    lit: () => page.evaluate(() => {                 // how much of the game screen is not black
      const c = document.getElementById('lcd'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] | d[i + 1] | d[i + 2]) n++;
      return n / (d.length / 16);
    }),
    async start(cart, room) {
      await page.goto(`${base}/?room=${room}`);
      await page.waitForSelector('#carts button');
      await page.locator('#carts button', { hasText: cart }).tap();
    },
  };
  return ph;
}
const has = (ph, text) => async () => (await ph.state()).texts.includes(text);
const room = () => 'E' + (roomN++);

// ------------------------------------------------------------------ lobby and files
console.log('\nserver: ' + BASE + '\n\nlobby');
{
  const a = await phone();
  await a.page.goto(BASE + '/');
  await a.page.waitForSelector('#carts button');
  const names = await a.page.locator('#carts button').evaluateAll((els) => els.map((e) => e.firstChild.textContent));
  ok(['DAMA', 'PONG', 'FLAP', 'KEYS'].every((n) => names.includes(n)), 'the lobby lists the games from /api/carts: ' + names.join(' '));
  for (const leak of ['/ppu.c', '/ppu/ppu.c', '/sdk/console.h', '/sdk/runtime.c', '/carts/dama/dama.c', '/dist/dama.wasm', '/dama.wasm', '/worker/src/index.js', '/host/match.mjs', '/Makefile', '/tests/lib.mjs']) {
    const status = await a.page.evaluate(async (u) => { const r = await fetch(u); return r.status + ' ' + (r.headers.get('content-type') || ''); }, leak);
    // a server may answer a missing file with the client page; what matters is that no source comes back
    if (!/^404/.test(status) && !/text\/html/.test(status)) ok(false, `${leak} is served (${status})`);
  }
  ok(true, 'no source file, cartridge or test file is served');
  await a.ctx.close();
}

// ------------------------------------------------------------------ Dama by touch
console.log('\ndama, two phones');
{
  const r = room(), a = await phone(), b = await phone();
  await a.start('DAMA', r);
  await until(has(a, 'WAITING FOR P2'), 'player 1 waits alone');
  ok((await a.state()).net === 'ONLINE', 'player 1 is online');
  await b.start('DAMA', r);
  await until(has(a, 'YOUR TURN'), 'player 1: YOUR TURN');
  await until(has(b, 'P1 TURN'), 'player 2: P1 TURN');
  ok((await a.state()).labels.join() === 'RESIGN,DRAW,', 'button labels: RESIGN, DRAW');
  ok((await a.lit()) > 0.1 && (await b.lit()) > 0.1, 'both screens are drawn');

  const cursor = async (ph) => (await ph.op(146)).slice(2, 4).join();
  const c0 = await cursor(a);
  await a.stick(1, 0);
  ok((await cursor(a)) !== c0, 'a push on the stick moves the cursor one square');
  const c1 = await cursor(a);
  await a.stick(-1, 0);
  ok((await cursor(a)) === c0 && c1 !== c0, 'and back');
  const cb = await cursor(b);
  ok(cb === (await cursor(b)), 'player 2\'s cursor did not move');

  // hold the stick: the cursor repeats
  const s = await a.center('#stick');
  await a.down(2, s.x + s.w * 0.3, s.y);
  await sleep(900);
  await a.up(2);
  const far = Number((await cursor(a)).split(',')[0]);
  ok(far - Number(c0.split(',')[0]) >= 24 * 3, 'a held stick repeats (moved ' + (far - Number(c0.split(',')[0])) / 24 + ' squares in 0.9 s)');
  for (let i = 0; i < 8; i++) await a.stick(-1, 0, 30);

  // select the man on the cursor (row 5, column 0) and move it up-right
  await a.tap('#ba');
  ok((await a.op(145))[0] === 2, 'A selects the piece under the cursor');
  await a.stick(1, -1);
  await a.tap('#ba');
  await until(has(a, 'P2 TURN'), 'the move was played: P2 TURN on player 1');
  await until(has(b, 'YOUR TURN'), 'and YOUR TURN on player 2');

  // player 2 answers: their view is rotated, so the same gestures work
  await b.tap('#ba');
  await b.stick(1, -1);
  await b.tap('#ba');
  await until(has(a, 'YOUR TURN'), 'player 2 moved with the same gestures on their own (rotated) view');

  // two fingers at once: stick held, A tapped
  await a.down(2, s.x, s.y - s.h * 0.3);
  await sleep(60);
  const ba = await a.center('#ba');
  await a.down(3, ba.x, ba.y);
  await sleep(60);
  const both = (await a.state()).byte;
  await a.up(3); await a.up(2);
  ok((both & 0x18) === 0x18 && (both & 7) === 0, 'stick up + A at the same time: input byte 0x' + both.toString(16));
  ok((await a.state()).scale === 1 && (await a.state()).byte === 0, 'no zoom, and everything released');

  // roll a finger from B to A without lifting
  const bb = await a.center('#bb');
  await a.down(1, bb.x, bb.y); await sleep(50);
  const onB = (await a.state()).byte;
  for (let i = 1; i <= 6; i++) { await a.move(1, bb.x + (ba.x - bb.x) * i / 6, bb.y + (ba.y - bb.y) * i / 6); await sleep(15); }
  const onA = (await a.state()).byte;
  await a.up(1);
  ok(onB === 0x20 && onA === 0x10, `a finger sliding from B to A moves the press with it (0x${onB.toString(16)} -> 0x${onA.toString(16)})`);

  // HOME: opened by button 1, never reaches the cartridge, toggles answer every tap
  await a.tap('#b1');
  ok((await a.state()).home, 'HOME opens');
  await a.tap('#ba');
  ok((await a.state()).byte === 0, 'with HOME open the cartridge sees no input');
  const before = (await a.state()).settings.bright;
  for (let i = 0; i < 3; i++) await a.tap('#home [data-act="bright"]', 30);     // three quick taps
  const after = (await a.state()).settings.bright;
  ok(after === (before + 3) % 4, `three quick taps on BRIGHTNESS change it three times (${before} -> ${after})`);
  await a.tap('#home [data-act="bright"]');
  await a.tap('#home [data-act="resume"]');
  ok(!(await a.state()).home, 'RESUME closes HOME');

  // draw offer with button 3, resign from HOME
  await a.tap('#b3');
  await until(has(b, 'P1 OFFERS DRAW'), 'button 3 offers a draw');
  await a.tap('#bb');
  await b.tap('#b1');
  await b.page.locator('#home [data-act="resign"]').scrollIntoViewIfNeeded();
  await b.tap('#home [data-act="resign"]');
  await until(has(a, 'YOU WIN'), 'RESIGN in HOME ends the match (system message)');
  ok((await a.state()).labels.join() === 'REMATCH,,', 'the button label changed to REMATCH');
  await a.tap('#b2'); await b.tap('#b2');
  await until(has(a, 'YOUR TURN'), 'REMATCH by both players starts a new game');

  // back from the lock screen: the phone asks for a full dump to prove the socket is alive
  await a.tap('#ba'); await a.stick(1, -1); await a.tap('#ba');
  await until(has(b, 'YOUR TURN'), 'a move, then the phone "wakes up"');
  await b.page.evaluate(() => { window.__n = 0; const m = window.opDebug.mem; window.__f = m.ops.slice(); m.ops.fill(0); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => b.page.evaluate(() => window.opDebug.mem.ops.join() === window.__f.join()), 'a wake-up brings a full dump: the picture is whole again');
  ok((await b.state()).net === 'ONLINE', 'and the phone is still online in the same game');

  // leave: back to the lobby, the other player is told
  await b.tap('#b1');
  await b.page.locator('#home [data-act="leave"]').scrollIntoViewIfNeeded();
  await b.tap('#home [data-act="leave"]');
  ok((await b.state()).lobby, 'LEAVE MATCH returns to the lobby');
  await until(has(a, 'P2 IS AWAY'), 'the other player sees P2 IS AWAY');
  await b.start('DAMA', r);
  await until(has(b, 'YOUR TURN'), 'coming back gives the same seat and the same game');
  await a.ctx.close(); await b.ctx.close();
}

// ------------------------------------------------------------------ the 60 Hz games
for (const cart of ['PONG', 'FLAP', 'KEYS']) {
  console.log('\n' + cart.toLowerCase() + ', two phones');
  const r = room(), a = await phone(), b = await phone();
  await a.start(cart, r); await b.start(cart, r);
  await until(async () => /60 HZ/.test((await a.state()).stats), 'the match runs at 60 Hz on the client');
  await sleep(1200);
  const st = await a.state();
  ok(/BUF \d+ MS/.test(st.stats), 'smooth playback is on: ' + st.stats);
  ok((await a.lit()) > 0.005 && (await b.lit()) > 0.005, 'both screens are drawn');
  if (cart === 'PONG') {
    const x0 = (await a.op(10))[2];
    const s = await a.center('#stick');
    await a.down(2, s.x + s.w * 0.3, s.y); await sleep(400); await a.up(2);
    ok((await a.op(10))[2] > x0, 'the stick moves your paddle');
  }
  if (cart === 'FLAP') {
    await until(async () => !(await a.state()).texts.includes('GET READY'), 'GET READY, then the birds fly');
    let top = 255;
    for (let i = 0; i < 12; i++) { await a.tap('#ba', 15); top = Math.min(top, (await a.op(44))[3]); }
    ok(top < 90, 'A flaps: your bird climbs (highest y = ' + top + ')');
    ok((await b.op(40))[3] !== (await b.op(44))[3], 'the other phone sees your bird apart from its own');
  }
  if (cart === 'KEYS') {
    await a.tap('#ba');
    await until(has(a, 'MISS'), 'a press with no tile there is judged MISS');
  }
  await a.ctx.close(); await b.ctx.close();
}

// ------------------------------------------------------------------ smoothness on a bad network
// Ball movement per displayed frame in Pong, counted only while the ball is in play (not
// during READY, when it stands still on purpose). A frozen frame = the ball did not move;
// a jump = it moved more than twice its normal step.
async function smoothness(base, smooth) {
  const r = room(), a = await phone(base), b = await phone(base);
  await a.page.addInitScript((on) => { localStorage.setItem('op-console', JSON.stringify({ smooth: on })); }, smooth);
  await a.start('PONG', r); await b.start('PONG', r);
  await until(async () => /60 HZ/.test((await a.state()).stats), `pong is running (smooth ${smooth ? 'on' : 'off'})`);
  await sleep(1500);
  const res = await a.page.evaluate(() => new Promise((resolve) => {
    const o = window.opDebug.shown, live = window.opDebug.mem.ops, pos = [];
    let n = 0, buffer = 0;
    const step = () => {
      buffer = Math.max(buffer, window.opDebug.bufferMs);
      const inPlay = o[12 * 8] === 2 && live[12 * 8] === 2 && live[13 * 8] === 0;      // slot 13 = the READY text
      pos.push(inPlay ? [o[12 * 8 + 2], o[12 * 8 + 3]] : null);
      if (++n < 600) requestAnimationFrame(step); else {
        let frames = 0, frozen = 0, jumps = 0; const d = [];
        const steady = (i) => { for (let k = i - 8; k <= i + 8; k++) if (!pos[k]) return false; return true; };
        for (let i = 1; i < pos.length; i++) if (steady(i)) d.push(Math.hypot(pos[i][0] - pos[i - 1][0], pos[i][1] - pos[i - 1][1]));
        const sorted = [...d].sort((x, y) => x - y), median = sorted[sorted.length >> 1] || 1;
        for (const v of d) { frames++; if (v < median * 0.15) frozen++; else if (v > median * 2.2) jumps++; }
        resolve({ frames, frozen: frozen / frames, jumps: jumps / frames, buffer });
      }
    };
    requestAnimationFrame(step);
  }));
  await a.ctx.close(); await b.ctx.close();
  return res;
}
if (JITTER) {
  console.log('\nsmooth playback, packets delayed 0 to 40 ms at random');
  const off = await smoothness(JITTER, false), on = await smoothness(JITTER, true);
  const pct = (v) => (v * 100).toFixed(1) + '%';
  console.log(`  smooth off: frozen ${pct(off.frozen)}  jumps ${pct(off.jumps)}  (${off.frames} frames)`);
  console.log(`  smooth on : frozen ${pct(on.frozen)}  jumps ${pct(on.jumps)}  (${on.frames} frames, buffer ${Math.round(on.buffer)} ms)`);
  ok(on.frames > 100 && off.frames > 100, 'enough frames measured');
  ok(on.frozen < 0.05 && on.jumps < 0.05, 'with smooth playback under 5% of frames freeze or jump');
  ok(on.frozen + on.jumps < (off.frozen + off.jumps) / 3, 'and it is at least 3 times better than without');
  ok(on.buffer > 10 && on.buffer < 120, 'the display buffer stays small');
}

await browser.close();
for (const p of sims) p.kill();
for (const p of [...new Set(problems)]) { failed++; console.log('  FAIL ' + p); }
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
