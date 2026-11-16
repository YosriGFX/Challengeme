// dama.test.mjs — the Dama rules, checked on set-up positions.
//
// The rules under test are the ones listed at the top of carts/dama/dama.c. Every move
// goes in through the real input byte (cursor + A), and every result is read back either
// from the board or from what a player's PPU would draw.
//
// Board: row 0 is player 2's back row, row 7 is player 1's. In the diagrams
//   w = player 1 man, W = player 1 king, b = player 2 man, B = player 2 king, . = empty
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart, IN, OP } from './lib.mjs';

const PIECE = { '.': 0, w: 1, b: 2, W: 3, B: 4 };
const S_PLAY = 1, S_OVER = 2, DRAW = 2;
const P1 = 0, P2 = 1;

// A running game with both players seated and the given position on the board.
function game(rows, side = P1) {
  const g = new Cart('tests/build/dama_test.wasm');
  g.join(0); g.join(1); g.join(2);                                   // two players and a spectator
  if (rows) {
    g.x.t_clear();
    rows.forEach((line, r) => [...line].forEach((ch, c) => {
      assert.ok(ch in PIECE, `bad piece "${ch}"`);
      if (PIECE[ch]) assert.equal((r + c) & 1, 1, `(${r},${c}) is a light square`);
      g.x.t_set(r, c, PIECE[ch]);
    }));
    g.x.t_start(side);
    g.flush();
  }
  return g;
}
const at = (g, r, c) => g.x.t_get(r, c);
const pressA = (g, p, r, c) => { g.x.t_cursor(p, r, c); g.tap(p, IN.A); };
// Play a move through the controller: select the piece, then every square it lands on.
function move(g, p, ...squares) { for (const [r, c] of squares) pressA(g, p, r, c); }
// A move that the rules must refuse: nothing on the board changes and the turn stays.
function refused(g, p, from, to) {
  const before = board(g), turn = g.x.t_turn();
  move(g, p, from, to);
  assert.equal(board(g), before, `move ${from} -> ${to} must be refused`);
  assert.equal(g.x.t_turn(), turn);
  g.tap(p, IN.B);                                                    // drop the selection
}
function board(g) {
  let s = '';
  for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) s += '.wbWB'[at(g, r, c)]; s += '\n'; }
  return s;
}
const count = (g, ...kinds) => [...board(g)].filter((ch) => kinds.includes(ch)).length;

test('start: 12 men each on the dark squares, player 1 moves first, clocks at 5:00', () => {
  const g = game();
  assert.equal(count(g, 'w'), 12); assert.equal(count(g, 'b'), 12); assert.equal(count(g, 'W', 'B'), 0);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (at(g, r, c)) assert.equal((r + c) & 1, 1);
  assert.equal(g.x.t_state(), S_PLAY); assert.equal(g.x.t_turn(), P1);
  assert.equal(g.x.t_clock(0), 300); assert.equal(g.x.t_clock(1), 300);
  assert.deepEqual([g.views[0].str(4), g.views[0].str(5)], ['5:00', '5:00']);
});

test('a man moves one square diagonally forward, for both players', () => {
  const g = game(['.b......', '........', '........', '........', '........', '..w.....', '........', '........']);
  move(g, P1, [5, 2], [4, 3]);
  assert.equal(at(g, 4, 3), 1); assert.equal(at(g, 5, 2), 0); assert.equal(g.x.t_turn(), P2);
  move(g, P2, [0, 1], [1, 2]);                                        // player 2 moves down the board
  assert.equal(at(g, 1, 2), 2); assert.equal(g.x.t_turn(), P1);
});

test('a man cannot move backward, sideways, straight, or two squares', () => {
  const g = game(['.b......', '........', '........', '........', '...w....', '........', '........', '........']);
  refused(g, P1, [4, 3], [5, 2]); refused(g, P1, [4, 3], [5, 4]);     // backward
  refused(g, P1, [4, 3], [4, 5]); refused(g, P1, [4, 3], [3, 3]);     // sideways, straight
  refused(g, P1, [4, 3], [2, 5]); refused(g, P1, [4, 3], [2, 1]);     // two squares with nothing to take
});

