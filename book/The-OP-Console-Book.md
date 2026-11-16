# The OP Console Book

Nov 15, 2026

> **Revision notes (latest engine).** Three things changed after this book was first written:
>
> 1. **Folders.** Only `public/` is served to players. The client's C source moved to `ppu/ppu.c`.
> 2. **Smooth playback.** Every packet now starts with a `FRAME` record (0x02, 2 bytes: the server tick).
>    For games at 20 Hz or more, the client plays frames back on its own steady clock, slightly behind
>    the newest one, and glides between two frames. Packet sizes quoted below are 3 bytes larger.
> 3. **Sound.** The client's sound engine is now a Game Boy chip (`public/chip.js`, an AudioWorklet)
>    driven by `public/sound.js`. Channel 2 is the wave channel loaded with a triangle. The cartridge
>    API in chapter 11 is unchanged. The "clean / raw" option is gone.
>
> The README in the engine folder is always the current reference.

## How to read this book

Read one part per day with the code open beside you, and by day 3 you can write a game and change the engine itself. Every chapter names the file it explains, so read the chapter, then read that file.

| Day | Goal | Chapters | Files to keep open |
| --- | --- | --- | --- |
| 1 | Understand the machine | 1 to 5 | `sdk/console.h`, `sdk/wire.h` |
| 2 | Write games | 6 to 12 | `carts/pong/pong.c`, `carts/dama/dama.c` |
| 3 | Own the engine | 13 to 17 | `sdk/runtime.c`, `ppu/ppu.c`, `public/main.js`, `host/match.mjs`, `worker/src/index.js` |

The whole engine is about 1,500 lines. Nothing in it is hidden behind a framework, so when the book and the code disagree, the code is right.

Two commands are all you need while reading:

```
make                      # rebuild the .wasm files after you change C
cd worker && npx wrangler dev   # run the Worker and Durable Object locally
```

Open the printed address in two browser tabs to play as two players.

# Day 1: Understand the machine

## 1. The idea in one page

The console is a classic CPU + PPU machine split across the network: the game runs only on the server, and the client only draws what it is told.

```
  PLAYER DEVICE: THE TERMINAL                        CLOUDFLARE: THE MACHINE
 +--------------------------------+                +------------------------------------+
 |  Input thread                  |                |  Hono Worker                       |
 |  Web Worker, owns the WebSocket|                |  checks access, hands the socket on|
 +--------------------------------+                +------------------------------------+
        |                                                        (connect time only)
        |   input: 1 byte, only on change
        +------------------------------------------>+------------------------------------+
                                                    |  DURABLE OBJECT = CPU              |
 +--------------------------------+                 |  one per match, the source of truth|
 |  PPU (ppu.wasm)                |                 |                                    |
 |  256 OP slots, strings, palette|                 |   +----------------------------+   |
 |  applies each packet atomically|<----------------+   | Cartridge (C to WASM)      |   |
 +--------------------------------+  changed OPs    |   | game state and rules       |   |
        |                            only           |   +----------------------------+   |
        v                                           |   +----------------------------+   |
 +--------------------------------+                 |   | Runtime                    |   |
 |  Canvas2D and APU              |                 |   | per-view diff and encoder  |   |
 |  draws the slots, plays presets|                 |   +----------------------------+   |
 |  no game logic on the device   |                 +------------------------------------+
 +--------------------------------+
                         one WebSocket per player
```

Input goes up as one byte to the cartridge inside the Durable Object. Only changed OPs come back down to the PPU. The Worker is involved once, at connect time.

| Part | Where it runs | What it does | Game Boy equivalent |
| --- | --- | --- | --- |
| CPU | Durable Object, one per match | Runs the cartridge (C compiled to WASM), owns all game state | SM83 + cartridge |
| PPU | Client, `ppu.wasm` + Canvas2D | Holds 256 draw OPs, strings and a palette, and draws them | PPU reading OAM and VRAM |
| APU | Client, WebAudio | Plays presets from a sound bank and loops music patterns | APU registers |
| Bus | One WebSocket per player | Up: a 1-byte input register. Down: only the bytes that changed | The memory bus |
| Gateway | Hono Worker | Serves the client, checks who may join, hands the socket to the match | The cartridge slot |

Three sentences hold the whole design:

1. **The DO is the CPU.** It runs the cartridge and writes OPs into a 2 KB OP buffer.
2. **The wire carries only changes.** An idle screen costs zero bytes.
3. **The client is the PPU.** It reads the OP buffer and the browser draws it crisp at any size.

**OP is the new pixel.** An OP is one 8-byte draw instruction (a circle, a rectangle, a line of text). The screen is a 256 x 256 unit space, like an SVG viewBox, so every coordinate fits in one byte and the picture stays sharp on any display.

**Secure by design** means the client never receives anything the player has not reached or may not see. There is no game code, no hidden state and no asset pack on the device. Each player gets their own view stream, so a hidden card or the other player's cursor never leaves the server.

**The OP set is a hardware contract.** Everything is integers, fixed sizes and deterministic. That is what lets the same protocol run later on an ESP32 or an FPGA.

## 2. Follow one button press

One press of the stick in Dama costs 2 bytes up and 11 bytes down, and touches every part of the engine. Trace it once and you know the whole system.

1. **The player pushes the stick right.** `public/main.js` builds the input byte in `updateInput()`. Stick right is direction 2 with the active bit, so the byte is `0x0A`.
2. **Local echo.** The same function moves the on-screen knob and plays a tick sound at once, before anything is sent.
3. **The input thread sends it.** `main.js` posts the byte to `public/input-worker.js`. The worker owns the WebSocket and sends `[0x01][0x0A]`, only because the byte changed.
4. **The Worker is not involved.** The socket was handed to the Durable Object at connect time, so the 2 bytes arrive straight in the match.
5. **The match passes it to the cartridge.** `host/match.mjs` calls `con_input(seat, byte)`. The runtime remembers the previous byte and calls `cart_input(player, now, prev)`.
6. **The game reacts.** In `carts/dama/dama.c`, `cart_input` sees the stick became active and moves that player's cursor one cell. Nothing is drawn yet.
7. **The match flushes every view.** For each connected player, `match.mjs` calls `con_flush(view, 0)`.
8. **The runtime redraws and diffs.** `con_flush` clears a scratch OP buffer, calls `cart_draw(view)`, then compares the result slot by slot with what that player's client already has. One slot differs: the cursor rectangle.
9. **The runtime encodes the packet.** One changed slot becomes `[0x10][1][slot][8 bytes]`, 11 bytes. The other player's view has no change, so they get nothing.
10. **The client applies it.** The worker passes the packet to `main.js`, which copies it into `ppu.wasm` and calls `ppu_apply(len)`. The PPU writes the 8 bytes into slot 146 of its OP buffer.
11. **The browser draws.** `draw()` walks the 256 slots in order and issues Canvas2D calls scaled from 256 units to real pixels.

Steps 5 to 9 are the server's whole job for one input: about one function call each. Inputs never wait for a tick, so this path runs the moment the byte arrives.

