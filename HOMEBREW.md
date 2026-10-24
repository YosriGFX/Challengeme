# Writing a game for Challenge Me

This page is for whoever writes a new game for this engine, person or AI. It says what
"hardware" the game runs on, what the translator needs from the code, and how to make a
good multiplayer game for it. Translating and adding the finished ROM is in
[TRANSLATOR.md](TRANSLATOR.md).

## 1. What the game runs on

A game is a normal original Game Boy (DMG) ROM, a `.gb` file. The translator turns it into
WebAssembly ahead of time. The server runs that WebAssembly in a Cloudflare Durable
Object, one per match. Phones never run the game: they get the screen (as changed 8x8
tiles), the sound (as sound register writes), and send back one byte of buttons.

So write the game exactly as for a real Game Boy, with GBDK-2020 (C) or RGBDS (assembly).
Test it on a real Game Boy or your usual tools while you write it, then translate it.

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
- More than two Game Boys per match. The 4-Player Adapter (DMG-07) is planned, and so is
  a 6-port hub of our own (section 6).

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

## 6. More players (planned)

The link cable and joypad are our own code, not real chips, so the server can offer
hardware no real Game Boy had. Two designs are planned; neither exists yet, so do not
write for them until this page says how they work:

- **The 4-Player Adapter (DMG-07)**, as Nintendo made it, for games like F-1 Pole Position.
- **A 6-port hub:** six Game Boys, one per phone, joined like the DMG-07 but with six
  ports.

A third option, one Game Boy with several joypad registers and one shared screen, is
possible for party games.

## 7. From source to a match

1. Build the ROM: `make` with GBDK-2020 or RGBDS, giving `game.gb`.
2. Translate: `python -m translator game.gb -o build/game.wat --wasm` (TRANSLATOR.md).
3. Check two linked Game Boys without phones:
   `node translator/tests/run_wasm.mjs --link build/game.wasm build/game.wasm 900 --buttons=80`
   (no `trap` in the output means no missing code).
4. Add it: `python -m tools.add_game game.gb mygame "My Game"`, or commit the `.wasm` and
   add a line to `src/games/index.js`, with `result` and `start` if needed.
5. Run `npx wrangler dev`, open the page on two phones, press START on both.
