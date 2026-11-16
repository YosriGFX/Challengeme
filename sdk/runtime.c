/* runtime.c — the CPU side, linked into every cartridge.
 *
 * For each view it remembers exactly what that client holds (OPs, motion,
 * bindings, strings), lets the cartridge redraw from an empty screen, and
 * sends only what differs. The host around it only moves bytes.
 */
#include "console.h"
#include "wire.h"

/* no libc: the compiler may still call these */
void *memcpy(void *d, const void *s, unsigned long n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, unsigned long n) { u8 *a = d; while (n--) *a++ = (u8)c; return d; }
int memcmp(const void *x, const void *y, unsigned long n) { const u8 *a = x, *b = y; for (; n--; a++, b++) if (*a != *b) return *a - *b; return 0; }

#define EXPORT(name) __attribute__((export_name(#name)))

typedef struct {
  u8 ops[CON_SLOTS * CON_OP_SIZE];
  u8 mv[CON_SLOTS * CON_MOVE_SIZE];
  u8 strs[CON_STRS * CON_STR_LEN];
  u8 binds[CON_BINDS * CON_BIND_SIZE];
} Screen;

static Screen cur;                          /* what the cartridge is drawing now */
static Screen held[CON_MAX_VIEWS];          /* what each view's client holds     */
static u16 t0[CON_MAX_VIEWS][CON_SLOTS];    /* the tick each held slot was written */
static u8 moves;                            /* slots in motion in `cur`          */

/* transition regions: the same for every view */
static u8 pal[CON_ROLES * 3], labels[CON_LABELS * CON_LABEL_LEN], tick_hz;
static u8 sfx_bank[CON_SFX * 8], sfx_used[CON_SFX];
static u8 music[CON_PATTERNS][CON_PATTERN_SIZE], music_used[CON_PATTERNS];
static u8 in_transition, trans_dirty;       /* bit n: view n has not received the last transition */

static u8 music_cmd, music_pat, music_dirty;
static u8 sfx_q[CON_MAX_VIEWS][8], sfx_n[CON_MAX_VIEWS];

static u8 prev_in[CON_MAX_PLAYERS], in_count[CON_MAX_PLAYERS], acked[CON_MAX_VIEWS], age;
static u16 frame;                           /* ticks since the match began */

static u8 out[WIRE_MAX_PACKET];
static u32 out_n;
static void put(u8 b) { if (out_n < WIRE_MAX_PACKET) out[out_n++] = b; }
static void putn(const u8 *p, u32 n) { while (n--) put(*p++); }
static u8 ascii(char c) { return (c >= 0x20 && c <= 0x7E) ? (u8)c : '?'; }

/* ==== cartridge API ==================================================== */
void con_op(u8 slot, u8 op, u8 color, u8 a, u8 b, u8 c, u8 d, u8 e, u8 f) {
  u8 *p = &cur.ops[slot * CON_OP_SIZE];
  p[0] = op; p[1] = color; p[2] = a; p[3] = b; p[4] = c; p[5] = d; p[6] = e; p[7] = f;
}

void con_str(u8 id, const char *s) {
  if (id >= CON_STRS) return;
  u8 *p = &cur.strs[id * CON_STR_LEN], i = 0;
  for (; i < CON_STR_LEN && s[i]; i++) p[i] = ascii(s[i]);
  for (; i < CON_STR_LEN; i++) p[i] = 0;
}

void con_move(u8 slot, u8 fx, u8 fy, i16 vx, i16 vy) {
  u8 *m = &cur.mv[slot * CON_MOVE_SIZE];
  if (!cur.ops[slot * CON_OP_SIZE] || !tick_hz || (!vx && !vy)) return;
  if (!con_moving(m)) { if (moves >= CON_MOVES) return; moves++; }
  m[0] = fx; m[1] = fy; m[2] = (u8)vx; m[3] = (u8)((u16)vx >> 8); m[4] = (u8)vy; m[5] = (u8)((u16)vy >> 8);
}

void con_bind(u8 id, u8 slot, u8 kind, i8 sx, i8 sy, u8 xmin, u8 xmax, u8 ymin, u8 ymax) {
  if (id >= CON_BINDS || kind > BIND_STEP) return;
  u8 *p = &cur.binds[id * CON_BIND_SIZE];
  p[0] = slot; p[1] = kind; p[2] = (u8)sx; p[3] = (u8)sy; p[4] = xmin; p[5] = xmax; p[6] = ymin; p[7] = ymax;
}

