/* DAMA — 2-player checkers on the dark squares of an 8 x 8 board.
 *
 * Rules:
 *   - A man moves one square diagonally forward. It captures by jumping an enemy
 *     piece next to it, forward or backward, onto the empty square behind it.
 *   - A man that ends its move on the far row becomes a king, drawn as two
 *     stacked discs. A man that only passes the far row in the middle of a
 *     capture stays a man.
 *   - A king flies: it moves any number of empty squares along a diagonal, and
 *     captures a piece at any distance along a diagonal, landing on any empty
 *     square behind it.
 *   - Capturing is forced, and so is the longest capture: you must take as many
 *     pieces as you can (a king counts as one piece). Jumped pieces leave the
 *     board only when the whole move ends: until then they block the way and
 *     cannot be jumped a second time.
 *   - Clocks: 5 minutes each. Only the clock of the side to move runs, and it is
 *     drawn inverted. The clocks stop while a player is away.
 *   - Win: the other side has no pieces, cannot move, resigns, or runs out of time.
 *   - Draw: the same position for the third time with the same side to move;
 *     25 moves each with only kings moving and nothing taken; a lone king that
 *     holds out 16 moves each against three pieces with a king, or 5 moves each
 *     against one or two pieces with a king; a draw offer that is accepted.
 *
 * Controls: stick = cursor, A = pick a piece, then its square, B = cancel.
 * Button 2 = RESIGN (then A to confirm), button 3 = DRAW (offer, or accept).
 * After the game, button 2 = REMATCH; it starts when both asked.
 * On your turn, your pieces that cannot move are dimmed.
 * Each player sees their own side at the bottom and only their own cursor.
 *
 * The tick is 10 Hz so that a held stick repeats and the clocks count; a tick
 * that changes nothing sends nothing.
 */
#include "console.h"

const u8 cart_players = 2;

#define CLOCK_SECONDS 300
#define TICK_HZ       10
#define REPEAT_AFTER  3        /* ticks a stick is held before the cursor repeats */

enum { S_WAIT, S_PLAY, S_OVER };
enum { SFX_MOVE, SFX_TAKE, SFX_NO, SFX_WIN, SFX_LOSE, SFX_KING, SFX_DRAW };
enum { STR_P1, STR_P2, STR_STATUS, STR_NOTE, STR_CLK1, STR_CLK2 };
enum { EMPTY, MAN1, MAN2, KING1, KING2 };
#define NOBODY 2               /* `winner` of a drawn game */

/* the board on screen */
#define X0 32
#define Y0 44
#define SQ 24
/* slots: slot order is layer order */
#define SL_SQUARE 0            /* 32 dark squares                         */
#define SL_BORDER 32
#define SL_DISC   33           /* 32: a man, or the lower disc of a king  */
#define SL_GAP    65           /* 32: the black gap between a king's discs */
#define SL_TOP    97           /* 32: the upper disc of a king            */
#define SL_HINT   129          /* 16: where the picked piece can go       */
#define SL_PICK   145
#define SL_CURSOR 146
#define SL_HUD    147

static u8 sq[8][8];            /* EMPTY, MAN1, MAN2, KING1, KING2 */
static u8 hit[8][8];           /* jumped in the move being played: still standing until it ends */
static u8 can[8][8];           /* pieces of the side to move that may move now */
static u8 state, turn, winner, present[2];
static u8 owed;                /* captures the side to move must still make (0 = a free move) */
static u8 chain, chain_r, chain_c;       /* a capture is under way with this piece */
static u8 cur_r[2], cur_c[2];            /* cursors, board coordinates */
static u8 picked[2], pick_r[2], pick_c[2];
static u8 asking[2];                     /* "A = RESIGN, B = BACK" is up */
static u8 offer[2], rematch[2];
static u16 clock_s[2];
static u8 tenth;                         /* ticks into the running second */
static u8 stick[2], held[2];             /* the stick as last sent, and for how many ticks */

/* what a draw needs to be noticed */
static u32 seen[64]; static u8 seen_n;   /* positions since the last man move or capture */
static u8 quiet;                         /* plies in a row with only kings moving and nothing taken */
static u8 lone_kind, lone_plies;         /* a lone king holding out */
static u8 move_took, move_man;           /* what the move being played did */
static u8 jump_r, jump_c;                /* the piece legal() found in the way */

static const i8 DR[4] = {-1, -1, 1, 1}, DC[4] = {-1, 1, -1, 1};

