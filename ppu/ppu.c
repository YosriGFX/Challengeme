/* ppu.c — the client-side memory map (PPU + APU registers), compiled to WASM.
 *
 * It holds no game logic. It only applies packets from the CPU to fixed
 * memory regions; the browser reads those regions to draw and play sound.
 * The same file is the reference for a future ESP32 / FPGA client.
 *
 * Rules enforced here, not trusted to the server:
 *   - palette / labels / tick / sound bank / music only change inside a
 *     transition, and all at once at END
 *   - a malformed packet is dropped as a whole (nothing half-applied)
 */
#include "../sdk/console.h"
#include "../sdk/wire.h"

void *memcpy(void *d, const void *s, unsigned long n) { u8 *a = d; const u8 *b = s; while (n--) *a++ = *b++; return d; }
void *memset(void *d, int c, unsigned long n) { u8 *a = d; while (n--) *a++ = (u8)c; return d; }

#define EXPORT(name) __attribute__((export_name(#name)))

/* live regions */
static u8 ops[CON_SLOTS * CON_OP_SIZE];
static u8 strs[CON_STRS * CON_STR_LEN];
typedef struct {
  u8 pal[CON_ROLES * 3];
  u8 labels[CON_LABELS * CON_LABEL_LEN];
  u8 tick;
  u8 sfx[CON_SFX * 8];
  u8 music[CON_PATTERNS * (3 + CON_STEPS * 4)];
} Trans;
static Trans live, shadow;

/* staging: a packet is applied to copies first, then committed */
static u8 ops_w[sizeof ops], strs_w[sizeof strs];

static u8 rx[WIRE_MAX_PACKET];
static u8 events[64];           /* pairs: [type][a][b], type = W_SFX or W_MUSIC */
static u32 events_n;
static u32 frame;                /* the server tick this picture belongs to */

EXPORT(ppu_rx)       u8 *ppu_rx(void)       { return rx; }
EXPORT(ppu_ops)      u8 *ppu_ops(void)      { return ops; }
EXPORT(ppu_strs)     u8 *ppu_strs(void)     { return strs; }
EXPORT(ppu_pal)      u8 *ppu_pal(void)      { return live.pal; }
EXPORT(ppu_labels)   u8 *ppu_labels(void)   { return live.labels; }
EXPORT(ppu_tick)     u32 ppu_tick(void)     { return live.tick; }
EXPORT(ppu_sfx)      u8 *ppu_sfx(void)      { return live.sfx; }
EXPORT(ppu_music)    u8 *ppu_music(void)    { return live.music; }
EXPORT(ppu_events)   u8 *ppu_events(void)   { return events; }
EXPORT(ppu_events_n) u32 ppu_events_n(void) { return events_n; }
EXPORT(ppu_frame)    u32 ppu_frame(void)    { return frame; }

#define F_DRAW  1   /* OP buffer or strings changed       */
#define F_TRANS 2   /* a transition was applied           */
#define F_EVENT 4   /* sound events are waiting           */
#define F_RESET 8   /* a full dump: forget what came before */
#define F_ERROR 128 /* malformed packet, nothing applied  */

