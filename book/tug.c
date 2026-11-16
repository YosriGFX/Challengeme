/* TUG — the smallest complete cartridge: a tug of war for two players.
 * Mash A to pull the knot to your side. Event-only: no timer runs at all.
 * Build it:  copy to carts/tug/tug.c, add "tug" to CARTS in the Makefile, make. */
#include "console.h"

const u8 cart_players = 2;

static u8 present[2], over, winner;
static i8 pos;                                    /* -10 .. +10, negative = toward player 1 */

void cart_init(void) {
  con_transition_begin();
  con_pal(C_PRIMARY,   0xEC, 0xE9, 0xE4);
  con_pal(C_SECONDARY, 0x5C, 0xC8, 0xF0);
  con_pal(C_ACCENT,    0xFF, 0xB2, 0x3F);
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);                               /* event-only */
  con_sfx_def(0, CH_PULSE1, DUTY_25, 72, 8, 0, 4, SFX_DECAY);       /* a pull */
  con_sfx_def(1, CH_PULSE1, DUTY_50, 72, 9, 12, 50, SFX_DECAY);     /* the win */
  con_transition_end();
}

void cart_presence(u8 p, u8 on) { present[p] = on; }
void cart_tick(void) {}
void cart_sys(u8 p, u8 code) { (void)p; (void)code; }

void cart_input(u8 p, u8 now, u8 prev) {
  u8 pressed = (u8)(now & ~prev);                 /* the bits that just went down */
  if (!present[0] || !present[1]) return;
  if (over) {
    if (IN_ACTION(now) == 1 && IN_ACTION(prev) != 1) {              /* button 2 = AGAIN */
      over = 0; pos = 0;
      con_transition_begin(); con_label(2, ""); con_transition_end();
    }
    return;
  }
  if (pressed & IN_A) {
    pos += p == 0 ? -1 : 1;
    con_sfx(VIEW(1 - p), 0);                      /* the other player hears the pull */
    if (pos <= -10 || pos >= 10) {
      over = 1; winner = pos < 0 ? 0 : 1;
      con_transition_begin(); con_label(2, "AGAIN"); con_transition_end();
      con_sfx(VIEW_ALL, 1);
    }
  }
}

void cart_draw(u8 view) {
  con_line(0, STROKE_B(C_PRIMARY, B25, 1), 28, 128, 228, 128);      /* the rope      */
  con_rect(1, FILL(C_PRIMARY),   20, 108, 8, 40);                   /* player 1 side */
  con_rect(2, FILL(C_SECONDARY), 228, 108, 8, 40);                  /* player 2 side */
  con_circ(3, FILL(C_ACCENT), (u8)(128 + pos * 10), 128, 8);        /* the knot      */

  const char *t = (!present[0] || !present[1]) ? "WAITING"
                : !over ? "MASH A"
                : view == winner ? "YOU WIN"
                : view < 2 ? "YOU LOSE" : "GAME OVER";
  con_str(0, t);
  con_text(4, FILL(C_ACCENT), 128, 200, 12, ALIGN_CENTER, 0);
}
