# The OP Console Book

This book teaches the whole engine in three days. It describes the code in this repository as
it is now. When the book and the code disagree, the code is right.

## How to read this book

Read one part a day with the code open beside you. Every chapter names the file it explains:
read the chapter, then read that file.

| Day | Goal | Chapters | Files to keep open |
| --- | --- | --- | --- |
| 1 | Understand the machine | 1 to 5 | `sdk/console.h`, `sdk/wire.h` |
| 2 | Write games | 6 to 12 | `book/tug.c`, `carts/pong/pong.c`, `carts/dama/dama.c` |
| 3 | Own the engine | 13 to 18 | `sdk/runtime.c`, `ppu/ppu.c`, `public/screen.js`, `host/match.mjs`, `worker/src/index.js` |

Two commands are all you need while reading:

```bash
make
```

```bash
node host/sim.mjs
```

The first rebuilds the `.wasm` files after you change C. The second runs the console on your
machine; open the address it prints in two browser tabs to play as two players.

# Day 1: Understand the machine

## 1. The idea in one page

A classic console has a CPU that runs the game and a PPU that puts the picture on the screen.
The OP Console splits that machine across the network.

```
  THE PLAYER'S DEVICE                                 CLOUDFLARE
 +----------------------------+                     +---------------------------------+
 | Input thread (net.js)      |  input: 2 bytes,    | Hono Worker                     |
 | owns the WebSocket         |  only on change     | checks who you are and what you |
 +----------------------------+-------------------->| own, then hands the socket on   |
 +----------------------------+                     +---------------------------------+
 | PPU (ppu.wasm)             |                     | MatchDO = the CPU, one per match|
 | 256 OP slots, strings,     |  only the bytes     |   cartridge (C to WASM)         |
 | motion, palette, sounds    |<--------------------|   runtime: one mirror per view  |
 +----------------------------+  that changed       +---------------------------------+
 | screen.js draws, chip.js   |                     | RegistryDO: users, catalog,     |
 | plays                      |                     | ownership                       |
 +----------------------------+                     +---------------------------------+
```

Three sentences carry the whole design:

- **DO = CPU.** The game exists only inside a Durable Object, as C compiled to WASM. There is
  one object per match, and it is the single source of truth.
- **Client = PPU + APU.** The device holds a small fixed memory map and draws what it is told.
  It has no game code, so there is nothing on it to read, change or cheat with.
- **OP is the new pixel.** The server does not send pictures. It sends drawing operations of
  8 bytes each, and only the ones that changed. An idle screen costs zero bytes.

Each player has their own stream. A cartridge draws once per player, and draws only what that
player may see. Hidden cards, the other player's cursor, a level not yet reached: none of it is
ever on the wire to the wrong device.

Everything in the contract is an integer of a fixed size. That is on purpose: the same contract
is meant to run on an ESP32 or an FPGA one day, and it must not depend on anything a browser has.

## 2. The client memory map

File: `ppu/ppu.c`, sizes in `sdk/console.h`.

The client's whole state is a few fixed regions:

| Region | Size | Changes |
| --- | --- | --- |
| OP buffer | 256 slots × 8 B | any packet |
| Motion | 256 × 6 B, plus the tick each slot was written | any packet |
| Strings | 16 × 16 B, printable ASCII | any packet |
| Input bindings | 4 × 8 B | any packet |
| Palette | 8 roles × RGB, role 0 always black | transition only |
| Button labels | 3 × 8 chars | transition only |
| Tick rate | 1 B, 0 to 60 | transition only |
| Sound bank | 16 presets × 8 B | transition only |
| Music | 4 patterns × (3 + 32 steps × 4 channels) | transition only |

Slot order is layer order: slot 0 is drawn first, slot 255 last.

The transition regions change only between `BEGIN` and `END`, and all at once at `END`. A game
decides when that happens: at load, at a level change, at the end of a match. So a palette can
never change halfway through a frame.

## 3. The OP

File: `sdk/console.h`.

One OP is 8 bytes: `[opcode][color][6 params]`. Coordinates are one byte each, in a space of
256 × 256 units. Think of it as an SVG viewBox: the browser draws it crisp at the device's own
resolution, a small display draws it at its own.