/* Apply one packet of `len` bytes from the rx buffer. Returns F_* flags. */
EXPORT(ppu_apply) u32 ppu_apply(u32 len) {
  u32 i = 0, flags = 0, ev = 0;
  u8 in_trans = 0, trans_done = 0;
  u32 new_frame = frame;
  u8 evbuf[sizeof events];
  if (len > WIRE_MAX_PACKET) return F_ERROR;
  memcpy(ops_w, ops, sizeof ops);
  memcpy(strs_w, strs, sizeof strs);
  memcpy(&shadow, &live, sizeof live);

#define NEED(n) if (i + (n) > len) return F_ERROR
  while (i < len) {
    u8 t = rx[i++];
    switch (t) {
    case W_RESET:
      memset(ops_w, 0, sizeof ops_w); memset(strs_w, 0, sizeof strs_w); flags |= F_DRAW | F_RESET; break;
    case W_FRAME: NEED(2); new_frame = rx[i] | ((u32)rx[i + 1] << 8); i += 2; break;
    case W_OPS_LIST: {
      NEED(1); u32 n = rx[i++]; NEED(n * 9);
      while (n--) { memcpy(&ops_w[rx[i] * 8], &rx[i + 1], 8); i += 9; }
      flags |= F_DRAW; break; }
    case W_OPS_MASK: {
      NEED(32); const u8 *m = &rx[i]; i += 32;
      for (u32 s = 0; s < CON_SLOTS; s++)
        if (m[s >> 3] & (1u << (s & 7))) { NEED(8); memcpy(&ops_w[s * 8], &rx[i], 8); i += 8; }
      flags |= F_DRAW; break; }
    case W_STR: {
      NEED(2); u8 id = rx[i], n = rx[i + 1]; i += 2; NEED(n);
      if (id >= CON_STRS || n > CON_STR_LEN) return F_ERROR;
      memset(&strs_w[id * CON_STR_LEN], 0, CON_STR_LEN);
      for (u8 k = 0; k < n; k++) { u8 c = rx[i + k]; strs_w[id * CON_STR_LEN + k] = (c >= 0x20 && c <= 0x7E) ? c : '?'; }
      i += n; flags |= F_DRAW; break; }
    case W_BEGIN: in_trans = 1; break;
    case W_END: if (!in_trans) return F_ERROR; in_trans = 0; trans_done = 1; break;
    case W_PAL: {
      NEED(4); if (!in_trans || rx[i] == 0 || rx[i] >= CON_ROLES) return F_ERROR;   /* black is never writable */
      memcpy(&shadow.pal[rx[i] * 3], &rx[i + 1], 3); i += 4; break; }
    case W_LABEL: {
      NEED(1 + CON_LABEL_LEN); if (!in_trans || rx[i] < 2 || rx[i] > 4) return F_ERROR;
      u8 *l = &shadow.labels[(rx[i] - 2) * CON_LABEL_LEN];
      for (u8 k = 0; k < CON_LABEL_LEN; k++) { u8 c = rx[i + 1 + k]; l[k] = (!c || (c >= 0x20 && c <= 0x7E)) ? c : '?'; }
      i += 1 + CON_LABEL_LEN; break; }
    case W_TICK: NEED(1); if (!in_trans || rx[i] > 60) return F_ERROR; shadow.tick = rx[i++]; break;
    case W_SFXDEF: {
      NEED(9); if (!in_trans || rx[i] >= CON_SFX) return F_ERROR;
      memcpy(&shadow.sfx[rx[i] * 8], &rx[i + 1], 8); i += 9; break; }
    case W_MUSDEF: {
      NEED(4); u8 id = rx[i], steps = rx[i + 2];
      if (!in_trans || id >= CON_PATTERNS || steps > CON_STEPS) return F_ERROR;
      NEED(4 + (u32)steps * 4);
      memcpy(&shadow.music[id * (3 + CON_STEPS * 4)], &rx[i + 1], 3 + (u32)steps * 4);
      i += 4 + (u32)steps * 4; break; }
    case W_SFX:
      NEED(1); if (ev + 3 <= sizeof evbuf) { evbuf[ev++] = W_SFX; evbuf[ev++] = rx[i]; evbuf[ev++] = 0; } i += 1; break;
    case W_MUSIC:
      NEED(2); if (ev + 3 <= sizeof evbuf) { evbuf[ev++] = W_MUSIC; evbuf[ev++] = rx[i]; evbuf[ev++] = rx[i + 1]; } i += 2; break;
    default: return F_ERROR;
    }
  }
  if (in_trans) return F_ERROR;                       /* BEGIN without END */

  /* commit: the whole packet becomes visible at once */
  memcpy(ops, ops_w, sizeof ops);
  memcpy(strs, strs_w, sizeof strs);
  frame = new_frame;
  if (trans_done) { memcpy(&live, &shadow, sizeof live); flags |= F_TRANS; }
  memcpy(events, evbuf, ev); events_n = ev / 3;
  if (ev) flags |= F_EVENT;
  return flags;
}
