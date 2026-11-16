/* FLAP — 2-player Flappy Bird, both birds on one screen, 60 Hz.
 *
 * Both players fly through the same pipes at the same moment and see each
 * other. A (or B, or stick up) flaps. A pipe or the ground ends your flight.
 * Every pipe passed is a point. The match ends when both are down, or as soon
 * as the bird still flying has more points than the one that fell.
 * After the match, button 2 asks for a rematch.
 *
 * The world scrolls at a steady speed, so pipes and ground marks are Motion
 * OPs: sent when they appear, moved by the client after that.
 */
#include "console.h"

const u8 cart_players = 2;

enum { S_WAIT, S_READY, S_PLAY, S_OVER };
enum { SFX_FLAP, SFX_POINT, SFX_HIT, SFX_WIN, SFX_LOSE, SFX_GO };
enum { STR_S1, STR_S2, STR_STATUS };
enum { SL_STAR = 0, SL_PIPE = 10, SL_GROUND = 30, SL_MARK = 31, SL_RIVAL = 40, SL_ME = 44, SL_ARROW = 48, SL_S1 = 50, SL_S2, SL_STATUS };
#define NOBODY 2

#define FP        256
#define BIRD_X    80           /* both birds fly at the same x: same pipes, same moment */
#define BIRD_R    6
#define GROUND    232
#define PIPE_W    26
#define PIPE_0    300          /* world x of the first pipe */
#define PIPE_STEP 112
#define SPEED     384          /* world scroll per tick, 8.8 (1.5 units) */
#define GRAVITY   28
#define FLAP_V    (-610)
#define MAX_FALL  900

static u8 state, present[2], winner, rematch[2];
static u16 timer;
static i32 scroll;             /* 8.8 */
static i32 y[2], vy[2];        /* 8.8 */
static u8 alive[2], score[2];
static i32 fell_at[2];         /* world x where a bird went down */
static u32 seed;

/* The pipes: one sequence per match, the same for both players. */
static i32 gap_y(i32 k)    { u32 h = ((u32)k + seed) * 2654435761u; return 62 + (i32)((h >> 16) % 108); }
static i32 gap_half(i32 k) { return 37 - (k > 9 ? 9 : k); }      /* the gaps get tighter */

static void begin(void) {
  seed += 40503;
  scroll = 0; timer = 0;
  for (u8 p = 0; p < 2; p++) { y[p] = (104 + p * 20) * FP; vy[p] = 0; alive[p] = 1; score[p] = 0; rematch[p] = 0; }
  state = S_READY;
  con_transition_begin();
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(60);
  con_transition_end();
}

static void finish(void) {
  state = S_OVER;
  winner = score[0] == score[1] ? NOBODY : score[0] > score[1] ? 0 : 1;
  con_transition_begin();
  con_label(2, "REMATCH");
  con_tick_rate(0);
  con_transition_end();
  if (winner != NOBODY) { con_sfx(VIEW(winner) | VIEW(2), SFX_WIN); con_sfx(VIEW(1 - winner), SFX_LOSE); }
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
  con_sfx_def(SFX_FLAP,  CH_TRIANGLE, 0,       62, 10, 7,       6,  SFX_DECAY);
  con_sfx_def(SFX_POINT, CH_PULSE1,   DUTY_25, 79, 8,  5,       9,  SFX_DECAY);
  con_sfx_def(SFX_HIT,   CH_NOISE,    0,       54, 11, (u8)-14, 22, SFX_DECAY);
  con_sfx_def(SFX_WIN,   CH_PULSE1,   DUTY_50, 72, 9,  12,      50, SFX_DECAY);
  con_sfx_def(SFX_LOSE,  CH_TRIANGLE, 0,       55, 12, (u8)-12, 50, SFX_DECAY);
  con_sfx_def(SFX_GO,    CH_PULSE1,   DUTY_50, 76, 8,  0,       20, SFX_DECAY);
  con_transition_end();
  seed = 2026;
  y[0] = 104 * FP; y[1] = 124 * FP;
  state = S_WAIT;
}

void cart_presence(u8 p, u8 on) {
  present[p] = on;
  if (state == S_WAIT && present[0] && present[1]) begin();
}

void cart_sys(u8 p, u8 code) {
  if (code == SYS_RESIGN && (state == S_PLAY || state == S_READY)) { score[p] = 0; score[1 - p] = 1; finish(); }
}

void cart_input(u8 p, u8 now, u8 prev) {
  if (state == S_OVER) {
    if (IN_ACTION(now) == 1 && IN_ACTION(prev) != 1) { rematch[p] = 1; if (rematch[0] && rematch[1]) begin(); }
    return;
  }
  u8 pressed = (u8)(now & ~prev);
  u8 up = in_dy(now) < 0 && in_dy(prev) >= 0;
  if (state == S_PLAY && alive[p] && ((pressed & (IN_A | IN_B)) || up)) {
    vy[p] = FLAP_V;
    con_sfx(VIEW(1 - p) | VIEW(2), SFX_FLAP);        /* your own flap clicks on your own device */
  }
}

