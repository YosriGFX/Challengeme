/* ppu.c — the client memory map (PPU + APU registers), compiled to WASM.
 *
 * No game logic lives here. It applies packets from the CPU to fixed memory
 * regions; the browser reads those regions to draw and to play sound. The
 * same file is the reference for an ESP32 or FPGA client.
 *
 * Enforced here, never trusted to the server:
 *   - a packet is applied whole or not at all
 *   - palette, labels, tick rate, sound bank and music change only inside a
 *     transition, all at once at END
 *   - role 0 stays black, text stays printable ASCII, the tick stays <= 60 Hz
 */
#include "../sdk/console.h"
#include "../sdk/wire.h"

#ifdef __wasm__                  /* the browser build: no libc, and the functions are exports */
void *memcpy(void *d, const void *s, unsigned long n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, unsigned long n) { u8 *a = d; while (n--) *a++ = (u8)c; return d; }
#define EXPORT(name) __attribute__((export_name(#name)))
#else                            /* a device or a desktop: plain C functions (see hardware/) */
#include <string.h>
#define EXPORT(name)
#endif

typedef struct {                 /* changes with any packet */
  u8 ops[CON_SLOTS * CON_OP_SIZE];
  u8 mv[CON_SLOTS * CON_MOVE_SIZE];
  u16 t0[CON_SLOTS];             /* the tick each slot was written: motion counts from it */
  u8 strs[CON_STRS * CON_STR_LEN];
  u8 binds[CON_BINDS * CON_BIND_SIZE];
  u16 frame;                     /* the server tick of the last packet */
  u8 ack;                        /* this player's inputs the server has handled */
} Live;
typedef struct {                 /* changes only at the END of a transition */
  u8 pal[CON_ROLES * 3];
  u8 labels[CON_LABELS * CON_LABEL_LEN];
  u8 tick;
  u8 sfx[CON_SFX * 8];
  u8 music[CON_PATTERNS * CON_PATTERN_SIZE];
} Trans;

static Live live, work;          /* a packet is applied to `work`, then committed */
static Trans trans, shadow;
static u8 rx[WIRE_MAX_PACKET];
static u8 events[64];            /* triples [type][a][b], type = W_SFX or W_MUSIC */
static u32 events_n;
static u8 view[CON_SLOTS * CON_OP_SIZE];

EXPORT(ppu_rx)       u8  *ppu_rx(void)       { return rx; }
EXPORT(ppu_ops)      u8  *ppu_ops(void)      { return live.ops; }
EXPORT(ppu_moves)    u8  *ppu_moves(void)    { return live.mv; }
EXPORT(ppu_t0)       u16 *ppu_t0(void)       { return live.t0; }
EXPORT(ppu_strs)     u8  *ppu_strs(void)     { return live.strs; }
EXPORT(ppu_binds)    u8  *ppu_binds(void)    { return live.binds; }
EXPORT(ppu_frame)    u32  ppu_frame(void)    { return live.frame; }
EXPORT(ppu_ack)      u32  ppu_ack(void)      { return live.ack; }
EXPORT(ppu_pal)      u8  *ppu_pal(void)      { return trans.pal; }
EXPORT(ppu_labels)   u8  *ppu_labels(void)   { return trans.labels; }
EXPORT(ppu_tick)     u32  ppu_tick(void)     { return trans.tick; }
EXPORT(ppu_sfx)      u8  *ppu_sfx(void)      { return trans.sfx; }
EXPORT(ppu_music)    u8  *ppu_music(void)    { return trans.music; }
EXPORT(ppu_events)   u8  *ppu_events(void)   { return events; }
EXPORT(ppu_events_n) u32  ppu_events_n(void) { return events_n; }

/* The whole OP buffer as it stands at server tick `tick`, every moving slot advanced.
 * A hardware client draws this once per tick; the browser does the same sum with a
 * fraction of a tick to move smoothly at any refresh rate. */
EXPORT(ppu_view) u8 *ppu_view(u32 tick) {
  for (u32 s = 0; s < CON_SLOTS; s++) {
    const u8 *op = &live.ops[s * 8], *mv = &live.mv[s * 6];
    if (con_moving(mv)) con_at(&view[s * 8], op, mv, (u16)(tick - live.t0[s]));
    else memcpy(&view[s * 8], op, 8);
  }
  return view;
}

#define F_DRAW  1   /* OPs, motion, bindings or strings changed */
#define F_TRANS 2   /* a transition was applied                 */
#define F_EVENT 4   /* sound events are waiting                 */
#define F_RESET 8   /* a full dump: forget what came before     */
#define F_ERROR 128 /* malformed packet, nothing applied        */

static u8 text(u8 c) { return (c >= 0x20 && c <= 0x7E) ? c : '?'; }
static void write_slot(u32 s, const u8 *src) {
  memcpy(&work.ops[s * 8], src, 8);
  memset(&work.mv[s * 6], 0, 6);            /* a written slot stands still until a MOVE says otherwise */
  work.t0[s] = work.frame;
}

