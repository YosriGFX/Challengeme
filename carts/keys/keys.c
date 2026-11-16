/* KEYS — 2-player fake-3D piano tiles, 60 Hz.
 *
 * Tiles fly toward you down a 4-lane highway. Hit each one as it crosses the
 * line. Both players get the same song at the same time and race for score.
 * Every hit plays its note, so playing well plays the melody.
 *
 * Lanes, left to right:  stick LEFT, stick RIGHT, B, A.
 * PERFECT = within 3 ticks (50 ms), GOOD = within 7 ticks. Button 2 = REMATCH.
 */
#include "console.h"

const u8 cart_players = 2;

enum { S_WAIT, S_PLAY, S_OVER };
enum { SFX_MISS = 8, SFX_BEAT, SFX_WIN, SFX_LOSE };
enum { STR_SCORE, STR_COMBO, STR_RIVAL, STR_JUDGE, STR_STATUS, STR_K0, STR_K1, STR_K2, STR_K3 };
enum { J_NONE, J_PERFECT, J_GOOD, J_MISS };

#define N_MAX   170
#define T0      210            /* tick of the first step                   */
#define STEP    15             /* ticks per step (8th notes at 120 bpm)    */
#define STEPS   150
#define AHEAD   96             /* how many ticks ahead a tile is visible   */
#define WINDOW  7
#define HOR     44
#define HIT     214
#define NEAR    60

static u8 state, present[2], winner, rematch[2];
static u16 now;
static u16 nt[N_MAX];                    /* the chart: time, lane, pitch */
static u8 nl[N_MAX], np[N_MAX], nn;
static u8 st[2][N_MAX];                  /* per player: 0 pending, 1 hit, 2 missed */
static u8 first[2];
static u16 score[2];
static u8 combo[2], judge[2], judge_t[2], flash[2][4], flash_ok[2][4];

static u32 seed;
static u32 rnd(void) { seed = seed * 1664525u + 1013904223u; return seed >> 16; }

static void make_chart(void) {
  u8 lane = 1, pi = 3;
  u16 prev_t = 0;
  nn = 0;
  for (u16 i = 0; i < STEPS && nn < N_MAX - 2; i++) {
    u8 beat = !(i & 1);
    if (rnd() % 10 >= (beat ? 9u : 3u)) continue;
    u16 t = (u16)(T0 + i * STEP);
    u8 l = (u8)(rnd() % 4);
    if (l == lane && (t - prev_t) <= STEP) l = (u8)((l + 2) % 4);     /* no fast repeats on one lane */
    i8 step = (i8)(rnd() % 5) - 2;
    pi = (u8)(pi + step > 7 ? 7 : pi + step < 0 ? 0 : pi + step);
    nt[nn] = t; nl[nn] = l; np[nn] = pi; nn++;
    if (beat && rnd() % 7 == 0) {                                     /* a chord: one note for each hand */
      nt[nn] = t; nl[nn] = (u8)(l < 2 ? 2 + (rnd() & 1) : (rnd() & 1)); np[nn] = (u8)(pi + 2 > 7 ? 7 : pi + 2); nn++;
    }
    lane = l; prev_t = t;
  }
}

static void begin(void) {
  seed += 7919;                                                       /* a new song every match */
  make_chart();
  now = 0;
  for (u8 p = 0; p < 2; p++) {
    first[p] = 0; score[p] = 0; combo[p] = 0; judge[p] = 0; judge_t[p] = 0; rematch[p] = 0;
    for (u8 i = 0; i < N_MAX; i++) st[p][i] = 0;
    for (u8 l = 0; l < 4; l++) flash[p][l] = 0;
  }
  state = S_PLAY;
  con_transition_begin();
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(60);
  con_transition_end();
}