static void down(u8 p) {
  alive[p] = 0; fell_at[p] = scroll / FP + BIRD_X;
  con_sfx(VIEW_ALL, SFX_HIT);
}

void cart_tick(void) {
  if (state == S_READY) {
    timer++;
    for (u8 p = 0; p < 2; p++) y[p] = (104 + p * 20) * FP + (((timer / 12) & 1) ? 2 * FP : -2 * FP);   /* hover */
    if (timer >= 100) { state = S_PLAY; vy[0] = vy[1] = FLAP_V; con_sfx(VIEW_ALL, SFX_GO); }
    return;
  }
  if (state != S_PLAY) return;
  scroll += SPEED;
  i32 wx = scroll / FP + BIRD_X;                     /* the birds' world x */

  for (u8 p = 0; p < 2; p++) {
    vy[p] += GRAVITY;
    if (vy[p] > MAX_FALL) vy[p] = MAX_FALL;
    y[p] += vy[p];
    if (y[p] < BIRD_R * FP) { y[p] = BIRD_R * FP; vy[p] = 0; }
    i32 by = y[p] / FP;
    if (by + BIRD_R >= GROUND) {                     /* on the ground */
      y[p] = (GROUND - BIRD_R) * FP; vy[p] = 0;
      if (alive[p]) down(p);
      continue;
    }
    if (!alive[p]) continue;

    i32 k = wx + BIRD_R < PIPE_0 ? 0 : (wx + BIRD_R - PIPE_0) / PIPE_STEP;      /* the pipe the bird is at, or the next */
    i32 px = PIPE_0 + k * PIPE_STEP;
    if (wx + BIRD_R - 1 > px && wx - BIRD_R + 1 < px + PIPE_W &&
        (by - BIRD_R + 1 < gap_y(k) - gap_half(k) || by + BIRD_R - 1 > gap_y(k) + gap_half(k))) { down(p); continue; }

    i32 passed = wx - BIRD_R < PIPE_0 + PIPE_W ? 0 : (wx - BIRD_R - PIPE_0 - PIPE_W) / PIPE_STEP + 1;
    if (passed > score[p] && passed < 250) { score[p] = (u8)passed; con_sfx(VIEW(p), SFX_POINT); }
  }

  if (!alive[0] && !alive[1]) finish();
  else if (!alive[0] && score[1] > score[0]) finish();
  else if (!alive[1] && score[0] > score[1]) finish();
}

/* ---- drawing --------------------------------------------------------- */
/* A rectangle cut to the screen. Returns 1 if nothing had to be cut. */
static u8 rect(u8 slot, u8 col, i32 rx, i32 ry, i32 w, i32 h) {
  u8 whole = 1;
  if (rx < 0) { w += rx; rx = 0; whole = 0; }
  if (ry < 0) { h += ry; ry = 0; whole = 0; }
  if (rx + w > 255) { w = 255 - rx; whole = 0; }
  if (ry + h > 255) { h = 255 - ry; whole = 0; }
  if (w > 0 && h > 0) con_rect(slot, col, (u8)rx, (u8)ry, (u8)w, (u8)h);
  return whole;
}

/* Something that scrolls with the world is drawn at C - scroll / 256. Seen as a Motion OP
 * that is the 8.8 position (C * 256 + 255 - scroll), moving by -SPEED each tick. */
static void scrolls(u8 slot) { if (state == S_PLAY) con_move(slot, (u8)(255 - (scroll & 255)), 0, -SPEED, 0); }

static void bird(u8 slot, u8 p, i32 bx, u8 bright) {
  if (bx < -10 || bx > 265) return;
  u8 role = p == 0 ? C_PRIMARY : C_SECONDARY;
  u8 x = (u8)(bx < 0 ? 0 : bx > 255 ? 255 : bx), by = (u8)(y[p] / FP);
  i32 tilt = vy[p] / 200;                                              /* nose up when rising */
  con_circ(slot, FILL_B(role, bright), x, by, BIRD_R);
  if (x > 8 && x < 240) {
    con_tri((u8)(slot + 1), FILL_B(C_ACCENT, bright), (u8)(x + 5), (u8)(by - 2 + tilt / 2), (u8)(x + 5), (u8)(by + 3 + tilt / 2), (u8)(x + 11), (u8)(by + 1 + tilt));   /* beak */
    con_tri((u8)(slot + 2), FILL(C_BLACK), (u8)(x - 5), by, (u8)(x + 1), by, (u8)(x - 3), (u8)(by + (vy[p] < 0 ? 5 : -5)));                                        /* wing */
    if (alive[p]) con_point((u8)(slot + 3), COL(C_BLACK, B100, 1, 2), (u8)(x + 2), (u8)(by - 2));                                                                  /* eye  */
  }
}

