/* six.c — a test-only cartridge with 6 seats. It is not a game: it exists to prove
 * that the runtime and the host really carry 6 private views plus a spectator view.
 * Every player holds a secret number (changed with A); a view draws only its own. */
#include "console.h"

const u8 cart_players = 6;

static u8 present[6], secret[6], ticks;

void cart_init(void) {
  con_transition_begin();
  for (u8 r = 1; r < 8; r++) con_pal(r, (u8)(r * 30), (u8)(255 - r * 30), 0x80);
  con_label(2, "ONE"); con_label(3, ""); con_label(4, "FOUR");
  con_tick_rate(0);
  con_sfx_def(0, CH_PULSE1, DUTY_50, 72, 8, 0, 5, SFX_DECAY);
  con_transition_end();
  for (u8 p = 0; p < 6; p++) secret[p] = (u8)(10 + p * 7);
}
void cart_presence(u8 p, u8 on) { present[p] = on; }
void cart_sys(u8 p, u8 code) { if (code == SYS_RESIGN) secret[p] = 0; }
void cart_tick(void) { ticks++; }
void cart_input(u8 p, u8 now, u8 prev) {
  if ((now & ~prev) & IN_A) { secret[p]++; con_sfx(VIEW(p), 0); }                 /* only you hear it */
  if ((now & ~prev) & IN_B) con_sfx(VIEW_ALL, 0);
  if (IN_ACTION(now) == 3 && IN_ACTION(prev) != 3) {                              /* button 4: go to 30 Hz */
    con_transition_begin(); con_tick_rate(30); con_transition_end();
  }
}
void cart_draw(u8 view) {
  char b[4];
  for (u8 p = 0; p < 6; p++)                                                       /* public: who is here */
    if (present[p]) con_circ(p, FILL((u8)(p + 1)), (u8)(30 + p * 36), 40, 10);
  if (view < 6) {                                                                  /* private: your number */
    b[0] = (char)('0' + secret[view] / 100); b[1] = (char)('0' + secret[view] / 10 % 10); b[2] = (char)('0' + secret[view] % 10); b[3] = 0;
    con_str(0, b);
    con_text(10, FILL(C_ACCENT), 128, 140, 30, ALIGN_CENTER, 0);
    con_rect(11, STROKE((u8)(view + 1), 2), (u8)(20 + view * 36), 28, 20, 24);     /* a frame around your seat */
  } else { con_str(0, "WATCHING"); con_text(10, FILL(C_PRIMARY), 128, 140, 12, ALIGN_CENTER, 0); }
  con_line(20, STROKE(C_PRIMARY, 1), 0, 200, ticks, 200);
}
