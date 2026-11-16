/* runtime.c — the CPU-side runtime, linked into every cartridge.
 *
 * It owns one copy of the client memory map per view, diffs what the
 * cartridge draws against what that view already has, and encodes only
 * the changes into one atomic packet. The host (local simulator, Durable
 * Object, anything) only moves bytes: it never looks inside a packet.
 */
#include "console.h"
#include "wire.h"

/* ---- no libc: the compiler may still emit calls to these ------------ */
void *memcpy(void *d, const void *s, unsigned long n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, unsigned long n) { u8 *a = d; while (n--) *a++ = (u8)c; return d; }
void *memmove(void *d, const void *s, unsigned long n) {
  u8 *a = d; const u8 *b = s;
  if (a < b) while (n--) *a++ = *b++; else { a += n; b += n; while (n--) *--a = *--b; }
  return d;
}
int memcmp(const void *x, const void *y, unsigned long n) { const u8 *a = x, *b = y; for (; n--; a++, b++) if (*a != *b) return *a - *b; return 0; }

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct { u8 ops[CON_SLOTS * CON_OP_SIZE]; u8 strs[CON_STRS * CON_STR_LEN]; } View;

static View cur;                      /* what the cartridge is drawing now  */
static View sent[CON_MAX_VIEWS];      /* what each view's client has        */

/* transition state (shared by all views) */
static u8 pal[CON_ROLES * 3];
static u8 labels[CON_LABELS * CON_LABEL_LEN];
static u8 tick_hz;
static u8 sfx_bank[CON_SFX * 8];
static u8 sfx_used[CON_SFX];
static u8 music[CON_PATTERNS][3 + CON_STEPS * 4];   /* step_10ms, steps, vol, notes */
static u8 music_used[CON_PATTERNS];
static u8 in_transition;
static u8 trans_dirty;                /* bit n = view n must receive the transition */

/* events */
static u8 music_cmd, music_pat, music_dirty;
static u8 sfx_q[CON_MAX_VIEWS][8], sfx_n[CON_MAX_VIEWS];

static u8 prev_in[CON_MAX_PLAYERS];
static u16 frame;                     /* counts ticks; lets the client play frames back evenly */
static u8 out[WIRE_MAX_PACKET];
static u32 out_n;

static void put(u8 b) { if (out_n < WIRE_MAX_PACKET) out[out_n++] = b; }
static void putn(const u8 *p, u32 n) { while (n--) put(*p++); }

/* ==== cartridge API =================================================== */
void con_op(u8 slot, u8 op, u8 color, u8 a, u8 b, u8 c, u8 d, u8 e, u8 f) {
  u8 *p = &cur.ops[slot * CON_OP_SIZE];
  p[0] = op; p[1] = color; p[2] = a; p[3] = b; p[4] = c; p[5] = d; p[6] = e; p[7] = f;
}

void con_str(u8 id, const char *s) {
  if (id >= CON_STRS) return;
  u8 *p = &cur.strs[id * CON_STR_LEN];
  u8 i = 0;
  for (; i < CON_STR_LEN && s[i]; i++) p[i] = (s[i] >= 0x20 && s[i] <= 0x7E) ? (u8)s[i] : '?';
  for (; i < CON_STR_LEN; i++) p[i] = 0;
}

void con_transition_begin(void) { in_transition = 1; }
void con_transition_end(void)   { in_transition = 0; trans_dirty = 0xFF; }

void con_pal(u8 role, u8 r, u8 g, u8 b) {
  if (!in_transition || role == 0 || role >= CON_ROLES) return;
  pal[role * 3] = r; pal[role * 3 + 1] = g; pal[role * 3 + 2] = b;
}

void con_label(u8 button, const char *text) {
  if (!in_transition || button < 2 || button > 4) return;
  u8 *p = &labels[(button - 2) * CON_LABEL_LEN];
  u8 i = 0;
  for (; i < CON_LABEL_LEN && text[i]; i++) p[i] = (u8)text[i];
  for (; i < CON_LABEL_LEN; i++) p[i] = 0;
}

void con_tick_rate(u8 hz) { if (in_transition) tick_hz = hz > 60 ? 60 : hz; }

void con_sfx_def(u8 id, u8 ch, u8 duty, u8 note, u8 vol, u8 sweep, u8 len, u8 flags) {
  if (!in_transition || id >= CON_SFX) return;
  u8 *p = &sfx_bank[id * 8];
  p[0] = ch; p[1] = duty; p[2] = note; p[3] = vol; p[4] = 0; p[5] = sweep; p[6] = len; p[7] = flags;
  sfx_used[id] = 1;
}

void con_music_def(u8 id, u8 step_10ms, u8 steps, u8 vol, const u8 *notes) {
  if (!in_transition || id >= CON_PATTERNS) return;
  if (steps > CON_STEPS) steps = CON_STEPS;
  music[id][0] = step_10ms; music[id][1] = steps; music[id][2] = vol;
  memcpy(&music[id][3], notes, (u32)steps * 4);
  music_used[id] = 1;
}