static u8 side(u8 v)       { return v ? (u8)((v - 1) & 1) : NOBODY; }
static u8 king(u8 v)       { return v >= KING1; }
static u8 on(i8 r, i8 c)   { return r >= 0 && r < 8 && c >= 0 && c < 8; }
static i8 forward(u8 p)    { return p == 0 ? -1 : 1; }
static u8 far_row(u8 p)    { return p == 0 ? 0 : 7; }

/* The most pieces that piece `v`, standing on (r, c), can still take in this move.
 * The piece itself has been lifted off the board by the caller. */
static u8 most(i8 r, i8 c, u8 v) {
  u8 best = 0;
  for (u8 d = 0; d < 4; d++) {
    i8 dr = DR[d], dc = DC[d], er = (i8)(r + dr), ec = (i8)(c + dc);
    if (king(v)) while (on(er, ec) && !sq[er][ec]) { er = (i8)(er + dr); ec = (i8)(ec + dc); }   /* fly to the first piece */
    if (!on(er, ec)) continue;
    u8 e = sq[er][ec];
    if (!e || side(e) == side(v) || hit[er][ec]) continue;
    hit[er][ec] = 1;
    for (i8 tr = (i8)(er + dr), tc = (i8)(ec + dc); on(tr, tc) && !sq[tr][tc]; tr = (i8)(tr + dr), tc = (i8)(tc + dc)) {
      u8 n = (u8)(1 + most(tr, tc, v));
      if (n > best) best = n;
      if (!king(v)) break;                       /* a man lands right behind the piece */
    }
    hit[er][ec] = 0;
  }
  return best;
}
static u8 most_from(u8 r, u8 c) { u8 v = sq[r][c]; sq[r][c] = EMPTY; u8 n = most((i8)r, (i8)c, v); sq[r][c] = v; return n; }

static u8 has_step(u8 r, u8 c) {
  u8 v = sq[r][c];
  for (u8 d = 0; d < 4; d++) {
    if (!king(v) && DR[d] != forward(side(v))) continue;
    i8 tr = (i8)(r + DR[d]), tc = (i8)(c + DC[d]);
    if (on(tr, tc) && !sq[tr][tc]) return 1;
  }
  return 0;
}

/* Work out what the side to move may do. Called after every change of the board. */
static void plan(void) {
  u8 cap[8][8], best = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) { can[r][c] = 0; cap[r][c] = 0; }
  if (chain) { can[chain_r][chain_c] = 1; owed = most_from(chain_r, chain_c); return; }   /* the same piece goes on */
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++)
    if (side(sq[r][c]) == turn) { cap[r][c] = most_from(r, c); if (cap[r][c] > best) best = cap[r][c]; }
  owed = best;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++)
    if (side(sq[r][c]) == turn) can[r][c] = best ? (cap[r][c] == best) : has_step(r, c);
}

static u8 any_move(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (can[r][c]) return 1;
  return 0;
}

/* May player p move the piece on (fr, fc) to (tr, tc) now?
 * 0 = no, 1 = a step, 2 = a capture (jump_r, jump_c is then the piece taken). */
static u8 legal(u8 p, u8 fr, u8 fc, u8 tr, u8 tc) {
  if (p != turn || !can[fr][fc] || sq[tr][tc]) return 0;
  i8 dr = (i8)(tr - fr), dc = (i8)(tc - fc);
  i8 dist = (i8)(dr < 0 ? -dr : dr);
  if (!dist || (dc != dr && dc != -dr)) return 0;      /* diagonals only */
  i8 sr = (i8)(dr < 0 ? -1 : 1), sc = (i8)(dc < 0 ? -1 : 1);
  u8 v = sq[fr][fc], enemies = 0;
  for (i8 k = 1; k < dist; k++) {
    u8 r = (u8)(fr + sr * k), c = (u8)(fc + sc * k), m = sq[r][c];
    if (!m) continue;
    if (side(m) == p || hit[r][c]) return 0;           /* own pieces and jumped pieces block */
    enemies++; jump_r = r; jump_c = c;
  }
  if (!owed) return king(v) ? enemies == 0 : (dist == 1 && sr == forward(p));
  if (enemies != 1 || (!king(v) && dist != 2)) return 0;
  /* a capture is only allowed if it still leads to the most pieces */
  sq[fr][fc] = EMPTY; hit[jump_r][jump_c] = 1;
  u8 n = (u8)(1 + most((i8)tr, (i8)tc, v));
  hit[jump_r][jump_c] = 0; sq[fr][fc] = v;
  return n == owed ? 2 : 0;
}

