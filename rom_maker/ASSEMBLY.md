# Writing a game in Game Boy assembly

No C, no compiler: a game is a few `.asm` text files that the RGBDS assembler turns into
a `.gb` ROM, byte for byte what you wrote. That is also what the translator handles best.
Two complete games are written this way; read the one you start from next to this page:
[template/](template/) (Coin Duel, two players on the link cable) and
[skyhop/](skyhop/) (Sky Hop, two to four players on the 4-Player Adapter).
[HARDWARE.md](HARDWARE.md) has the engine's rules.

## 1. Tools and files

- **RGBDS** (`rgbasm`, `rgblink`, `rgbfix`): the assembler. **wabt** (`wat2wasm`): used
  by the translator. `sh tools/setup.sh` downloads both into `rom_maker/.tools/`.
- Python 3 and Node.js 18+ for the translator and the test run.

A game is one folder:

| File | What it is |
| --- | --- |
| `main.asm` | the code; the only file assembled, it `INCLUDE`s the others |
| `hardware.inc` | register names (`rLCDC`, `rSC`, ...) and constants |
| `tiles.asm` | graphics, as rows of shade digits |
| `game.json` | title, players, link, where the win counters are, the server's `start` script |
| `bot.mjs` | a bot that plays the game, for whole-match tests (section 12) |

`python3 tools/new.py <folder> "<Title>" [--players 4]` starts one from the right
example. `python3 tools/build.py <folder>` builds `<folder>/build/game.gb`, `game.sym`
(every label and its address), `game.map`, `game.wasm`, and screenshots.

## 2. RGBDS in five minutes

```asm
INCLUDE "hardware.inc"          ; paste another file here
DEF SPEED EQU 2                 ; a constant

SECTION "State", WRAM0[$C010]   ; variables: a section in work RAM, at a fixed address
wScore: db                      ; 1 byte
wSeed:  dw                      ; 2 bytes

SECTION "Main", ROM0            ; code in ROM bank 0 (the linker picks the address)
Update:                         ; a label (global)
    ld a, [wScore]              ; [ ] = memory
    inc a
    ld [wScore], a
    cp 5
    jr c, .notYet               ; .local labels belong to the last global label
    xor a                       ; a = 0
.notYet:
    ret

Tiles:
    dw `00333300                ; one row of 8 pixels, a shade 0-3 per digit
    db $FF, %10100000, 12       ; hex, binary, decimal bytes
    ds 16, 0                    ; 16 bytes of 0
```

`ldh [rSC], a` writes a register in $FF00-$FFFF (a short, fast form of `ld`).

## 3. The CPU (SM83) you need

Registers: `a` (math happens here), `b c d e h l`, pairs `bc de hl`, `sp`, and flags
`z` (result was 0), `c` (carry / "less than" after `cp`), `n`, `h`.

| Want | Write |
| --- | --- |
| load / store | `ld a, 5` · `ld a, b` · `ld a, [hl+]` (then hl += 1) · `ld [wX], a` |
| math | `add 3` · `sub b` · `inc a` · `dec [hl]` · `and $0F` · `or c` · `xor a` (a = 0) · `cpl` (invert) |
| compare | `cp 7` then `jr c` (a < 7), `jr nc` (a >= 7), `jr z` (a = 7), `jr nz` |
| bits | `bit 4, b` then `jr z` (bit clear) · `set 0, [hl]` · `res 0, [hl]` · `swap a` · `srl a` · `rla` |
| jump | `jr label` (within ±127 bytes) · `jp label` (anywhere) · `jp nz, label` |
| call | `call Fn` · `ret` · `ret nc` · `push hl` / `pop hl` |
| wait | `halt` (sleep until an enabled interrupt, e.g. the next frame) |

16-bit loop: `dec bc` does not set flags, so test with `ld a, b / or c / jr nz, .loop`.

## 4. Anatomy of a ROM

| Address | What |
| --- | --- |
| $0000-$3FFF | ROM bank 0: interrupt vectors at $40 (VBlank) $48 (LCD) $50 (timer) $58 (serial), header at $100-$14F, then code |
| $4000-$7FFF | ROM bank 1, or a switchable bank with an MBC (section 10) |
| $8000-$97FF | tile graphics (VRAM) |
| $9800-$9BFF | background map: 32 x 32 tile numbers, the screen shows 20 x 18 |
| $C000-$DFFF | work RAM: your variables (stack at the top: `ld sp, $E000`) |
| $FE00-$FE9F | OAM: 40 sprites x 4 bytes (Y+16, X+8, tile, flags) |
| $FF00-$FF7F | registers; $FF80-$FFFE fast RAM (HRAM); $FFFF interrupt enable |

The header (`nop / jp Start` at $100, then room to $150) is filled by `rgbfix`.

## 5. Start-up and the frame loop

```asm
Start:
    di
    ld sp, $E000
    call LcdOff            ; wait for line 144, then LCDC = 0: VRAM is free to write
    ; copy tiles to $8000, draw the background map, clear OAM, clear your RAM
    ld a, LCDC_ON          ; screen back on
    ldh [rLCDC], a
    ld a, IE_VBLANK        ; wake up once per frame
    ldh [rIE], a
    ei
