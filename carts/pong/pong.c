/* PONG — 2 players, 60 Hz while a point is played, no timer at all otherwise.
 *
 * Each player sees their own paddle at the bottom: player 2's view is the same
 * court turned half a circle. Stick left / right moves the paddle. First to 5.
 * After the match, button 2 asks for a rematch; it starts when both asked.
 *
 * The ball and the paddles are Motion OPs: the server sends them when they
 * change direction, the client moves them in between. Your own paddle is also
 * bound to your stick, so it answers at once.
 */
#include "console.h"

const u8 cart_players = 2;

enum { S_WAIT, S_SERVE, S_PLAY, S_OVER };
enum { SFX_PADDLE, SFX_WALL, SFX_POINT, SFX_WIN, SFX_LOSE };
enum { STR_S1, STR_S2, STR_STATUS };
enum { SL_LINE = 0, SL_SCORE1 = 8, SL_SCORE2, SL_PAD1, SL_PAD2, SL_BALL, SL_STATUS };

#define FP        256          /* ball position and speed are 8.8 fixed point */
#define PAD_W     40
#define PAD_H     5
#define PAD_Y1    236          /* player 1's paddle, court coordinates */
#define PAD_Y2    15           /* player 2's paddle                    */
#define PAD_MIN   (PAD_W / 2)
#define PAD_MAX   (255 - PAD_W / 2)
#define PAD_SPEED 3            /* units per tick */
#define BALL_R    4
#define WIN_SCORE 5

static u8 state, present[2], score[2], winner, rematch[2], timer;
static i32 px[2];              /* paddle centers */
static i8 dir[2];              /* -1, 0, +1 in court coordinates */
static i32 bx, by, vx, vy;     /* ball, 8.8 */

static void serve(u8 to) {
  bx = 128 * FP; by = 128 * FP;
  vx = ((score[0] + score[1]) & 1) ? 150 : -150;
  vy = to == 0 ? 2 * FP : -2 * FP;
  state = S_SERVE; timer = 60;
}

static void start(void) {
  score[0] = score[1] = 0; rematch[0] = rematch[1] = 0;
  px[0] = px[1] = 128;
  con_transition_begin();
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(60);
  con_transition_end();
  serve(0);
}

static void finish(u8 w) {
  state = S_OVER; winner = w;
  con_transition_begin();
  con_label(2, "REMATCH");
  con_tick_rate(0);
  con_transition_end();
  con_sfx(VIEW(w) | VIEW(2), SFX_WIN);
  con_sfx(VIEW(1 - w), SFX_LOSE);
}

void cart_init(void) {
  con_transition_begin();
  con_pal(C_PRIMARY,   0xA6, 0xF3, 0xFF);
  con_pal(C_SECONDARY, 0xFF, 0x7D, 0xB8);
  con_pal(C_ACCENT,    0xFF, 0xE0, 0x8A);
  con_pal(C_HIGHLIGHT, 0xFF, 0xFF, 0xFF);
  con_pal(C_ERROR,     0xFF, 0x5A, 0x5A);
  con_pal(C_SUCCESS,   0x6B, 0xE3, 0x8C);
  con_pal(C_SPARE,     0x80, 0x80, 0x80);
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);
  con_sfx_def(SFX_PADDLE, CH_PULSE1,   DUTY_25, 76, 8,  0,       4,  SFX_DECAY);
  con_sfx_def(SFX_WALL,   CH_TRIANGLE, 0,       64, 12, 0,       4,  SFX_DECAY);
  con_sfx_def(SFX_POINT,  CH_NOISE,    0,       60, 9,  (u8)-12, 25, SFX_DECAY);
  con_sfx_def(SFX_WIN,    CH_PULSE1,   DUTY_50, 72, 9,  12,      50, SFX_DECAY);
  con_sfx_def(SFX_LOSE,   CH_TRIANGLE, 0,       55, 12, (u8)-12, 50, SFX_DECAY);
  con_transition_end();
  px[0] = px[1] = 128; bx = by = 128 * FP;
  state = S_WAIT;
}

void cart_presence(u8 p, u8 on) {
  present[p] = on;
  dir[p] = 0;
  if (state == S_WAIT && present[0] && present[1]) start();
}

void cart_sys(u8 p, u8 code) {
  if (code == SYS_RESIGN && (state == S_PLAY || state == S_SERVE)) finish((u8)(1 - p));
}

void cart_input(u8 p, u8 now, u8 prev) {
  i8 d = in_dx(now);
  dir[p] = p == 1 ? (i8)-d : d;                  /* player 2 looks at the court from the other side */
  if (state == S_OVER && IN_ACTION(now) == 1 && IN_ACTION(prev) != 1) {
    rematch[p] = 1;
    if (rematch[0] && rematch[1]) start();
  }
}

static void point(u8 p) {
  con_sfx(VIEW_ALL, SFX_POINT);
  if (++score[p] >= WIN_SCORE) finish(p); else serve((u8)(1 - p));
}

static void bounce(u8 p) {
  i32 off = bx / FP - px[p];                     /* where on the paddle it landed */
  vx += off * 14;
  if (vx > 3 * FP) vx = 3 * FP;
  if (vx < -3 * FP) vx = -3 * FP;
  vy = -vy; vy += vy > 0 ? 18 : -18;             /* a little faster with every hit */
  if (vy > 5 * FP) vy = 5 * FP;
  if (vy < -5 * FP) vy = -5 * FP;
  con_sfx(VIEW_ALL, SFX_PADDLE);
}