void cart_draw(u8 view) {
  u8 me = view < 2 ? view : 0, other = (u8)(1 - me);
  i32 sc = scroll / FP;
  char b[6];

  /* far away: a few stars drifting slowly */
  static const u8 SX[6] = {20, 70, 120, 160, 200, 240}, SY[6] = {30, 70, 22, 96, 48, 80};
  for (u8 i = 0; i < 6; i++) con_point((u8)(SL_STAR + i), COL(C_HIGHLIGHT, B50, 1, 1), (u8)((SX[i] + 256 - (sc / 8) % 256) % 256), SY[i]);

  /* pipes: 4 slots each. A pipe keeps its slots while it crosses the screen. */
  i32 k0 = sc < PIPE_0 + PIPE_W ? 0 : (sc - PIPE_0 - PIPE_W) / PIPE_STEP;
  if (state != S_WAIT)
    for (u8 i = 0; i < 4; i++) {
      i32 k = k0 + i, px = PIPE_0 + k * PIPE_STEP - sc;
      if (px > 255) break;
      i32 top = gap_y(k) - gap_half(k), bot = gap_y(k) + gap_half(k);
      u8 s = (u8)(SL_PIPE + (k & 3) * 4), whole;
      whole  = rect(s,           FILL_B(C_SUCCESS, B25), px, 0, PIPE_W, top);
      whole &= rect((u8)(s + 1), FILL(C_SUCCESS), px - 3, top - 8, PIPE_W + 6, 8);            /* lip */
      whole &= rect((u8)(s + 2), FILL_B(C_SUCCESS, B25), px, bot, PIPE_W, GROUND - bot);
      whole &= rect((u8)(s + 3), FILL(C_SUCCESS), px - 3, bot, PIPE_W + 6, 8);
      if (whole) for (u8 j = 0; j < 4; j++) scrolls((u8)(s + j));      /* fully on screen: it just slides */
    }

  /* ground: a line, and marks that scroll at full speed */
  con_line(SL_GROUND, STROKE(C_PRIMARY, 1), 0, GROUND, 255, GROUND);
  for (u8 i = 0; i < 8; i++) {
    i32 gx = i * 36 - sc % 36;
    if (gx < 0 || gx > 243) continue;
    con_line((u8)(SL_MARK + i), STROKE_B(C_PRIMARY, B50, 1), (u8)(gx + 12), GROUND + 6, (u8)gx, GROUND + 14);
    scrolls((u8)(SL_MARK + i));
  }

  /* birds: the rival first, yours on top. A bird that fell stays where it fell and scrolls away. */
  bird(SL_RIVAL, other, alive[other] ? BIRD_X : fell_at[other] - sc, alive[other] ? B75 : B25);
  bird(SL_ME,    me,    alive[me]    ? BIRD_X : fell_at[me] - sc,    alive[me]    ? B100 : B50);

  /* a small arrow, so you always know which bird is yours */
  if (view < 2 && alive[me] && state != S_OVER) {
    u8 by = (u8)(y[me] / FP), ay = (u8)(by > 22 ? by - 16 : by + 10), tip = (u8)(by > 22 ? by - 11 : by + 15);
    con_tri(SL_ARROW, FILL(C_ACCENT), BIRD_X - 3, ay, BIRD_X + 3, ay, BIRD_X, tip);
  }

  b[0] = 'P'; b[1] = '1'; b[2] = ' '; b[3] = (char)('0' + score[0] / 10 % 10); b[4] = (char)('0' + score[0] % 10); b[5] = 0; con_str(STR_S1, b);
  b[1] = '2'; b[3] = (char)('0' + score[1] / 10 % 10); b[4] = (char)('0' + score[1] % 10); con_str(STR_S2, b);
  con_text(SL_S1, FILL_B(C_PRIMARY,   alive[0] ? B100 : B50), 10,  18, 11, ALIGN_LEFT,  STR_S1);
  con_text(SL_S2, FILL_B(C_SECONDARY, alive[1] ? B100 : B50), 246, 18, 11, ALIGN_RIGHT, STR_S2);

  const char *t = ""; u8 col = FILL(C_ACCENT), size = 16;
  if (state == S_WAIT) { t = view == 1 ? "WAITING FOR P1" : "WAITING FOR P2"; col = FILL_B(C_PRIMARY, B75); size = 10; }
  else if (state == S_READY) t = "GET READY";
  else if (state == S_PLAY && view < 2 && !alive[me]) { t = "YOU FELL"; col = FILL(C_ERROR); size = 12; }
  else if (state == S_OVER) {
    if (winner == NOBODY) t = "DRAW";
    else if (view >= 2) t = winner == 0 ? "P1 WINS" : "P2 WINS";
    else if (rematch[me]) { t = "REMATCH SENT"; size = 10; }
    else if (rematch[other]) { t = "REMATCH?"; size = 12; }
    else if (winner == me) { t = "YOU WIN"; col = FILL(C_SUCCESS); }
    else { t = "YOU LOSE"; col = FILL(C_ERROR); }
  }
  if (t[0]) { con_str(STR_STATUS, t); con_text(SL_STATUS, col, 128, 60, size, ALIGN_CENTER, STR_STATUS); }
}