MainLoop:
    halt                   ; sleep until VBlank (the $40 vector is just `reti`)
    nop
    call Draw              ; first: write sprites / map while the screen is not drawing
    call ReadJoypad
    ; ... game logic ...
    jr MainLoop
```

Never turn the LCD off outside VBlank on a real Game Boy (the template's `LcdOff` waits).

## 6. Graphics

- **Tiles**: 8 x 8 pixels, 16 bytes, 4 shades. Write them as `` dw `01233210 `` rows.
  With `LCDC_ON` both the background and sprites use tiles from $8000 (tile 0 at $8000,
  tile 1 at $8010, ...). Up to 256 tiles there.
- **Background**: one byte per 8 x 8 cell at $9800 + 32 * row + column. `rSCX`/`rSCY`
  scroll it.
- **Sprites**: OAM entry n at $FE00 + 4n: Y + 16, X + 8, tile, flags (bit 5 flip X,
  bit 6 flip Y, bit 4 palette OBP1, bit 7 behind background). Y = 0 hides it. At most
  10 per line.
- **Palettes**: `rBGP`, `rOBP0`, `rOBP1` map the 4 shades; `%11100100` is the normal one.
- Many sprites: keep a copy of OAM in RAM and copy it in VBlank with the standard OAM DMA
  routine in HRAM (`ld a, HIGH(wShadowOAM) / ldh [$46], a / ld a, 40 / .w: dec a /
  jr nz, .w / ret`, copied to $FF80 and called there). The translator recognises exactly
  this routine; it is the one piece of code allowed to run from RAM.

## 7. Buttons

`ReadJoypad` in the template returns a byte with `PAD_RIGHT`, `PAD_LEFT`, `PAD_UP`,
`PAD_DOWN`, `PAD_A`, `PAD_B`, `PAD_SELECT`, `PAD_START` set while held. For "just
pressed", keep last frame's byte: `pressed = now & ~last`.

## 8. Two players: link cable and lockstep

Both Game Boys run the same ROM on the server. The template's way, which you should keep:

1. **Handshake** (`Handshake`): both listen (`SB = 0`, `SC = $80`). The first to see
   START sends `$A5` as master (`SC = $81`) and is player 1; the one that receives `$A5`
   is player 2. The server's `start` script presses START on Game Boy 1, so phone 1 is
   always player 1.
2. **Seed**: player 1 sends one random byte; both seed the same generator from it.
3. **Every frame** (`Exchange`): put your buttons in `SB`; player 1 waits a moment then
   starts the transfer (`SC = $81`), player 2 waits for it (`SC = $80`); when `SC` bit 7
   is 0, `SB` holds the other player's buttons.