static u8 count(u8 p) {
  u8 n = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (side(sq[r][c]) == p && !hit[r][c]) n++;
  return n;
}
static u8 kings(u8 p) {
  u8 n = 0;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (sq[r][c] == KING1 + p) n++;
  return n;
}
static void clear_jumped(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if (hit[r][c]) { hit[r][c] = 0; sq[r][c] = EMPTY; }
}

static void play_on(void) {
  state = S_PLAY;
  con_transition_begin();
  con_label(2, "RESIGN"); con_label(3, "DRAW"); con_label(4, "");
  con_tick_rate(TICK_HZ);
  con_transition_end();
  con_music(MUSIC_PLAY, 0);
}

static void set_up(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) {
    sq[r][c] = ((r + c) & 1) ? (r < 3 ? MAN2 : r > 4 ? MAN1 : EMPTY) : EMPTY;
    hit[r][c] = 0;
  }
  turn = 0; winner = 0; chain = 0; owed = 0; tenth = 0;
  seen_n = 0; quiet = 0; lone_kind = 0; lone_plies = 0; move_took = 0; move_man = 0;
  for (u8 p = 0; p < 2; p++) { picked[p] = asking[p] = rematch[p] = offer[p] = 0; clock_s[p] = CLOCK_SECONDS; }
  cur_r[0] = 5; cur_c[0] = 0; cur_r[1] = 2; cur_c[1] = 7;
  plan();
}

/* w = 0 or 1: that player wins. w = NOBODY: a draw. */
static void end_game(u8 w) {
  state = S_OVER; winner = w; chain = 0;
  picked[0] = picked[1] = asking[0] = asking[1] = offer[0] = offer[1] = 0;
  clear_jumped();
  con_transition_begin();
  con_label(2, "REMATCH"); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);
  con_transition_end();
  con_music(MUSIC_STOP, 0);
  if (w == NOBODY) con_sfx(VIEW_ALL, SFX_DRAW);
  else { con_sfx(VIEW(w) | VIEW(2), SFX_WIN); con_sfx(VIEW(1 - w), SFX_LOSE); }
}

static u32 position(void) {                      /* a hash of the board and the side to move */
  u32 h = 2166136261u;
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) if ((r + c) & 1) h = (h ^ sq[r][c]) * 16777619u;
  return (h ^ turn) * 16777619u;
}

/* A move has ended and the turn has passed. Is the game drawn? */
static u8 drawn(void) {
  if (move_took || move_man) { seen_n = 0; quiet = 0; }      /* nothing before this can come back */
  else if (quiet < 250) quiet++;
  if (quiet >= 50) return 1;                                 /* 25 moves each */

  u32 h = position(); u8 times = 0;
  for (u8 i = 0; i < seen_n; i++) if (seen[i] == h) times++;
  if (times >= 2) return 1;                                  /* this is the third time */
  if (seen_n < 64) seen[seen_n++] = h;

  u8 kind = 0;                                               /* a lone king holding out */
  for (u8 p = 0; p < 2; p++) {
    u8 mine = count(p), theirs = count((u8)(1 - p));
    if (mine == 1 && kings(p) == 1 && kings((u8)(1 - p)) >= 1) kind = theirs == 3 ? 1 : (theirs == 1 || theirs == 2) ? 2 : kind;
  }
  if (kind != lone_kind) { lone_kind = kind; lone_plies = 0; }
  else if (kind && lone_plies < 250) lone_plies++;
  return (kind == 1 && lone_plies >= 32) || (kind == 2 && lone_plies >= 10);
}

