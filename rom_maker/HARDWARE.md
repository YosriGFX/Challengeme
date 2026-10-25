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
plays the game on linked Game Boys in one go.

Each match is two to four Game Boys, all on the server: two joined by a link cable, or
two to four by the 4-Player Adapter (section 6). Each phone shows its own Game Boy big
and the others small (picture-in-picture).

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
- More than four players (a bigger hub of our own is an idea for later).

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

## 5. Making a good multiplayer game

The server owns everything; phones only see and press. That gives you these guarantees
for free, and a few things to do:

- **Fairness:** all Game Boys run on one machine in lockstep, one scanline apart at
  most. Give every player the same luck: on the cable, player 1's Game Boy picks a seed
  and sends it (as Tetris does with its pieces); on the adapter, mix the shared button
  bytes into the generator every tick (Sky Hop).
- **Who is master (cable):** both Game Boys boot identically, so the game must decide by a
  handshake: each side waits on the external clock (`FF02 = $80`), and the side whose
  player presses START first becomes master (`FF02 = $81`) and sends. To make Game Boy 1
  (player 1) always the master, have the game's `start` script press START on Game Boy 1
  only, as the Tetris and Dr. Mario scripts do.
- **Link timing:** one byte takes 4096 cycles (just under 1 ms; about 17 bytes a frame).
  The slave gets its byte and its serial interrupt when the master's transfer ends. A
  master whose slave is not listening reads `$FF` after those 4096 cycles and the slave
  gets nothing: retry on `$FF` (see ASSEMBLY.md, the `Exchange` step). If
  both sides start as master at the same moment, the server still swaps the two bytes
  (real hardware would garble them).
- **Exchange inputs every frame** (cable) or every packet (adapter), and run every
  side from the same inputs: lockstep keeps all screens in agreement.
- **Win and loss:** keep round wins in fixed RAM addresses and count up by one per
  round: "my wins" and "their wins" on the cable, every player's wins (player 1 first) on
  the adapter. Then the `result` in `game.json` lets the server announce rounds and the
  match winner on the phones (ASSEMBLY.md section 10). Between rounds, wait for START
  from every player.
- **Start fast:** the lobby already makes both players press START before the game runs.
  Boot straight into the two-player match, or keep the menu to one screen, so the `start`
  script stays short or is not needed at all.
- **Every screen is visible to every player.** Design for it: no hidden information on
  your own screen that the other player must not see.
- **Sound:** each player hears their own Game Boy only.

## 6. The 4-Player Adapter (DMG-07)

`src/gb/adapter.js` joins two to four Game Boys the way Nintendo's adapter does (Pan
Docs "4-Player Adapter", Shonumi's notes, bbbbbr's logic-analyzer captures). Den of
Snakes (GBDK), F-1 Pole Position and Sky Hop play on it. Exactly what it does:

- **Clock.** The adapter is the only clock: every Game Boy waits with `SC = $80`. On each
  byte, a listening Game Boy gets the byte in `SB` and its serial interrupt; the adapter
  gets what that Game Boy had in `SB`. So a Game Boy's answer to byte k is what it puts
  in `SB` after byte k, and the adapter reads it during byte k + 1. A Game Boy that is
  not listening answers `$FF` (or `$00` if `SB` bit 7 is 0); an empty port answers 0.
- **Ping phase.** Packets of 4 bytes, 1.43 ms apart, one packet every 12.2 ms +
  (RATE & 15) ms: `$FE, STAT, STAT, STAT`. `STAT` = bits 4-7: ports that answered
  `$88, $88` in the packet before (port 1 = bit 4); bits 0-2: the receiving port's
  number, 1-4. Each Game Boy answers `$88, $88, RATE, SIZE`; RATE and SIZE count from
  player 1 only (SIZE 1-4 bytes per player per packet).
- **Start.** A Game Boy answering `$AA` to `$FE` and the first two `STAT`s starts the
  game: the next packet is `$CC, $CC, $CC, $CC` (at ping timing), and the game packets
  begin one packet time later.
- **Game packets.** 4 x SIZE bytes, the same to every port, 0.128 + (RATE >> 4) x 0.106
  + 0.887 ms apart; one packet every max(17 + (RATE & 15) ms, all its bytes + 1 ms).
  Each packet carries every port's block from the packet before, port 1 first; a port's
  block is its answers to the first SIZE bytes. The first packet is all zeros.
- **Back to ping.** A whole packet's worth of `$FF` in a row from one Game Boy: every
  port gets one packet of `$FF`, then ping packets again.
- **Seats.** Player N's phone is port N. With fewer players the other ports are empty.

How a game uses it, in assembly: ASSEMBLY.md section 9 and `skyhop/main.asm`.

## 7. From source to a match

1. From `rom_maker/`: `python3 tools/build.py mygame` assembles `mygame/main.asm`,
   translates it and runs as many linked Game Boys as `game.json` says (`--script`,
   `--shots`, `--frames`, `--bot`). It ends with `GB1 ok`, `GB2 ok`, ... when no code is
   missing, and writes `mygame/build/game.gb`, `game.wasm` and screenshots.
2. Add it to the server, from the repository root:
   `python -m tools.add_game rom_maker/mygame/build/game.gb mygame "My Game" --meta rom_maker/mygame/game.json`
   (only on this machine), or copy `game.wasm` to `src/games/` and add a line to
   `src/games/index.js` with the `result`, `start`, `players`, `minPlayers` and `link`
   from `mygame/game.json`.
3. Run `npx wrangler dev`, open the page on the phones, press START on each.

## 8. GBDK-2020 (C) instead of assembly

GBDK-2020 4.3 output translates (tested with Den of Snakes): build the `.gb` with its
`make`, then run the translator on it (`python -m translator game.gb -o game.wat --wasm`
from the repository root) and `tools/run.mjs` on the `.wasm`. Register interrupt
handlers with `add_VBL(handler)` and friends as usual. Avoid calling through function
pointers kept in variables; where you must, keep each target's address in a `const`
table in ROM.
