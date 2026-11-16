/* console.h — the whole contract between a cartridge and the console.
 *
 * DO = CPU, client = PPU + APU, OP is the new pixel.
 * Integers only, fixed sizes, deterministic: the same contract is meant to run
 * on an ESP32 or an FPGA later, so nothing here depends on a browser.
 *
 * A cartridge includes this file, implements the cart_* callbacks at the bottom
 * and is compiled together with sdk/runtime.c into one .wasm.
 */
#ifndef CONSOLE_H
#define CONSOLE_H

typedef unsigned char  u8;
typedef signed char    i8;
typedef unsigned short u16;
typedef short          i16;
typedef unsigned int   u32;
typedef int            i32;

/* ---- the client memory map ------------------------------------------ */
#define CON_SLOTS       256   /* OP buffer: 256 slots x 8 B              */
#define CON_OP_SIZE     8
#define CON_STRS        16    /* strings: 16 x 16 B, printable ASCII     */
#define CON_STR_LEN     16
#define CON_MOVE_SIZE   6     /* motion of a slot: fx fy vx(2) vy(2)     */
#define CON_MOVES       64    /* slots that may be in motion at once     */
#define CON_BINDS       4     /* slots the player's own stick may drive  */
#define CON_BIND_SIZE   8
#define CON_ROLES       8     /* palette: role 0 is always black         */
#define CON_LABELS      3     /* cartridge action buttons 2..4           */
#define CON_LABEL_LEN   8
#define CON_SFX         16    /* sound bank: 16 presets x 8 B            */
#define CON_PATTERNS    4     /* music patterns                          */
#define CON_STEPS       32    /* steps per pattern, x 4 channels         */
#define CON_PATTERN_SIZE (3 + CON_STEPS * 4)
#define CON_MAX_PLAYERS 6
#define CON_MAX_VIEWS   (CON_MAX_PLAYERS + 1)   /* + one shared spectator view */
#define CON_MAX_AGE     15    /* most ticks an input may claim to be "seen late" */

/* ---- OP: [opcode][color][6 params], coordinates 0..255 --------------- */
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

/* ---- color byte: bit 0-2 role | 3-4 brightness | 5 fill | 6-7 stroke width - 1 */
enum { C_BLACK = 0, C_PRIMARY, C_SECONDARY, C_ACCENT, C_HIGHLIGHT, C_ERROR, C_SUCCESS, C_SPARE };
enum { B25 = 0, B50, B75, B100 };
#define COL(role, bright, fill, width) \
  ((u8)(((role) & 7) | (((bright) & 3) << 3) | ((fill) ? 0x20 : 0) | ((((width) - 1) & 3) << 6)))
#define FILL(role)                    COL(role, B100, 1, 1)
#define FILL_B(role, bright)          COL(role, bright, 1, 1)
#define STROKE(role, width)           COL(role, B100, 0, width)
#define STROKE_B(role, bright, width) COL(role, bright, 0, width)
enum { ALIGN_LEFT = 0, ALIGN_CENTER, ALIGN_RIGHT };

/* ---- input byte: bit 0-2 stick direction | 3 stick active | 4 A | 5 B | 6-7 action button */
enum { DIR_U = 0, DIR_UR, DIR_R, DIR_DR, DIR_D, DIR_DL, DIR_L, DIR_UL };
#define IN_DIR(b)     ((b) & 7)
#define IN_ACTIVE(b)  ((b) & 8)
#define IN_A          0x10
#define IN_B          0x20
#define IN_ACTION(b)  (((b) >> 6) & 3)      /* 0 none, 1..3 = buttons 2..4 */
static inline i8 in_dx(u8 b) { static const i8 t[8] = {0, 1, 1, 1, 0, -1, -1, -1}; return IN_ACTIVE(b) ? t[b & 7] : 0; }
static inline i8 in_dy(u8 b) { static const i8 t[8] = {-1, -1, 0, 1, 1, 1, 0, -1}; return IN_ACTIVE(b) ? t[b & 7] : 0; }

enum { SYS_RESIGN = 1 };                    /* from the HOME overlay, never an input bit */

/* ---- sound ----------------------------------------------------------- */
enum { CH_PULSE1 = 0, CH_PULSE2, CH_TRIANGLE, CH_NOISE };
enum { DUTY_12 = 0, DUTY_25, DUTY_50, DUTY_75 };
enum { MUSIC_STOP = 0, MUSIC_PLAY = 1 };
#define SFX_DECAY 1                         /* flags bit 0: volume fades over the length */

/* ==== drawing: only inside cart_draw(view) ==============================
 * Every draw starts from an empty screen. Slot order = layer order.        */
void con_op(u8 slot, u8 op, u8 color, u8 a, u8 b, u8 c, u8 d, u8 e, u8 f);
void con_str(u8 id, const char *s);

static inline void con_rect (u8 s, u8 col, u8 x, u8 y, u8 w, u8 h) { con_op(s, OP_RECT, col, x, y, w, h, 0, 0); }
static inline void con_circ (u8 s, u8 col, u8 x, u8 y, u8 r)       { con_op(s, OP_CIRC, col, x, y, r, 0, 0, 0); }
static inline void con_tri  (u8 s, u8 col, u8 x1, u8 y1, u8 x2, u8 y2, u8 x3, u8 y3) { con_op(s, OP_TRI, col, x1, y1, x2, y2, x3, y3); }
static inline void con_diam (u8 s, u8 col, u8 cx, u8 cy, u8 w, u8 h) { con_op(s, OP_DIAM, col, cx, cy, w, h, 0, 0); }
static inline void con_line (u8 s, u8 col, u8 x1, u8 y1, u8 x2, u8 y2) { con_op(s, OP_LINE, col, x1, y1, x2, y2, 0, 0); }
static inline void con_point(u8 s, u8 col, u8 x, u8 y)             { con_op(s, OP_POINT, col, x, y, 0, 0, 0, 0); }
static inline void con_text (u8 s, u8 col, u8 x, u8 y, u8 size, u8 align, u8 str_id) { con_op(s, OP_TEXT, col, x, y, size, align, str_id, 0); }

