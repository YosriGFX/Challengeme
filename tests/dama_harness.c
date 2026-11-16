/* dama_harness.c — the Dama cartridge plus test-only doors into its state, so the rule
 * tests can set up any position. Built to tests/build/dama_test.wasm by `make`.
 * It is never served and never copied into the Worker. */
#include "../carts/dama/dama.c"

#define T(name) __attribute__((export_name(#name)))

T(t_clear) void t_clear(void) {
  for (u8 r = 0; r < 8; r++) for (u8 c = 0; c < 8; c++) { bd[r][c] = 0; tk[r][c] = 0; }
  chain = 0; need = 0; hist_n = 0; quiet = 0; end_class = 0; end_plies = 0; move_took = 0; move_man = 0;
  for (u8 p = 0; p < 2; p++) { sel[p] = confirm[p] = offer[p] = rematch[p] = 0; }
}
T(t_set)    void t_set(u32 r, u32 c, u32 v) { bd[r][c] = (u8)v; }
T(t_get)    u32  t_get(u32 r, u32 c)        { return bd[r][c]; }
T(t_taken)  u32  t_taken(u32 r, u32 c)      { return tk[r][c]; }
T(t_movable) u32 t_movable(u32 r, u32 c)    { return mvb[r][c]; }
T(t_start)  void t_start(u32 side)          { turn = (u8)side; chain = 0; plan(); }
T(t_cursor) void t_cursor(u32 p, u32 r, u32 c) { cr[p] = (u8)r; cc[p] = (u8)c; }
T(t_cursor_r) u32 t_cursor_r(u32 p)         { return cr[p]; }
T(t_cursor_c) u32 t_cursor_c(u32 p)         { return cc[p]; }
T(t_turn)   u32  t_turn(void)               { return turn; }
T(t_state)  u32  t_state(void)              { return state; }
T(t_winner) u32  t_winner(void)             { return winner; }
T(t_need)   u32  t_need(void)               { return need; }
T(t_chain)  u32  t_chain(void)              { return chain; }
T(t_clock)  u32  t_clock(u32 p)             { return clk[p]; }
T(t_set_clock) void t_set_clock(u32 p, u32 s) { clk[p] = (u16)s; }