| Opcode | Params |
| --- | --- |
| `NOP` | an empty slot |
| `RECT` | x, y, w, h |
| `CIRC` | x, y, r |
| `TRI` | x1, y1, x2, y2, x3, y3 |
| `DIAM` | cx, cy, w, h |
| `LINE` | x1, y1, x2, y2 |
| `POINT` | x, y |
| `TEXT` | x, y, size, align, string id |

The color byte packs four things:

```
bit 7 6     5      4 3          2 1 0
stroke-1   fill   brightness    role
```

The role picks one of 8 palette entries (black, primary, secondary, accent, highlight, error,
success, spare). Brightness is 25, 50, 75 or 100 percent. With fill off, the shape is an outline
1 to 4 units wide. A rectangle's outline is drawn inside the rectangle, so a border never grows
out of its box.

There is no sprite and no image. A complex shape is built from layers, and **black fill is the
eraser**: Dama's king is a disc, a slightly larger black disc above it, and a second disc on top.

## 4. The input byte

File: `sdk/console.h`, `public/pad.js`.

The controller is one byte, sent only when it changes:

```
bit 7 6          5   4   3              2 1 0
action button    B   A   stick active   stick direction (8 ways)
```

The action field holds one button at a time: 0 none, 1 to 3 for buttons 2 to 4. Button 1 is
HOME. It belongs to the console, is handled on the client and never reaches a cartridge. What
HOME does to a match (resign) travels as a separate system message, so a cartridge cannot fake it
and cannot block it.

With the byte the client sends one more: the low 8 bits of the server tick that was on the screen
when the player acted. Chapter 11 says what that is for.

## 5. The wire

File: `sdk/wire.h`.

One WebSocket binary message is one packet. A packet is a row of records, each starting with a
type byte. Two rules hold for every packet:

- It is **atomic**: the client applies all of it or none of it.
- Every value is **absolute**, never a difference from before. A packet that is lost with its
  connection is repaired by a full dump, not by replaying history.

Every packet starts with `FRAME`, the server tick it belongs to. `MID` after it says the packet
was made between two ticks, as the answer to an input: the client uses only tick packets to read
the server's clock. `RESET` starts a full dump.
`OPS_LIST` carries up to 31 changed slots as `[slot][8 bytes]`; from 32 slots on, `OPS_MASK`
is smaller: a 256-bit mask says which slots follow. `MOVE`, `BIND` and `ACK` belong to chapters
10 and 11. `STR` sets a string. `BEGIN` ... `END` wrap a transition. `SFX` and `MUSIC` are
sound events.

The client sends three things: `IN` (the input byte and the tick on screen), `SYS` (from HOME)
and `RESYNC` (please send a full dump).

Sizes to remember: one changed slot is 14 bytes on the wire (3 for the tick, 2 for the list
header, 9 for the slot). Dama's full board on joining is under 1 KB.

# Day 2: Write games

## 6. A cartridge in 60 lines

File: `book/tug.c`.

A cartridge is one C file. It includes `console.h`, sets `cart_players`, and implements six
callbacks:

| Callback | Called |
| --- | --- |
| `cart_init()` | once, when the match is made. Do the first transition here. |
| `cart_presence(player, connected)` | a player came or went |
| `cart_input(player, now, prev)` | at once, on every change of that player's input byte |
| `cart_sys(player, code)` | a system message from HOME (`SYS_RESIGN`) |
| `cart_tick()` | tick-rate times a second; never, if the rate is 0 |
| `cart_draw(view)` | whenever something may have changed, once per view |
| `cart_turn()` | optional: the seat that must act now, or 255 (lets one phone host two players) |
| `cart_result()` | optional: 255 while playing, then the winning seat, or the number of seats for a draw |

Read `book/tug.c` now. It is a complete game: two players mash A to pull a knot to their side.
Notice what it does not have: no network code, no sockets, no knowledge of who is connected how.
It keeps its state in plain variables, changes them in `cart_input`, and describes the screen in
`cart_draw`.

Its tick rate is 0. Nothing runs between inputs, and the match costs nothing while both players
think.

## 7. Drawing

`cart_draw(view)` always starts from an empty screen and draws everything again. That sounds
wasteful and is the opposite: the runtime compares what you drew with what that player's device
already shows, and sends only the difference. You never track what changed. You only say what
the screen is.

For that to stay cheap, **give things that persist a fixed slot**. Dama keeps square `i` in slot
`i`, the piece on it in slot `33 + i`. When a piece moves, two slots differ and 23 bytes are sent.
If you numbered slots with a running counter, removing one thing would shift all the others and
every one of them would be sent again.