/* Motion OP. Say that the slot just drawn keeps moving by (vx, vy) each tick, in 1/256
 * units, from the exact position (drawn x + fx/256, drawn y + fy/256). The client then
 * animates it by itself. While the cartridge keeps drawing the slot where that motion
 * puts it, nothing is sent; the moment it draws anything else, the correction goes out.
 * So motion can never make a picture wrong, it only saves bytes and smooths the display. */
void con_move(u8 slot, u8 fx, u8 fy, i16 vx, i16 vy);

/* Input binding (latency compensation). Say that this player's own stick drives the slot
 * just drawn, so the client moves it at once instead of waiting for the round trip.
 * The cartridge still moves it by the same rule; the client falls back on what it is sent.
 *   BIND_VEL : while the stick is held, x += dx * sx and y += dy * sy every tick
 *   BIND_STEP: once per push or change of direction, x += dx * sx and y += dy * sy
 * dx, dy are -1, 0, +1 from the stick. A move that would leave [min, max] is not made. */
enum { BIND_NONE = 0, BIND_VEL, BIND_STEP };
void con_bind(u8 id, u8 slot, u8 kind, i8 sx, i8 sy, u8 xmin, u8 xmax, u8 ymin, u8 ymax);

/* ==== transitions: palette, labels, tick rate, sound bank, music =======
 * Accepted only between begin and end; the client applies them all at once. */
void con_transition_begin(void);
void con_transition_end(void);
void con_pal(u8 role, u8 r, u8 g, u8 b);            /* role 1..7 */
void con_label(u8 button, const char *text);        /* button 2..4, max 8 chars, "" = unused */
void con_tick_rate(u8 hz);                          /* 0 = event-only, max 60 */
/* note = MIDI number, vol 0..15, sweep = signed semitones over the length, len in 10 ms */
void con_sfx_def(u8 id, u8 ch, u8 duty, u8 note, u8 vol, u8 sweep, u8 len, u8 flags);
/* notes = steps x 4 bytes (pulse 1, pulse 2, triangle, noise), 0 = rest */
void con_music_def(u8 id, u8 step_10ms, u8 steps, u8 vol, const u8 *notes);

/* ==== events (any time) ============================================== */
void con_sfx(u8 view_mask, u8 id);                  /* bit n = view n */
void con_music(u8 cmd, u8 pattern);
#define VIEW_ALL 0xFF
#define VIEW(n)  ((u8)(1u << (n)))

/* Inside cart_input: how many ticks old the picture was that the player reacted to
 * (0..CON_MAX_AGE). A game that judges timing takes this off, so a slow network does
 * not turn a press that was on time into a late one. */
u8 con_input_age(void);

/* ==== what the cartridge implements ================================== */
extern const u8 cart_players;                       /* seats, 1..6 */
void cart_init(void);                               /* once; do the first transition here */
void cart_presence(u8 player, u8 connected);
void cart_input(u8 player, u8 now, u8 prev);        /* at once, on every change */
void cart_sys(u8 player, u8 code);
void cart_tick(void);                               /* tick-rate times a second */
void cart_draw(u8 view);                            /* view < cart_players: that player; else spectator */

/* Optional: a cartridge may define these too. Without them the answers are "nobody" and
 * "still running".
 *   cart_turn   the seat that must act now, or 255 when nobody in particular. A device that
 *               hosts a match for two players on one screen shows that seat's view.
 *   cart_result 255 while the match runs; then the winning seat, or cart_players for a draw. */
u8 cart_turn(void);
u8 cart_result(void);

/* ==== shared arithmetic: runtime and PPU must agree bit for bit ======= */
static inline i32 con_floor8(i32 v) { return v >= 0 ? v >> 8 : -((255 - v) >> 8); }     /* floor(v / 256) */
static inline u8  con_clamp8(i32 v) { return (u8)(v < 0 ? 0 : v > 255 ? 255 : v); }
static inline i32 con_vel(const u8 *p) { return (i16)(u16)(p[0] | (p[1] << 8)); }
static inline u8  con_moving(const u8 *mv) { return (u8)(mv[2] | mv[3] | mv[4] | mv[5]); }

/* The OP `op` as it stands `n` ticks after it was written with motion `mv`.
 * Every point of the shape moves together; a coordinate stops at the screen edge. */
static inline void con_at(u8 *out, const u8 *op, const u8 *mv, u32 n) {
  i32 dx = con_floor8(mv[0] + con_vel(mv + 2) * (i32)n), dy = con_floor8(mv[1] + con_vel(mv + 4) * (i32)n);
  u8 points = op[0] == OP_TRI ? 3 : op[0] == OP_LINE ? 2 : 1;
  for (u8 i = 0; i < CON_OP_SIZE; i++) out[i] = op[i];
  for (u8 i = 0; i < points; i++) {
    out[2 + i * 2] = con_clamp8(op[2 + i * 2] + dx);
    out[3 + i * 2] = con_clamp8(op[3 + i * 2] + dy);
  }
}

#endif