test('a player cannot move out of turn or move the other side\'s pieces', () => {
  const g = game(['.b......', '........', '........', '........', '........', '..w.....', '........', '........']);
  refused(g, P2, [0, 1], [1, 2]);                                     // not player 2's turn
  refused(g, P1, [0, 1], [1, 2]);                                     // not player 1's piece
});

test('a man captures forward', () => {
  const g = game(['.b......', '........', '........', '........', '...b....', '..w.....', '........', '........']);
  move(g, P1, [5, 2], [3, 4]);
  assert.equal(at(g, 3, 4), 1); assert.equal(at(g, 4, 3), 0); assert.equal(count(g, 'b'), 1);
});

test('a man captures backward', () => {
  const g = game(['.b......', '........', '........', '..w.....', '...b....', '........', '........', '........']);
  move(g, P1, [3, 2], [5, 4]);
  assert.equal(at(g, 5, 4), 1); assert.equal(at(g, 4, 3), 0); assert.equal(count(g, 'b'), 1);
});

test('a man cannot jump its own piece, or an enemy with no empty square behind it', () => {
  const g = game(['.b......', '........', '........', '......b.', '.....b..', '....w...', '.w......', 'w.......']);
  assert.equal(g.x.t_need(), 0);
  refused(g, P1, [7, 0], [5, 2]);                                     // over its own man
  refused(g, P1, [5, 4], [3, 6]);                                     // the square behind is taken
});

test('capturing is forced: other moves are refused and other pieces are locked', () => {
  const g = game(['.b......', '........', '........', '........', '...b....', '..w...w.', '........', '........']);
  assert.equal(g.x.t_need(), 1);
  assert.equal(g.x.t_movable(5, 2), 1); assert.equal(g.x.t_movable(5, 6), 0);
  refused(g, P1, [5, 6], [4, 7]);                                     // a free move with another piece
  refused(g, P1, [5, 2], [4, 1]);                                     // a free move with the capturing piece
  move(g, P1, [5, 2], [3, 4]);
  assert.equal(at(g, 4, 3), 0);
});

test('the longest capture is forced: between two pieces', () => {
  const g = game(['.b......', '........', '.....b..', '........', '.b...b..', 'w...w...', '........', '........']);
  assert.equal(g.x.t_need(), 2);
  assert.equal(g.x.t_movable(5, 0), 0, 'the piece that can take only one is locked');
  assert.equal(g.x.t_movable(5, 4), 1);
  refused(g, P1, [5, 0], [3, 2]);
  move(g, P1, [5, 4], [3, 6], [1, 4]);
  assert.equal(count(g, 'b'), 2); assert.equal(at(g, 1, 4), 1); assert.equal(g.x.t_turn(), P2);
});

test('the longest capture is forced: between two routes of the same piece', () => {
  const g = game(['.b......', '........', '.....b..', '........', '.b.b....', '..w.....', '........', '........']);
  assert.equal(g.x.t_need(), 2);
  refused(g, P1, [5, 2], [3, 0]);                                     // this route takes only one
  move(g, P1, [5, 2], [3, 4], [1, 6]);
  assert.equal(count(g, 'b'), 2); assert.equal(at(g, 4, 1), 2, 'the piece on the short route is still there');
});

test('kings count as one piece when choosing the longest capture', () => {
  // left: one king to take. right: two men to take. Two men is more than one king.
  const g = game(['.b......', '........', '.....b..', '........', '.B...b..', 'w...w...', '........', '........']);
  assert.equal(g.x.t_need(), 2);
  assert.equal(g.x.t_movable(5, 0), 0); assert.equal(g.x.t_movable(5, 4), 1);
  refused(g, P1, [5, 0], [3, 2]);
});

