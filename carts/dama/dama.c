/* DAMA — 2-player online checkers. Almost static: the screen changes once a second (the clocks).
 * The tick is 10 Hz so a held stick can repeat; a tick that changes nothing sends nothing.
 *
 * Rules:
 *   - Men move one square diagonally forward. They capture by jumping an enemy piece
 *     next to them, forward or backward, onto the empty square behind it.
 *   - Kings: a man that ends its move on the far row becomes a king (two stacked discs).
 *     A king flies: it moves any number of empty squares along a diagonal, and captures
 *     a piece any distance away along a diagonal, landing on any empty square beyond it.
 *   - Captures are forced, and the longest one too: you must take the most pieces you can
 *     (kings count as one). Jumped pieces come off only when the move ends, so no piece
 *     can be jumped twice, and a jumped piece still blocks the way. A man that only passes
 *     the far row in the middle of a capture stays a man.
 *   - Clocks: CLOCK_MINUTES each. The clock of the side to move runs and is drawn inverted.
 *   - Win: the other side has no pieces left, cannot move, resigns, or runs out of time.
 *   - Draw: the same position a third time with the same side to move; 25 moves each with
 *     only kings moving and nothing taken; a lone king against three pieces with at least
 *     one king holding out 16 moves each, or against one or two pieces with a king, 5 moves
 *     each; a draw offer taken.
 *
 * Controls: stick = move cursor, A = select / move, B = cancel,
 *           button 2 = RESIGN (then A to confirm), button 3 = DRAW (offer, or accept an offer).
 * On your turn, your pieces that cannot move are dimmed.
 * Each player has their own view: own pieces at the bottom, own cursor only.
 */
#include "console.h"

const u8 cart_players = 2;

#define CLOCK_MINUTES 5
#define TICK_HZ       10
#define REPEAT_DELAY  3      /* ticks a stick is held before the cursor repeats */

enum { S_WAIT, S_PLAY, S_OVER };
enum { SFX_MOVE, SFX_CAPTURE, SFX_INVALID, SFX_WIN, SFX_LOSE, SFX_KING, SFX_DRAW };
enum { STR_P1, STR_P2, STR_STATUS, STR_NOTE, STR_CLK1, STR_CLK2 };
#define DRAW 2                   /* value of `winner` for a drawn game */

#define X0 32
#define Y0 44
#define SQ 24

/* slot map (slot order = layer order) */
#define SL_SQUARE 0     /* 32 dark squares                      */
#define SL_BORDER 32
#define SL_PIECE  33    /* 32 cells: the disc (lower disc of a king) */
#define SL_KING_A 65    /* 32 cells: black gap between the two discs */
#define SL_KING_B 97    /* 32 cells: the upper disc of a king        */
#define SL_DEST   129   /* 16 destination hints                 */
#define SL_SELECT 145
#define SL_CURSOR 146
#define SL_HUD    147

static u8 bd[8][8];              /* 0 empty, 1 P1 man, 2 P2 man, 3 P1 king, 4 P2 king */
static u8 tk[8][8];              /* jumped in the move being played: still on the board until it ends */
static u8 state, turn, winner;
static u8 present[2];
static u8 need;                  /* captures the player to move must still make (0 = free move) */
static u8 mvb[8][8];             /* pieces of the player to move that may move now */
static u8 chain, chr, chc;       /* capture sequence in progress with this piece */
static u8 cr[2], cc[2];          /* cursors (board coordinates) */
static u8 sel[2], sr[2], sc[2];
static u8 confirm[2], rematch[2], offer[2];
static u16 clk[2];
static u8 sub;                   /* ticks into the current second */
static u8 in_now[2], hold[2];    /* held stick, for cursor repeat */

/* draw bookkeeping */
static u32 hist[64]; static u8 hist_n;   /* positions since the last man move or capture */
static u8 quiet;                         /* plies with only kings moving and nothing taken */
static u8 end_class, end_plies;          /* lone-king endgames */
static u8 move_took, move_man;           /* what the move being played did */

static const i8 DR[4] = {-1, -1, 1, 1}, DC[4] = {-1, 1, -1, 1};