## 3. The client memory map

The client's entire state is about 3 KB of fixed memory regions, defined in `ppu/ppu.c`. The server's only job is to keep those regions equal to what the cartridge wants each player to see.

| Region | Size | Content | Changes |
| --- | --- | --- | --- |
| OP buffer | 256 slots x 8 B = 2,048 B | Draw instructions. Slot order is layer order | Any time |
| String pool | 16 strings x 16 B = 256 B | Printable ASCII text that `TEXT` OPs point to | Any time |
| Palette | 8 roles x 3 B = 24 B | RGB per role. Role 0 is always black | Transition only |
| Labels | 3 x 8 B = 24 B | Text under action buttons 2, 3 and 4 | Transition only |
| Tick rate | 1 B | The cartridge's current tick rate, for display | Transition only |
| Sound bank | 16 presets x 8 B = 128 B | APU register presets, one per sound effect | Transition only |
| Music | 4 patterns x 131 B = 524 B | Step patterns for the 4 channels | Transition only |

The regions fall into two groups, and the difference matters when you design a game.

**Live regions** (OP buffer, strings) can change in any packet. This is your gameplay stream: movement, scores, messages.

**Transition regions** (palette, labels, tick, sound bank, music) change only between `BEGIN_TRANSITION` and `END_TRANSITION`, and the client applies them all at once at END. Use a transition at a safe moment: load, level change, pause, match end. The PPU enforces this itself and rejects a palette write outside a transition.

**Load is just the first dump.** When a player joins, the server sends `RESET`, one transition with every transition region, and every non-empty OP and string. A reconnect does the same, so there is no history to replay.

**Packets are atomic.** `ppu_apply` works on staging copies and commits only if the whole packet parsed. A frame never shows new shapes with old colors, and a corrupt packet changes nothing.

The server keeps a mirror of the live regions for every view, in `sdk/runtime.c`. That mirror is what makes the diff possible.

## 4. The OP, the color byte and the input byte

Three byte layouts are the whole hardware contract, and all three live in `sdk/console.h`.

### The OP: 8 bytes

```
[opcode][color][a][b][c][d][e][f]
```

| Opcode | Name | Parameters | Notes |
| --- | --- | --- | --- |
| 0 | `NOP` | none | Empty slot, draws nothing |
| 1 | `RECT` | x, y, w, h | A stroke is drawn inside the box |
| 2 | `CIRC` | x, y, r | Center and radius |
| 3 | `TRI` | x1, y1, x2, y2, x3, y3 | Uses all 6 bytes |
| 4 | `DIAM` | cx, cy, w, h | Diamond (losange) around a center |
| 5 | `LINE` | x1, y1, x2, y2 | Round caps, width from the color byte |
| 6 | `POINT` | x, y | A dot as wide as the stroke width |
| 7 | `TEXT` | x, y, size, align, str\_id | Baseline at y, size in units |

Coordinates are `uint8`, so the range is 0 to 255. A shape cannot be 256 wide, and a center cannot sit off-screen. Complex shapes are built by layering simple ones.

### The color byte

```
bit 0-2  role        0 black, 1 primary, 2 secondary, 3 accent,
                     4 highlight, 5 error, 6 success, 7 spare
bit 3-4  brightness  0 = 25%, 1 = 50%, 2 = 75%, 3 = 100%
bit 5    fill        0 = stroke, 1 = fill
bit 6-7  width       stroke width 1 to 4 units (stored as width - 1)
```

An OP never carries an RGB value. It names a **role**, and the palette region maps roles to colors. That is why a cartridge can swap its whole look with a 5-byte palette record, and why the player's brightness and warm filters cost nothing.

**Black is the eraser.** Role 0 with fill draws black over whatever is below it. A king in Dama is two stacked discs: the gap between them is a black disc.

You never build this byte by hand. Use the macros:

```c
FILL(C_PRIMARY)                 // filled, 100%
FILL_B(C_PRIMARY, B25)          // filled, 25% (the board's dark squares)
STROKE(C_ACCENT, 2)             // outline, 2 units wide
STROKE_B(C_PRIMARY, B25, 1)     // dim outline
```

### The input byte

```
bit 0-2  stick direction   0 up, 1 up-right, 2 right, 3 down-right,
                           4 down, 5 down-left, 6 left, 7 up-left
bit 3    stick active      0 = released
bit 4    A
bit 5    B
bit 6-7  action            0 none, 1 = button 2, 2 = button 3, 3 = button 4
```

Stick, A, B and one action button can all be held together. Two action buttons at once cannot be expressed, by design. Button 1 is HOME: the client handles it locally and it never appears in this byte.

The helpers `in_dx(b)` and `in_dy(b)` turn the stick into -1, 0 or +1 on each axis, in screen coordinates where y grows downward.

## 5. The wire protocol

One WebSocket binary message is one atomic packet, and a packet is a plain sequence of records. Each record starts with a type byte from `sdk/wire.h`.

### Server to client

| Record | Type | Bytes | Meaning |
| --- | --- | --- | --- |
| `RESET` | 0x01 | 1 | Clear the OP buffer and strings (join or resync) |
| `OPS_LIST` | 0x10 | 2 + 9 per slot | `[n]` then `[slot][8 B]` for each changed slot |
| `OPS_MASK` | 0x11 | 33 + 8 per slot | A 256-bit dirty mask, then the changed slots in order |
| `STR` | 0x20 | 3 + length | `[id][len][bytes]` |
| `BEGIN` | 0x30 | 1 | Start of a transition |
| `END` | 0x31 | 1 | Apply everything since BEGIN at once |
| `PAL` | 0x32 | 5 | `[role 1-7][R][G][B]` |
| `LABEL` | 0x33 | 10 | `[button 2-4][8 B text]` |
| `TICK` | 0x34 | 2 | `[hz]` |
| `SFXDEF` | 0x35 | 10 | `[id][8 B preset]` |
| `MUSDEF` | 0x36 | 5 + 4 per step | `[id][step_10ms][steps][vol][notes]` |
| `SFX` | 0x40 | 2 | `[id]` play a preset from the sound bank |
| `MUSIC` | 0x41 | 3 | `[cmd][pattern]`, 0 = stop, 1 = play |

### Client to server

| Record | Type | Bytes | Meaning |
| --- | --- | --- | --- |
| `IN` | 0x01 | 2 | `[input byte]`, sent only on change |
| `SYS` | 0x02 | 2 | `[code]` from the HOME overlay (1 = resign) |
| `RESYNC` | 0x03 | 1 | Ask for a full dump |

### A real packet, byte by byte

This is the Dama cursor moving one cell to the right, 11 bytes:

```
10          OPS_LIST
01          1 slot follows
92          slot 146 (the cursor)
01          RECT
5C          color: role 4 highlight, 100%, stroke, width 2
39 A5       x = 57, y = 165
16 16       w = 22, h = 22
00 00       unused
```

### Three properties to remember