test('jumped pieces stay on the board until the move ends, then all come off', () => {
  const g = game(['.b......', '........', '.....b..', '........', '.....b..', '....w...', '........', '........']);
  move(g, P1, [5, 4], [3, 6]);                                        // first jump of two
  assert.equal(at(g, 4, 5), 2, 'the jumped man is still on the board');
  assert.equal(g.x.t_taken(4, 5), 1);
  assert.equal(g.x.t_turn(), P1, 'the turn has not passed'); assert.equal(g.x.t_chain(), 1);
  assert.ok(g.views[0].texts().includes('TAKE AGAIN'));
  // while it waits, the jumped piece is drawn dimmed (25%) for both players
  const slot = 33 + 4 * 4 + (5 >> 1);
  assert.equal((g.views[0].op(slot)[1] >> 3) & 3, 0);
  pressA(g, P1, 1, 4);                                                // second jump ends the move
  assert.equal(at(g, 4, 5), 0); assert.equal(at(g, 2, 5), 0);
  assert.equal(count(g, 'b'), 1); assert.equal(g.x.t_turn(), P2);
});

test('during a capture sequence the same piece must go on: no other piece, no cancel', () => {
  const g = game(['.b......', '........', '.....b..', '........', '.....b..', '....w.w.', '........', '........']);
  move(g, P1, [5, 4], [3, 6]);
  g.tap(P1, IN.B);                                                    // B must not cancel the sequence
  pressA(g, P1, 5, 6);                                                // another piece must not be selectable
  assert.equal(g.x.t_chain(), 1); assert.equal(g.x.t_turn(), P1);
  pressA(g, P1, 1, 4);
  assert.equal(at(g, 1, 4), 1); assert.equal(g.x.t_turn(), P2);
});

test('a piece cannot be jumped twice', () => {
  // The king could go back and forth over the same man for ever if that were allowed.
  const g = game(['.......b', '........', '........', '........', '.b......', 'W.......', '........', '........']);
  assert.equal(g.x.t_need(), 1);
  move(g, P1, [5, 0], [3, 2]);
  assert.equal(g.x.t_turn(), P2, 'the move ended after one capture');
  assert.equal(at(g, 4, 1), 0); assert.equal(count(g, 'b'), 1);
});

test('a jumped piece still blocks the way', () => {
  // The king on (4,3) has a man on each side on one diagonal. If a jumped man left the
  // board at once, the king could take one, fly back through its square and take the other.
  const g = game(['.b......', '........', '........', '....b...', '...W....', '..b.....', '........', '........']);
  assert.equal(g.x.t_need(), 1, 'only one of the two can be taken');
  move(g, P1, [4, 3], [2, 5]);
  assert.equal(g.x.t_turn(), P2);
  assert.equal(at(g, 3, 4), 0); assert.equal(at(g, 5, 2), 2);
});

test('a man that only passes the far row in the middle of a capture stays a man', () => {
  const g = game(['........', '....b.b.', '...w....', '........', '........', 'b.......', '........', '........']);
  assert.equal(g.x.t_need(), 2);
  move(g, P1, [2, 3], [0, 5], [2, 7]);                                // touches row 0, ends on row 2
  assert.equal(at(g, 2, 7), 1, 'still a man'); assert.equal(count(g, 'W'), 0);
  assert.equal(count(g, 'b'), 1);
});

test('a man that ends its move on the far row becomes a king (by a step, by a capture, both sides)', () => {
  let g = game(['.b......', '..w.....', '........', '........', '........', '........', '........', '........']);
  move(g, P1, [1, 2], [0, 3]);
  assert.equal(at(g, 0, 3), 3);
  g = game(['........', '....b...', '...w....', '........', '........', 'b.......', '........', '........']);
  move(g, P1, [2, 3], [0, 5]);
  assert.equal(at(g, 0, 5), 3); assert.equal(at(g, 1, 4), 0);
  g = game(['........', '........', '........', '........', '........', '........', '.b......', '......w.'], P2);
  move(g, P2, [6, 1], [7, 2]);
  assert.equal(at(g, 7, 2), 4);
});