void con_transition_begin(void) { in_transition = 1; }
void con_transition_end(void)   { in_transition = 0; trans_dirty = 0xFF; }

void con_pal(u8 role, u8 r, u8 g, u8 b) {
  if (!in_transition || role == 0 || role >= CON_ROLES) return;
  pal[role * 3] = r; pal[role * 3 + 1] = g; pal[role * 3 + 2] = b;
}

void con_label(u8 button, const char *text) {
  if (!in_transition || button < 2 || button > 4) return;
  u8 *p = &labels[(button - 2) * CON_LABEL_LEN], i = 0;
  for (; i < CON_LABEL_LEN && text[i]; i++) p[i] = ascii(text[i]);
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
    if (((view_mask >> v) & 1) && sfx_n[v] < 8) sfx_q[v][sfx_n[v]++] = id;
}

void con_music(u8 cmd, u8 pattern) { music_cmd = cmd; music_pat = pattern; music_dirty = 0xFF; }
u8 con_input_age(void) { return age; }

/* ==== host API ========================================================= */
EXPORT(con_init)    void con_init(void)    { cart_init(); }
EXPORT(con_players) u32  con_players(void) { return cart_players; }
EXPORT(con_tick_hz) u32  con_tick_hz(void) { return tick_hz; }
EXPORT(con_packet)  u8  *con_packet(void)  { return out; }
EXPORT(con_frame)   u32  con_frame(void)   { return frame; }

EXPORT(con_presence) void con_presence(u32 player, u32 on) {
  if (player >= cart_players) return;
  prev_in[player] = 0;
  if (on) in_count[player] = 0;             /* the client counts its inputs from the join too */
  cart_presence((u8)player, (u8)(on != 0));
}

/* shown: the low 8 bits of the tick that was on the player's screen, or any value
 * above 255 when the client did not say. */
EXPORT(con_input) void con_input(u32 player, u32 byte, u32 shown) {
  if (player >= cart_players) return;
  u8 prev = prev_in[player], late = shown > 255 ? 0 : (u8)(frame - shown);
  age = late > 127 ? 0 : late > CON_MAX_AGE ? CON_MAX_AGE : late;
  prev_in[player] = (u8)byte;
  in_count[player]++;
  cart_input((u8)player, (u8)byte, prev);
  age = 0;
}

EXPORT(con_sys)  void con_sys(u32 player, u32 code) { if (player < cart_players) cart_sys((u8)player, (u8)code); }
EXPORT(con_tick) void con_tick(void) { frame++; cart_tick(); }

/* A fingerprint of everything any player can see right now. Two runs of the same cartridge
 * fed the same inputs on the same ticks give the same number: that is what makes a match
 * log checkable by anybody (host/replay.mjs). It changes nothing. */
EXPORT(con_digest) u32 con_digest(void) {
  u32 h = 2166136261u ^ frame;
  for (u8 v = 0; v <= cart_players; v++) {
    memset(&cur, 0, sizeof cur); moves = 0;
    cart_draw(v);
    const u8 *p = (const u8 *)&cur;
    for (u32 i = 0; i < sizeof cur; i++) h = (h ^ p[i]) * 16777619u;
  }
  return h;
}

/* Build the packet for one view. how: bit 0 = a full dump (join, resync), bit 1 = made
 * between two ticks (anything but the flush right after con_tick).
 * Returns its length; 0 means this view has nothing to learn. */