void cart_init(void) {
  static const u8 scale[8] = {60, 62, 64, 67, 69, 72, 74, 76};        /* C major pentatonic */
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
  for (u8 i = 0; i < 8; i++) con_sfx_def(i, CH_PULSE1, DUTY_25, scale[i], 9, 0, 22, SFX_DECAY);
  con_sfx_def(SFX_MISS, CH_NOISE,    0,       48, 6,  (u8)-6,  6,  SFX_DECAY);
  con_sfx_def(SFX_BEAT, CH_TRIANGLE, 0,       36, 9,  (u8)-5,  5,  SFX_DECAY);
  con_sfx_def(SFX_WIN,  CH_PULSE1,   DUTY_50, 72, 9,  12,      50, SFX_DECAY);
  con_sfx_def(SFX_LOSE, CH_TRIANGLE, 0,       55, 12, (u8)-12, 50, SFX_DECAY);
  con_transition_end();
  seed = 12345;
  state = S_WAIT;
}

void cart_presence(u8 p, u8 on) {
  present[p] = on;
  if (state == S_WAIT && present[0] && present[1]) begin();
}

static void finish(void) {
  state = S_OVER;
  winner = score[0] == score[1] ? 2 : score[0] > score[1] ? 0 : 1;
  con_transition_begin();
  con_label(2, "REMATCH");
  con_tick_rate(0);
  con_transition_end();
  if (winner < 2) { con_sfx(VIEW(winner) | VIEW(2), SFX_WIN); con_sfx(VIEW(1 - winner), SFX_LOSE); }
}

void cart_sys(u8 p, u8 code) { if (code == SYS_RESIGN && state == S_PLAY) { score[p] = 0; score[1 - p] |= 1; finish(); } }

static void set_judge(u8 p, u8 j) { judge[p] = j; judge_t[p] = 40; }

/* a lane was pressed: hit the earliest pending tile of that lane inside the window */
static void press(u8 p, u8 lane) {
  flash[p][lane] = 8; flash_ok[p][lane] = 0;
  for (u8 i = first[p]; i < nn && nt[i] <= now + WINDOW; i++) {
    if (st[p][i] || nl[i] != lane) continue;
    i32 d = (i32)nt[i] - (i32)now;
    if (d < -WINDOW) continue;
    u8 perfect = d >= -3 && d <= 3;
    st[p][i] = 1;
    if (combo[p] < 250) combo[p]++;
    score[p] = (u16)(score[p] + (perfect ? 3 : 1) + (combo[p] >= 30 ? 3 : combo[p] / 10));
    set_judge(p, perfect ? J_PERFECT : J_GOOD);
    flash_ok[p][lane] = 1;
    con_sfx(VIEW(p), np[i]);                    /* the hit plays its note */
    return;
  }
  combo[p] = 0; set_judge(p, J_MISS);           /* pressed with nothing there */
  con_sfx(VIEW(p), SFX_MISS);
}

void cart_input(u8 p, u8 b, u8 prev) {
  if (state == S_OVER) {
    if (IN_ACTION(b) == 1 && IN_ACTION(prev) != 1) { rematch[p] = 1; if (rematch[0] && rematch[1]) begin(); }
    return;
  }
  if (state != S_PLAY) return;
  i8 dn = in_dx(b), dp = in_dx(prev);
  u8 pressed = (u8)(b & ~prev);
  if (dn < 0 && dp >= 0) press(p, 0);
  if (dn > 0 && dp <= 0) press(p, 1);
  if (pressed & IN_B) press(p, 2);
  if (pressed & IN_A) press(p, 3);
}

void cart_tick(void) {
  if (state != S_PLAY) return;
  now++;
  if (now >= T0 - 120 && (now - T0 + 120) % 30 == 0 && now < nt[nn - 1] + 30) con_sfx(VIEW_ALL, SFX_BEAT);
  for (u8 p = 0; p < 2; p++) {
    if (judge_t[p]) judge_t[p]--;
    for (u8 l = 0; l < 4; l++) if (flash[p][l]) flash[p][l]--;
    while (first[p] < nn) {                     /* tiles that went past unhit are missed */
      u8 i = first[p];
      if (st[p][i]) { first[p]++; continue; }
      if (nt[i] + WINDOW >= now) break;
      st[p][i] = 2; combo[p] = 0; set_judge(p, J_MISS); first[p]++;
    }
  }
  if (now > nt[nn - 1] + 100) finish();
}