test('a king flies: any number of empty squares along a diagonal, in all four directions', () => {
  const g = game(['.b......', '........', '........', '........', '...W....', '........', '........', '........']);
  move(g, P1, [4, 3], [1, 6]); assert.equal(at(g, 1, 6), 3);
  move(g, P2, [0, 1], [1, 0]);
  move(g, P1, [1, 6], [6, 1]); assert.equal(at(g, 6, 1), 3);          // back down the same diagonal
  move(g, P2, [1, 0], [2, 1]);
  move(g, P1, [6, 1], [7, 0]); assert.equal(at(g, 7, 0), 3);
});

test('a king cannot leave its diagonal, pass its own piece, or jump two pieces in a row', () => {
  const g = game(['.b......', '........', '........', '....b...', '...b....', '..w.....', '.....w..', 'W.....W.']);
  refused(g, P1, [7, 6], [4, 3]);                                     // over its own man on (6,5)
  refused(g, P1, [7, 0], [4, 3]);                                     // (4,3) is taken
  refused(g, P1, [7, 0], [2, 5]);                                     // through its own man and two enemies
  refused(g, P1, [7, 6], [7, 4]);                                     // not a diagonal
});

test('a king captures from a distance and may land on any empty square behind the piece', () => {
  for (const land of [[3, 4], [2, 5], [1, 6], [0, 7]]) {
    const g = game(['.b......', '........', '........', '........', '...b....', '........', '........', 'W.......']);
    assert.equal(g.x.t_need(), 1);
    move(g, P1, [7, 0], land);
    assert.equal(at(g, land[0], land[1]), 3); assert.equal(at(g, 4, 3), 0); assert.equal(g.x.t_turn(), P2);
  }
});

test('a king must pick the landing square that keeps the longest capture', () => {
  const g = game(['.......b', '....b...', '........', '........', '...b....', '........', '........', 'W.......']);
  assert.equal(g.x.t_need(), 2);
  refused(g, P1, [7, 0], [3, 4]);                                     // from here nothing more can be taken
  move(g, P1, [7, 0], [2, 5], [0, 3]);
  assert.equal(at(g, 0, 3), 3); assert.equal(count(g, 'b'), 1);
});

test('win: the other side has no pieces left', () => {
  const g = game(['........', '........', '........', '........', '...b....', '..w.....', '........', '........']);
  move(g, P1, [5, 2], [3, 4]);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), P1);
  assert.ok(g.views[0].texts().includes('YOU WIN')); assert.ok(g.views[1].texts().includes('YOU LOSE'));
  assert.equal(g.views[0].label(2), 'REMATCH'); assert.equal(g.hz, 0, 'nothing runs after the match');
});

test('win: the other side cannot move', () => {
  const g = game(['........', '........', '........', 'b.......', '.w......', '..w.....', '........', '......w.']);
  move(g, P1, [7, 6], [6, 7]);                                        // player 2's only man is blocked
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), P1);
});

test('resign: from HOME (system message), or button 2 then A; B backs out', () => {
  let g = game();
  g.sys(P2, 1);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), P1);
  g = game();
  g.tap(P1, IN.act(2));
  assert.ok(g.views[0].texts().includes('A=RESIGN B=BACK'));
  assert.ok(!g.views[1].texts().includes('A=RESIGN B=BACK'), 'the other player does not see the question');
  g.tap(P1, IN.B);
  assert.equal(g.x.t_state(), S_PLAY); assert.ok(!g.views[0].texts().includes('A=RESIGN B=BACK'));
  g.tap(P1, IN.act(2)); g.tap(P1, IN.A);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), P2);
});

test('clocks: only the side to move runs, and running out of time loses', () => {
  const g = game();
  assert.equal(g.hz, 10);
  g.tick(30);                                                         // 3 seconds
  assert.equal(g.x.t_clock(0), 297); assert.equal(g.x.t_clock(1), 300);
  assert.equal(g.views[1].str(4), '4:57');
  move(g, P1, [5, 0], [4, 1]);
  g.tick(20);
  assert.equal(g.x.t_clock(0), 297); assert.equal(g.x.t_clock(1), 298);
  g.x.t_set_clock(1, 1);
  g.tick(10);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), P1);
});

