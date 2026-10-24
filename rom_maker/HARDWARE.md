# The Challenge Me "hardware"

This page is for whoever writes a new game for this engine, person or AI. It says what
"hardware" the game runs on, what the translator needs from the code, and how to make a
good multiplayer game for it. How to write the game in assembly is in
[ASSEMBLY.md](ASSEMBLY.md); translating and adding the finished ROM is in
[../TRANSLATOR.md](../TRANSLATOR.md).

## 1. What the game runs on

A game is a normal original Game Boy (DMG) ROM, a `.gb` file. The translator turns it into
WebAssembly ahead of time. The server runs that WebAssembly in a Cloudflare Durable
Object, one per match. Phones never run the game: they get the screen (as changed 8x8
tiles), the sound (as sound register writes), and send back one byte of buttons.

So write the game exactly as for a real Game Boy. In this folder that means RGBDS
assembly ([ASSEMBLY.md](ASSEMBLY.md)): no C compiler, and the code the translator handles
best. GBDK-2020 (C) works too (section 8). `tools/build.py` assembles, translates and
plays the game on two linked Game Boys in one go.

Each match is two Game Boys joined by a link cable, both on the server. Player 1's phone
shows Game Boy 1 big and Game Boy 2 small (picture-in-picture); player 2's the other way.

## 2. Hardware that works

| Part | Supported |
| --- | --- |
| CPU | the whole SM83 (LR35902) instruction set, cycle-counted |
| Screen | background, window, 10 sprites per line, 8x8 and 8x16 sprites, BGP/OBP0/OBP1, SCX/SCY/WX/WY |
| Raster effects | per line: each line is drawn at the end of its mode 3, so changes made in a STAT (mode 0/2 or LYC) interrupt or during HBlank apply from the next line drawn |
| Interrupts | V-Blank, STAT (LYC and modes), timer, serial |
| Timer | DIV, TIMA, TMA, TAC, all four speeds |
| OAM DMA | FF46; copies at once (the usual HRAM wait loop is harmless) |
| Cartridge | ROM only, MBC1, MBC3 (no clock), MBC5; up to 128 KiB of cartridge RAM |
| Sound | all four channels, sweep, envelopes, lengths, wave RAM, NR50/NR51 panning; played on each phone |
| Link cable | serial transfers at 8192 Hz, internal or external clock (section 4) |
| Joypad | FF00, both button rows |

## 3. Not supported (yet)

- Game Boy Color features (double speed, VRAM/WRAM banks, color palettes, HDMA).
- Battery saves: cartridge RAM works while the match runs, but starts empty each match.
- The MBC3 real-time clock.
- The joypad interrupt (poll FF00 instead, once per frame).
- Changes in the middle of a line (each line is drawn in one go).
- Games for more than two players: the server already has the 4-Player Adapter (section
  6), but writing new games for it is on hold. Write two-player games for now.

## 4. Rules for code the translator can follow

The translator finds all code before the game runs. It follows every call, jump and
branch, and recognises common jump tables. Code it cannot find stops that Game Boy with
`stopped at BB:AAAA`. Write code it can see:

1. **Keep code in ROM.** Code copied to RAM and run there needs a `ram_code` hint. The
   standard OAM DMA routine in HRAM is the only exception (detected automatically).
2. **Jump tables:** keep a table of `dw` addresses and load its base with `ld hl,table`
   (or `ld de,table / add hl,de`), then `jp hl`, or `push hl / ret`. The classic
   `rst $28` table placed right after the call also works. Do not compute addresses with
   arithmetic on the high byte, or build them from data in RAM.
3. **Function pointers** stored in RAM (state machines, callbacks): list every target in
   the hints file `entries`, or keep the targets in one ROM table as above.
4. **Bank switching:** switch with a constant (`ld a,5 / ld ($2000),a`) right before
   calling into that bank when you can. If bank 0 jumps into 4000-7FFF with a bank chosen
   at run time, add `BB:AAAA` entries for each bank it can be.
5. **No data inside code paths**, except the table after a call to a routine that pops
   its own return address.
6. **No self-modifying code.**

If a build stops at an address, TRANSLATOR.md section 4 explains how to find out why.

## 5. Making a good two-player game

The server owns everything; phones only see and press. That gives you these guarantees
for free, and a few things to do:

- **Fairness:** both Game Boys run on one machine in lockstep, one scanline apart at
  most. Use the link to share one random seed at the start (player 1's Game Boy picks it
  and sends it), so both players get the same luck, as Tetris does with its pieces.
- **Who is master:** both Game Boys boot identically, so the game must decide by a
  handshake: each side waits on the external clock (`FF02 = $80`), and the side whose
  player presses START first becomes master (`FF02 = $81`) and sends. To make Game Boy 1
  (player 1) always the master, have the game's `start` script press START on Game Boy 1
  only, as the Tetris and Dr. Mario scripts do.
- **Link timing:** one byte takes 4096 cycles (just under 1 ms; about 17 bytes a frame).
  The slave gets its byte and its serial interrupt when the master's transfer ends. If
  both sides start as master at the same moment, the server still swaps the two bytes
  (real hardware would garble them).
- **Exchange inputs every frame** (or a small state), and run both sides from the same
  inputs: lockstep keeps both screens in agreement.
- **Win and loss:** keep each side's round wins in fixed RAM addresses, one for "my wins"
  and one for "their wins", and count up by one per round. Then a `result` line in
  `src/games/index.js` lets the server announce rounds and the match winner on the phones
  (TRANSLATOR.md, "Wins and losses"). Reset both to 0 for a new match.
- **Start fast:** the lobby already makes both players press START before the game runs.
  Boot straight into the two-player match, or keep the menu to one screen, so the `start`
  script stays short or is not needed at all.
- **Both screens are visible to both players.** Design for it: no hidden information on
  your own screen that the other player must not see.
- **Sound:** each player hears their own Game Boy only.

## 6. More players (on hold)

The server can join up to four Game Boys with Nintendo's 4-Player Adapter (DMG-07,
`src/gb/adapter.js`, following Pan Docs' "4-Player Adapter" page); Den of Snakes, an
open-source GBDK game for it, plays on it. Matches, lobby and phone page handle up to
four seats. New 4-player games are on hold for now: write two-player games. A 6-port
hub of our own, and one Game Boy with several joypads, are ideas for later.

## 7. From source to a match

1. From `rom_maker/`: `python3 tools/build.py mygame` assembles `mygame/main.asm`,
   translates it and runs two linked Game Boys (`--script`, `--shots`, `--frames`).
   It ends with `GB1 ok` / `GB2 ok` when no code is missing, and writes
   `mygame/build/game.gb`, `game.wasm` and screenshots.
2. Add it to the server, from the repository root:
   `python -m tools.add_game rom_maker/mygame/build/game.gb mygame "My Game" --meta rom_maker/mygame/game.json`
   (only on this machine), or copy `game.wasm` to `src/games/` and add a line to
   `src/games/index.js` with the `result` and `start` from `mygame/game.json`.
3. Run `npx wrangler dev`, open the page on two phones, press START on both.

## 8. GBDK-2020 (C) instead of assembly

GBDK-2020 4.3 output translates (tested with Den of Snakes): build the `.gb` with its
`make`, then run the translator on it (`python -m translator game.gb -o game.wat --wasm`
from the repository root) and `tools/run2.mjs` on the `.wasm`. Register interrupt
handlers with `add_VBL(handler)` and friends as usual. Avoid calling through function
pointers kept in variables; where you must, keep each target's address in a `const`
table in ROM.