static u8 own(u8 v) { return v ? (u8)((v - 1) & 1) : 2; }
static u8 inb(i8 r, i8 c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
static i8 fwd(u8 p) { return p == 0 ? -1 : 1; }

/* The most pieces piece `v` can still capture from (r,c). The piece itself is lifted
   off the board by the caller; pieces already jumped stay and block. */
static u8 maxcap(i8 r, i8 c, u8 v) {
  u8 p = own(v), best = 0;
  for (u8 d = 0; d < 4; d++) {
    i8 dr = DR[d], dc = DC[d], mr = (i8)(r + dr), mc = (i8)(c + dc);
    if (v >= 3) while (inb(mr, mc) && !bd[mr][mc]) { mr = (i8)(mr + dr); mc = (i8)(mc + dc); }   /* a king flies */
    if (!inb(mr, mc)) continue;
    u8 m = bd[mr][mc];
    if (!m || own(m) == p || tk[mr][mc]) continue;
    tk[mr][mc] = 1;
    for (i8 tr = (i8)(mr + dr), tc = (i8)(mc + dc); inb(tr, tc) && !bd[tr][tc]; tr = (i8)(tr + dr), tc = (i8)(tc + dc)) {
      u8 n = (u8)(1 + maxcap(tr, tc, v));
      if (n > best) best = n;
      if (v < 3) break;                          /* a man lands right behind the piece */
    }
    tk[mr][mc] = 0;
  }
  return best;
}
static u8 maxcap_at(u8 r, u8 c) { u8 v = bd[r][c]; bd[r][c] = 0; u8 n = maxcap((i8)r, (i8)c, v); bd[r][c] = v; return n; }

static u8 can_step(u8 r, u8 c) {
  u8 v = bd[r][c], p = own(v);
  for (u8 d = 0; d < 4; d++) {
    if (v < 3 && DR[d] != fwd(p)) continue;
    i8 tr = (i8)(r + DR[d]), tc = (i8)(c + DC[d]);
    if (inb(tr, tc) && !bd[tr][tc]) return 1;
  }
  return 0;
}

/* Work out what the player to move is allowed to do. Called after every board change. */
static void plan(void) {
  u8 cap[8][8], best = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) { mvb[r][c] = 0; cap[r][c] = 0; }
  if (chain) { mvb[chr][chc] = 1; need = maxcap_at(chr, chc); return; }   /* must continue with the same piece */
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++)
    if (own(bd[r][c]) == turn) { cap[r][c] = maxcap_at(r, c); if (cap[r][c] > best) best = cap[r][c]; }
  need = best;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++)
    if (own(bd[r][c]) == turn) mvb[r][c] = best ? (cap[r][c] == best) : can_step(r, c);
}

static u8 any_move(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (mvb[r][c]) return 1;
  return 0;
}

/* 0 = illegal, 1 = step, 2 = capture (then cap_r / cap_c is the jumped piece) */
static u8 cap_r, cap_c;
static u8 legal(u8 p, u8 fr, u8 fc, u8 tr, u8 tc) {
  if (p != turn || !mvb[fr][fc] || bd[tr][tc]) return 0;
  i8 dr = (i8)(tr - fr), dc = (i8)(tc - fc);
  i8 dist = (i8)(dr < 0 ? -dr : dr);
  if (!dist || (dc != dr && dc != -dr)) return 0;      /* diagonals only */
  i8 sr_ = (i8)(dr < 0 ? -1 : 1), sc_ = (i8)(dc < 0 ? -1 : 1);
  u8 v = bd[fr][fc], enemies = 0;
  for (i8 k = 1; k < dist; k++) {
    u8 r = (u8)(fr + sr_ * k), c = (u8)(fc + sc_ * k), m = bd[r][c];
    if (!m) continue;
    if (own(m) == p || tk[r][c]) return 0;             /* own pieces and jumped pieces block */
    enemies++; cap_r = r; cap_c = c;
  }
  if (!need) return v >= 3 ? enemies == 0 : (dist == 1 && sr_ == fwd(p));
  if (enemies != 1) return 0;
  if (v < 3 && dist != 2) return 0;
  /* a capture is only legal if it keeps the longest sequence possible */
  bd[fr][fc] = 0; tk[cap_r][cap_c] = 1;
  u8 n = (u8)(1 + maxcap((i8)tr, (i8)tc, v));
  tk[cap_r][cap_c] = 0; bd[fr][fc] = v;
  return n == need ? 2 : 0;
}

static u8 count(u8 p) {
  u8 n = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (own(bd[r][c]) == p && !tk[r][c]) n++;
  return n;
}
static u8 kings(u8 p) {
  u8 n = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (bd[r][c] == 3 + p) n++;
  return n;
}