Strings work the same way: `con_str(id, text)` fills one of 16 strings, a `TEXT` OP points to it
by id. Change the string and only the string is sent.

## 8. Views

`cart_draw` is called once for each player and once for the spectators, with the view number.
A view below `cart_players` is that player; anything else is the shared spectator view.

This is where the security of the console lives. Whatever you do not draw for a view is not in
that view's stream. Dama draws the cursor only for its owner. A card game would draw the faces
of a hand only for the player who holds it. There is no "hide" flag to forget, because there is
no shared picture to hide things in.

A view is also how each player gets their own side at the bottom. Pong and Dama turn the picture
half a circle for player 2 and turn that player's stick with it.

For three to six players, give each seat its own palette role (roles 1 to 6) and keep role 7 for
what belongs to nobody. `carts/trail/trail.c` does exactly that.

## 9. Transitions

Palette, button labels, tick rate, sound bank and music change only inside a transition:

```c
con_transition_begin();
con_label(2, "REMATCH");
con_tick_rate(0);
con_transition_end();
```

Outside `begin` ... `end` these calls do nothing. The client checks the same rule on its side
and drops a packet that breaks it.

Use the tick rate as a throttle. Pong runs at 60 Hz only while a point is played. When the match
ends it sets the rate to 0 and the server stops its timer.

## 10. Time and Motion OPs

`cart_tick()` advances the game by one step. Keep all movement in integers; Pong keeps the ball
in 8.8 fixed point (256 = one unit).

Drawing the ball at a new place every tick works, and costs a packet every tick. A **Motion OP**
removes that cost. After drawing a slot, say how it keeps moving:

```c
con_circ(SL_BALL, FILL(C_ACCENT), (u8)(bx >> 8), (u8)(by >> 8), BALL_R);
con_move(SL_BALL, (u8)bx, (u8)by, vx, vy);     /* fractions of x and y, speed per tick */
```

Now the client moves the ball by itself. On the next tick the runtime works out where the client
has it, compares that with what you drew, and finds no difference: nothing is sent. When the ball
bounces, what you draw is no longer where the motion leads, and the new position and the new
motion go out in one packet.

Two things make this safe to use anywhere:

- **Motion cannot make a picture wrong.** It is only a prediction the runtime checks on every
  tick. If you draw something else, the correction is sent at that moment.
- **Both sides do the same sum.** `con_at()` in `console.h` is the one function that says where
  a moving OP is after `n` ticks. The runtime and the PPU both use it, so they agree to the bit.

A browser runs the same sum with a fraction of a tick, so a Motion OP also moves smoothly on a
120 Hz screen.

One detail for turned views: a position `p` in 8.8 becomes `65535 - p` when the picture is turned
half a circle, and the speed changes sign. Pong's `cart_draw` shows it.

## 11. Input: bindings and input age

A player's input goes to the server, the server answers, the device draws. That round trip is
short, but on a phone it is long enough to feel in the two places where a hand is directly
connected to a thing on screen: a paddle and a cursor.

A **binding** tells the client that this player's own stick drives a slot:

```c
con_bind(0, SL_PAD1 + me, BIND_VEL, PAD_SPEED, 0, 0, 255 - PAD_W, 0, 255);   /* Pong */
con_bind(0, SL_CURSOR, BIND_STEP, SQ, SQ, X0 + 1, X0 + 1 + 7 * SQ, Y0 + 1, Y0 + 1 + 7 * SQ);   /* Dama */
```

- `BIND_VEL`: while the stick is held, the slot moves by `(sx, sy)` each tick, kept inside the
  limits.
- `BIND_STEP`: once per push or change of direction, the slot steps by `(sx, sy)`; a step that
  would leave the limits is not made.

The client moves the slot at once. The cartridge still moves it by the same rule when the input
arrives, and what the server draws is what counts. For steps the client knows exactly which of
its inputs the server has already seen: every packet carries `ACK`, the number of inputs handled.
A step is shown on top of the server's picture until its number is acknowledged, then it is part
of the server's picture.

Declare a binding in `cart_draw`, only for the view of the player it belongs to, and only while
the rule really applies.

**Input age** is for games that judge timing. A player reacts to what is on their screen, and
that picture is a little old. Every input carries the tick that was on screen, and inside
`cart_input` the cartridge can ask how old that was:

