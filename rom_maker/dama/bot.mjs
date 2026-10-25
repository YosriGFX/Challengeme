// Plays Dama for a whole-match test: python3 tools/build.py dama --bot dama/bot.mjs --frames 100000 --shots ""
// Each player picks a random legal move from the game's own list (wFrom / wTo / wLen,
// and wLand for a capture's landings), walks its cursor (seen from its own side of the
// board) and presses A on the piece, then on each landing, or on the square of a plain
// move. Between games it presses START. setChooser(fn) lets a test pick the moves
// instead: fn(player, moves) gets { from, to, lands } and returns an index.
// Buttons: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B, 40 select, 80 start.
const GEN_DONE = 3, PHASE_PLAY = 1, PHASE_WAIT = 2, BLACK = 8;
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) / 16777216;
let choose = (player, moves) => Math.floor(random() * moves.length);
const plan = { 1: null, 2: null };   // per player: { targets, step }
let tap = { 1: 0, 2: 0 };            // the last frame each player pressed something

export function seedBot(n) { seed = n >>> 0 || 1; }
export function setChooser(fn) { choose = fn; }
export { random };

// The legal moves as the Game Boy of player p lists them.
export function movesOf(ram, p) {
  return Array.from({ length: ram(p, "wCount") }, (_, i) => {
    const len = ram(p, "wLen", i);
    const lands = Array.from({ length: len }, (_, k) => ram(p, "wLand", k * 64 + i));
    const caps = Array.from({ length: len }, (_, k) => ram(p, "wCap", k * 64 + i));
    return { from: ram(p, "wFrom", i), to: ram(p, "wTo", i), lands, caps };
  });
}

export default function bot({ frame, ram, press }) {
  if (frame < 40) return;                               // the start script does the handshake
  for (const p of [1, 2]) {
    press(p, 0);
    if (frame - tap[p] < 5) continue;                   // let go, and let the game see it
    const phase = ram(p, "wPhase");
    if (phase === PHASE_WAIT) {
      if (frame % 40 === p) { press(p, 0x80); tap[p] = frame; }
      plan[p] = null;
      continue;
    }
    if (phase !== PHASE_PLAY) continue;
    const black = ram(p, "wWhite") !== p;
    const mine = ram(p, "wSide") === (black ? BLACK : 0);
    if (!mine || ram(p, "wGenState") !== GEN_DONE) { plan[p] = null; continue; }
    if (!ram(p, "wCount")) continue;
    if (!plan[p] || plan[p].step >= plan[p].targets.length) {
      const moves = movesOf(ram, p);
      const m = moves[choose(p, moves)];
      plan[p] = { targets: [m.from, ...(m.lands.length ? m.lands : [m.to])], step: 0 };
    }
    const target = plan[p].targets[plan[p].step];
    const s = `wPl${p}`;
    const file = ram(p, s, 0), rank = ram(p, s, 1);
    const tf = (target - 21) % 10, tr = Math.floor((target - 21) / 10);
    let bits = 0;
    // From white's side: right = file + 1, up = rank + 1; black's side is turned around.
    if (tf !== file) bits |= (tf > file) !== black ? 0x01 : 0x02;
    if (tr !== rank) bits |= (tr > rank) !== black ? 0x04 : 0x08;
    if (!bits) {
      bits = 0x10;                                      // A on the piece, then on each square
      plan[p].step++;
    }
    press(p, bits);
    tap[p] = frame;
  }
}