/* Apply one packet of `len` bytes from the rx buffer. Returns F_* flags. */
EXPORT(ppu_apply) u32 ppu_apply(u32 len) {
  u32 i = 0, flags = 0, ev = 0;
  u8 in_trans = 0, trans_done = 0, evbuf[sizeof events];
  if (len > WIRE_MAX_PACKET) return F_ERROR;
  memcpy(&work, &live, sizeof live);
  memcpy(&shadow, &trans, sizeof trans);

#define NEED(n) if (i + (n) > len) return F_ERROR
  while (i < len) {
    u8 t = rx[i++];
    switch (t) {
    case W_RESET:
      memset(work.ops, 0, sizeof work.ops); memset(work.mv, 0, sizeof work.mv); memset(work.t0, 0, sizeof work.t0);
      memset(work.strs, 0, sizeof work.strs); memset(work.binds, 0, sizeof work.binds);
      flags |= F_DRAW | F_RESET; break;
    case W_FRAME: NEED(2); work.frame = (u16)(rx[i] | (rx[i + 1] << 8)); i += 2; break;
    case W_ACK: NEED(1); work.ack = rx[i++]; break;
    case W_OPS_LIST: {
      NEED(1); u32 n = rx[i++]; NEED(n * 9);
      while (n--) { write_slot(rx[i], &rx[i + 1]); i += 9; }
      flags |= F_DRAW; break; }
    case W_OPS_MASK: {
      NEED(32); const u8 *m = &rx[i]; i += 32;
      for (u32 s = 0; s < CON_SLOTS; s++)
        if (m[s >> 3] & (1u << (s & 7))) { NEED(8); write_slot(s, &rx[i]); i += 8; }
      flags |= F_DRAW; break; }
    case W_MOVE: {
      NEED(1); u32 n = rx[i++]; NEED(n * 7);
      while (n--) { u32 s = rx[i]; memcpy(&work.mv[s * 6], &rx[i + 1], 6); work.t0[s] = work.frame; i += 7; }
      flags |= F_DRAW; break; }
    case W_BIND: {
      NEED(9); if (rx[i] >= CON_BINDS || rx[i + 2] > BIND_STEP) return F_ERROR;
      memcpy(&work.binds[rx[i] * 8], &rx[i + 1], 8); i += 9;
      flags |= F_DRAW; break; }
    case W_STR: {
      NEED(2); u8 id = rx[i], n = rx[i + 1]; i += 2; NEED(n);
      if (id >= CON_STRS || n > CON_STR_LEN) return F_ERROR;
      memset(&work.strs[id * CON_STR_LEN], 0, CON_STR_LEN);
      for (u8 k = 0; k < n; k++) work.strs[id * CON_STR_LEN + k] = text(rx[i + k]);
      i += n; flags |= F_DRAW; break; }
    case W_BEGIN: in_trans = 1; break;
    case W_END: if (!in_trans) return F_ERROR; in_trans = 0; trans_done = 1; break;
    case W_PAL:
      NEED(4); if (!in_trans || rx[i] == 0 || rx[i] >= CON_ROLES) return F_ERROR;      /* black is never writable */
      memcpy(&shadow.pal[rx[i] * 3], &rx[i + 1], 3); i += 4; break;
    case W_LABEL: {
      NEED(1 + CON_LABEL_LEN); if (!in_trans || rx[i] < 2 || rx[i] > 4) return F_ERROR;
      u8 *l = &shadow.labels[(rx[i] - 2) * CON_LABEL_LEN];
      for (u8 k = 0; k < CON_LABEL_LEN; k++) l[k] = rx[i + 1 + k] ? text(rx[i + 1 + k]) : 0;
      i += 1 + CON_LABEL_LEN; break; }
    case W_TICK: NEED(1); if (!in_trans || rx[i] > 60) return F_ERROR; shadow.tick = rx[i++]; break;
    case W_SFXDEF:
      NEED(9); if (!in_trans || rx[i] >= CON_SFX) return F_ERROR;
      memcpy(&shadow.sfx[rx[i] * 8], &rx[i + 1], 8); i += 9; break;
    case W_MUSDEF: {
      NEED(4); u8 id = rx[i], steps = rx[i + 2];
      if (!in_trans || id >= CON_PATTERNS || steps > CON_STEPS) return F_ERROR;
      NEED(4 + (u32)steps * 4);
      memcpy(&shadow.music[id * CON_PATTERN_SIZE], &rx[i + 1], 3 + (u32)steps * 4);
      i += 4 + (u32)steps * 4; break; }
    case W_SFX:
      NEED(1); if (ev + 3 <= sizeof evbuf) { evbuf[ev++] = W_SFX; evbuf[ev++] = rx[i]; evbuf[ev++] = 0; } i += 1; break;
    case W_MUSIC:
      NEED(2); if (ev + 3 <= sizeof evbuf) { evbuf[ev++] = W_MUSIC; evbuf[ev++] = rx[i]; evbuf[ev++] = rx[i + 1]; } i += 2; break;
    default: return F_ERROR;
    }
  }
  if (in_trans) return F_ERROR;                       /* BEGIN without END */

  memcpy(&live, &work, sizeof live);                  /* commit: the whole packet shows at once */
  if (trans_done) { memcpy(&trans, &shadow, sizeof trans); flags |= F_TRANS; }
  memcpy(events, evbuf, ev); events_n = ev / 3;
  if (ev) flags |= F_EVENT;
  return flags;
}