/* ---- drawing: the highway in perspective ---------------------------- */
static i32 scale(i32 ticks) { i32 dz = ticks * 4; return dz < -32 ? 548 : NEAR * 256 / (dz + NEAR); }   /* 256 = on the hit line */
static i32 PY(i32 s) { return HOR + (HIT - HOR) * s / 256; }
static i32 EX(i32 edge, i32 s) { return 128 + (edge * 2 - 4) * 28 * s / 256; }     /* lane edges 0..4 */
static i32 CX(i32 lane, i32 s) { return 128 + (lane * 2 - 3) * 28 * s / 256; }     /* lane centers    */

static void line(u8 slot, u8 col, i32 x1, i32 y1, i32 x2, i32 y2) {
  for (u8 pass = 0; pass < 2; pass++) {
    if ((x1 < 0 && x2 < 0) || (x1 > 255 && x2 > 255)) return;
    if (x1 != x2) {
      if (x1 < 0)   { y1 += (y2 - y1) * (0 - x1) / (x2 - x1);   x1 = 0; }
      if (x1 > 255) { y1 += (y2 - y1) * (255 - x1) / (x2 - x1); x1 = 255; }
      if (x2 < 0)   { y2 += (y1 - y2) * (0 - x2) / (x1 - x2);   x2 = 0; }
      if (x2 > 255) { y2 += (y1 - y2) * (255 - x2) / (x1 - x2); x2 = 255; }
    }
    i32 t = x1; x1 = y1; y1 = t; t = x2; x2 = y2; y2 = t;
  }
  con_line(slot, col, (u8)x1, (u8)y1, (u8)x2, (u8)y2);
}
static void rect(u8 slot, u8 col, i32 rx, i32 ry, i32 w, i32 h) {
  if (rx < 0) { w += rx; rx = 0; }
  if (ry < 0) { h += ry; ry = 0; }
  if (rx + w > 255) w = 255 - rx;
  if (ry + h > 255) h = 255 - ry;
  if (w > 0 && h > 0) con_rect(slot, col, (u8)rx, (u8)ry, (u8)w, (u8)h);
}
static void num(char *o, u16 v, u8 digits) { for (i8 i = (i8)(digits - 1); i >= 0; i--) { o[i] = (char)('0' + v % 10); v /= 10; } o[digits] = 0; }