void cart_tick(void) {
  if (state != S_SERVE && state != S_PLAY) return;
  for (u8 p = 0; p < 2; p++) {
    px[p] += dir[p] * PAD_SPEED;
    if (px[p] < PAD_MIN) px[p] = PAD_MIN;
    if (px[p] > PAD_MAX) px[p] = PAD_MAX;
  }
  if (state == S_SERVE) { if (--timer == 0) state = S_PLAY; return; }

  i32 oy = by;
  bx += vx; by += vy;
  if (bx < BALL_R * FP)         { bx = BALL_R * FP;         vx = -vx; con_sfx(VIEW_ALL, SFX_WALL); }
  if (bx > (255 - BALL_R) * FP) { bx = (255 - BALL_R) * FP; vx = -vx; con_sfx(VIEW_ALL, SFX_WALL); }

  i32 hit1 = (PAD_Y1 - BALL_R) * FP, hit2 = (PAD_Y2 + PAD_H + BALL_R) * FP;
  i32 reach = PAD_W / 2 + BALL_R;
  if (vy > 0 && oy < hit1 && by >= hit1) {
    i32 d = bx / FP - px[0];
    if (d >= -reach && d <= reach) { by = hit1; bounce(0); }
  } else if (vy < 0 && oy > hit2 && by <= hit2) {
    i32 d = bx / FP - px[1];
    if (d >= -reach && d <= reach) { by = hit2; bounce(1); }
  }
  if (by > 262 * FP) point(1);
  else if (by < -6 * FP) point(0);
}

/* A paddle in this view: where it is, and how it is moving right now. */
static void paddle(u8 slot, u8 p, u8 flip, u8 role) {
  u8 x = (u8)((flip ? 255 - px[p] : px[p]) - PAD_W / 2);
  u8 y = p == 0 ? (flip ? 255 - PAD_Y1 - PAD_H : PAD_Y1) : (flip ? 255 - PAD_Y2 - PAD_H : PAD_Y2);
  con_rect(slot, FILL(role), x, y, PAD_W, PAD_H);
  i8 d = dir[p];
  if ((d < 0 && px[p] <= PAD_MIN) || (d > 0 && px[p] >= PAD_MAX)) d = 0;       /* against the wall */
  if (flip) d = (i8)-d;
  if (d && (state == S_SERVE || state == S_PLAY)) con_move(slot, 0, 0, (i16)(d * PAD_SPEED * FP), 0);
}

void cart_draw(u8 view) {
  u8 me = view < 2 ? view : 2;                   /* 2 = spectator, sees player 1's side */
  u8 flip = (me == 1);
  char b[2] = {0, 0};

  for (u8 i = 0; i < 8; i++)                     /* the dashed center line */
    con_line((u8)(SL_LINE + i), STROKE_B(C_PRIMARY, B25, 1), (u8)(8 + i * 32), 128, (u8)(24 + i * 32), 128);

  b[0] = (char)('0' + score[0]); con_str(STR_S1, b);
  b[0] = (char)('0' + score[1]); con_str(STR_S2, b);
  con_text(SL_SCORE1, FILL_B(C_PRIMARY,   B50), 128, flip ? 104 : 184, 36, ALIGN_CENTER, STR_S1);
  con_text(SL_SCORE2, FILL_B(C_SECONDARY, B50), 128, flip ? 184 : 104, 36, ALIGN_CENTER, STR_S2);

  paddle(SL_PAD1, 0, flip, C_PRIMARY);
  paddle(SL_PAD2, 1, flip, C_SECONDARY);
  if (me < 2 && (state == S_SERVE || state == S_PLAY))                         /* your stick drives your paddle */
    con_bind(0, (u8)(SL_PAD1 + me), BIND_VEL, PAD_SPEED, 0, 0, 255 - PAD_W, 0, 255);

  i32 uy = by / FP;
  if ((state == S_PLAY || state == S_SERVE) && uy >= BALL_R && uy <= 255 - BALL_R) {
    /* Turned half a circle, a position p becomes 65535 - p in 8.8, and the speed changes sign. */
    u32 x = (u32)(flip ? 0xFFFF - bx : bx), y = (u32)(flip ? 0xFFFF - by : by);
    con_circ(SL_BALL, FILL(C_ACCENT), (u8)(x >> 8), (u8)(y >> 8), BALL_R);
    if (state == S_PLAY) con_move(SL_BALL, (u8)x, (u8)y, (i16)(flip ? -vx : vx), (i16)(flip ? -vy : vy));
  }

  const char *t = ""; u8 col = FILL(C_ACCENT);
  if (state == S_WAIT) { t = me == 1 ? "WAITING FOR P1" : "WAITING FOR P2"; col = FILL_B(C_PRIMARY, B75); }
  else if (state == S_SERVE) t = "READY";
  else if (state == S_OVER) {
    if (me == 2) t = winner == 0 ? "P1 WINS" : "P2 WINS";
    else if (rematch[me]) t = "REMATCH SENT";
    else if (rematch[1 - me]) t = "REMATCH?";
    else if (winner == me) { t = "YOU WIN"; col = FILL(C_SUCCESS); }
    else { t = "YOU LOSE"; col = FILL(C_ERROR); }
  }
  if (t[0]) { con_str(STR_STATUS, t); con_text(SL_STATUS, col, 128, 150, 10, ALIGN_CENTER, STR_STATUS); }
}
