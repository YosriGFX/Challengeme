/* console.h — the one header a cartridge needs.
 *
 * DO = CPU, client = PPU + APU, OP is the new pixel.
 * Integers only, fixed sizes, deterministic: this is a hardware contract.
 *
 * A cartridge implements the cart_* callbacks at the bottom and calls the
 * con_* API. It is compiled together with sdk/runtime.c into one .wasm.
 */
#ifndef CONSOLE_H
#define CONSOLE_H

typedef unsigned char  u8;
typedef signed char    i8;
typedef unsigned short u16;
typedef short          i16;
typedef unsigned int   u32;
typedef int            i32;

/* ---- sizes of the client memory map -------------------------------- */
#define CON_SLOTS       256   /* OP buffer: 256 slots x 8 B = 2 KB       */
#define CON_OP_SIZE     8
#define CON_STRS        16    /* string pool: 16 strings x 16 B = 256 B  */
#define CON_STR_LEN     16
#define CON_ROLES       8     /* role 0 is always black (#000)           */
#define CON_LABELS      3     /* cartridge action buttons 2..4           */
#define CON_LABEL_LEN   8
#define CON_SFX         16    /* sound bank: 16 presets x 8 B            */
#define CON_PATTERNS    4     /* music patterns                          */
#define CON_STEPS       32    /* max steps per pattern (x 4 channels)    */
#define CON_MAX_PLAYERS 6
#define CON_MAX_VIEWS   (CON_MAX_PLAYERS + 1)  /* + one spectator view   */

/* ---- OP codes: [opcode][color][6 params] --------------------------- */
enum {
  OP_NOP = 0,
  OP_RECT,   /* x, y, w, h                 */
  OP_CIRC,   /* x, y, r                    */
  OP_TRI,    /* x1, y1, x2, y2, x3, y3     */
  OP_DIAM,   /* cx, cy, w, h               */
  OP_LINE,   /* x1, y1, x2, y2             */
  OP_POINT,  /* x, y                       */
  OP_TEXT    /* x, y, size, align, str_id  */
};

/* ---- color byte ----------------------------------------------------
 * bit 0-2 role | bit 3-4 brightness | bit 5 fill | bit 6-7 stroke width-1 */
enum { C_BLACK = 0, C_PRIMARY, C_SECONDARY, C_ACCENT,
       C_HIGHLIGHT, C_ERROR, C_SUCCESS, C_SPARE };
enum { B25 = 0, B50, B75, B100 };
#define COL(role, bright, fill, width) \
  ((u8)(((role) & 7) | (((bright) & 3) << 3) | ((fill) ? 0x20 : 0) | ((((width) - 1) & 3) << 6)))
#define FILL(role)            COL(role, B100, 1, 1)
#define FILL_B(role, bright)  COL(role, bright, 1, 1)
#define STROKE(role, width)   COL(role, B100, 0, width)
#define STROKE_B(role, bright, width) COL(role, bright, 0, width)

enum { ALIGN_LEFT = 0, ALIGN_CENTER, ALIGN_RIGHT };

/* ---- input byte ----------------------------------------------------
 * bit 0-2 stick direction | bit 3 stick active | bit 4 A | bit 5 B
 * bit 6-7 action: 0 none, 1 = button 2, 2 = button 3, 3 = button 4      */
enum { DIR_U = 0, DIR_UR, DIR_R, DIR_DR, DIR_D, DIR_DL, DIR_L, DIR_UL };
#define IN_DIR(b)     ((b) & 7)
#define IN_ACTIVE(b)  ((b) & 8)
#define IN_A          0x10
#define IN_B          0x20
#define IN_ACTION(b)  (((b) >> 6) & 3)
/* stick as dx/dy (-1, 0, +1), screen coordinates (y grows down) */
static inline i8 in_dx(u8 b) { static const i8 t[8] = {0,1,1,1,0,-1,-1,-1}; return IN_ACTIVE(b) ? t[b & 7] : 0; }
static inline i8 in_dy(u8 b) { static const i8 t[8] = {-1,-1,0,1,1,1,0,-1}; return IN_ACTIVE(b) ? t[b & 7] : 0; }