static void labels_play(void) {
  con_transition_begin();
  con_label(2, "RESIGN"); con_label(3, "DRAW"); con_label(4, "");
  con_tick_rate(TICK_HZ);
  con_transition_end();
  con_music(MUSIC_PLAY, 0);
}

static void reset_board(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) {
    bd[r][c] = ((r + c) & 1) ? (r < 3 ? 2 : (r > 4 ? 1 : 0)) : 0;
    tk[r][c] = 0;
  }
  turn = 0; winner = 0; chain = 0; need = 0;
  sub = 0;
  hist_n = 0; quiet = 0; end_class = 0; end_plies = 0; move_took = 0; move_man = 0;
  for (u8 p = 0; p < 2; p++) { sel[p] = confirm[p] = rematch[p] = offer[p] = 0; clk[p] = CLOCK_MINUTES * 60; }
  cr[0] = 5; cc[0] = 0; cr[1] = 2; cc[1] = 7;
  plan();
}

/* w = 0 or 1: that player wins. w = DRAW: nobody does. */
static void end_game(u8 w) {
  state = S_OVER; winner = w; chain = 0;
  sel[0] = sel[1] = confirm[0] = confirm[1] = offer[0] = offer[1] = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (tk[r][c]) { tk[r][c] = 0; bd[r][c] = 0; }
  con_transition_begin();
  con_label(2, "REMATCH"); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);
  con_transition_end();
  con_music(MUSIC_STOP, 0);
  if (w == DRAW) con_sfx(VIEW_ALL, SFX_DRAW);
  else { con_sfx(VIEW(w) | VIEW(2), SFX_WIN); con_sfx(VIEW(1 - w), SFX_LOSE); }
}

static u32 position_hash(void) {
  u32 h = 2166136261u;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if ((r + c) & 1) h = (h ^ bd[r][c]) * 16777619u;
  return (h ^ turn) * 16777619u;
}

/* Called when a move has ended and the turn has passed. Returns 1 if the game is drawn. */
static u8 check_draws(void) {
  if (move_took || move_man) { hist_n = 0; quiet = 0; }      /* such a position can never come back */
  else if (quiet < 250) quiet++;
  if (quiet >= 50) return 1;                                 /* 25 moves each, kings only, nothing taken */

  u32 h = position_hash(); u8 seen = 0;
  for (u8 i = 0; i < hist_n; i++) if (hist[i] == h) seen++;
  if (seen >= 2) return 1;                                   /* third time, same side to move */
  if (hist_n < 64) hist[hist_n++] = h;

  /* a lone king holding out */
  u8 cls = 0;
  for (u8 p = 0; p < 2; p++) {
    u8 mine = count(p), theirs = count((u8)(1 - p));
    if (mine == 1 && kings(p) == 1 && kings((u8)(1 - p)) >= 1) {
      if (theirs == 3) cls = 1;
      else if (theirs == 1 || theirs == 2) cls = 2;
    }
  }
  if (cls != end_class) { end_class = cls; end_plies = 0; }
  else if (cls && end_plies < 250) end_plies++;
  if (cls == 1 && end_plies >= 32) return 1;                 /* 16 moves each */
  if (cls == 2 && end_plies >= 10) return 1;                 /* 5 moves each  */
  return 0;
}

static void do_move(u8 p, u8 fr, u8 fc, u8 tr, u8 tc, u8 kind) {
  u8 v = bd[fr][fc];
  bd[fr][fc] = 0; bd[tr][tc] = v;
  offer[0] = offer[1] = 0;                             /* a move answers any draw offer with "no" */
  if (v < 3) move_man = 1;
  if (kind == 2) {
    tk[cap_r][cap_c] = 1; move_took = 1;               /* it comes off when the whole move ends */
    con_sfx(VIEW_ALL, SFX_CAPTURE);
    chain = 1; chr = tr; chc = tc;
    plan();
    if (need) { sel[p] = 1; sr[p] = tr; sc[p] = tc; return; }   /* the sequence is not finished */
  } else con_sfx(VIEW(1 - p) | VIEW(2), SFX_MOVE);     /* the mover's own click is local */

  /* the move ends here */
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (tk[r][c]) { tk[r][c] = 0; bd[r][c] = 0; }
  if (v < 3 && tr == (p == 0 ? 0 : 7)) { bd[tr][tc] = (u8)(v + 2); con_sfx(VIEW_ALL, SFX_KING); }
  chain = 0; sel[p] = 0;
  turn = (u8)(1 - p);
  plan();
  if (!any_move()) end_game(p);
  else if (check_draws()) end_game(DRAW);
  move_took = 0; move_man = 0;
}