**List or mask, whichever is smaller.** With up to 31 changed slots the list is shorter. From 32 slots the mask wins. The encoder decides per packet, and the type byte tells the client which it got.

**Every value is absolute.** A slot record carries all 8 bytes, never a delta like "x + 5". If a packet were lost, the next update of that slot would heal it. That keeps the protocol ready for a datagram transport later.

**The client validates everything.** Unknown record, bad length, palette write outside a transition, a BEGIN with no END: `ppu_apply` returns an error, applies nothing, and the client asks for a `RESYNC`.

Measured sizes: a Dama full dump on join is about 860 bytes, a cursor move is 11 bytes, and a Pong frame is about 11 bytes.

# Day 2: Write games

## 6. Your first cartridge

A complete online 2-player game fits in about 50 lines of C. This one is **Tug**: both players mash A, the knot moves toward whoever presses faster, and the first to pull it 10 steps wins. It was compiled and run before going into this book.

### Step 1: create the files

Create `carts/tug/tug.c` with the code below, and `carts/tug/manifest.json`:

```json
{ "id": "tug", "name": "TUG", "players": 2, "tick_hz": 0 }
```

### Step 2: the game

```c
#include "console.h"

const u8 cart_players = 2;

static u8 present[2], over, winner;
static i8 pos;                          /* -10 .. +10, negative = toward player 1 */

void cart_init(void) {
  con_transition_begin();
  con_pal(C_PRIMARY,   0xEC, 0xE9, 0xE4);
  con_pal(C_SECONDARY, 0x5C, 0xC8, 0xF0);
  con_pal(C_ACCENT,    0xFF, 0xB2, 0x3F);
  con_label(2, ""); con_label(3, ""); con_label(4, "");
  con_tick_rate(0);                     /* event-only: no timer at all */
  con_sfx_def(0, CH_PULSE1, DUTY_25, 72, 8, 0, 4, SFX_DECAY);     /* pull */
  con_sfx_def(1, CH_PULSE1, DUTY_50, 72, 9, 12, 50, SFX_DECAY);   /* win  */
  con_transition_end();
}

void cart_presence(u8 p, u8 on) { present[p] = on; }
void cart_tick(void) {}
void cart_sys(u8 p, u8 code) { (void)p; (void)code; }

void cart_input(u8 p, u8 now, u8 prev) {
  u8 pressed = (u8)(now & ~prev);       /* bits that just went down */
  if (!present[0] || !present[1]) return;
  if (over) {
    if (IN_ACTION(now) == 1 && IN_ACTION(prev) != 1) {             /* button 2 = REMATCH */
      over = 0; pos = 0;
      con_transition_begin(); con_label(2, ""); con_transition_end();
    }
    return;
  }
  if (pressed & IN_A) {
    pos += p == 0 ? -1 : 1;
    con_sfx(VIEW(1 - p), 0);            /* the other player hears the pull */
    if (pos <= -10 || pos >= 10) {
      over = 1; winner = pos < 0 ? 0 : 1;
      con_transition_begin(); con_label(2, "REMATCH"); con_transition_end();
      con_sfx(VIEW_ALL, 1);
    }
  }
}

void cart_draw(u8 view) {
  con_line(0, STROKE_B(C_PRIMARY, B25, 1), 28, 128, 228, 128);     /* the rope   */
  con_rect(1, FILL(C_PRIMARY),   20, 108, 8, 40);                  /* P1's side  */
  con_rect(2, FILL(C_SECONDARY), 228, 108, 8, 40);                 /* P2's side  */
  con_circ(3, FILL(C_ACCENT), (u8)(128 + pos * 10), 128, 8);       /* the knot   */

  const char *t = (!present[0] || !present[1]) ? "WAITING"
                : !over ? "MASH A"
                : view == winner ? "YOU WIN"
                : view < 2 ? "YOU LOSE" : "GAME OVER";
  con_str(0, t);
  con_text(4, FILL(C_ACCENT), 128, 200, 12, ALIGN_CENTER, 0);
}
```

### Step 3: register and build

1. In the `Makefile`, add `tug` to the end of the `CARTS :=` line.
2. In `worker/src/index.js`, import `./carts/tug.wasm` and the manifest, and add a `tug` entry to `CARTS`, copying the two existing lines.
3. Run `make`, then restart `npx wrangler dev`.

### What this small game already shows

- **No rendering code.** `cart_draw` describes the screen as 5 OPs. One pull changes only slot 3, so it costs 11 bytes.
- **No networking code.** You never touch a socket, a packet or a player list.
- **Per-player views.** The same state gives "YOU WIN" to one player and "YOU LOSE" to the other, from one `view` argument.
- **No cheating surface.** `pos` exists only in the Durable Object. A modified client can only send input bytes, which is what an honest client sends too.
- **Zero idle cost.** Tick rate 0 means no timer runs. The match does work only when a byte arrives.

## 7. The six callbacks

A cartridge is one constant and six functions. The runtime calls them; you never call them yourself.

| Callback | Called when | What you do there | What you must not do |
| --- | --- | --- | --- |
| `cart_init()` | Once, when the match is created | First transition: palette, labels, tick rate, sound bank, music. Reset your state | Draw |
| `cart_presence(player, on)` | A player's socket connects or drops | Track who is here. Start the match when everyone is present | Assume a player stays |
| `cart_input(player, now, prev)` | That player's input byte changed | Change game state. Queue sounds. Start a transition if needed | Draw |
| `cart_sys(player, code)` | The player picked a system action in HOME | Handle `SYS_RESIGN` | Trust it for anything else |
| `cart_tick()` | Tick-rate times per second, never at 0 Hz | Advance time: physics, clocks, countdowns | Read input here (keep it from `cart_input`) |
| `cart_draw(view)` | After every event, once per connected view | Describe the whole screen for that view | Change game state |

`const u8 cart_players = 2;` tells the host how many seats exist.

### The order of one event

Every event follows the same two phases:

1. **Update.** Exactly one of `cart_presence`, `cart_input`, `cart_sys` or `cart_tick` runs and changes state.
2. **Draw.** `cart_draw(view)` runs once for each connected view, and the runtime sends each view its changes.

Keep the two phases separate. `cart_draw` must be a pure function of your state and the `view` number. It may run 1 time or 7 times per event, and for a spectator as well as for players. If it changes state, players will see different games.

### The view argument

- `view < cart_players` is that player's own screen.
- `view == cart_players` is the spectator screen, shared by everyone who joined after the seats were full.

Both games start `cart_draw` with `u8 me = view < 2 ? view : 2;` and then treat `me == 2` as the neutral view: no cursor, no "YOUR TURN", no hidden information.

### State lives in statics

Your state is ordinary `static` variables. There is no heap, no libc and no file system: the cartridge is compiled with `-nostdlib`. The runtime provides `memcpy`, `memset`, `memmove` and `memcmp`. Anything else, such as number formatting, you write yourself (see `fmt_clock` in Dama, 3 lines).

## 8. Drawing well