/* ---- system messages (from the HOME overlay, never input bits) ----- */
enum { SYS_RESIGN = 1, SYS_PAUSE = 2 };

/* ---- APU ------------------------------------------------------------ */
enum { CH_PULSE1 = 0, CH_PULSE2, CH_TRIANGLE, CH_NOISE };
enum { DUTY_12 = 0, DUTY_25, DUTY_50, DUTY_75 };
enum { MUSIC_STOP = 0, MUSIC_PLAY = 1 };
#define SFX_DECAY 1   /* flags bit 0: volume decays to 0 over the length */

/* ==== drawing: only valid inside cart_draw(view) =====================
 * Every draw starts from an empty OP buffer and empty strings.
 * Slot order = layer order (slot 0 is drawn first).                     */
void con_op(u8 slot, u8 op, u8 color, u8 a, u8 b, u8 c, u8 d, u8 e, u8 f);
void con_str(u8 id, const char *s);                 /* printable ASCII, max 16 */

static inline void con_rect (u8 s, u8 col, u8 x, u8 y, u8 w, u8 h) { con_op(s, OP_RECT,  col, x, y, w, h, 0, 0); }
static inline void con_circ (u8 s, u8 col, u8 x, u8 y, u8 r)       { con_op(s, OP_CIRC,  col, x, y, r, 0, 0, 0); }
static inline void con_tri  (u8 s, u8 col, u8 x1, u8 y1, u8 x2, u8 y2, u8 x3, u8 y3) { con_op(s, OP_TRI, col, x1, y1, x2, y2, x3, y3); }
static inline void con_diam (u8 s, u8 col, u8 cx, u8 cy, u8 w, u8 h) { con_op(s, OP_DIAM, col, cx, cy, w, h, 0, 0); }
static inline void con_line (u8 s, u8 col, u8 x1, u8 y1, u8 x2, u8 y2) { con_op(s, OP_LINE, col, x1, y1, x2, y2, 0, 0); }
static inline void con_point(u8 s, u8 col, u8 x, u8 y)             { con_op(s, OP_POINT, col, x, y, 0, 0, 0, 0); }
static inline void con_text (u8 s, u8 col, u8 x, u8 y, u8 size, u8 align, u8 str_id) { con_op(s, OP_TEXT, col, x, y, size, align, str_id, 0); }

/* ==== transitions: palette / labels / tick / sound bank / music =====
 * These writes are only accepted between begin and end, and the client
 * applies them all at once at END.                                      */
void con_transition_begin(void);
void con_transition_end(void);
void con_pal(u8 role, u8 r, u8 g, u8 b);            /* role 1..7 */
void con_label(u8 button, const char *text);        /* button 2..4, max 8 chars, "" = unused */
void con_tick_rate(u8 hz);                          /* 0 = event-only, max 60 */
void con_sfx_def(u8 id, u8 ch, u8 duty, u8 note, u8 vol, u8 sweep, u8 len, u8 flags);
/* note = MIDI number, vol 0..15, sweep = signed semitones over the length,
 * len in 10 ms units. notes = steps x 4 bytes (pulse1, pulse2, triangle, noise), 0 = rest */
void con_music_def(u8 id, u8 step_10ms, u8 steps, u8 vol, const u8 *notes);

/* ==== events (any time) ============================================== */
void con_sfx(u8 view_mask, u8 id);                  /* bit n = view n */
void con_music(u8 cmd, u8 pattern);                 /* MUSIC_PLAY / MUSIC_STOP */
#define VIEW_ALL 0xFF
#define VIEW(n)  ((u8)(1u << (n)))

/* ==== what the cartridge implements ================================== */
extern const u8 cart_players;                       /* number of player seats */
void cart_init(void);                               /* called once; do the first transition here */
void cart_presence(u8 player, u8 connected);
void cart_input(u8 player, u8 now, u8 prev);        /* called immediately on every change */
void cart_sys(u8 player, u8 code);
void cart_tick(void);                               /* called tick-rate times per second */
void cart_draw(u8 view);                            /* view < cart_players: that player; else spectator */

#endif