void cart_draw(u8 view) {
  u8 me = view < 2 ? view : 0, other = (u8)(1 - me);
  char b[10];

  /* the highway: 5 lane lines running to the vanishing point */
  for (u8 e = 0; e < 5; e++)
    line(e, STROKE_B(C_HIGHLIGHT, (e == 0 || e == 4) ? B100 : B50, 1), EX(e, 300), PY(300), EX(e, 16), PY(16));

  /* beat lines rushing toward you */
  if (state == S_PLAY) {
    i32 k = now < T0 ? 0 : (now - T0 + 29) / 30;
    for (u8 i = 0; i < 4; i++) {
      i32 d = T0 + (k + i) * 30 - now;
      if (d > AHEAD) break;
      i32 s = scale(d);
      line((u8)(5 + i), STROKE_B(C_HIGHLIGHT, B25, 1), EX(0, s), PY(s), EX(4, s), PY(s));
    }
  }

  /* the tiles: they grow as they come closer */
  if (state == S_PLAY)
    for (u8 i = first[me]; i < nn && nt[i] <= now + AHEAD; i++) {
      if (st[me][i] == 1) continue;
      i32 s = scale((i32)nt[i] - (i32)now);
      i32 w = 46 * s / 256, h = 18 * s / 256;
      if (h < 2) h = 2;
      rect((u8)(10 + i % 30), FILL_B(nl[i] < 2 ? C_PRIMARY : C_SECONDARY, st[me][i] == 2 ? B25 : B100), CX(nl[i], s) - w / 2, PY(s) - h / 2, w, h);
    }

  /* the hit line and the 4 pads */
  con_line(40, STROKE(C_ACCENT, 2), 14, HIT, 242, HIT);
  static const char *KEY[4] = {"<", ">", "B", "A"};
  for (u8 l = 0; l < 4; l++) {
    u8 x = (u8)(CX(l, 256) - 24);
    if (flash[me][l]) con_rect((u8)(41 + l), FILL(flash_ok[me][l] ? C_SUCCESS : C_ERROR), x, HIT - 9, 48, 18);
    else con_rect((u8)(41 + l), STROKE_B(l < 2 ? C_PRIMARY : C_SECONDARY, B75, 1), x, HIT - 9, 48, 18);
    con_str((u8)(STR_K0 + l), KEY[l]);
    con_text((u8)(45 + l), FILL_B(l < 2 ? C_PRIMARY : C_SECONDARY, B75), (u8)CX(l, 256), 240, 11, ALIGN_CENTER, (u8)(STR_K0 + l));
  }

  /* HUD: your score and combo, the rival's score, song progress */
  u8 s = 50;
  if (state != S_WAIT) {
    num(b, score[me], 4); con_str(STR_SCORE, b);
    con_text(s++, FILL(C_PRIMARY), 12, 22, 16, ALIGN_LEFT, STR_SCORE);
    if (combo[me] >= 2) { b[0] = 'X'; num(b + 1, combo[me], 3); con_str(STR_COMBO, b); con_text(s++, FILL(C_ACCENT), 12, 36, 9, ALIGN_LEFT, STR_COMBO); }
    b[0] = 'P'; b[1] = (char)('1' + other); b[2] = ' '; num(b + 3, score[other], 4); con_str(STR_RIVAL, b);
    con_text(s++, FILL_B(score[other] > score[me] ? C_ERROR : C_PRIMARY, B75), 244, 18, 9, ALIGN_RIGHT, STR_RIVAL);
    /* the rival's 4 lanes, live: you see every press they make and whether it hit */
    for (u8 l = 0; l < 4; l++) {
      u8 x = (u8)(204 + l * 10);
      if (flash[other][l]) con_rect((u8)(60 + l), FILL(flash_ok[other][l] ? C_SUCCESS : C_ERROR), x, 24, 8, 8);
      else con_rect((u8)(60 + l), STROKE_B(C_PRIMARY, B50, 1), x, 24, 8, 8);
    }
    i32 end = nn ? nt[nn - 1] : 1, w = now >= end ? 232 : now * 232 / end;
    con_rect(s++, FILL_B(C_ACCENT, B75), 12, 2, (u8)(w < 1 ? 1 : w), 2);
  }
  if (state == S_PLAY && judge_t[me]) {
    static const char *J[4] = {"", "PERFECT", "GOOD", "MISS"};
    static const u8 JC[4] = {0, C_SUCCESS, C_PRIMARY, C_ERROR};
    con_str(STR_JUDGE, J[judge[me]]);
    con_text(s++, FILL_B(JC[judge[me]], judge_t[me] > 12 ? B100 : B50), 128, 36, 10, ALIGN_CENTER, STR_JUDGE);
  }

  const char *t = ""; u8 col = FILL(C_ACCENT), size = 16;
  if (state == S_WAIT) { t = view == 1 ? "WAITING FOR P1" : "WAITING FOR P2"; col = FILL_B(C_PRIMARY, B75); size = 10; }
  else if (state == S_PLAY && now < T0 - 90) t = "GET READY";
  else if (state == S_OVER) {
    if (winner == 2) t = "DRAW";
    else if (view >= 2) t = winner == 0 ? "P1 WINS" : "P2 WINS";
    else if (rematch[me]) { t = "REMATCH SENT"; size = 10; }
    else if (rematch[other]) { t = "REMATCH?"; size = 12; }
    else if (winner == me) { t = "YOU WIN"; col = FILL(C_SUCCESS); }
    else { t = "YOU LOSE"; col = FILL(C_ERROR); }
  }
  con_str(STR_STATUS, t);
  if (t[0]) con_text(s++, col, 128, 120, size, ALIGN_CENTER, STR_STATUS);
}