test('clocks pause while a player is away', () => {
  const g = game();
  g.leave(1);
  g.tick(50);
  assert.equal(g.x.t_clock(0), 300);
  assert.ok(g.views[0].texts().includes('P2 IS AWAY'));
  g.join(1);
  g.tick(10);
  assert.equal(g.x.t_clock(0), 299);
});

test('the clock of the side to move is drawn inverted: a filled box with black digits', () => {
  const g = game();
  const inverted = (v, x) => {
    for (let s = 147; s < 160; s++) {
      const o = v.op(s);
      if (o[0] === OP.RECT && (o[1] & 0x20) && o[2] === x && o[3] === 21) {
        const digits = v.op(s + 1);
        return digits[0] === OP.TEXT && (digits[1] & 7) === 0;        // role 0 = black
      }
    }
    return false;
  };
  for (const v of g.views) { assert.ok(inverted(v, 30), 'player 1 clock inverted'); assert.ok(!inverted(v, 188)); }
  move(g, P1, [5, 0], [4, 1]);
  for (const v of g.views) { assert.ok(inverted(v, 188), 'player 2 clock inverted'); assert.ok(!inverted(v, 30)); }
});

test('draw: the same position a third time with the same side to move', () => {
  const g = game(['.b...B..', '........', '........', '........', '........', '......w.', '........', '..W.....']);
  move(g, P1, [5, 6], [4, 7]);                                        // position X, player 2 to move (1st time)
  const lap = () => {
    move(g, P2, [0, 5], [1, 4]); move(g, P1, [7, 2], [6, 1]);
    move(g, P2, [1, 4], [0, 5]);
    assert.equal(g.x.t_state(), S_PLAY);
    move(g, P1, [6, 1], [7, 2]);                                      // back to X
  };
  lap();                                                              // 2nd time
  assert.equal(g.x.t_state(), S_PLAY, 'twice is not a draw');
  lap();                                                              // 3rd time
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), DRAW);
  for (const v of g.views) assert.ok(v.texts().includes('DRAW'));
});

// Two kings that can wander for a long time without ever meeting and without repeating a
// position three times: player 1's king steps between two corner squares behind its own
// men, player 2's king walks a loop of 7 squares.
const WANDER = ['........', '........', '........', 'B.......', '........', '......w.', '.....w..', '......W.'];
const LOOP = [[3, 0], [4, 1], [5, 2], [6, 1], [7, 2], [6, 3], [7, 4]];
function wanderer(g) {
  let i = 0;                                                          // plies played so far
  return (plies) => {
    for (let n = 0; n < plies; n++, i++) {
      const k = i >> 1;
      if (i % 2 === 0) move(g, P1, k % 2 ? [6, 7] : [7, 6], k % 2 ? [7, 6] : [6, 7]);
      else move(g, P2, LOOP[k % 7], LOOP[(k + 1) % 7]);
      if (n < plies - 1) assert.equal(g.x.t_state(), S_PLAY, `still playing after ${i + 1} plies`);
    }
  };
}

test('draw: 25 moves each with only kings moving and nothing taken', () => {
  const rows = [...WANDER]; rows[0] = '.b......';                      // a second piece: not a lone king
  const g = game(rows), wander = wanderer(g);
  wander(49);
  assert.equal(g.x.t_state(), S_PLAY, '49 plies is not enough');
  wander(1);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), DRAW);
});

test('a man move or a capture starts the 25-move count again', () => {
  const rows = [...WANDER]; rows[0] = '.b......';
  const g = game(rows), wander = wanderer(g);
  wander(49);
  move(g, P2, [0, 1], [1, 2]);                                        // ply 50 is a man move
  assert.equal(g.x.t_state(), S_PLAY);
  assert.equal(at(g, 1, 2), 2);
});