```c
u8 lag = con_input_age();                     /* ticks, 0 to CON_MAX_AGE */
i32 t = (i32)now - (lag > LAG_MAX ? LAG_MAX : lag);
```

Keys judges a press against tick `t`, not against the tick it arrived on. Cap the allowance, as
Keys does: the number comes from the client.

## 12. Sound

The client's sound chip is a Game Boy APU: two pulse channels, a wave channel loaded with a
triangle, and noise. A cartridge never touches registers. In a transition it defines up to 16
presets:

```c
/*            id        channel    duty     note vol sweep len flags */
con_sfx_def(SFX_MOVE, CH_PULSE1, DUTY_25, 72,  8,  0,    6,  SFX_DECAY);
```

`note` is a MIDI number, `vol` 0 to 15, `sweep` a signed number of semitones over the length,
`len` in hundredths of a second. Music is up to four patterns of up to 32 steps with four notes
each, looped on the client's own clock.

Then, at any time, `con_sfx(view_mask, id)` plays a preset for the views in the mask. One rule
keeps sound from feeling late: **a sound the player caused themselves plays on their own device
at once; everything else comes from the server.** So Dama sends the move sound to the other
player only. The mover already heard their click.

# Day 3: Own the engine

## 13. The runtime

File: `sdk/runtime.c`.

The runtime is linked into every cartridge. For each view it keeps a `Screen`: exactly what that
client holds (OPs, motion, strings, bindings) and the tick each slot was written.

`con_flush(view, full)` is the heart of the engine:

1. Clear the working screen and call `cart_draw(view)`.
2. For each slot, work out what the client shows right now. For a moving slot that is `con_at()`
   applied to what was sent. If the cartridge drew exactly that, with the same motion, skip it.
3. Encode the rest: a list for up to 31 slots, a mask from 32. Then motion, bindings, changed
   strings, the acknowledgement, music and sounds.
4. If nothing was added after the tick stamp, return 0: there is no packet.

A full dump is the same code with the mirror cleared first, so the diff is against an empty
screen. Join, resync and "the client got confused" are all one path.

The host around it is small on purpose. It calls `con_input`, `con_sys`, `con_presence`,
`con_tick`, then `con_flush` for each view, and moves the bytes. It never looks inside a packet.

## 14. The PPU

File: `ppu/ppu.c`.

`ppu_apply(len)` copies the live regions to a working copy, applies the packet to that copy
record by record, and copies it back only if every record parsed. A packet that is cut short,
carries an unknown record, or breaks a rule changes nothing at all, and the client asks for a
full dump.

The rules it enforces are the ones the client must not take on trust: role 0 stays black, a
palette or label or tick outside a transition is an error, text is printable ASCII, the tick rate
is at most 60.

Writing a slot stops its motion; a `MOVE` record later in the same packet starts a new one, and
the motion counts from that packet's tick. `ppu_view(tick)` gives the whole OP buffer advanced to
a tick: that is what a hardware client draws.

## 15. The client

Files: `public/screen.js`, `public/pad.js`, `public/net.js`, `public/main.js`.

**`net.js`** is a Web Worker that owns the WebSocket, so input never waits for drawing. It sends
the input byte only when it changes, reconnects after a second, and when the page becomes visible
again it checks its socket: a phone that slept can hold a socket that looks open and is dead, and
an idle screen is silent by design. It sends `RESYNC`, which is always answered; no answer in
2.5 seconds means a new socket.

**`screen.js`** keeps a clock of server ticks from the tick stamp on every packet. With it:

- For games at 20 Hz or more it plays frames back one tick plus the measured jitter behind the
  newest, and glides between two frames. The game still runs only on the server; this decides
  when a finished picture is shown.
- It moves Motion OPs between packets.
- It moves bound slots with the player's stick.

Then it draws the 256 slots with Canvas2D.

**`pad.js`** turns touch, mouse and keyboard into the input byte. It cancels every browser touch
default on the page, so no browser gesture can interfere: no zoom, no scroll, no synthetic click.
The room field is the one exception, and its text is 16 px so Safari does not zoom on focus.
A finger that starts on a button is followed until it lifts, so a thumb can roll from B to A.

**`main.js`** is the front panel: lobby, HOME, and the wiring. Both menus are driven by the stick
and A / B or by a tap, and never scroll.

