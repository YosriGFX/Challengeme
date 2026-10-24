# Translating a Game Boy game

The translator turns a Game Boy ROM (`.gb`) into WebAssembly (`.wasm`) ahead of time. It
reads the game's machine code, finds every routine, and writes each one out as native
WebAssembly, together with a hand-written runtime for the screen, timer, link cable,
joypad and cartridge banking. Nothing emulates the CPU at play time: the server runs the
`.wasm` directly in the Match Durable Object, and the phones only receive pixels.

This page covers the whole job: setting up, translating, adding the game, and what to do
when a game stops or will not translate.

## 1. Set up once

You need Python 3.11 or newer, [wabt](https://github.com/WebAssembly/wabt) for
`wat2wasm`, and Node.js for the test harness. All three are dev tools only: production is
the `.wasm` plus pure JS on Cloudflare Workers.

```sh
cd challengeme
python3 -m venv .venv
. .venv/bin/activate                 # Windows: .venv\Scripts\activate
# no pip install: the translator uses only the standard library
wat2wasm --version                   # macOS: brew install wabt, Debian/Ubuntu: apt install wabt
```

## 2. Translate

```sh
python -m translator "roms/Some Game.gb" -o build/somegame.wat --wasm
```

The output looks like this:

```
cartridge: MBC1, 16 ROM banks, 0 RAM banks
build/somegame.wat: 1991 functions, 4956 blocks, 20950 instructions, 9606 flag computations removed
note: no code at C865 (jumps there will trap)
build/somegame.wasm: 1310498 bytes
```

- `cartridge`: the memory controller (ROM only, MBC1, MBC3, MBC5) and its size.
- `functions`, `blocks`, `instructions`: how much code was found.
- `note: no code at ...`: a place the code may jump to, where the translator found no
  valid code. Usually harmless (padding behind an interrupt vector, a table entry that is
  never used). It only matters if the game really jumps there; see section 4.
- `note: bank 0 jumps to XXXX with a bank set at runtime`: code in bank 0 jumps into the
  switchable bank, and the bank is chosen while the game runs. See section 5.

The default target is the server (`--target server`). `--target browser` builds the
shared-memory variant for running in a browser Web Worker.

## 3. Add the game

**To the repository** (everyone gets it on deploy):

1. `cp build/somegame.wasm src/games/`
2. In `src/games/index.js`, import it and add a line to `BUILT_IN`:
   ```js
   import somegame from "./somegame.wasm";
   // ...
   { id: "somegame", title: "Some Game (2 players)", module: somegame },
   ```
3. Add the same id to `BUILT_IN` in `tools/add_game.py`, and an `<option>` to
   `public/index.html` (the start page's list for when `/api/games` cannot load).

**Only on your machine** (nothing is committed):

```sh
python -m tools.add_game "roms/Some Game.gb" somegame "Some Game" [--hints hints/somegame.json]
```

This translates the game into `src/games/local/` and lists it in `src/games/local.js`,
both kept out of git. `python -m tools.add_game --remove somegame` takes it out again.

Then restart `npx wrangler dev`, open `http://<your-ip>:8787/` on a phone, pick the game
and share the player 2 link. The page addresses allowed to connect are in `APP_ORIGIN` in
`wrangler.jsonc`.

## 4. When a game stops ("stopped at 09:4770")

A game can jump to code the translator did not find. That stops that Game Boy and shows
the address on the phone, e.g. `stopped at 09:4770`. The server log has the same
address: `{"msg":"trap","player":1,"at":"09:4770"}`.

Addresses are written `AAAA` for bank 0 (0000-3FFF), RAM and HRAM, and `BB:AAAA` for the
switchable ROM bank (4000-7FFF) in bank `BB`.

### Reproduce it without phones

```sh
node translator/tests/run_wasm.mjs build/somegame.wasm 600
```

This runs 600 frames (10 seconds) and prints the CPU state as JSON; `trap` names the
address. Useful options:

- `--buttons=80`: hold buttons (bits: 01 right, 02 left, 04 up, 08 down, 10 A, 20 B,
  40 Select, 80 Start).
- `--link a.wasm b.wasm` (in front of the file names): two Game Boys on a link cable,
  with `--buttons2=` for the second one.
- `--shades`: also print the screen.

### Find out how the game gets there

```sh
python -m tools.inspect_rom refs "roms/Some Game.gb" 4770
python -m tools.inspect_rom dis  "roms/Some Game.gb" 09:43C0 20
```

`refs` lists every place where the address appears as a 16-bit word. `dis` disassembles
the code at a place. You will usually see one of these:

| What you see | What it is | What to do |
| --- | --- | --- |
| The word sits in a run of similar words (`70 47 dc 43 bd 47 ...`) | a table of code addresses the game jumps through | add the trap address to `entries`, or better, all addresses of the table |
| `ld hl,$4770` / `jp hl` with code in between | a jump the translator could not follow | add the address to `entries` |
| The address is in RAM (C000-DFFF) or HRAM (FF80-FFFE) | the game copied a routine there and runs it | add a `ram_code` hint (section 5) |
| Bank 0 code switches banks, then jumps into 4000-7FFF | a bank picked at runtime | add `BB:AAAA` for each bank it can be |

Then translate again with `--hints`, and run again. A game may need a few rounds. Each
fix also reveals the code behind it.

## 5. The hints file

A JSON file passed with `--hints hints/somegame.json`:

```json
{
  "entries": ["039F", "09:4770", "09:45EB"],
  "ram_code": [{ "addr": "FFB6", "rom": "2386", "len": 10 }]
}
```

- `entries`: extra places where code starts. Use `AAAA` for bank 0 and `BB:AAAA` for
  banked code (`AAAA` alone in 4000-7FFF means bank 1).
- `ram_code`: a routine the game copies into RAM and runs there. `addr` is where it runs,
  `rom` is the file offset in the `.gb` it is copied from (a hex number, as printed by
  `inspect_rom refs`), and `len` is its length in bytes. To find it, look for the code
  that copies bytes to `addr` (`ld hl,src / ld de,addr / ... ld (de),a`).

Keep hints files next to the ROMs (e.g. `hints/`) and commit them with the game.

## 6. What the translator already finds on its own

Most of what used to need hints is detected automatically, so try without hints first:

- calls, jumps and branches, in bank 0 and in the switchable banks, including bank
  switches with a constant (`ld a,5 / ld ($2000),a`);
- `jp hl` right after `ld hl,nn`;
- tables of code addresses used through `jp hl`, or through `push hl` then `ret`, with
  the table base loaded as `ld hl,table` (also through an index helper call),
  `ld de,table / add hl,de`, or `add a,low / adc a,high`; empty slots (`0000`) are skipped;
- tables placed right after a call to a routine that pops its own return address (the
  classic `rst $28` jump table, used by Tetris and Dr. Mario);
- return addresses pushed before a jump (`ld de,nn / push de`);
- interrupt handlers longer than their 8-byte slot;
- the standard OAM DMA routine games copy into HRAM.

Guesses from tables are tentative: if a guessed entry turns out not to be code, it is
dropped instead of breaking the build.

## 7. If translation itself fails

- `error: illegal opcode XX at AAAA`: the translator was led into data. If `AAAA` comes
  from one of your `entries`, remove it. Otherwise note where it was reached from
  (`inspect_rom dis` a little before it) and open an issue with the ROM name and address.
- `error: overlapping instructions at AAAA and BBBB`: two paths decode the same bytes
  differently. One of them is data being read as code. Check your `entries` first.

## 8. Multiplayer

Two Game Boys run in each match, joined by an emulated link cable. Games that use the
link cable for two players work (Tetris, Dr. Mario, Super R.C. Pro-Am). Games whose
multiplayer needs Nintendo's 4-Player Adapter (DMG-07), like F-1 Pole Position, still run,
but each player plays alone until the adapter is added.

To check a two-player game without phones:

```sh
node translator/tests/run_wasm.mjs --link build/game.wasm build/game.wasm 900 --buttons=80
```

### Wins and losses

The server can tell who won a round by reading the game's own memory, so phones never
report results. Add a `result` to the game's line in `src/games/index.js`:

```js
{ id: "tetris", title: "Tetris (2 players)", module: tetris, result: { wins: 0xffd7, theirs: 0xffd8, best: 4 } },
```

- `wins`: the RAM address where each Game Boy counts the rounds its own player won.
- `theirs`: where it counts the other player's round wins.
- `best`: the number of round wins that ends the match.

A round counts once both Game Boys agree (player 1's `wins` equals player 2's `theirs`).
The server stores it in the match's `results` table, logs
`{"msg":"result","winner":2,"wins":[0,1],"over":false}`, and sends both phones
`{"t":"result",...}`, which shows the big YOU WIN / YOU LOSE in the page.

To find the addresses for a new game, play two rounds with
`run_wasm.mjs --link` and compare RAM dumps after each: look for a byte that goes 0, 1, 2
on the winner's side and the same value at another address on the loser's side.

### Skipping the menus

A match starts when both players are online and have pressed START. With a `start` on the
game's line, the server first runs the game ahead at once through its menus, pressing
buttons on the way, so players land straight in the 2-player match:

```js
start: { frames: 380, inputs: [[280, 0x08, 0], [286, 0, 0], [300, 0x80, 0], [306, 0, 0], [360, 0x80, 0], [366, 0, 0]] },
```

Each `[frame, player 1, player 2]` sets both Game Boys' buttons from that frame on (the
same bits as `--buttons`), and `frames` is where the run stops. The game is the same every
time it boots, so the same presses always land on the same menu items. To find them, run
the two linked Game Boys with a script and look at the screens at a few frames; press each
button for about 6 frames, and stop `frames` just before the match begins.

### Sound

The runtime logs every write to the sound registers (FF10-FF3F) with its cycle. The server
sends each phone its own Game Boy's writes, and the phone plays them on its own copy of the
sound chip (`public/apu.js`). Nothing in the game needs to change for this.

## 9. Not supported yet

Game Boy Color, the MBC3 real-time clock, battery saves, and the 4-Player Adapter.

## 10. Tests

```sh
python -m unittest discover -s translator/tests -t .
```

Each test builds a small purpose-made ROM, translates it and runs it in V8. Add a test
when you teach the translator a new idiom (`translator/tests/test_discovery.py` has
examples).