void cart_init(void) {
  con_transition_begin();
  con_pal(C_PRIMARY,   0xEC, 0xE9, 0xE4);
  con_pal(C_SECONDARY, 0x5C, 0xC8, 0xF0);
  con_pal(C_ACCENT,    0xFF, 0xB2, 0x3F);
  con_pal(C_HIGHLIGHT, 0xC9, 0xA7, 0xFF);
  con_pal(C_ERROR,     0xFF, 0x5A, 0x5A);
  con_pal(C_SUCCESS,   0x6B, 0xE3, 0x8C);
  con_pal(C_SPARE,     0x80, 0x80, 0x80);
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);
  /*            id           channel      duty     note vol sweep        len flags */
  con_sfx_def(SFX_MOVE,    CH_PULSE1,   DUTY_25, 72,  8,  0,           6,  SFX_DECAY);
  con_sfx_def(SFX_CAPTURE, CH_NOISE,    0,       64,  9,  (u8)-12,     12, SFX_DECAY);
  con_sfx_def(SFX_INVALID, CH_PULSE2,   DUTY_50, 45,  7,  (u8)-3,      10, SFX_DECAY);
  con_sfx_def(SFX_WIN,     CH_PULSE1,   DUTY_50, 72,  9,  12,          50, SFX_DECAY);
  con_sfx_def(SFX_LOSE,    CH_TRIANGLE, 0,       55,  12, (u8)-12,     50, SFX_DECAY);
  con_sfx_def(SFX_KING,    CH_PULSE2,   DUTY_25, 84,  8,  7,           20, SFX_DECAY);
  con_sfx_def(SFX_DRAW,    CH_TRIANGLE, 0,       64,  11, 0,           40, SFX_DECAY);
  /* a calm 16-step loop: pulse1, pulse2, triangle, noise */
  static const u8 song[16 * 4] = {
    76,0,48,0,  0,0,0,0,  0,0,55,0,  0,0,0,0,   79,0,57,0,  0,0,0,0,  0,0,53,0,  0,0,0,0,
    74,0,48,0,  0,0,0,0,  0,0,55,0,  72,0,0,0,  0,0,52,0,   0,0,0,0,  0,0,55,0,  0,0,0,0 };
  con_music_def(0, 28, 16, 4, song);
  con_transition_end();
  reset_board();
  state = S_WAIT;
}

void cart_presence(u8 p, u8 on) {
  present[p] = on;
  if (!on) in_now[p] = 0;
  if (state == S_WAIT && present[0] && present[1]) { state = S_PLAY; labels_play(); }
}

/* one cursor step in the direction of the stick; player 2's view is rotated */
static void move_cursor(u8 p, u8 in) {
  i8 dx = in_dx(in), dy = in_dy(in);
  if (p == 1) { dx = (i8)-dx; dy = (i8)-dy; }
  i8 r = (i8)(cr[p] + dy), c = (i8)(cc[p] + dx);
  if (r >= 0 && r < 8) cr[p] = (u8)r;
  if (c >= 0 && c < 8) cc[p] = (u8)c;
}

void cart_tick(void) {
  if (state != S_PLAY) return;
  for (u8 p = 0; p < 2; p++)                                   /* a held stick repeats */
    if (IN_ACTIVE(in_now[p]) && ++hold[p] > REPEAT_DELAY) move_cursor(p, in_now[p]);
  if (!present[0] || !present[1]) return;                      /* clocks pause while someone is away */
  if (++sub < TICK_HZ) return;
  sub = 0;
  if (clk[turn]) clk[turn]--;
  if (!clk[turn]) end_game((u8)(1 - turn));
}

void cart_sys(u8 p, u8 code) {
  if (code == SYS_RESIGN && state == S_PLAY) end_game((u8)(1 - p));
}