You redraw the whole screen every time, and the runtime sends only what differs. Your job is to make "what differs" small, and that comes down to how you assign slots.

### Rule 1: give persistent things a fixed slot

The diff compares slot N now with slot N before. If an object keeps its slot, moving it changes one slot (9 bytes). If objects shift slots, everything after the shift looks changed.

```c
/* Bad: a running counter. Removing piece 3 shifts every later piece. */
u8 s = 0;
for (each piece) con_circ(s++, ...);

/* Good: the slot comes from the board cell. A removed piece is one NOP. */
con_circ(SL_PIECE + r * 4 + (c >> 1), ...);
```

Dama defines a slot map at the top of the file and never deviates from it:

```c
#define SL_SQUARE 0     /* 32 dark squares                           */
#define SL_BORDER 32
#define SL_PIECE  33    /* 32 cells: the disc (lower disc of a king) */
#define SL_KING_A 65    /* 32 cells: black gap between the two discs */
#define SL_KING_B 97    /* 32 cells: the upper disc of a king        */
#define SL_DEST   129   /* 16 destination hints                      */
#define SL_SELECT 145
#define SL_CURSOR 146
#define SL_HUD    147
```

A running counter is fine for things that never appear or disappear in the middle, such as Pong's short list or the HUD lines at the end of Dama.

### Rule 2: slot order is layer order

Slot 0 is drawn first and slot 255 last. There is no z field. Plan the map bottom-up: background, board, pieces, marks on pieces, highlights, cursor, text. Leave gaps between groups so you can add things later.

### Rule 3: you start from empty

Before each `cart_draw` the runtime clears the scratch buffer. Whatever you do not draw this time becomes `NOP` and disappears from the client. You never "delete" anything: you just stop drawing it.

### Rule 4: draw only what this view may see

This is the security model, and it is one `if`:

```c
if (me < 2 && state != S_OVER)
  con_rect(SL_CURSOR, STROKE(C_HIGHLIGHT, 2), ...cc[me]..., ...cr[me]...);
```

Each player's cursor is drawn only in their own view, so the opponent's client never learns where it is. A card game does the same with hands: draw the card face for its owner and the card back for everyone else.

### Rule 5: rotate a view with two small functions

Both games show each player their own side at the bottom. Dama does it by mapping board cells to screen positions:

```c
static u8 flip;
static u8 cx(u8 c) { return (u8)(X0 + (flip ? 7 - c : c) * SQ); }
static u8 cy(u8 r) { return (u8)(Y0 + (flip ? 7 - r : r) * SQ); }
```

The game logic always works in board coordinates. Only drawing and stick input know about the flip.

### Strings

`con_str(id, text)` fills one of 16 string slots (16 characters each), and a `TEXT` OP points at it by id. Strings diff separately from OPs, so a score that changes sends only the new string, about 5 bytes. Text is printable ASCII, and anything else becomes `?`.

### Building shapes by layering