4. **Run the whole game from both inputs**, in the same order, on both Game Boys. Then
   both screens agree without sending any game state.

Lockstep only holds if the game logic uses nothing but the two inputs, the seed and its
own variables: never `rDIV`, `rLY`, timers or the frame you are in for decisions after
the handshake. Call the random generator the same number of times on both sides.

More data per frame: send several bytes in a row (each is one more transfer, about
1 ms; up to 15 a frame is fine).

## 9. Three or four players: the 4-Player Adapter

With more than two players (or `"link": "adapter"` in `game.json`), the Game Boys are
joined by Nintendo's 4-Player Adapter (DMG-07). The adapter clocks every byte; each Game
Boy only listens (`SC = $80`) and answers. [skyhop/main.asm](skyhop/main.asm) does it
all in the serial interrupt (`SerialIsr`); keep that code as it is:

1. **Ping phase.** The adapter sends packets `$FE, STAT, STAT, STAT` to every port.
   `STAT` bits 4-7 are the ports with a Game Boy answering, bits 0-2 this port's player
   number (1-4). Answer `$88, $88, RATE, SIZE` (Sky Hop: RATE 0, SIZE 1). Each answer is
   what you put in `SB` after a byte arrives; the adapter reads it with the next byte.
2. **Start.** Player 1's START makes it answer `$AA` to a whole packet. The adapter then
   sends `$CC` four times and the game packets begin. The server's `start` script
   presses START on Game Boy 1.
3. **Game packets.** Each packet is 4 x SIZE bytes, the same on every port: every
   player's block from the packet before, player 1 first (an empty port gives zeros).
   Your block is your answers to the packet's first SIZE bytes. Sky Hop sends its
   buttons as its 1-byte block. **Never send `$FF`**: a packet's worth of `$FF` ends the
   game packets (Sky Hop clears the SELECT bit, so its byte is never `$FF`).
4. **Lockstep.** Queue each complete packet in the interrupt and run **one game tick per
   packet** in the main loop, from the four button bytes. Every Game Boy gets the same
   packets, so every screen agrees. Packets come every 17 ms (about one a frame); draw
   in the V-Blank interrupt, not in the tick.
5. **Who plays:** the last `STAT` before the game says which ports are connected (Sky
   Hop's `wMask`) and which player this Game Boy is (`wMe`). Highlight your own player
   (Sky Hop draws it with OBP1) and show every player's score.

Randomness: there is no seed exchange; Sky Hop mixes the four button bytes into its
random generator every tick (`MixSeed`), the same on every Game Boy.

## 10. Wins, losses and the server

With **two players on the cable**, keep, on each Game Boy, "rounds my player won" and "rounds the other player won" at
fixed addresses (template: `$C000` and `$C001`), both counting up by one per round, and
0 at the start. The server reads them on both Game Boys; once they agree it shows YOU WIN /
YOU LOSE on the phones and records it. `game.json`:

```json
{
  "title": "Coin Duel",
  "result": { "wins": 49152, "theirs": 49153, "best": 5, "bestAt": 49154, "bestChoices": [1, 2, 3, 4, 5, 7, 9] },
  "start": { "frames": 30, "inputs": [[10, 128, 0], [16, 0, 0]] }
}
```

`wins`/`theirs` are the addresses in decimal ($C000 = 49152), `best` the round wins that
end the match. `start` is run on the server before the players see anything: from frame
10 Game Boy 1 holds START (128), from 16 nothing. After the match the server goes back
to its lobby and starts fresh Game Boys for a rematch, so the ROM needs no rematch menu.

With **the adapter (any number of players)**, keep every player's round wins on every
Game Boy, player 1 first (Sky Hop: `$C000-$C003`), and give the first address as
`winsBy` instead of `wins`/`theirs`:

```json
{
  "title": "Sky Hop", "players": 4, "minPlayers": 2, "link": "adapter",
  "result": { "winsBy": 49152, "best": 3, "bestAt": 49156, "bestChoices": [1, 2, 3, 4, 5, 7, 9] },
  "start": { "frames": 30, "inputs": [[10, 128, 0, 0, 0], [16, 0, 0, 0, 0]] }
}
```

The server counts a round once every Game Boy agrees on the new number; the phones show
everybody's score. `players`/`minPlayers` are the most and fewest seats (whoever opens
the match picks), `inputs` rows have one button byte per player.