static void move(u8 p, u8 fr, u8 fc, u8 tr, u8 tc, u8 how) {
  u8 v = sq[fr][fc];
  sq[fr][fc] = EMPTY; sq[tr][tc] = v;
  offer[0] = offer[1] = 0;                             /* playing on answers a draw offer with "no" */
  if (!king(v)) move_man = 1;
  if (how == 2) {
    hit[jump_r][jump_c] = 1; move_took = 1;            /* it leaves the board when the whole move ends */
    con_sfx(VIEW_ALL, SFX_TAKE);
    chain = 1; chain_r = tr; chain_c = tc;
    plan();
    if (owed) { picked[p] = 1; pick_r[p] = tr; pick_c[p] = tc; return; }      /* more to take: same piece, same turn */
  } else con_sfx(VIEW(1 - p) | VIEW(2), SFX_MOVE);     /* the mover's own click is local */

  /* the move ends here */
  clear_jumped();
  if (!king(v) && tr == far_row(p)) { sq[tr][tc] = (u8)(KING1 + p); con_sfx(VIEW_ALL, SFX_KING); }
  chain = 0; picked[p] = 0;
  turn = (u8)(1 - p);
  plan();
  if (!any_move()) end_game(p);
  else if (drawn()) end_game(NOBODY);
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
  con_sfx_def(SFX_MOVE, CH_PULSE1,   DUTY_25, 72, 8,  0,       6,  SFX_DECAY);
  con_sfx_def(SFX_TAKE, CH_NOISE,    0,       64, 9,  (u8)-12, 12, SFX_DECAY);
  con_sfx_def(SFX_NO,   CH_PULSE2,   DUTY_50, 45, 7,  (u8)-3,  10, SFX_DECAY);
  con_sfx_def(SFX_WIN,  CH_PULSE1,   DUTY_50, 72, 9,  12,      50, SFX_DECAY);
  con_sfx_def(SFX_LOSE, CH_TRIANGLE, 0,       55, 12, (u8)-12, 50, SFX_DECAY);
  con_sfx_def(SFX_KING, CH_PULSE2,   DUTY_25, 84, 8,  7,       20, SFX_DECAY);
  con_sfx_def(SFX_DRAW, CH_TRIANGLE, 0,       64, 11, 0,       40, SFX_DECAY);
  static const u8 song[16 * 4] = {               /* a calm loop: pulse 1, pulse 2, triangle, noise */
    76,0,48,0,  0,0,0,0,  0,0,55,0,  0,0,0,0,   79,0,57,0,  0,0,0,0,  0,0,53,0,  0,0,0,0,
    74,0,48,0,  0,0,0,0,  0,0,55,0,  72,0,0,0,  0,0,52,0,   0,0,0,0,  0,0,55,0,  0,0,0,0 };
  con_music_def(0, 28, 16, 4, song);
  con_transition_end();
  set_up();
  state = S_WAIT;
}

void cart_presence(u8 p, u8 on_) {
  present[p] = on_;
  stick[p] = 0;
  if (state == S_WAIT && present[0] && present[1]) play_on();
}

/* One cursor step the way the stick points. Player 2 looks at the board from the other side. */
static void step_cursor(u8 p, u8 in) {
  i8 dx = in_dx(in), dy = in_dy(in);
  if (p == 1) { dx = (i8)-dx; dy = (i8)-dy; }
  i8 r = (i8)(cur_r[p] + dy), c = (i8)(cur_c[p] + dx);
  if (r >= 0 && r < 8) cur_r[p] = (u8)r;
  if (c >= 0 && c < 8) cur_c[p] = (u8)c;
}

void cart_tick(void) {
  if (state != S_PLAY) return;
  for (u8 p = 0; p < 2; p++)                           /* a held stick repeats */
    if (IN_ACTIVE(stick[p]) && ++held[p] > REPEAT_AFTER) step_cursor(p, stick[p]);
  if (!present[0] || !present[1]) return;              /* the clocks wait for a player who is away */
  if (++tenth < TICK_HZ) return;
  tenth = 0;
  if (clock_s[turn]) clock_s[turn]--;
  if (!clock_s[turn]) end_game((u8)(1 - turn));
}

void cart_sys(u8 p, u8 code) {
  if (code == SYS_RESIGN && state == S_PLAY) end_game((u8)(1 - p));
}

void cart_input(u8 p, u8 now, u8 prev) {
  u8 pressed = (u8)(now & ~prev);
  u8 act = IN_ACTION(now) != IN_ACTION(prev) ? IN_ACTION(now) : 0;
  stick[p] = now;                                      /* also after the game: a stick let go then must not repeat later */

  if (state == S_OVER) {
    if (act == 1 && !rematch[p]) {
      rematch[p] = 1;
      if (rematch[0] && rematch[1]) { set_up(); play_on(); }
    }
    return;
  }

  /* the cursor: one step at once on a push or a change of direction (the client does the
     same step by itself, see con_bind), then it repeats while the stick is held */
  if (IN_ACTIVE(now) && (!IN_ACTIVE(prev) || IN_DIR(now) != IN_DIR(prev))) { held[p] = 0; step_cursor(p, now); }

  if (state != S_PLAY) return;
  if (act == 1) asking[p] = 1;
  if (act == 2) {                                      /* DRAW: offer one, or accept the other player's */
    offer[p] = 1;
    if (offer[1 - p]) { end_game(NOBODY); return; }
  }

  if (pressed & IN_B) {
    if (asking[p]) asking[p] = 0;
    else if (offer[p]) offer[p] = 0;                   /* take your own offer back */
    else if (!chain) picked[p] = 0;
  }
  if (pressed & IN_A) {
    if (asking[p]) { end_game((u8)(1 - p)); return; }
    if (turn != p) { con_sfx(VIEW(p), SFX_NO); return; }
    u8 r = cur_r[p], c = cur_c[p];
    if (picked[p]) {
      u8 how = legal(p, pick_r[p], pick_c[p], r, c);
      if (how) { move(p, pick_r[p], pick_c[p], r, c, how); return; }
      if (!chain && r == pick_r[p] && c == pick_c[p]) { picked[p] = 0; return; }       /* A on it again: put it down */
    }
    if (!chain && can[r][c]) { picked[p] = 1; pick_r[p] = r; pick_c[p] = c; }
    else con_sfx(VIEW(p), SFX_NO);
  }
}