**`local.js`** is a second thread that speaks exactly like `net.js`, so the page cannot tell them
apart. Instead of a socket it hosts the match itself, with `match.mjs`: the same file the server
runs. It is used only for a game whose manifest says `"offline"`, which the server then lets a
player keep. One phone holds both seats; after every move `local.js` asks the cartridge whose turn
it is (`cart_turn`) and shows that seat's view, so the board turns to the other player.

## 16. The host

Files: `host/match.mjs`, `host/sim.mjs`.

`Match` is one running match. It seats connections (the same id always gets its own seat back,
extra connections watch), passes messages to the cartridge, and runs a timer at the cartridge's
tick rate. At rate 0 there is no timer.

`match.mjs` uses no Node.js and no Cloudflare API, so the same file runs in both places.
`sim.mjs` is the local stand-in for Cloudflare: a static file server for `public/` only, and a
small WebSocket server. `JITTER_MS=40 node host/sim.mjs` delays packets at random to try a bad
network.

## 17. The Worker

File: `worker/src/index.js`.

The Hono Worker is the gate. Before a socket reaches a match it checks, in this order: the game
exists, the request comes from one of our own pages (`Origin`), the session cookie is valid, and
this user may play this game. Only then does it hand the socket to `MatchDO`.

- **Users.** `POST /api/session` makes an account for the device on its first visit and sets a
  signed, HttpOnly cookie. Page scripts cannot read it and a client cannot forge it. The seat in
  a match is the user id plus the tab's id.
- **Another device.** `POST /api/link` gives a signed-in device a code of 8 letters that works
  once, for 5 minutes. `POST /api/link/use` on a second device makes it the same account.
- **Catalog and ownership** live in `RegistryDO`, one Durable Object with its own SQLite: tables
  `users`, `carts` (price, listed) and `owned`. Nothing has to be created before the first deploy.
- **Buying.** `POST /api/buy` asks Stripe for a Checkout page. Money never touches the Worker.
  Stripe calls `POST /api/stripe` when an order is paid; the Worker checks the signature and only
  then writes a row into `owned`.
- **A locked game sends nothing.** The refusal happens at the upgrade, so not one byte of a game
  that is not owned reaches the device.
- **A game leaves the server only if it says so.** `GET /offline/<cart>.wasm` answers only for a
  cartridge whose manifest has `"offline": true`, and only to a user who may play it. Hiding things
  from a player is then impossible, so only a game that hides nothing should ever say it.
- **Results.** For a game that hides nothing, `GET /api/log/<cart>/<room>` gives the match record,
  who won (`cart_result`), and the hashes a ledger holds. `POST /api/sign/<cart>/<room>` keeps one
  wallet signature per seat once the match is over; `public/ledger.js` makes them, and
  `evm/MatchLedger.sol` accepts a result only with both.

`MatchDO` holds the WebSocket and stays awake while a match is open. It answers a client's close
frame so that no half-closed socket keeps it awake after the players have gone.

A match also keeps a log of everything that went into the cartridge and on which tick.
`record()` returns it with a fingerprint of what every player sees, and `Match.replay()` runs
a record again on a fresh cartridge. Because a cartridge is deterministic, the two fingerprints
must be equal: `node host/replay.mjs match.json` checks exactly that.

## 18. Where to go next

- **A new game.** Copy `book/tug.c`, give it a name, add it to `CARTS` in the `Makefile` and in
  `worker/src/index.js`.
- **The console font.** `font/build.py` is the font: a table of strokes. Change a glyph there and
  run `make font`. It writes the browser's font and `ppu/font.h` together, so a device and a phone
  always show the same letters.
- **A hardware client.** `hardware/ref.c` is a whole client in 50 lines: a packet into
  `ppu_apply`, the OP buffer out of `ppu_view(tick)`, and `hardware/raster.c` to draw it with
  integers only. `make hardware` runs it for every game. `hardware/esp32/` puts a socket, a display
  and buttons around the same three calls for an ESP32 board.
- **An FPGA client.** `fpga/ppu_line.v` draws the OP buffer one screen line at a time, slot by slot
  in layer order, into a line buffer the display reads. A small processor beside it runs `ppu.c` and
  hands it the OP buffer once per tick. It draws filled rectangles today; each other shape is one more
  case that says which pixels of the line it covers, and `hardware/raster.c` already has the rules.