void con_sfx(u8 view_mask, u8 id) {
  for (u8 v = 0; v < CON_MAX_VIEWS; v++)
    if ((view_mask >> v) & 1 && sfx_n[v] < 8) sfx_q[v][sfx_n[v]++] = id;
}

void con_music(u8 cmd, u8 pattern) { music_cmd = cmd; music_pat = pattern; music_dirty = 0xFF; }

/* ==== host API ======================================================== */
EXPORT(con_init) void con_init(void) { cart_init(); }
EXPORT(con_players) u32 con_players(void) { return cart_players; }
EXPORT(con_tick_hz) u32 con_tick_hz(void) { return tick_hz; }
EXPORT(con_packet) u8 *con_packet(void) { return out; }

EXPORT(con_presence) void con_presence(u32 player, u32 on) {
  if (player < cart_players) { if (!on) prev_in[player] = 0; cart_presence((u8)player, (u8)on); }
}

EXPORT(con_input) void con_input(u32 player, u32 byte) {
  if (player >= cart_players) return;
  u8 prev = prev_in[player];
  prev_in[player] = (u8)byte;
  cart_input((u8)player, (u8)byte, prev);
}

EXPORT(con_sys) void con_sys(u32 player, u32 code) { if (player < cart_players) cart_sys((u8)player, (u8)code); }
EXPORT(con_tick) void con_tick(void) { frame++; cart_tick(); }

/* Build the packet for one view. full = 1 on join / resync.
 * Returns the packet length (0 = nothing to send). */
EXPORT(con_flush) u32 con_flush(u32 view, u32 full) {
  if (view >= CON_MAX_VIEWS) return 0;
  View *s = &sent[view];
  u8 bit = (u8)(1u << view);
  out_n = 0;

  memset(&cur, 0, sizeof cur);
  cart_draw((u8)view);

  if (full) {
    put(W_RESET);
    memset(s, 0, sizeof *s);
    sfx_n[view] = 0;                 /* old sounds are not replayed */
  }

  if (full || (trans_dirty & bit)) {
    put(W_BEGIN);
    for (u8 r = 1; r < CON_ROLES; r++) { put(W_PAL); put(r); putn(&pal[r * 3], 3); }
    for (u8 b = 0; b < CON_LABELS; b++) { put(W_LABEL); put((u8)(b + 2)); putn(&labels[b * CON_LABEL_LEN], CON_LABEL_LEN); }
    put(W_TICK); put(tick_hz);
    for (u8 i = 0; i < CON_SFX; i++) if (sfx_used[i]) { put(W_SFXDEF); put(i); putn(&sfx_bank[i * 8], 8); }
    for (u8 i = 0; i < CON_PATTERNS; i++) if (music_used[i]) {
      put(W_MUSDEF); put(i); putn(music[i], 3u + (u32)music[i][1] * 4);
    }
    put(W_END);
    trans_dirty &= (u8)~bit;
  }

  /* OP deltas: slot list or dirty mask, whichever is smaller */
  u8 mask[32]; u32 n = 0;
  memset(mask, 0, sizeof mask);
  for (u32 i = 0; i < CON_SLOTS; i++)
    if (memcmp(&cur.ops[i * 8], &s->ops[i * 8], 8)) { mask[i >> 3] |= (u8)(1u << (i & 7)); n++; }
  if (n) {
    if (n <= 31) {
      put(W_OPS_LIST); put((u8)n);
      for (u32 i = 0; i < CON_SLOTS; i++)
        if (mask[i >> 3] & (1u << (i & 7))) { put((u8)i); putn(&cur.ops[i * 8], 8); }
    } else {
      put(W_OPS_MASK); putn(mask, 32);
      for (u32 i = 0; i < CON_SLOTS; i++)
        if (mask[i >> 3] & (1u << (i & 7))) putn(&cur.ops[i * 8], 8);
    }
    memcpy(s->ops, cur.ops, sizeof cur.ops);
  }

  /* string deltas */
  for (u8 i = 0; i < CON_STRS; i++) {
    u8 *a = &cur.strs[i * CON_STR_LEN], *b = &s->strs[i * CON_STR_LEN];
    if (memcmp(a, b, CON_STR_LEN)) {
      u8 len = 0; while (len < CON_STR_LEN && a[len]) len++;
      put(W_STR); put(i); put(len); putn(a, len);
      memcpy(b, a, CON_STR_LEN);
    }
  }

  if (full || (music_dirty & bit)) { put(W_MUSIC); put(music_cmd); put(music_pat); music_dirty &= (u8)~bit; }
  for (u8 i = 0; i < sfx_n[view]; i++) { put(W_SFX); put(sfx_q[view][i]); }
  sfx_n[view] = 0;

  /* stamp the packet with its tick, but only if it carries anything */
  if (out_n && out_n + 3 <= WIRE_MAX_PACKET) {
    memmove(out + 3, out, out_n);
    out[0] = W_FRAME; out[1] = (u8)frame; out[2] = (u8)(frame >> 8);
    out_n += 3;
  }
  return out_n;
}