After each round, put the players back at their start and wait until **every** player
has pressed START (a new press, not one held from before) before the next round begins;
show PRESS START and who is ready. Coin Duel does this with `wWait`, `wReady1`/`wReady2`
and `wLast1`/`wLast2` in `Update`; Sky Hop with `wReady` and `wPrev` in `WaitRound`.

Let the players choose the match length: read the round wins that win the match from a
fixed byte after the counters (Coin Duel: `wBest` at `$C002`, Sky Hop at `$C004`; 0 = the
ROM's own default) and list it in
`game.json` as `"bestAt": 49154` with `"bestChoices": [1, 2, 3, 4, 5, 7, 9]` inside
`result`. The start page then shows a "Rounds to win the match" choice, and the server
writes the chosen number to that byte on every Game Boy right after the `start` script.
Keep the choices at 9 or less if the score is shown as one digit.

**Time limit.** Whoever opens the match can also give it a time (1 to 10 minutes). The
server keeps that clock, not the ROM: when it runs out, the player with the most round
wins takes the match, and if the lead is shared, the next round win that puts one player
ahead ends it ("sudden death"). The ROM needs nothing extra, but it has to play well with
it: keep rounds short (well under a minute), add a win to the counters the moment the
round is decided, and make every round end. No stalemate where nobody can win; a round
nobody wins counts for nobody and the next one starts.

## 11. Bigger games

- More than 32 KiB: use MBC5 (`rgbfix -m 0x19`, `SECTION "Level", ROMX, BANK[2]`).
  Switch with a constant right before the call: `ld a, BANK(Fn) / ld [$2000], a /
  call Fn`, from bank 0 code.
- State machines: instead of storing addresses in RAM, store a state number and branch:
  `ld a, [wState] / cp 0 / jp z, Title / cp 1 / jp z, Play ...`.
- Sound: channel 1 is in the template (`Beep`). Channels: 1 square with sweep
  ($FF10-14), 2 square ($FF16-19), 3 wave ($FF1A-1E, samples at $FF30-3F), 4 noise
  ($FF20-23). Turn sound on with `rNR52 = $80`, `rNR50 = $77`, `rNR51 = $FF`.

## 12. Testing a whole match with a bot

A screenshot shows a moment; a bot plays a whole match. `bot.mjs` (see
[template/bot.mjs](template/bot.mjs), [skyhop/bot.mjs](skyhop/bot.mjs)) is called
before every frame and presses buttons for each player from the game's RAM:

```js
export default function bot({ frame, players, ram, press }) {
  const x = ram(1, "wP1X");            // a label from build/game.sym, read on Game Boy 1
  const h = ram(2, "wPHl", 1);         // label + offset: element 1 of an array
  press(1, x < 80 ? 0x01 : 0x02);      // hold right or left (01 right ... 80 start)
}
```

`python3 tools/build.py <folder> --bot <folder>/bot.mjs --frames 30000 --shots ""` plays
until the match is decided and prints every round (`match over, player N wins`). Make
the bots differ in skill so different players win rounds, and make them press START
between rounds.

## 13. When the build says STOPPED

`GB1 STOPPED: no translated code at 0123` means the game jumped somewhere the translator
did not see as code. Look the address up in `build/game.sym`, then see
[HARDWARE.md](HARDWARE.md) section 4: usually an address computed or kept in RAM. Rewrite
that spot as plain `call`/`jp` or a `jp z` chain.