/* ---- drawing ---------------------------------------------------------- */
static u8 flip;                                        /* this view has player 2 at the bottom */
static u8 sx(u8 c) { return (u8)(X0 + (flip ? 7 - c : c) * SQ); }
static u8 sy(u8 r) { return (u8)(Y0 + (flip ? 7 - r : r) * SQ); }

static void tag(char *o, u8 p, u8 n) {
  o[0] = 'P'; o[1] = (char)('1' + p); o[2] = ' '; o[3] = (char)('0' + n / 10); o[4] = (char)('0' + n % 10); o[5] = 0;
}
static void clock_text(char *o, u16 s) {
  o[0] = (char)('0' + s / 60 % 10); o[1] = ':'; o[2] = (char)('0' + (s % 60) / 10); o[3] = (char)('0' + s % 10); o[4] = 0;
}

void cart_draw(u8 view) {
  u8 me = view < 2 ? view : 2;                         /* 2 = spectator */
  u8 my_turn = state == S_PLAY && me == turn;
  char buf[17];
  flip = (me == 1);

  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) {
    if (!((r + c) & 1)) continue;
    u8 i = (u8)(r * 4 + (c >> 1)), v = sq[r][c];
    con_rect((u8)(SL_SQUARE + i), FILL_B(C_PRIMARY, B25), sx(c), sy(r), SQ, SQ);
    if (!v) continue;
    u8 role = side(v) == 0 ? C_PRIMARY : C_SECONDARY;
    /* dimmed: a piece jumped in this move, or on your turn a piece of yours that cannot move */
    u8 br = hit[r][c] ? B25 : (my_turn && side(v) == me && !can[r][c]) ? B50 : B100;
    u8 x = (u8)(sx(c) + SQ / 2), y = (u8)(sy(r) + SQ / 2);
    if (!king(v)) con_circ((u8)(SL_DISC + i), FILL_B(role, br), x, y, 8);
    else {                                             /* a king: two stacked discs */
      con_circ((u8)(SL_DISC + i), FILL_B(role, br), x, (u8)(y + 3), 8);
      con_circ((u8)(SL_GAP + i),  FILL(C_BLACK),    x, (u8)(y - 2), 9);      /* black is the eraser */
      con_circ((u8)(SL_TOP + i),  FILL_B(role, br), x, (u8)(y - 3), 8);
    }
  }
  con_rect(SL_BORDER, STROKE(C_PRIMARY, 1), X0, Y0, 8 * SQ, 8 * SQ);

  if (me < 2 && state == S_PLAY && picked[me]) {       /* the picked piece and where it may go */
    u8 n = 0;
    con_circ(SL_PICK, STROKE(C_ACCENT, 2), (u8)(sx(pick_c[me]) + SQ / 2), (u8)(sy(pick_r[me]) + SQ / 2), 11);
    for (u8 d = 0; d < 4; d++) for (i8 k = 1; k < 8; k++) {
      i8 tr = (i8)(pick_r[me] + DR[d] * k), tc = (i8)(pick_c[me] + DC[d] * k);
      if (!on(tr, tc)) break;
      if (n < 16 && legal(me, pick_r[me], pick_c[me], (u8)tr, (u8)tc))
        con_circ((u8)(SL_HINT + n++), FILL(C_ACCENT), (u8)(sx((u8)tc) + SQ / 2), (u8)(sy((u8)tr) + SQ / 2), 3);
    }
  }
  if (me < 2 && state != S_OVER) {
    con_rect(SL_CURSOR, STROKE(C_HIGHLIGHT, 2), (u8)(sx(cur_c[me]) + 1), (u8)(sy(cur_r[me]) + 1), SQ - 2, SQ - 2);
    /* your stick steps your cursor one square, on your own screen, in the direction you push */
    con_bind(0, SL_CURSOR, BIND_STEP, SQ, SQ, X0 + 1, X0 + 1 + 7 * SQ, Y0 + 1, Y0 + 1 + 7 * SQ);
  }

  /* pieces left and clocks. A small diamond marks your own side.
     The running clock is inverted: a filled box with black digits. */
  u8 s = SL_HUD, run = state == S_PLAY;
  tag(buf, 0, count(0)); con_str(STR_P1, buf);
  tag(buf, 1, count(1)); con_str(STR_P2, buf);
  clock_text(buf, clock_s[0]); con_str(STR_CLK1, buf);
  clock_text(buf, clock_s[1]); con_str(STR_CLK2, buf);
  con_text(s++, FILL(C_PRIMARY),   32,  16, 8, ALIGN_LEFT,  STR_P1);
  con_text(s++, FILL(C_SECONDARY), 224, 16, 8, ALIGN_RIGHT, STR_P2);
  if (run && turn == 0) { con_rect(s++, FILL(C_PRIMARY), 30, 21, 38, 16); con_text(s++, FILL(C_BLACK), 49, 34, 13, ALIGN_CENTER, STR_CLK1); }
  else con_text(s++, FILL_B(C_PRIMARY, B50), 49, 34, 13, ALIGN_CENTER, STR_CLK1);
  if (run && turn == 1) { con_rect(s++, FILL(C_SECONDARY), 188, 21, 38, 16); con_text(s++, FILL(C_BLACK), 207, 34, 13, ALIGN_CENTER, STR_CLK2); }
  else con_text(s++, FILL_B(C_SECONDARY, B50), 207, 34, 13, ALIGN_CENTER, STR_CLK2);
  if (me == 0) con_diam(s++, FILL(C_ACCENT), 25, 13, 6, 6);
  if (me == 1) con_diam(s++, FILL(C_ACCENT), 231, 13, 6, 6);

  const char *t; u8 col = FILL(C_PRIMARY);
  if (state == S_WAIT) { t = me == 1 ? "WAITING FOR P1" : "WAITING FOR P2"; col = FILL_B(C_PRIMARY, B75); }
  else if (state == S_OVER) {
    if (winner == NOBODY) { t = "DRAW"; col = FILL(C_ACCENT); }
    else if (me == 2) { t = winner == 0 ? "P1 WINS" : "P2 WINS"; col = FILL(winner == 0 ? C_PRIMARY : C_SECONDARY); }
    else if (winner == me) { t = "YOU WIN"; col = FILL(C_SUCCESS); }
    else { t = "YOU LOSE"; col = FILL(C_ERROR); }
  }
  else if (me < 2 && asking[me]) { t = "A=RESIGN B=BACK"; col = FILL(C_ERROR); }
  else if (me < 2 && !present[1 - me]) { t = me == 0 ? "P2 IS AWAY" : "P1 IS AWAY"; col = FILL_B(C_PRIMARY, B75); }
  else if (me == turn) { t = chain ? "TAKE AGAIN" : owed ? "YOU MUST TAKE" : "YOUR TURN"; col = FILL(C_ACCENT); }
  else { t = turn == 0 ? "P1 TURN" : "P2 TURN"; col = FILL_B(turn == 0 ? C_PRIMARY : C_SECONDARY, B75); }
  con_str(STR_STATUS, t);
  con_text(s++, col, 128, 251, 9, ALIGN_CENTER, STR_STATUS);

  const char *n = "";                                  /* a note at the top: draw offers, rematch */
  if (state == S_PLAY && (offer[0] || offer[1])) {
    if (me < 2 && offer[me]) n = "DRAW OFFERED";
    else n = offer[0] ? "P1 OFFERS DRAW" : "P2 OFFERS DRAW";
  } else if (state == S_OVER && (rematch[0] || rematch[1])) {
    if (me < 2 && rematch[me]) n = "REMATCH SENT";
    else n = rematch[0] ? "P1 WANTS REMATCH" : "P2 WANTS REMATCH";
  }
  if (n[0]) { con_str(STR_NOTE, n); con_text(s++, FILL(C_ACCENT), 128, 30, 7, ALIGN_CENTER, STR_NOTE); }
}
