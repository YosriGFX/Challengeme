/* TRAIL — 2 to 6 players on one screen, 30 Hz.
 *
 * Everybody rides at the same speed and leaves a wall behind. Touch a wall or
 * the edge and you are out. The last one riding wins the round; three rounds
 * win the match. One mechanic: the stick turns you (up, right, down, left).
 * You cannot turn straight back into your own wall.
 *
 * Seats fill as players join. With two or more seated, A starts a round for
 * everyone who is there; anyone who joins later rides from the next round.
 * Everybody sees the same arena: nothing here is hidden from anyone.
 * After the match, button 2 = AGAIN (any player).
 *
 * Colors: this cartridge gives one palette role to each of the six seats
 * (roles 1 to 6) and keeps role 7 for the arena and the text.
 */
#include "console.h"

const u8 cart_players = 6;

enum { S_LOBBY, S_COUNT, S_RIDE, S_ROUND_END, S_OVER };
enum { SFX_CRASH, SFX_GO, SFX_ROUND, SFX_WIN, SFX_TICK };
enum { STR_SCORE = 0, STR_STATUS = 6, STR_SUB = 7 };
enum { SL_BORDER = 0, SL_SCORE = 1, SL_YOU = 7, SL_STATUS = 8, SL_SUB = 9, SL_WALL = 16 };
#define C_UI       C_SPARE
#define NOBODY     6

#define CELLS      120         /* the arena is 120 x 120 cells */
#define CELL       2           /* units per cell */
#define AX         8           /* the arena on screen */
#define AY         14
#define SEGS       40          /* straight pieces of wall per player (slots 16 + p * 40 ...) */
#define WIN_ROUNDS 3

static const u8 START_X[6] = {20, 99, 60, 59, 20, 99}, START_Y[6] = {60, 59, 20, 99, 20, 99};
static const u8 START_D[6] = {1, 3, 2, 0, 1, 3};                  /* 0 up, 1 right, 2 down, 3 left */
static const i8 DX[4] = {0, 1, 0, -1}, DY[4] = {-1, 0, 1, 0};

static u8 state, present[6], riding[6], alive[6], wins[6], champion, last_winner;
static u8 dir[6], want[6];
static u8 px[6][SEGS + 1], py[6][SEGS + 1], pn[6];                 /* corners of each wall; the last one is the head */
static u8 wall[CELLS * CELLS / 8];
static u16 timer;

static u8 taken(u8 x, u8 y) { u16 i = (u16)(y * CELLS + x); return (wall[i >> 3] >> (i & 7)) & 1; }
static void take(u8 x, u8 y) { u16 i = (u16)(y * CELLS + x); wall[i >> 3] |= (u8)(1u << (i & 7)); }
static u8 seated(void) { u8 n = 0; for (u8 p = 0; p < 6; p++) n += present[p]; return n; }

static void rate(u8 hz) { con_transition_begin(); con_label(2, state == S_OVER ? "AGAIN" : ""); con_tick_rate(hz); con_transition_end(); }

/* everybody back on their starting spot, no walls */
static void park(void) {
  for (u8 p = 0; p < 6; p++) { px[p][0] = px[p][1] = START_X[p]; py[p][0] = py[p][1] = START_Y[p]; pn[p] = 2; riding[p] = 0; }
}
static void end_round(void);

static void new_round(void) {
  for (u16 i = 0; i < sizeof wall; i++) wall[i] = 0;
  park();
  for (u8 p = 0; p < 6; p++) {
    riding[p] = alive[p] = present[p];
    dir[p] = want[p] = START_D[p];
    if (riding[p]) take(START_X[p], START_Y[p]);
  }
  state = S_COUNT; timer = 0;
  rate(30);
}