test('draw: a lone king holds out 16 moves each against three pieces with a king', () => {
  const g = game(WANDER), wander = wanderer(g);                       // king + 2 men against a lone king
  wander(1);                                                          // the count starts once the position stands
  wander(31);
  assert.equal(g.x.t_state(), S_PLAY, '31 plies is not enough');
  wander(1);
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), DRAW);
});

test('draw: a lone king holds out 5 moves each against one or two pieces with a king', () => {
  for (const rows of [
    ['........', '........', '........', 'B.......', '........', '........', '.....w..', '......W.'],   // king + man
    ['........', '........', '........', 'B.......', '........', '........', '........', '......W.'],   // king alone
  ]) {
    const g = game(rows), wander = wanderer(g);
    wander(1);
    wander(9);
    assert.equal(g.x.t_state(), S_PLAY, '9 plies is not enough');
    wander(1);
    assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), DRAW);
  }
});

test('draw offer: the other player accepts with DRAW; a move declines it; B takes it back', () => {
  let g = game();
  g.tap(P1, IN.act(3));
  assert.ok(g.views[0].texts().includes('DRAW OFFERED')); assert.ok(g.views[1].texts().includes('P1 OFFERS DRAW'));
  g.tap(P2, IN.act(3));
  assert.equal(g.x.t_state(), S_OVER); assert.equal(g.x.t_winner(), DRAW);

  g = game();
  g.tap(P2, IN.act(3));
  move(g, P1, [5, 0], [4, 1]);                                        // playing on is the answer "no"
  assert.ok(!g.views[0].texts().includes('P2 OFFERS DRAW'));
  g.tap(P1, IN.act(3));                                               // so this is a new offer, not an acceptance
  assert.equal(g.x.t_state(), S_PLAY);

  g = game();
  g.tap(P1, IN.act(3)); g.tap(P1, IN.B);
  assert.ok(!g.views[1].texts().includes('P1 OFFERS DRAW'));
  g.tap(P2, IN.act(3));
  assert.equal(g.x.t_state(), S_PLAY, 'an offer that was taken back cannot be accepted');
});

test('rematch: starts only when both players ask, with a fresh board and fresh clocks', () => {
  const g = game();
  g.tick(30); g.sys(P1, 1);
  assert.equal(g.x.t_state(), S_OVER);
  g.tap(P1, IN.act(2));
  assert.equal(g.x.t_state(), S_OVER);
  assert.ok(g.views[0].texts().includes('REMATCH SENT')); assert.ok(g.views[1].texts().includes('P1 WANTS REMATCH'));
  g.tap(P2, IN.act(2));
  assert.equal(g.x.t_state(), S_PLAY);
  assert.equal(count(g, 'w'), 12); assert.equal(count(g, 'b'), 12);
  assert.equal(g.x.t_clock(0), 300); assert.equal(g.x.t_turn(), P1);
  assert.equal(g.views[0].label(2), 'RESIGN'); assert.equal(g.views[0].label(3), 'DRAW'); assert.equal(g.hz, 10);
});

test('drawing: a king is two stacked discs, a man is one', () => {
  const g = game(['.b......', '........', '........', '........', '........', '..w.....', '........', 'W.......']);
  const v = g.views[0];
  const man = 5 * 4 + (2 >> 1), king = 7 * 4 + (0 >> 1);
  assert.equal(v.op(33 + man)[0], OP.CIRC); assert.equal(v.op(65 + man)[0], OP.NOP); assert.equal(v.op(97 + man)[0], OP.NOP);
  assert.equal(v.op(33 + king)[0], OP.CIRC); assert.equal(v.op(97 + king)[0], OP.CIRC);
  assert.equal(v.op(65 + king)[1] & 7, 0, 'the gap between the discs is drawn in black');
  assert.ok(v.op(97 + king)[3] < v.op(33 + king)[3], 'the upper disc sits above the lower one');
});