| You want | Draw |
| --- | --- |
| A ring | `CIRC` with a stroke |
| A crescent | A filled circle, then a black filled circle offset on top |
| A king (two stacked discs) | A disc, a slightly larger black disc shifted up, then a second disc on top |
| A dashed line | Several short `LINE` OPs (Pong's center line uses 8) |
| A dimmed item | The same OP with `B50` or `B25` brightness |
| A thick frame | `RECT` stroke with width 2 to 4, drawn inside the box |

### The budget

You have 256 slots per view. Dama uses about 75 at the start of a match, Pong about 14. If you approach the limit, the design is probably too busy for the console's look anyway.

## 9. Input

`cart_input(player, now, prev)` gives you the new input byte and the previous one, and every pattern you need comes from comparing the two. It is called only when the byte changes, so there is no auto-repeat and no polling.

### The four patterns

**A button was just pressed** (edge):

```c
u8 pressed = (u8)(now & ~prev);
if (pressed & IN_A) { /* fires once per press */ }
```

**A button is held** (level). Store what you need and use it in `cart_tick`:

```c
static i8 dir[2];
void cart_input(u8 p, u8 now, u8 prev) { dir[p] = in_dx(now); }
void cart_tick(void) { px[0] += dir[0] * 3; }
```

**The stick moved one step** (menus, cursors, boards). Fire when the stick becomes active or changes direction:

```c
if (IN_ACTIVE(now) && (!IN_ACTIVE(prev) || IN_DIR(now) != IN_DIR(prev))) {
  cursor_x += in_dx(now);
  cursor_y += in_dy(now);
}
```

**An action button was pressed.** The action field is a number, not a bit, so compare the field:

```c
u8 act = IN_ACTION(now) != IN_ACTION(prev) ? IN_ACTION(now) : 0;
if (act == 1) { /* button 2 */ }
```

### Things that will bite you

- **A rotated view needs rotated input.** If player 2's screen is flipped, negate the stick for them: `if (p == 1) { dx = -dx; dy = -dy; }`.
- **A keyboard diagonal is two events.** Pressing Up then Right arrives as "up", then "up-right". With the one-step pattern the cursor moves twice. That is correct for a touch stick, and fine for keys once you know it.
- **A held stick does not repeat.** With tick rate 0 nothing fires while the stick is held. If you want cursor repeat, give the game a tick and count frames in `cart_tick`.
- **A disconnect releases everything.** The runtime resets `prev` to 0 when a player leaves. Also clear your own held state in `cart_presence`, as Pong does with `dir[p] = 0`.
- **Never trust an input to be legal.** A modified client can send any byte at any time. Check turn, state and rules in `cart_input` every time, as Dama's `legal()` does.

### What the client does on its own

The client plays a click for the player's own presses and moves the on-screen knob immediately. This is the local echo: instant feedback with no round trip. Everything that depends on game state still comes from the server.

## 10. Transitions, palette, labels and tick rate

A transition is the only moment the console's "settings" may change, and the cartridge decides when that moment is. Everything between begin and end reaches the client as one atomic change.

```c
con_transition_begin();
con_pal(C_PRIMARY, 0x30, 0x60, 0xA0);     /* underground palette */
con_label(2, "REMATCH");
con_tick_rate(0);
con_transition_end();
```

Outside a begin/end pair these calls do nothing. The runtime ignores them, and the client would reject them anyway.

### What a transition may change

| Call | Changes | Limits |
| --- | --- | --- |
| `con_pal(role, r, g, b)` | One palette role | Roles 1 to 7. Black cannot be changed |
| `con_label(button, text)` | Text under action button 2, 3 or 4 | 8 characters. An empty string dims the button |
| `con_tick_rate(hz)` | How often `cart_tick` runs | 0 to 60. 0 means event-only |
| `con_sfx_def(...)` | One sound bank preset | 16 presets |
| `con_music_def(...)` | One music pattern | 4 patterns, 32 steps each |

You only set what changes. The rest keeps its value. The runtime then resends the whole transition block to every view, about 100 to 250 bytes depending on your sound bank, so use transitions at real scene changes, not every frame.

### When to use one

- **At load**, in `cart_init`. This one is required: without a palette, everything is black.
- **When the match starts**: set the tick rate and the in-game labels.
- **At a level change**: swap the palette (a sunny stage, then an underground one).
- **When the match ends**: tick rate back to 0, labels to REMATCH.

A calm screen is part of the console's character. There is no way to flash the palette in the middle of play, and that is deliberate.

### Tick rate is a game design choice

| Game type | Tick rate | Why |
| --- | --- | --- |
| Board and card games | 0 | Nothing moves between inputs |
| Board game with clocks | 1 | Dama: only the clocks advance |
| Slow action | 15 to 20 | Enough for simple movement |
| Fast action, reaction games | 60 | Pong: the ball needs every frame |

Change the rate as the game changes phase. Pong runs at 0 while waiting, 60 during play, and 0 again after the match. At 0 no timer exists at all, so a waiting match costs nothing.

Write `cart_tick` in terms of ticks, with integer or fixed-point math. Pong keeps positions in 8.8 fixed point (`#define FP 256`) and moves the ball by `vx`, `vy` each tick. If you change the tick rate of a physics game, scale your speeds with it.

### Labels and the HOME button

Button 1 is always HOME and belongs to the system. The client draws its overlay above the canvas, outside the OP buffer, so a cartridge cannot draw a fake one or block it. While HOME is open, the cartridge sees an input byte of 0.

A choice in HOME that affects the match, such as Resign, arrives as `cart_sys(player, SYS_RESIGN)`. It is a system message, never an input bit.

## 11. Sound

Sound works like drawing: you define small presets once, then trigger them with 2 bytes. No audio ever crosses the wire. The client synthesizes everything from register values, NES-style.

### The four channels

| Channel | Constant | Character | Good for |
| --- | --- | --- | --- |
| Pulse 1 | `CH_PULSE1` | Bright square wave | Melody, clicks, confirmations |
| Pulse 2 | `CH_PULSE2` | Second square wave | Harmony, a different "voice" for errors |
| Triangle | `CH_TRIANGLE` | Soft and round | Bass, calm tones, losing sounds |
| Noise | `CH_NOISE` | Hiss | Hits, captures, explosions |

### Defining a sound effect

In a transition, usually in `cart_init`:

```c
/*          id  channel    duty     note vol sweep    len flags     */
con_sfx_def(0,  CH_PULSE1, DUTY_25, 72,  8,  0,       6,  SFX_DECAY);  /* short blip    */
con_sfx_def(1,  CH_NOISE,  0,       64,  9,  (u8)-12, 12, SFX_DECAY);  /* falling hiss  */
con_sfx_def(2,  CH_PULSE1, DUTY_50, 72,  9,  12,      50, SFX_DECAY);  /* rising fanfare */
```

| Field | Range | Meaning |
| --- | --- | --- |
| duty | `DUTY_12`, `DUTY_25`, `DUTY_50`, `DUTY_75` | Pulse width. 12% is thin, 50% is full. Ignored by triangle and noise |
| note | MIDI number | 60 = middle C, 69 = A 440 Hz, +12 = one octave up |
| vol | 0 to 15 | Peak volume |
| sweep | signed semitones | Pitch slides this far over the length. Cast negatives: `(u8)-12` |
| len | 10 ms units | 6 = 60 ms, 50 = half a second |
| flags | `SFX_DECAY` or 0 | With decay the volume fades to zero. Without, it holds, then stops |

### Triggering

```c
con_sfx(VIEW_ALL, 1);            /* everyone hears it          */
con_sfx(VIEW(p), 2);             /* only player p              */
con_sfx(VIEW(1 - p) | VIEW(2), 0);   /* the opponent and spectators */
```

The first argument is a bit mask of views, so each player can hear something different. Dama plays the win sound to the winner and the lose sound to the loser from the same event.

### The rule for who plays what

**If the client triggered it, the client plays it. Everything else comes from the server.**

- The player's own button and stick clicks are played locally and instantly by the client. Do not send those.
- The opponent's move, a capture, an invalid action, a win: only the server knows these, so the cartridge triggers them.

That is why Dama sends the move sound to `VIEW(1 - p)` and not to the mover.

### Music

A pattern is a list of steps, 4 bytes per step: one note for each channel, 0 for silence.

```c
static const u8 song[8 * 4] = {
/* pulse1 pulse2 triangle noise */
   76,    0,     48,      0,
   0,     0,     0,       0,
   0,     0,     55,      0,
   0,     0,     0,       0,
   79,    0,     57,      0,
   0,     0,     0,       0,
   0,     0,     53,      0,
   0,     0,     0,       0 };

con_music_def(0, 28, 8, 4, song);   /* id 0, 280 ms per step, 8 steps, volume 4 */
```

Define patterns in a transition. Start and stop them at any time:

```c
con_music(MUSIC_PLAY, 0);   /* loop pattern 0 */
con_music(MUSIC_STOP, 0);
```

The client loops the pattern on its own clock, so music works even at tick rate 0 and costs nothing after the first send. Keep the volume low (3 to 5): the player can also turn music off in HOME.

### Secure by design applies to sound too

A sound or pattern you define is sent to the client. If a secret boss theme would spoil a surprise, define it in the transition that starts that level, not at load.

## 12. Reading Dama and Pong

The two shipped games are the two ends of the range: Dama is a state machine that reacts to inputs, and Pong is a simulation that advances with time. Read both files top to bottom with this chapter as a guide.

### Pong (`carts/pong/pong.c`, about 150 lines): read this one first

| Part | What to notice |
| --- | --- |
| `enum { S_WAIT, S_SERVE, S_PLAY, S_OVER }` | A small state machine drives everything |
| `start()` and `finish()` | Each state change that alters tick rate or labels is one transition |
| `cart_input` | It only stores a direction. No movement happens here |
| `cart_tick` | Paddles, ball, walls, paddle hits and scoring, all in 8.8 fixed point |
| The paddle hit test | It checks that the ball crossed the paddle line this tick (`oy < hit1 && by >= hit1`), so a fast ball cannot tunnel through |
| `bounce()` | Where the ball hits the paddle changes `vx`, and every hit adds a little speed |
| `VX()` and `VY()` in `cart_draw` | Player 2's view is the same world rotated 180 degrees |
| Scores | "Yours" is always the lower number on screen, in both views |

**The lesson of Pong:** input stores intent, tick advances the world, draw describes it. Keep those three apart and action games stay simple.

### Dama (`carts/dama/dama.c`, about 400 lines)

| Part | What to notice |
| --- | --- |
| The rules comment at the top | The cartridge is the rulebook. Changing a rule is changing this file |
| The slot map | Fixed slots per board cell keep a move at a few dozen bytes |
| `maxcap()` | A recursive search for the longest capture. Jumped pieces are only marked (`tk[][]`), so they still block and cannot be jumped twice |
| `plan()` | Runs after every board change and fills `mvb[][]`: which pieces may move now. It also sets `need`, the captures still owed |
| `legal()` | Answers "may this piece go there?" for steps and captures, and enforces the longest-capture rule by simulating the move |
| `do_move()` | Applies a move, continues a capture sequence, removes jumped pieces when the move ends, promotes kings, switches turn, detects a win or a draw |
| `cart_input` | Cursor, select, move, cancel, resign confirm, draw offer. Every A press goes through `legal()` |
| `cart_draw` | The dimming is one line: `dim = my_turn && own(v) == me && !mvb[r][c]` |

**The lesson of Dama:** compute what is allowed once, after each change (`plan`), and let both the rules (`legal`) and the picture (`cart_draw`) read from it. The dimmed pieces, the destination dots and the "YOU MUST TAKE" line all come from the same data that enforces the rule, so the screen can never disagree with the game.

### Patterns both games share

- **Waiting for players.** `cart_presence` starts the match when both seats are filled, and never before.
- **A player leaves mid-match.** State is kept. Dama pauses the clocks and shows "P2 IS AWAY". When they reconnect they get a full dump and continue.
- **Rematch.** Each player presses button 2. When both have, the state resets with a new transition.
- **Three status texts from one state.** Player, opponent and spectator each get their own wording in `cart_draw`.
- **Sounds by audience.** Win to the winner, lose to the loser, shared events to everyone.

# Day 3: Own the engine

## 13. Inside the runtime

`sdk/runtime.c` is about 180 lines and is linked into every cartridge, so each `.wasm` is one self-contained machine: game plus encoder. The host never parses a packet.

### Its state

```c
typedef struct { u8 ops[256 * 8]; u8 strs[16 * 16]; } View;

static View cur;                    /* what the cartridge is drawing now */
static View sent[CON_MAX_VIEWS];    /* what each view's client has       */
```

`cur` is the scratch buffer your `con_op` calls write into. `sent[v]` mirrors the client of view `v`. With 7 views that is about 16 KB, and the whole cartridge fits in 2 WASM pages (128 KB).

The transition regions (palette, labels, tick, sound bank, music) are stored once for the match. A bit mask, `trans_dirty`, remembers which views still need the latest transition.

### The exports the host calls

| Export | Does |
| --- | --- |
| `con_init()` | Calls `cart_init` |
| `con_players()` | Returns `cart_players` |
| `con_presence(player, on)` | Calls `cart_presence`, and clears the stored input on leave |
| `con_input(player, byte)` | Keeps the previous byte and calls `cart_input(player, now, prev)` |
| `con_sys(player, code)` | Calls `cart_sys` |
| `con_tick()` | Calls `cart_tick` |
| `con_tick_hz()` | The current tick rate, so the host can set its timer |
| `con_flush(view, full)` | Draws, diffs and encodes one view. Returns the packet length |
| `con_packet()` | Pointer to the packet buffer inside WASM memory |

That table is the complete host interface. Any environment that can instantiate a WASM module and call nine functions can run a match.

### `con_flush`, step by step

1. Clear `cur` and call `cart_draw(view)`.
2. If `full`: emit `RESET`, zero `sent[view]`, and drop queued sounds (old sounds are not replayed on reconnect).
3. If `full` or this view's `trans_dirty` bit is set: emit `BEGIN`, the palette, labels, tick, used sound presets, used patterns, `END`.
4. Compare `cur.ops` with `sent[view].ops` slot by slot using `memcmp`, building a 32-byte dirty mask and a count.
5. Emit `OPS_LIST` if 31 or fewer slots changed, otherwise `OPS_MASK`. Copy `cur.ops` into `sent[view].ops`.
6. Compare the 16 strings and emit a `STR` record for each one that changed.
7. Emit `MUSIC` if a music command is pending for this view, then one `SFX` record per queued sound.
8. Return the length. Zero means this view has nothing new, and the host sends nothing.

### Why it is built this way

- **Immediate-mode drawing, retained-mode wire.** You get the simple model (redraw everything), and the network gets the cheap one (send changes). The diff is the bridge.
- **A full dump is not a special path.** After `RESET` the mirror is all zeros, so the normal diff naturally emits every non-empty slot. Join, reconnect and resync reuse the same code.
- **Per-view cost is tiny.** One draw plus a 2 KB compare per view per event. Next to a 16.7 ms frame at 60 Hz the compare is negligible, so your own `cart_draw` is the part to keep light.

### If you want to change it

- More strings or longer strings: `CON_STRS` and `CON_STR_LEN` in `console.h`. Both sides read the same header, so rebuild cartridges and `ppu.wasm` together.
- A new OP: add the opcode in `console.h`, a `case` in `draw()` in `public/main.js`, and a helper next to `con_rect`. The runtime and `ppu.c` need no change, because they treat OPs as opaque 8-byte values.
- A new record type: add it to `wire.h`, emit it in `con_flush`, and parse it in `ppu_apply`.

## 14. Inside the client

The client is five small files, and none of them knows anything about any game. It is a terminal: it applies bytes, draws slots, plays presets and reports one input byte.

| File | Role | Thread |
| --- | --- | --- |
| `ppu/ppu.c` (to `ppu.wasm`) | The memory map. Parses and validates packets | Main |
| `public/main.js` | Drawing, controller, lobby, HOME overlay | Main |
| `public/input-worker.js` | Owns the WebSocket | Web Worker |
| `public/sound.js` + `public/chip.js` | Sound synthesis | Main (WebAudio runs its own audio thread) |
| `public/sw.js` | Caches the shell for offline start | Service worker |

### `ppu.c`: the part that would become hardware

`ppu_apply(len)` is the heart of it, and it works in three stages:

1. **Copy** the live OP buffer, strings and transition regions into staging copies.
2. **Parse** every record into the staging copies. Any problem returns `F_ERROR` at once.
3. **Commit** by copying staging back to live, and return flags: `F_DRAW`, `F_TRANS`, `F_EVENT`.

Because nothing touches live memory before stage 3, a packet is all-or-nothing. Transition records write into a `shadow` struct that becomes live only if the packet contained an `END`.

The other exports just return pointers (`ppu_ops()`, `ppu_strs()`, `ppu_pal()`, and so on). JavaScript wraps each one in a `Uint8Array` view over WASM memory once, at startup, and reads them directly with no copying.

This file is written as the reference for a future ESP32 or FPGA client. It has no browser dependency at all.

### `main.js`: drawing

`draw()` is one loop over 256 slots:

```js
const k = canvas.width / 256;          // 256 units -> real pixels
ctx.setTransform(k, 0, 0, k, 0, 0);
for (let s = 0; s < 256; s++) { /* switch on the opcode, one Canvas2D call each */ }
```

The canvas backing store is sized to the device's real pixels, and one transform maps the 256-unit space onto it. That single line is why everything is crisp on any screen.

Drawing is requested, not continuous: a packet that changed something calls `requestDraw()`, which schedules one `requestAnimationFrame`. An idle screen draws nothing.

`buildColors()` computes 8 roles x 4 brightness levels = 32 CSS colors from the palette, applying the player's brightness and warm filter. Filters touch only these 32 entries, and role 0 is forced to black.

### `main.js`: the controller

`updateInput()` merges keyboard, touch stick and buttons into the one input byte, moves the knob, plays the local click, and posts the byte to the worker only when it changed. While HOME is open or no match is running, the byte is forced to 0.

### `input-worker.js`: the input thread

The worker owns the socket so that sending input never waits for drawing. It also reconnects after 1 second when the socket drops, and re-sends the current input byte on open. Since the server sends a full dump on every join, a reconnect needs no extra logic on the client.

Input reaches the worker by `postMessage`. A `SharedArrayBuffer` input register would remove even that hop, at the price of COOP and COEP headers on the Worker.

### `sound.js` and `chip.js`: sound

`voice()` builds one oscillator (or noise source) plus a gain envelope per sound and lets it stop itself. Pulse waves are built from Fourier coefficients for each duty cycle. Noise is a 15-bit shift register, like the NES.

"Clean" mode uses fewer harmonics and a low-pass filter. "Raw" mode uses 64 harmonics and no filter. The cartridge cannot tell which one the player chose.

Music is a 50 ms timer that schedules steps 200 ms ahead on the audio clock, so timing stays steady even when the main thread is busy.

Browsers block audio until a user gesture. That is why `apu.start()` is called from the lobby's game button and from every control press.

## 15. Inside the host and the Durable Object

The host is the thinnest layer in the system: it seats players, moves bytes and runs a timer. `host/match.mjs` is about 100 lines and uses no Node or Cloudflare API, which is why the same file runs in both places.

### `match.mjs`: one running match

A connection is any object with `send(bytes)` and `close()`. The match gives it a `view` number.

| Method | Does |
| --- | --- |
| `Match.create(wasm)` | Instantiates the cartridge and calls `con_init` |
| `join(conn, token)` | Seats the connection, tells the cartridge, sends a full dump |
| `leave(conn)` | Frees the seat's socket, tells the cartridge, stops the timer if the match is empty |
| `message(conn, bytes)` | Routes `IN`, `SYS` or `RESYNC`, then flushes every view |
| `tick()` | Calls `con_tick`, then flushes every view |

**Seating.** `join` looks for a seat in this order: the seat that already has this token (a reconnect), a free seat, a seat whose player has left. If none is found, the connection becomes a spectator. The token is a random string the client keeps in `sessionStorage`, so a page reload returns to the same seat.

**Flushing.** After every event the match calls `con_flush` for each connected player and sends the result if its length is not zero. Spectators share one view: one flush, sent to all of them.

**The timer.** After every flush the match reads `con_tick_hz()`. If the rate changed, it replaces its interval. At 0 there is no interval. The loop catches up at most 5 ticks after a stall, so a hiccup never becomes a spiral.

### `worker/src/index.js`: Worker and Durable Object

The Hono app has two routes:

- `GET /api/carts` returns the catalog.
- `GET /match/:cart/:room` checks the request, finds the Durable Object by name (`cart/room`), and forwards the upgrade request to it. From then on the WebSocket belongs to the Durable Object and the Worker is out of the path.

The client files are served as static assets, configured by `[assets]` in `wrangler.toml`.

`MatchDO.fetch` creates the `Match` on first use, accepts the server side of a `WebSocketPair`, wraps it as a connection, and calls `match.join`. Messages and close events go straight to `match.message` and `match.leave`. When the last player leaves, the match object is dropped, and the next join starts a fresh one.

**One Durable Object is one match.** The name `dama/ROOM1` always reaches the same object, wherever the players are. That is the single source of truth the whole design rests on.

### Where your platform code goes

The route handler in the Worker is the gate. Before forwarding the upgrade, it is the place to:

- verify the player's session or token,
- check that the player owns the cartridge,
- create or look up the match in your catalog,
- reject the request with a normal HTTP status if any check fails.

Nothing after that point needs to know about users or purchases.

### `host/sim.mjs`

This is the same two routes on plain Node, with a hand-written WebSocket server, for testing without Cloudflare. It is optional. If you delete it, keep `match.mjs`.

## 16. Limits, costs and pitfalls

The limits are the console's hardware spec, and designing inside them is the craft. This chapter lists them, then what a match costs, then the mistakes that are easy to make.

### Hard limits

| Limit | Value | Defined in |
| --- | --- | --- |
| Screen space | 256 x 256 units, coordinates 0 to 255 | `uint8` parameters |
| OP slots | 256 per view | `CON_SLOTS` |
| Strings | 16, each up to 16 printable ASCII characters | `CON_STRS`, `CON_STR_LEN` |
| Colors | 7 roles + black, 4 brightness levels each | Color byte |
| Stroke width | 1 to 4 units | Color byte |
| Button labels | 3, each up to 8 characters | `CON_LABEL_LEN` |
| Sound presets | 16 | `CON_SFX` |
| Music | 4 patterns, 32 steps, 4 channels | `CON_PATTERNS`, `CON_STEPS` |
| Tick rate | 0 to 60 Hz | `con_tick_rate` |
| Queued sounds | 8 per view per flush | `sfx_q` in `runtime.c` |
| Packet size | 4,096 bytes | `WIRE_MAX_PACKET` |
| Views | 6 players + 1 spectator view | `CON_MAX_VIEWS` |
| Cartridge memory | 128 KB, 16 KB stack, no heap | `Makefile` linker flags |

### What a match costs on Cloudflare

Three meters matter. Check the current numbers on Cloudflare's pricing pages before you plan around them.

- **Duration.** A Durable Object is billed for the time it is active, at a fixed 128 MB. A 3-minute match is about 180 s x 0.128 GB = 23 GB-s. The free plan includes 13,000 GB-s per day.
- **Requests.** Incoming WebSocket messages are billed at a 20 to 1 ratio. Because input is sent only on change, a match produces few of them. This is the reason for the on-change rule.
- **Outgoing messages are not billed.** A 60 Hz stream down to the players costs duration only.

The current Durable Object uses the standard WebSocket API, so it stays active while any socket is open, even at tick rate 0. Hibernation would remove that cost for idle board games, but the cartridge's WASM memory must first be saved to storage and restored on wake. That is not built yet.

### Pitfalls

**Changing state in `cart_draw`.** It runs once per view. Anything it changes happens a different number of times for different players. Keep it read-only.

**A running slot counter for things that come and go.** One removed item shifts every slot after it and the packet grows from 9 bytes to hundreds. Use fixed slots (chapter 8).

**Forgetting the first transition.** Without `con_pal` calls in `cart_init`, every role is black and the screen looks empty.

**Calling transition functions outside begin/end.** They are silently ignored. If a label or palette does not change, check this first.

**Coordinates that wrap.** Parameters are `u8`. `con_rect(s, c, 250, 10, 20, 20)` is fine, but computing `x - 12` when `x` is 5 gives 249. Clamp before you cast.

**Text that does not fit.** A string is cut at 16 characters and a label at 8. "RESIGN? A=YES B=NO" becomes "RESIGN? A=YES B=".

**Deep recursion.** The stack is 16 KB. Dama's `maxcap` recursion is shallow and uses a few bytes per level. A search with large local arrays per level will overflow silently.

**Trusting the client.** Every input can arrive at any moment, in any state, from a modified client. Validate turn, state and rules on every input.

**Leaking through drawing.** Anything you draw in a view is known to that player, even if it is covered by another shape. Do not draw a hidden card and put a rectangle over it. Do not draw it at all.

**Leaking through timing or sound.** A sound sent only when the opponent holds a certain card tells the player about that card. Apply the same view rule to `con_sfx`.

**Float math.** It compiles, but it breaks the hardware contract and can differ between targets. Use integers or fixed point.

**Stale client during development.** The service worker is network-first, so a reload gets new files. If something still looks old, do a hard reload.

**Forgetting to rebuild both sides.** If you change `console.h` or `wire.h`, run `make` so the cartridges and `ppu.wasm` are rebuilt together, then restart the Worker.

## 17. Exercises

Finish these ten and you own the engine. They go from changing a constant to adding a feature across every layer, and each one names the files it touches.

### Warm-up: change a game

1. **Recolor Dama.** Change the palette in `cart_init` to your own three colors. Rebuild and check both players' views. *Files: `dama.c`.*
2. **Faster Pong.** Make the ball start 50% faster and the match go to 7. *Files: `pong.c`.*
3. **A new sound.** Give Pong a different sound when the ball hits the top paddle than the bottom one. *Files: `pong.c`.*

### Build: write games

4. **Ship Tug.** Type in the game from chapter 6, register it in the `Makefile` and the Worker, and play it in two tabs.
5. **Tug with a clock.** Add a 20-second countdown at tick rate 1. When it reaches zero, whoever the knot is closer to wins. Use a transition to start and stop the tick. *You will use: `cart_tick`, `con_tick_rate`, `con_str`.*
6. **Tic-tac-toe.** A 3 x 3 board, a cursor per player, turns, win and draw detection, rematch. Give every cell a fixed slot. Aim for under 150 lines. *You will use everything from Day 2.*
7. **A hidden-information game.** Each player secretly picks rock, paper or scissors with the stick, then presses A. Reveal both only when both have locked in. Log every packet in onPacket() in main.js and confirm that the opponent's choice never arrives before the reveal. *This is the secure-by-design exercise.*

### Master: change the engine

8. **A new OP.** Add `OP_ARC` (a quarter circle: x, y, r, quadrant). Add the opcode and a `con_arc` helper in `console.h`, and a `case` in `draw()` in `main.js`. Notice that `runtime.c` and `ppu.c` need no change. *Files: `console.h`, `main.js`.*
9. **Cursor repeat.** Make Dama's cursor repeat when the stick is held: after 400 ms, one step every 120 ms. This needs a faster tick while a stick is held, without spending bandwidth when nothing moves. *Files: `dama.c`. Think about what happens to the clocks.*
10. **A ping display.** Add a client-to-server record `PING` and a server-to-client record `PONG` that carries the same byte back. Show the round-trip time in the status line. *Files: `wire.h`, `match.mjs`, `input-worker.js`, `main.js`. Decide whether it should go through the cartridge at all.*

### How to check your work

- Watch the status line under the screen. It shows tick rate, packets per second and bytes per second. A cursor move in a board game should cost about 11 bytes.
- Always test with two tabs, and reload one in the middle of a match. It must return to the same seat with the same state.
- Open a third tab to check the spectator view.

# Cheat sheet

Everything a cartridge can call, on one page. All of it is declared in `sdk/console.h`.

### You implement

```c
const u8 cart_players = 2;
void cart_init(void);                        /* once: first transition, reset state  */
void cart_presence(u8 player, u8 connected); /* a player joined or left              */
void cart_input(u8 player, u8 now, u8 prev); /* input byte changed                   */
void cart_sys(u8 player, u8 code);           /* SYS_RESIGN from the HOME overlay     */
void cart_tick(void);                        /* tick-rate times per second           */
void cart_draw(u8 view);                     /* describe the screen, read-only       */
```

### Drawing (inside `cart_draw` only)

```c
con_rect (slot, color, x, y, w, h);
con_circ (slot, color, x, y, r);
con_tri  (slot, color, x1, y1, x2, y2, x3, y3);
con_diam (slot, color, cx, cy, w, h);
con_line (slot, color, x1, y1, x2, y2);
con_point(slot, color, x, y);
con_text (slot, color, x, y, size, align, str_id);   /* ALIGN_LEFT / CENTER / RIGHT */
con_str  (id, "TEXT");                               /* 16 strings, 16 chars        */
```

### Colors

```c
FILL(role)                 FILL_B(role, bright)
STROKE(role, width)        STROKE_B(role, bright, width)

roles:      C_BLACK  C_PRIMARY  C_SECONDARY  C_ACCENT
            C_HIGHLIGHT  C_ERROR  C_SUCCESS  C_SPARE
brightness: B25  B50  B75  B100          width: 1 to 4
```

### Input

```c
u8 pressed = now & ~prev;          /* just pressed                         */
pressed & IN_A      pressed & IN_B
IN_ACTIVE(now)      IN_DIR(now)    /* DIR_U, DIR_UR, DIR_R ... DIR_UL      */
in_dx(now)          in_dy(now)     /* -1, 0, +1 (y grows downward)         */
IN_ACTION(now)                     /* 0 none, 1 = button 2, 2 = 3, 3 = 4   */
```

### Transitions

```c
con_transition_begin();
con_pal(role, r, g, b);                    /* roles 1 to 7                  */
con_label(button, "TEXT");                 /* buttons 2 to 4, 8 chars       */
con_tick_rate(hz);                         /* 0 to 60                       */
con_sfx_def(id, ch, duty, note, vol, sweep, len, flags);
con_music_def(id, step_10ms, steps, vol, notes);
con_transition_end();
```

### Sound events (any time)

```c
con_sfx(VIEW_ALL, id);     con_sfx(VIEW(p), id);     con_sfx(VIEW(a) | VIEW(b), id);
con_music(MUSIC_PLAY, id);                 con_music(MUSIC_STOP, 0);

channels: CH_PULSE1  CH_PULSE2  CH_TRIANGLE  CH_NOISE
duty:     DUTY_12  DUTY_25  DUTY_50  DUTY_75        flags: SFX_DECAY
notes:    MIDI, 60 = middle C, 69 = A 440 Hz        len: 10 ms units
```

### Commands

```
make                              rebuild all .wasm files
cd worker && npx wrangler dev     run the Worker + Durable Object locally
cd worker && npx wrangler deploy  deploy to Cloudflare
node host/sim.mjs                 optional: test without Cloudflare
```

### Five rules to keep on the wall

1. Input changes state, tick advances time, draw only describes.
2. Fixed slots for things that persist. Slot order is layer order.
3. Draw only what this view may see.
4. Palette, labels, tick rate and sound definitions change only in a transition.
5. Integers only. Validate every input.