void cart_init(void) {
  con_transition_begin();
  con_pal(1, 0xEC, 0xE9, 0xE4);            /* seat 1 */
  con_pal(2, 0x5C, 0xC8, 0xF0);            /* seat 2 */
  con_pal(3, 0xFF, 0xB2, 0x3F);            /* seat 3 */
  con_pal(4, 0xC9, 0xA7, 0xFF);            /* seat 4 */
  con_pal(5, 0xFF, 0x5A, 0x5A);            /* seat 5 */
  con_pal(6, 0x6B, 0xE3, 0x8C);            /* seat 6 */
  con_pal(C_UI, 0x9A, 0x9A, 0x9A);         /* arena and text */
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);
  con_sfx_def(SFX_CRASH, CH_NOISE,    0,       52, 11, (u8)-12, 20, SFX_DECAY);
  con_sfx_def(SFX_GO,    CH_PULSE1,   DUTY_50, 76, 8,  0,       20, SFX_DECAY);
  con_sfx_def(SFX_ROUND, CH_PULSE1,   DUTY_25, 79, 8,  5,       15, SFX_DECAY);
  con_sfx_def(SFX_WIN,   CH_PULSE1,   DUTY_50, 72, 9,  12,      50, SFX_DECAY);
  con_sfx_def(SFX_TICK,  CH_TRIANGLE, 0,       60, 10, 0,       5,  SFX_DECAY);
  con_transition_end();
  park();
  state = S_LOBBY; champion = last_winner = NOBODY;
}

void cart_presence(u8 p, u8 on) { present[p] = on; }
void cart_sys(u8 p, u8 code) {
  if (code == SYS_RESIGN && state == S_RIDE && riding[p] && alive[p]) { alive[p] = 0; con_sfx(VIEW_ALL, SFX_CRASH); end_round(); }
}

void cart_input(u8 p, u8 now, u8 prev) {
  u8 pressed = (u8)(now & ~prev);
  if (state == S_LOBBY) { if ((pressed & IN_A) && seated() >= 2) new_round(); return; }
  if (state == S_OVER) {
    if (IN_ACTION(now) == 1 && IN_ACTION(prev) != 1) {
      for (u8 q = 0; q < 6; q++) wins[q] = 0;
      champion = last_winner = NOBODY; state = S_LOBBY;
      park();
      rate(0);
    }
    return;
  }
  if (IN_ACTIVE(now) && !(IN_DIR(now) & 1)) want[p] = (u8)(IN_DIR(now) >> 1);      /* the four straight directions only */
}

static void end_round(void) {
  u8 left = 0, who = NOBODY;
  for (u8 p = 0; p < 6; p++) if (riding[p] && alive[p]) { left++; who = p; }
  if (left > 1) return;
  last_winner = left ? who : NOBODY;                    /* nobody left: the round has no winner */
  if (left && ++wins[who] >= WIN_ROUNDS) {
    champion = who; state = S_OVER;
    rate(0);
    con_sfx(VIEW_ALL, SFX_WIN);
    return;
  }
  state = S_ROUND_END; timer = 0;
  con_sfx(VIEW_ALL, SFX_ROUND);
}

void cart_tick(void) {
  if (state == S_COUNT) {
    if (timer % 30 == 0 && timer < 90) con_sfx(VIEW_ALL, SFX_TICK);
    if (++timer >= 90) { state = S_RIDE; con_sfx(VIEW_ALL, SFX_GO); }
    return;
  }
  if (state == S_ROUND_END) {
    if (++timer >= 75) { if (seated() >= 2) new_round(); else { state = S_LOBBY; park(); rate(0); } }
    return;
  }
  if (state != S_RIDE) return;

  /* Everybody steps at the same moment: first where each one goes, then who survives. */
  i16 nx[6], ny[6];
  u8 crash[6];
  for (u8 p = 0; p < 6; p++) {
    crash[p] = 0;
    if (!riding[p] || !alive[p]) continue;
    if (want[p] != dir[p] && want[p] != ((dir[p] + 2) & 3) && pn[p] <= SEGS) {      /* a turn starts a new piece of wall */
      dir[p] = want[p];
      px[p][pn[p]] = px[p][pn[p] - 1]; py[p][pn[p]] = py[p][pn[p] - 1]; pn[p]++;
    }
    want[p] = dir[p];
    nx[p] = (i16)(px[p][pn[p] - 1] + DX[dir[p]]); ny[p] = (i16)(py[p][pn[p] - 1] + DY[dir[p]]);
    if (nx[p] < 0 || nx[p] >= CELLS || ny[p] < 0 || ny[p] >= CELLS || taken((u8)nx[p], (u8)ny[p])) crash[p] = 1;
  }
  for (u8 p = 0; p < 6; p++) for (u8 q = (u8)(p + 1); q < 6; q++)              /* two heads into the same cell: both out */
    if (riding[p] && alive[p] && riding[q] && alive[q] && nx[p] == nx[q] && ny[p] == ny[q]) crash[p] = crash[q] = 1;
  u8 any = 0;
  for (u8 p = 0; p < 6; p++) {
    if (!riding[p] || !alive[p]) continue;
    if (crash[p]) { alive[p] = 0; any = 1; continue; }
    px[p][pn[p] - 1] = (u8)nx[p]; py[p][pn[p] - 1] = (u8)ny[p];
    take((u8)nx[p], (u8)ny[p]);
  }
  if (any) { con_sfx(VIEW_ALL, SFX_CRASH); end_round(); }
}