EXPORT(con_flush) u32 con_flush(u32 view, u32 how) {
  u32 full = how & 1;
  if (view >= CON_MAX_VIEWS) return 0;
  Screen *h = &held[view];
  u8 bit = (u8)(1u << view);

  memset(&cur, 0, sizeof cur); moves = 0;
  cart_draw((u8)view);

  out_n = 0;
  put(W_FRAME); put((u8)frame); put((u8)(frame >> 8));
  if (how & 2) put(W_MID);
  u32 head = out_n;
  if (full) {
    put(W_RESET);
    memset(h, 0, sizeof *h);
    sfx_n[view] = 0;                        /* old sounds are not replayed */
  }

  if (full || (trans_dirty & bit)) {
    put(W_BEGIN);
    for (u8 r = 1; r < CON_ROLES; r++) { put(W_PAL); put(r); putn(&pal[r * 3], 3); }
    for (u8 b = 0; b < CON_LABELS; b++) { put(W_LABEL); put((u8)(b + 2)); putn(&labels[b * CON_LABEL_LEN], CON_LABEL_LEN); }
    put(W_TICK); put(tick_hz);
    for (u8 i = 0; i < CON_SFX; i++) if (sfx_used[i]) { put(W_SFXDEF); put(i); putn(&sfx_bank[i * 8], 8); }
    for (u8 i = 0; i < CON_PATTERNS; i++) if (music_used[i]) { put(W_MUSDEF); put(i); putn(music[i], 3u + (u32)music[i][1] * 4); }
    put(W_END);
    trans_dirty &= (u8)~bit;
  }

  /* A slot is dirty when the cartridge drew something else than what the client
     shows for it right now, which for a moving slot is where its motion has taken it. */
  u8 mask[32], moved[CON_SLOTS];
  u32 n = 0, nm = 0;
  memset(mask, 0, sizeof mask);
  for (u32 i = 0; i < CON_SLOTS; i++) {
    const u8 *c = &cur.ops[i * 8], *cm = &cur.mv[i * 6];
    u8 *o = &h->ops[i * 8], *om = &h->mv[i * 6];
    u8 now[8], nowm[6];
    if (con_moving(om)) {
      u32 dt = (u16)(frame - t0[view][i]);
      con_at(now, o, om, dt);
      memcpy(nowm, om, 6);
      nowm[0] = (u8)(om[0] + con_vel(om + 2) * (i32)dt); nowm[1] = (u8)(om[1] + con_vel(om + 4) * (i32)dt);
    } else { memcpy(now, o, 8); memset(nowm, 0, 6); }
    if (!memcmp(c, now, 8) && !memcmp(cm, nowm, 6)) continue;
    mask[i >> 3] |= (u8)(1u << (i & 7)); n++;
    if (con_moving(cm)) moved[nm++] = (u8)i;
    memcpy(o, c, 8); memcpy(om, cm, 6); t0[view][i] = frame;
  }
  if (n) {
    if (n < 32) {
      put(W_OPS_LIST); put((u8)n);
      for (u32 i = 0; i < CON_SLOTS; i++) if (mask[i >> 3] & (1u << (i & 7))) { put((u8)i); putn(&cur.ops[i * 8], 8); }
    } else {
      put(W_OPS_MASK); putn(mask, 32);
      for (u32 i = 0; i < CON_SLOTS; i++) if (mask[i >> 3] & (1u << (i & 7))) putn(&cur.ops[i * 8], 8);
    }
    if (nm) { put(W_MOVE); put((u8)nm); for (u32 k = 0; k < nm; k++) { put(moved[k]); putn(&cur.mv[moved[k] * 6], 6); } }
  }

  for (u8 i = 0; i < CON_BINDS; i++) {
    u8 *a = &cur.binds[i * 8], *b = &h->binds[i * 8];
    if (memcmp(a, b, 8)) { put(W_BIND); put(i); putn(a, 8); memcpy(b, a, 8); }
  }

  for (u8 i = 0; i < CON_STRS; i++) {
    u8 *a = &cur.strs[i * CON_STR_LEN], *b = &h->strs[i * CON_STR_LEN];
    if (memcmp(a, b, CON_STR_LEN)) {
      u8 len = 0; while (len < CON_STR_LEN && a[len]) len++;
      put(W_STR); put(i); put(len); putn(a, len);
      memcpy(b, a, CON_STR_LEN);
    }
  }

  if (view < cart_players && (full || acked[view] != in_count[view])) { put(W_ACK); put(in_count[view]); acked[view] = in_count[view]; }
  if (full || (music_dirty & bit)) { put(W_MUSIC); put(music_cmd); put(music_pat); music_dirty &= (u8)~bit; }
  for (u8 i = 0; i < sfx_n[view]; i++) { put(W_SFX); put(sfx_q[view][i]); }
  sfx_n[view] = 0;

  return out_n > head ? out_n : 0;          /* a packet with only its tick stamp says nothing */
}