void cart_input(u8 p, u8 now, u8 prev) {
  u8 pressed = (u8)(now & ~prev);
  u8 act = IN_ACTION(now) != IN_ACTION(prev) ? IN_ACTION(now) : 0;

  if (state == S_OVER) {
    if (act == 1 && !rematch[p]) {
      rematch[p] = 1;
      if (rematch[0] && rematch[1]) { reset_board(); state = S_PLAY; labels_play(); }
    }
    return;
  }

  /* cursor: one step at once on a push or a direction change, then it repeats while held */
  in_now[p] = now;
  if (IN_ACTIVE(now) && (!IN_ACTIVE(prev) || IN_DIR(now) != IN_DIR(prev))) { hold[p] = 0; move_cursor(p, now); }

  if (state != S_PLAY) return;
  if (act == 1) confirm[p] = 1;
  if (act == 2) {                                      /* DRAW: offer, or take the other player's offer */
    offer[p] = 1;
    if (offer[1 - p]) { end_game(DRAW); return; }
  }

  if (pressed & IN_B) {
    if (confirm[p]) confirm[p] = 0;
    else if (offer[p]) offer[p] = 0;                   /* take your own offer back */
    else if (!chain) sel[p] = 0;
  }
  if (pressed & IN_A) {
    if (confirm[p]) { end_game((u8)(1 - p)); return; }
    if (turn != p) { con_sfx(VIEW(p), SFX_INVALID); return; }
    u8 r = cr[p], c = cc[p];
    if (sel[p]) {
      u8 k = legal(p, sr[p], sc[p], r, c);
      if (k) { do_move(p, sr[p], sc[p], r, c, k); return; }
      if (!chain && r == sr[p] && c == sc[p]) { sel[p] = 0; return; }
    }
    if (!chain && mvb[r][c]) { sel[p] = 1; sr[p] = r; sc[p] = c; }
    else con_sfx(VIEW(p), SFX_INVALID);
  }
}

/* ---- drawing -------------------------------------------------------- */
static u8 flip;
static u8 cx(u8 c) { return (u8)(X0 + (flip ? 7 - c : c) * SQ); }
static u8 cy(u8 r) { return (u8)(Y0 + (flip ? 7 - r : r) * SQ); }

static void fmt_tag(char *o, u8 p, u8 n) {
  o[0] = 'P'; o[1] = (char)('1' + p); o[2] = ' '; o[3] = (char)('0' + n / 10); o[4] = (char)('0' + n % 10); o[5] = 0;
}
static void fmt_clock(char *o, u16 s) {
  o[0] = (char)('0' + s / 60 % 10); o[1] = ':'; o[2] = (char)('0' + (s % 60) / 10); o[3] = (char)('0' + s % 10); o[4] = 0;
}