/* ---- drawing ---------------------------------------------------------- */
static u8 X(u8 cell) { return (u8)(AX + cell * CELL + 1); }
static u8 Y(u8 cell) { return (u8)(AY + cell * CELL + 1); }

void cart_draw(u8 view) {
  char b[4];
  con_rect(SL_BORDER, STROKE_B(C_UI, B75, 1), AX - 1, AY - 1, CELLS * CELL + 2, CELLS * CELL + 2);

  for (u8 p = 0; p < 6; p++) {                          /* rounds won, one number per seat in its color */
    if (!present[p] && !riding[p] && !wins[p]) continue;
    b[0] = (char)('0' + wins[p]); b[1] = 0;
    con_str((u8)(STR_SCORE + p), b);
    con_text((u8)(SL_SCORE + p), FILL_B((u8)(p + 1), present[p] ? B100 : B50), (u8)(28 + p * 40), 10, 10, ALIGN_CENTER, (u8)(STR_SCORE + p));
  }
  if (view < 6) con_line(SL_YOU, STROKE((u8)(view + 1), 1), (u8)(20 + view * 40), 12, (u8)(36 + view * 40), 12);     /* this one is you */

  for (u8 p = 0; p < 6; p++) {                          /* the walls: one line per straight piece */
    u8 show = state == S_LOBBY ? present[p] : riding[p];
    if (!show) continue;
    u8 col = STROKE_B((u8)(p + 1), (state == S_LOBBY || alive[p]) ? B100 : B50, 2);
    for (u8 k = 0; k + 1 < pn[p]; k++)
      con_line((u8)(SL_WALL + p * SEGS + k), col, X(px[p][k]), Y(py[p][k]), X(px[p][k + 1]), Y(py[p][k + 1]));
  }

  const char *t = "", *u = "";
  u8 col = FILL(C_UI);
  if (state == S_LOBBY) {
    if (seated() < 2) t = "WAITING FOR PLAYERS"; else { t = "PRESS A TO START"; col = FILL(C_ACCENT); }
    u = view < 6 ? "STICK TURNS" : "WATCHING";
  } else if (state == S_COUNT) {
    t = timer < 30 ? "3" : timer < 60 ? "2" : "1";
    if (view < 6 && !riding[view]) u = "YOU RIDE NEXT ROUND";
  } else if (state == S_RIDE) {
    if (view < 6 && riding[view] && !alive[view]) { u = "YOU CRASHED"; }
  } else if (state == S_ROUND_END) {
    if (last_winner == NOBODY) t = "NO WINNER";
    else if (last_winner == view) { t = "ROUND WON"; col = FILL((u8)(view + 1)); }
    else { static char w[] = "P1 WINS ROUND"; w[1] = (char)('1' + last_winner); t = w; col = FILL((u8)(last_winner + 1)); }
  } else {
    if (champion == view) { t = "YOU WIN"; col = FILL((u8)(view + 1)); }
    else { static char w[] = "P1 WINS"; w[1] = (char)('1' + champion); t = w; col = FILL((u8)(champion + 1)); }
    u = "BUTTON 2 = AGAIN";
  }
  if (t[0]) { con_str(STR_STATUS, t); con_text(SL_STATUS, col, 128, 120, state == S_COUNT ? 28 : 11, ALIGN_CENTER, STR_STATUS); }
  if (u[0]) { con_str(STR_SUB, u); con_text(SL_SUB, FILL_B(C_UI, B75), 128, 140, 7, ALIGN_CENTER, STR_SUB); }
}