test('drawing: on your turn, your pieces that cannot move are dimmed, and only for you', () => {
  const g = game();
  const bright = (v, r, c) => (v.op(33 + r * 4 + (c >> 1))[1] >> 3) & 3;
  assert.equal(bright(g.views[0], 5, 0), 3, 'a front man can move: full');
  assert.equal(bright(g.views[0], 7, 0), 1, 'a back man cannot move: 50%');
  assert.equal(bright(g.views[1], 7, 0), 3, 'the other player sees it at full');
  assert.equal(bright(g.views[1], 0, 1), 3, 'not player 2\'s turn: nothing of theirs is dimmed');
  assert.equal(bright(g.views[2], 7, 0), 3, 'a spectator sees everything at full');
});

test('views: each player has their own side at the bottom and sees only their own cursor', () => {
  const g = game();
  const cursor = (v) => v.op(146);
  assert.equal(cursor(g.views[0])[0], OP.RECT); assert.equal(cursor(g.views[1])[0], OP.RECT);
  assert.equal(cursor(g.views[2])[0], OP.NOP, 'a spectator has no cursor');
  const before = cursor(g.views[1]).join();
  g.tap(P1, IN.R); g.tap(P1, IN.U);                                   // player 1 moves the cursor
  assert.equal(cursor(g.views[1]).join(), before, 'player 2 never receives player 1\'s cursor');
  // player 1's piece on (7,0) is bottom-left for player 1 and top-right for player 2
  const piece = (v) => v.op(33 + 7 * 4 + 0);
  assert.ok(piece(g.views[0])[2] < 128 && piece(g.views[0])[3] > 128);
  assert.ok(piece(g.views[1])[2] > 128 && piece(g.views[1])[3] < 128);
});

test('cursor: one step per push, the stick is rotated for player 2, and a held stick repeats', () => {
  const g = game();
  assert.deepEqual([g.x.t_cursor_r(0), g.x.t_cursor_c(0)], [5, 0]);
  g.tap(P1, IN.R); assert.deepEqual([g.x.t_cursor_r(0), g.x.t_cursor_c(0)], [5, 1]);
  g.tap(P1, IN.U); assert.deepEqual([g.x.t_cursor_r(0), g.x.t_cursor_c(0)], [4, 1]);
  g.tap(P1, IN.DL); assert.deepEqual([g.x.t_cursor_r(0), g.x.t_cursor_c(0)], [5, 0]);
  g.tap(P1, IN.L); assert.deepEqual([g.x.t_cursor_r(0), g.x.t_cursor_c(0)], [5, 0], 'stops at the edge');
  assert.deepEqual([g.x.t_cursor_r(1), g.x.t_cursor_c(1)], [2, 7]);
  g.tap(P2, IN.R); assert.deepEqual([g.x.t_cursor_r(1), g.x.t_cursor_c(1)], [2, 6], 'player 2\'s right is the board\'s left');
  g.tap(P2, IN.U); assert.deepEqual([g.x.t_cursor_r(1), g.x.t_cursor_c(1)], [3, 6]);
  g.input(P1, IN.R);                                                  // hold
  assert.equal(g.x.t_cursor_c(0), 1);
  g.tick(3); assert.equal(g.x.t_cursor_c(0), 1, 'a short hold is one step');
  g.tick(3); assert.equal(g.x.t_cursor_c(0), 4, 'then it repeats every tick');
  g.input(P1, 0); g.tick(5); assert.equal(g.x.t_cursor_c(0), 4);
});

test('traffic: an idle board sends nothing, a cursor step is one small packet', () => {
  const g = game();
  g.tick(1);
  assert.deepEqual(g.tick(8).filter(Boolean), [], 'ticks between clock seconds send no bytes');
  const sizes = g.input(P1, IN.R);
  assert.ok(sizes[0] > 0 && sizes[0] <= 16, `cursor packet is ${sizes[0]} bytes`);
  assert.equal(sizes[1], 0, 'and the other player gets nothing at all');
  assert.equal(g.errors, 0);
});
