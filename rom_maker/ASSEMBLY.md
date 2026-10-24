# Writing a game in Game Boy assembly

No C, no compiler: a game is a few `.asm` text files that the RGBDS assembler turns into
a `.gb` ROM, byte for byte what you wrote. That is also what the translator handles best.
[template/](template/) is a complete two-player game (Coin Duel) written this way; read
it next to this page. [HARDWARE.md](HARDWARE.md) has the engine's rules.

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
| `game.json` | title, where the win counters are, the server's `start` script |

`python3 tools/build.py <folder>` builds `<folder>/build/game.gb`, `game.sym` (every label
and its address), `game.map`, `game.wasm`, and screenshots.

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

## 8. Two players: link and lockstep

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

## 9. Wins, losses and the server

Keep, on each Game Boy, "rounds my player won" and "rounds the other player won" at
fixed addresses (template: `$C000` and `$C001`), both counting up by one per round, and
0 at the start. The server reads them on both Game Boys; once they agree it shows YOU WIN /
YOU LOSE on the phones and records it. `game.json`:

```json
{
  "title": "Coin Duel",
  "result": { "wins": 49152, "theirs": 49153, "best": 5 },
  "start": { "frames": 30, "inputs": [[10, 128, 0], [16, 0, 0]] }
}
```

`wins`/`theirs` are the addresses in decimal ($C000 = 49152), `best` the round wins that
end the match. `start` is run on the server before the players see anything: from frame
10 Game Boy 1 holds START (128), from 16 nothing. After the match the server goes back
to its lobby and starts fresh Game Boys for a rematch, so the ROM needs no rematch menu.

## 10. Bigger games

- More than 32 KiB: use MBC5 (`rgbfix -m 0x19`, `SECTION "Level", ROMX, BANK[2]`).
  Switch with a constant right before the call: `ld a, BANK(Fn) / ld [$2000], a /
  call Fn`, from bank 0 code.
- State machines: instead of storing addresses in RAM, store a state number and branch:
  `ld a, [wState] / cp 0 / jp z, Title / cp 1 / jp z, Play ...`.
- Sound: channel 1 is in the template (`Beep`). Channels: 1 square with sweep
  ($FF10-14), 2 square ($FF16-19), 3 wave ($FF1A-1E, samples at $FF30-3F), 4 noise
  ($FF20-23). Turn sound on with `rNR52 = $80`, `rNR50 = $77`, `rNR51 = $FF`.

## 11. When the build says STOPPED

`GB1 STOPPED: no translated code at 0123` means the game jumped somewhere the translator
did not see as code. Look the address up in `build/game.sym`, then see
[HARDWARE.md](HARDWARE.md) section 4: usually an address computed or kept in RAM. Rewrite
that spot as plain `call`/`jp` or a `jp z` chain.