void cart_draw(u8 view) {
  u8 me = view < 2 ? view : 2;          /* 2 = spectator */
  flip = (me == 1);
  char buf[17];
  u8 my_turn = state == S_PLAY && me == turn;

  /* board */
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) {
    if (!((r + c) & 1)) continue;
    u8 i = (u8)(r * 4 + (c >> 1)), v = bd[r][c];
    con_rect((u8)(SL_SQUARE + i), FILL_B(C_PRIMARY, B25), cx(c), cy(r), SQ, SQ);
    if (!v) continue;
    u8 role = own(v) == 0 ? C_PRIMARY : C_SECONDARY;
    /* dim: a piece already jumped in this move, or on your turn a piece of yours that cannot move */
    u8 br = tk[r][c] ? B25 : (my_turn && own(v) == me && !mvb[r][c]) ? B50 : B100;
    u8 x = (u8)(cx(c) + 12), y = (u8)(cy(r) + 12);
    if (v < 3) con_circ((u8)(SL_PIECE + i), FILL_B(role, br), x, y, 8);
    else {                               /* a king is two stacked discs */
      con_circ((u8)(SL_PIECE + i),  FILL_B(role, br), x, (u8)(y + 3), 8);
      con_circ((u8)(SL_KING_A + i), FILL(C_BLACK),    x, (u8)(y - 2), 9);      /* black = eraser: the gap */
      con_circ((u8)(SL_KING_B + i), FILL_B(role, br), x, (u8)(y - 3), 8);
    }
  }
  con_rect(SL_BORDER, STROKE(C_PRIMARY, 1), X0, Y0, 192, 192);

  /* selection + where it can go */
  if (me < 2 && state == S_PLAY && sel[me]) {
    u8 n = 0;
    con_circ(SL_SELECT, STROKE(C_ACCENT, 2), (u8)(cx(sc[me]) + 12), (u8)(cy(sr[me]) + 12), 11);
    for (u8 d = 0; d < 4; d++) for (i8 k = 1; k < 8; k++) {
      i8 tr = (i8)(sr[me] + DR[d] * k), tc = (i8)(sc[me] + DC[d] * k);
      if (!inb(tr, tc)) break;
      if (n < 16 && legal(me, sr[me], sc[me], (u8)tr, (u8)tc))
        con_circ((u8)(SL_DEST + n++), FILL(C_ACCENT), (u8)(cx((u8)tc) + 12), (u8)(cy((u8)tr) + 12), 3);
    }
  }
  if (me < 2 && state != S_OVER)
    con_rect(SL_CURSOR, STROKE(C_HIGHLIGHT, 2), (u8)(cx(cc[me]) + 1), (u8)(cy(cr[me]) + 1), SQ - 2, SQ - 2);

  /* HUD: pieces left + clocks. A small accent diamond marks your own side.
     The clock of the side to move is drawn inverted: a filled box with black digits. */
  u8 s = SL_HUD;
  fmt_tag(buf, 0, count(0)); con_str(STR_P1, buf);
  fmt_tag(buf, 1, count(1)); con_str(STR_P2, buf);
  fmt_clock(buf, clk[0]); con_str(STR_CLK1, buf);
  fmt_clock(buf, clk[1]); con_str(STR_CLK2, buf);
  u8 run = state == S_PLAY;
  con_text(s++, FILL(C_PRIMARY),   32,  16, 8, ALIGN_LEFT,  STR_P1);
  con_text(s++, FILL(C_SECONDARY), 224, 16, 8, ALIGN_RIGHT, STR_P2);
  if (run && turn == 0) { con_rect(s++, FILL(C_PRIMARY), 30, 21, 38, 16); con_text(s++, FILL(C_BLACK), 49, 34, 13, ALIGN_CENTER, STR_CLK1); }
  else con_text(s++, FILL_B(C_PRIMARY, B50), 49, 34, 13, ALIGN_CENTER, STR_CLK1);
  if (run && turn == 1) { con_rect(s++, FILL(C_SECONDARY), 188, 21, 38, 16); con_text(s++, FILL(C_BLACK), 207, 34, 13, ALIGN_CENTER, STR_CLK2); }
  else con_text(s++, FILL_B(C_SECONDARY, B50), 207, 34, 13, ALIGN_CENTER, STR_CLK2);
  if (me == 0) con_diam(s++, FILL(C_ACCENT), 25, 13, 6, 6);
  if (me == 1) con_diam(s++, FILL(C_ACCENT), 231, 13, 6, 6);

  /* status line */
  const char *t = ""; u8 col = FILL(C_PRIMARY);
  if (state == S_WAIT) { t = me == 1 ? "WAITING FOR P1" : "WAITING FOR P2"; col = FILL_B(C_PRIMARY, B75); }
  else if (state == S_OVER) {
    if (winner == DRAW) { t = "DRAW"; col = FILL(C_ACCENT); }
    else if (me == 2) { t = winner == 0 ? "P1 WINS" : "P2 WINS"; col = FILL(winner == 0 ? C_PRIMARY : C_SECONDARY); }
    else if (winner == me) { t = "YOU WIN"; col = FILL(C_SUCCESS); }
    else { t = "YOU LOSE"; col = FILL(C_ERROR); }
  }
  else if (me < 2 && confirm[me]) { t = "A=RESIGN B=BACK"; col = FILL(C_ERROR); }
  else if (me < 2 && !present[1 - me]) { t = me == 0 ? "P2 IS AWAY" : "P1 IS AWAY"; col = FILL_B(C_PRIMARY, B75); }
  else if (me == turn) { t = chain ? "TAKE AGAIN" : need ? "YOU MUST TAKE" : "YOUR TURN"; col = FILL(C_ACCENT); }
  else { t = turn == 0 ? "P1 TURN" : "P2 TURN"; col = FILL_B(turn == 0 ? C_PRIMARY : C_SECONDARY, B75); }
  con_str(STR_STATUS, t);
  con_text(s++, col, 128, 251, 9, ALIGN_CENTER, STR_STATUS);

  /* a note at the top: draw offers during play, rematch after the game */
  const char *n = "";
  if (state == S_PLAY && (offer[0] || offer[1])) {
    if (me < 2 && offer[me]) n = "DRAW OFFERED";
    else n = offer[0] ? "P1 OFFERS DRAW" : "P2 OFFERS DRAW";
  } else if (state == S_OVER && (rematch[0] || rematch[1])) {
    if (me < 2 && rematch[me]) n = "REMATCH SENT";
    else n = rematch[0] ? "P1 WANTS REMATCH" : "P2 WANTS REMATCH";
  }
  if (n[0]) { con_str(STR_NOTE, n); con_text(s++, FILL(C_ACCENT), 128, 30, 7, ALIGN_CENTER, STR_NOTE); }
}
