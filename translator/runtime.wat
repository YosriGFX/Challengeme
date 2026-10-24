  ;; ===== Runtime library (hand-written native WASM; the game's code is in $f_*) =====
  ;; Memory layout (Phase 1, section 3):
  ;;   0x00000 GB bus            0x10000 control block (shared with JS)
  ;;   0x13000 line scratch      0x20000 framebuffers A/B (160x144 RGBA)
  ;;   0x50000 cartridge RAM banks (128 KiB)   0x70000 full ROM image
  ;; Control block: 0x10000 frame_seq, 0x10004 front_fb, 0x10008 joypad
  ;; (bit0 Right, 1 Left, 2 Up, 3 Down, 4 A, 5 B, 6 Select, 7 Start; 1 = pressed),
  ;; 0x10010 serial pending, 0x10014 serial tx, 0x10018 serial rx, 0x1001C serial rx ready,
  ;; 0x10020 ROM bank at the last trap, 0x10024 sound log length.
  ;; Sound log at 0x14000: each write to the sound registers (FF10-FF3F) as 8 bytes,
  ;; i32 cycles before the end of the current run_frame budget, u8 register (low byte of
  ;; its address), u8 value. The host drains it after each run_frame; the phones play it.
  (import "env" "mem" (memory __PAGES__ __PAGES__ shared))

  ;; Every mutable global is exported (hardware state as "s_*"), so memory plus globals
  ;; is the whole machine: the host can save and restore it between frames.

  ;; Canonical CPU state between translated functions.
  (global $A (export "A") (mut i32) (i32.const 0))
  (global $B (export "B") (mut i32) (i32.const 0))
  (global $C (export "C") (mut i32) (i32.const 0))
  (global $D (export "D") (mut i32) (i32.const 0))
  (global $E (export "E") (mut i32) (i32.const 0))
  (global $H (export "H") (mut i32) (i32.const 0))
  (global $L (export "L") (mut i32) (i32.const 0))
  (global $SP (export "SP") (mut i32) (i32.const 0))
  (global $PC (export "PC") (mut i32) (i32.const 0))
  (global $ZF (export "ZF") (mut i32) (i32.const 0))
  (global $NF (export "NF") (mut i32) (i32.const 0))
  (global $HF (export "HF") (mut i32) (i32.const 0))
  (global $CF (export "CF") (mut i32) (i32.const 0))
  (global $IME (export "IME") (mut i32) (i32.const 0))
  (global $HALT (export "HALT") (mut i32) (i32.const 0))
  (global $CYC (export "CYC") (mut i32) (i32.const 0))

  ;; Timing. Translated code yields at loop back-edges once $CYC reaches $DEADLINE,
  ;; the earliest pending hardware event (or the frame end).
  (global $DEADLINE (export "s_DEADLINE") (mut i32) (i32.const 0))
  (global $FRAME_END (export "s_FRAME_END") (mut i32) (i32.const 0))

  ;; PPU: cycle the current line started, its LY, whether it was drawn, mode for STAT.
  (global $LINE_T (export "s_LINE_T") (mut i32) (i32.const 0))
  (global $LY_CUR (export "LY") (mut i32) (i32.const 0))
  (global $RENDERED (export "s_RENDERED") (mut i32) (i32.const 0))
  (global $MODE (export "s_MODE") (mut i32) (i32.const 0))
  (global $STAT_SIG (export "s_STAT_SIG") (mut i32) (i32.const 0))
  (global $WIN_LINE (export "s_WIN_LINE") (mut i32) (i32.const 0))
  (global $WIN_USED (export "s_WIN_USED") (mut i32) (i32.const 0))

  ;; Timer: TIMA held $TIMA at cycle $TIMA_T; DIV counts from $DIV_T0.
  (global $DIV_T0 (export "s_DIV_T0") (mut i32) (i32.const 0))
  (global $TIMA (export "s_TIMA") (mut i32) (i32.const 0))
  (global $TIMA_T (export "s_TIMA_T") (mut i32) (i32.const 0))

  ;; Serial (master side of the link cable): transfer completes at $SER_DONE.
  (global $SER_DONE (export "s_SER_DONE") (mut i32) (i32.const 0))

  ;; Cartridge (MBC). $BANK is the ROM bank mapped at 0x4000-0x7FFF.
  (global $MBC i32 (i32.const __MBC__))
  (global $BANK_MASK i32 (i32.const __BANK_MASK__))
  (global $RAM_BANKS i32 (i32.const __RAM_BANKS__))
  (global $BANK (export "BANK") (mut i32) (i32.const 1))
  (global $RAM_BANK (export "s_RAM_BANK") (mut i32) (i32.const 0))
  (global $RAM_EN (export "s_RAM_EN") (mut i32) (i32.const 0))
  (global $MBC_LO (export "s_MBC_LO") (mut i32) (i32.const 1))
  (global $MBC_HI (export "s_MBC_HI") (mut i32) (i32.const 0))
  (global $MBC_MODE (export "s_MBC_MODE") (mut i32) (i32.const 0))

  (type $blk (func (result i32)))
  (table $jt __TABLE__ funcref)

  ;; Jump-table slot for a GB address: 0x4000-0x7FFF depends on the mapped ROM bank.
  (func $slot (param $pc i32) (result i32)
    (if (result i32) (i32.lt_u (i32.sub (local.get $pc) (i32.const 0x4000)) (i32.const 0x4000))
      (then (i32.add (i32.add (i32.const 0x10000) (i32.shl (global.get $BANK) (i32.const 14)))
                     (i32.and (local.get $pc) (i32.const 0x3FFF))))
      (else (local.get $pc))))

;; A jump into work RAM that holds only `jp nn`: games point an interrupt vector at such
  ;; a jump and rewrite nn as they go (F-1 Pole Position's LCD handler). It runs here, so
  ;; nn needs no translated copy of the RAM.
  (func $ram_jump (param $pc i32) (result i32)
    (if (result i32) (i32.and (i32.lt_u (i32.sub (local.get $pc) (i32.const 0xC000)) (i32.const 0x2000))
                              (i32.eq (i32.load8_u (local.get $pc)) (i32.const 0xC3)))
      (then
        (global.set $CYC (i32.add (global.get $CYC) (i32.const 16)))
        (i32.load16_u (i32.add (local.get $pc) (i32.const 1))))
      (else (local.get $pc))))

  (func $irq (param $bit i32)
    (i32.store8 (i32.const 0xFF0F) (i32.or (i32.load8_u (i32.const 0xFF0F)) (local.get $bit))))

  (func $lcd_on (result i32)
    (i32.and (i32.load8_u (i32.const 0xFF40)) (i32.const 0x80)))

  ;; ---------------------------------------------------------------- PPU timing
  (func $ly_at (param $cyc i32) (result i32)
    (if (result i32) (call $lcd_on)
      (then (i32.rem_u (i32.add (global.get $LY_CUR)
                                (i32.div_u (i32.sub (local.get $cyc) (global.get $LINE_T)) (i32.const 456)))
                       (i32.const 154)))
      (else (i32.const 0))))

  (func $mode_at (param $cyc i32) (result i32) (local $dot i32)
    (if (i32.eqz (call $lcd_on)) (then (return (i32.const 0))))
    (if (i32.ge_u (call $ly_at (local.get $cyc)) (i32.const 144)) (then (return (i32.const 1))))
    (local.set $dot (i32.rem_u (i32.sub (local.get $cyc) (global.get $LINE_T)) (i32.const 456)))
    (if (i32.lt_u (local.get $dot) (i32.const 80)) (then (return (i32.const 2))))
    (if (i32.lt_u (local.get $dot) (i32.const 252)) (then (return (i32.const 3))))
    (i32.const 0))

  ;; STAT interrupt fires on the rising edge of (LYC=LY and bit6) or (mode source enabled).
  (func $stat_eval (local $stat i32) (local $sig i32)
    (local.set $stat (i32.load8_u (i32.const 0xFF41)))
    (local.set $sig (i32.or
      (i32.and (i32.ne (i32.and (local.get $stat) (i32.const 0x40)) (i32.const 0))
               (i32.eq (global.get $LY_CUR) (i32.load8_u (i32.const 0xFF45))))
      (i32.ne (i32.and (local.get $stat)
                       (i32.shl (i32.const 8) (global.get $MODE))) (i32.const 0))))
    (if (i32.eqz (call $lcd_on)) (then (local.set $sig (i32.const 0))))
    (if (i32.and (local.get $sig) (i32.eqz (global.get $STAT_SIG))) (then (call $irq (i32.const 2))))
    (global.set $STAT_SIG (local.get $sig)))

  ;; ---------------------------------------------------------------- drawing
  (func $back_fb (result i32)
    (i32.add (i32.const 0x20000)
             (i32.mul (i32.sub (i32.const 1) (i32.atomic.load (i32.const 0x10004))) (i32.const 92160))))

  (func $shade (param $pal i32) (param $idx i32) (result i32)
    (i32.load (i32.add (i32.const 0x13100)
      (i32.shl (i32.and (i32.shr_u (local.get $pal) (i32.shl (local.get $idx) (i32.const 1))) (i32.const 3))
               (i32.const 2)))))

  (func $flip
    (i32.atomic.store (i32.const 0x10004) (i32.sub (i32.const 1) (i32.atomic.load (i32.const 0x10004))))
    (drop (i32.atomic.rmw.add (i32.const 0x10000) (i32.const 1))))

  (func $fill_back_white (local $p i32) (local $end i32)
    (local.set $p (call $back_fb))
    (local.set $end (i32.add (local.get $p) (i32.const 92160)))
    (loop $l
      (i32.store (local.get $p) (i32.load (i32.const 0x13100)))
      (local.set $p (i32.add (local.get $p) (i32.const 4)))
      (br_if $l (i32.lt_u (local.get $p) (local.get $end)))))

  ;; Draws one scanline (background, window, sprites) into the back framebuffer.
  ;; Scratch 0x13000-0x1309F keeps each pixel's BG color index for sprite priority.
  (func $render_line (param $ly i32)
    (local $lcdc i32) (local $row i32) (local $x i32) (local $mx i32) (local $my i32)
    (local $map i32) (local $tile i32) (local $addr i32) (local $bit i32) (local $idx i32)
    (local $wx i32) (local $win i32) (local $bgp i32)
    (local $n i32) (local $i i32) (local $o i32) (local $sy i32) (local $h i32)
    (local $line i32) (local $attr i32) (local $sx i32) (local $px i32) (local $key i32) (local $j i32)
    (local.set $lcdc (i32.load8_u (i32.const 0xFF40)))
    (local.set $bgp (i32.load8_u (i32.const 0xFF47)))
    (local.set $row (i32.add (call $back_fb) (i32.mul (local.get $ly) (i32.const 640))))
    (local.set $wx (i32.sub (i32.load8_u (i32.const 0xFF4B)) (i32.const 7)))
    (local.set $win (i32.and (i32.eq (i32.and (local.get $lcdc) (i32.const 0x21)) (i32.const 0x21))
                             (i32.and (i32.ge_u (local.get $ly) (i32.load8_u (i32.const 0xFF4A)))
                                      (i32.lt_s (local.get $wx) (i32.const 160)))))
    (global.set $WIN_USED (i32.const 0))
    (local.set $x (i32.const 0))
    (loop $pix
      (local.set $idx (i32.const 0))
      (if (i32.and (local.get $lcdc) (i32.const 1))
        (then
          (if (i32.and (local.get $win) (i32.ge_s (local.get $x) (local.get $wx)))
            (then
              (global.set $WIN_USED (i32.const 1))
              (local.set $mx (i32.sub (local.get $x) (local.get $wx)))
              (local.set $my (global.get $WIN_LINE))
              (local.set $map (select (i32.const 0x9C00) (i32.const 0x9800) (i32.and (local.get $lcdc) (i32.const 0x40)))))
            (else
              (local.set $mx (i32.and (i32.add (local.get $x) (i32.load8_u (i32.const 0xFF43))) (i32.const 0xFF)))
              (local.set $my (i32.and (i32.add (local.get $ly) (i32.load8_u (i32.const 0xFF42))) (i32.const 0xFF)))
              (local.set $map (select (i32.const 0x9C00) (i32.const 0x9800) (i32.and (local.get $lcdc) (i32.const 0x08))))))
          (local.set $tile (i32.load8_u (i32.add (local.get $map)
            (i32.add (i32.shl (i32.shr_u (local.get $my) (i32.const 3)) (i32.const 5))
                     (i32.shr_u (local.get $mx) (i32.const 3))))))
          (local.set $addr (if (result i32) (i32.and (local.get $lcdc) (i32.const 0x10))
            (then (i32.add (i32.const 0x8000) (i32.shl (local.get $tile) (i32.const 4))))
            (else (i32.add (i32.const 0x9000)
                           (i32.shl (i32.sub (i32.xor (local.get $tile) (i32.const 0x80)) (i32.const 0x80)) (i32.const 4))))))
          (local.set $addr (i32.add (local.get $addr) (i32.shl (i32.and (local.get $my) (i32.const 7)) (i32.const 1))))
          (local.set $bit (i32.sub (i32.const 7) (i32.and (local.get $mx) (i32.const 7))))
          (local.set $idx (i32.or
            (i32.and (i32.shr_u (i32.load8_u (local.get $addr)) (local.get $bit)) (i32.const 1))
            (i32.shl (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $addr) (i32.const 1))) (local.get $bit))
                              (i32.const 1)) (i32.const 1))))))
      (i32.store8 (i32.add (i32.const 0x13000) (local.get $x)) (local.get $idx))
      (i32.store (i32.add (local.get $row) (i32.shl (local.get $x) (i32.const 2)))
                 (call $shade (local.get $bgp) (local.get $idx)))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br_if $pix (i32.lt_u (local.get $x) (i32.const 160))))
    (if (global.get $WIN_USED) (then (global.set $WIN_LINE (i32.add (global.get $WIN_LINE) (i32.const 1)))))

    ;; Sprites: pick the first 10 on this line (OAM order), keyed by (X << 6 | index).
    (if (i32.eqz (i32.and (local.get $lcdc) (i32.const 2))) (then (return)))
    (local.set $h (select (i32.const 16) (i32.const 8) (i32.and (local.get $lcdc) (i32.const 4))))
    (local.set $n (i32.const 0))
    (local.set $i (i32.const 0))
    (loop $scan
      (local.set $o (i32.add (i32.const 0xFE00) (i32.shl (local.get $i) (i32.const 2))))
      (local.set $sy (i32.sub (local.get $ly) (i32.sub (i32.load8_u (local.get $o)) (i32.const 16))))
      (if (i32.lt_u (local.get $sy) (local.get $h))
        (then
          (i32.store16 (i32.add (i32.const 0x13200) (i32.shl (local.get $n) (i32.const 1)))
                       (i32.or (i32.shl (i32.load8_u (i32.add (local.get $o) (i32.const 1))) (i32.const 6))
                               (local.get $i)))
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $scan (i32.and (i32.lt_u (local.get $i) (i32.const 40)) (i32.lt_u (local.get $n) (i32.const 10)))))
    ;; Insertion sort, highest key first, so the highest-priority sprite is drawn last.
    (local.set $i (i32.const 1))
    (block $sorted (loop $outer
      (br_if $sorted (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $key (i32.load16_u (i32.add (i32.const 0x13200) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $j (local.get $i))
      (block $placed (loop $inner
        (br_if $placed (i32.eqz (local.get $j)))
        (br_if $placed (i32.ge_u (i32.load16_u (i32.add (i32.const 0x131FE) (i32.shl (local.get $j) (i32.const 1))))
                                 (local.get $key)))
        (i32.store16 (i32.add (i32.const 0x13200) (i32.shl (local.get $j) (i32.const 1)))
                     (i32.load16_u (i32.add (i32.const 0x131FE) (i32.shl (local.get $j) (i32.const 1)))))
        (local.set $j (i32.sub (local.get $j) (i32.const 1)))
        (br $inner)))
      (i32.store16 (i32.add (i32.const 0x13200) (i32.shl (local.get $j) (i32.const 1))) (local.get $key))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $outer)))
    (local.set $i (i32.const 0))
    (block $done (loop $draw
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $o (i32.add (i32.const 0xFE00)
        (i32.shl (i32.and (i32.load16_u (i32.add (i32.const 0x13200) (i32.shl (local.get $i) (i32.const 1))))
                          (i32.const 0x3F)) (i32.const 2))))
      (local.set $attr (i32.load8_u (i32.add (local.get $o) (i32.const 3))))
      (local.set $line (i32.sub (local.get $ly) (i32.sub (i32.load8_u (local.get $o)) (i32.const 16))))
      (if (i32.and (local.get $attr) (i32.const 0x40))
        (then (local.set $line (i32.sub (i32.sub (local.get $h) (i32.const 1)) (local.get $line)))))
      (local.set $tile (i32.load8_u (i32.add (local.get $o) (i32.const 2))))
      (if (i32.eq (local.get $h) (i32.const 16)) (then (local.set $tile (i32.and (local.get $tile) (i32.const 0xFE)))))
      (local.set $addr (i32.add (i32.add (i32.const 0x8000) (i32.shl (local.get $tile) (i32.const 4)))
                                (i32.shl (local.get $line) (i32.const 1))))
      (local.set $px (i32.const 0))
      (loop $spx
        (local.set $sx (i32.add (i32.sub (i32.load8_u (i32.add (local.get $o) (i32.const 1))) (i32.const 8))
                                (local.get $px)))
        (local.set $bit (select (local.get $px) (i32.sub (i32.const 7) (local.get $px))
                                (i32.and (local.get $attr) (i32.const 0x20))))
        (local.set $idx (i32.or
          (i32.and (i32.shr_u (i32.load8_u (local.get $addr)) (local.get $bit)) (i32.const 1))
          (i32.shl (i32.and (i32.shr_u (i32.load8_u (i32.add (local.get $addr) (i32.const 1))) (local.get $bit))
                            (i32.const 1)) (i32.const 1))))
        (if (i32.and (i32.lt_u (local.get $sx) (i32.const 160)) (i32.ne (local.get $idx) (i32.const 0)))
          (then
            (if (i32.or (i32.eqz (i32.and (local.get $attr) (i32.const 0x80)))
                        (i32.eqz (i32.load8_u (i32.add (i32.const 0x13000) (local.get $sx)))))
              (then
                (i32.store (i32.add (local.get $row) (i32.shl (local.get $sx) (i32.const 2)))
                  (call $shade (i32.load8_u (select (i32.const 0xFF49) (i32.const 0xFF48)
                                                    (i32.and (local.get $attr) (i32.const 0x10))))
                               (local.get $idx)))))))
        (local.set $px (i32.add (local.get $px) (i32.const 1)))
        (br_if $spx (i32.lt_u (local.get $px) (i32.const 8))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $draw))))

  ;; ---------------------------------------------------------------- timer
  (func $tima_period (result i32)
    (i32.load8_u (i32.add (i32.const 0x13110) (i32.and (i32.load8_u (i32.const 0xFF07)) (i32.const 3)))))
  ;; (periods 1024/16/64/256 are stored as shifts 10/4/6/8 at 0x13110)

  (func $tima_at (param $cyc i32) (result i32) (local $s i32) (local $v i32) (local $tma i32)
    (if (i32.eqz (i32.and (i32.load8_u (i32.const 0xFF07)) (i32.const 4))) (then (return (global.get $TIMA))))
    (local.set $s (call $tima_period))
    (local.set $v (i32.add (global.get $TIMA)
      (i32.sub (i32.shr_u (i32.sub (local.get $cyc) (global.get $DIV_T0)) (local.get $s))
               (i32.shr_u (i32.sub (global.get $TIMA_T) (global.get $DIV_T0)) (local.get $s)))))
    (if (i32.gt_u (local.get $v) (i32.const 255))
      (then
        (local.set $tma (i32.load8_u (i32.const 0xFF06)))
        (local.set $v (i32.add (local.get $tma)
          (i32.rem_u (i32.sub (local.get $v) (i32.const 256)) (i32.sub (i32.const 256) (local.get $tma)))))))
    (local.get $v))

  (func $tima_sync (param $cyc i32) (local $v i32)
    (local.set $v (call $tima_at (local.get $cyc)))
    (if (i32.and (i32.ne (i32.and (i32.load8_u (i32.const 0xFF07)) (i32.const 4)) (i32.const 0))
                 (i32.lt_u (local.get $v) (global.get $TIMA)))
      (then (call $irq (i32.const 4))))
    (global.set $TIMA (local.get $v))
    (global.set $TIMA_T (local.get $cyc)))

  (func $tima_overflow_at (result i32) (local $s i32) (local $first i32)
    (local.set $s (call $tima_period))
    (local.set $first (i32.add (global.get $DIV_T0)
      (i32.shl (i32.add (i32.shr_u (i32.sub (global.get $TIMA_T) (global.get $DIV_T0)) (local.get $s)) (i32.const 1))
               (local.get $s))))
    (i32.add (local.get $first) (i32.shl (i32.sub (i32.const 255) (global.get $TIMA)) (local.get $s))))

  ;; ---------------------------------------------------------------- events
  ;; Earliest pending event at or before `limit`; sets $EV to its kind (0 none, 1 PPU, 2 timer, 3 serial).
  (global $EV (export "s_EV") (mut i32) (i32.const 0))
  (func $next_event (result i32) (local $best i32) (local $t i32)
    (local.set $best (global.get $FRAME_END))
    (global.set $EV (i32.const 0))
    (if (call $lcd_on)
      (then
        (local.set $t (i32.add (global.get $LINE_T)
          (select (i32.const 252) (i32.const 456)
                  (i32.and (i32.eqz (global.get $RENDERED)) (i32.lt_u (global.get $LY_CUR) (i32.const 144))))))
        (if (i32.lt_s (i32.sub (local.get $t) (local.get $best)) (i32.const 0))
          (then (local.set $best (local.get $t)) (global.set $EV (i32.const 1))))))
    (if (i32.and (i32.load8_u (i32.const 0xFF07)) (i32.const 4))
      (then
        (local.set $t (call $tima_overflow_at))
        (if (i32.lt_s (i32.sub (local.get $t) (local.get $best)) (i32.const 0))
          (then (local.set $best (local.get $t)) (global.set $EV (i32.const 2))))))
    (if (i32.atomic.load (i32.const 0x10010))
      (then
        (if (i32.lt_s (i32.sub (global.get $SER_DONE) (local.get $best)) (i32.const 0))
          (then (local.set $best (global.get $SER_DONE)) (global.set $EV (i32.const 3))))))
    (local.get $best))

  (func $do_event (param $t i32)
    (if (i32.eq (global.get $EV) (i32.const 1))
      (then
        (if (i32.and (i32.eqz (global.get $RENDERED)) (i32.lt_u (global.get $LY_CUR) (i32.const 144)))
          (then                                                       ;; end of mode 3: draw, enter HBlank
            (call $render_line (global.get $LY_CUR))
            (global.set $RENDERED (i32.const 1))
            (global.set $MODE (i32.const 0))
            (call $stat_eval)
            (return)))
        ;; next line
        (global.set $LINE_T (i32.add (global.get $LINE_T) (i32.const 456)))
        (global.set $RENDERED (i32.const 0))
        (global.set $LY_CUR (i32.rem_u (i32.add (global.get $LY_CUR) (i32.const 1)) (i32.const 154)))
        (i32.store8 (i32.const 0xFF44) (global.get $LY_CUR))
        (if (i32.eq (global.get $LY_CUR) (i32.const 144))
          (then (call $irq (i32.const 1)) (call $flip)))
        (if (i32.eqz (global.get $LY_CUR)) (then (global.set $WIN_LINE (i32.const 0))))
        (global.set $MODE (select (i32.const 1) (i32.const 2) (i32.ge_u (global.get $LY_CUR) (i32.const 144))))
        (call $stat_eval)
        (return)))
    (if (i32.eq (global.get $EV) (i32.const 2))
      (then
        (global.set $TIMA (i32.load8_u (i32.const 0xFF06)))
        (global.set $TIMA_T (local.get $t))
        (call $irq (i32.const 4))
        (return)))
    (if (i32.eq (global.get $EV) (i32.const 3))
      (then
        (i32.store8 (i32.const 0xFF01)
          (select (i32.atomic.load (i32.const 0x10018)) (i32.const 0xFF) (i32.atomic.load (i32.const 0x1001C))))
        (i32.store8 (i32.const 0xFF02) (i32.and (i32.load8_u (i32.const 0xFF02)) (i32.const 0x7F)))
        (i32.atomic.store (i32.const 0x10010) (i32.const 0))
        (call $irq (i32.const 8)))))

  ;; Processes every event up to $CYC, then sets $DEADLINE to the next one.
  (func $hw_catch_up (local $t i32)
    (loop $again
      (local.set $t (call $next_event))
      (if (i32.and (i32.ne (global.get $EV) (i32.const 0))
                   (i32.le_s (i32.sub (local.get $t) (global.get $CYC)) (i32.const 0)))
        (then (call $do_event (local.get $t)) (br $again))))
    (global.set $DEADLINE (local.get $t)))

  ;; ---------------------------------------------------------------- memory slow paths
  (func $joypad (result i32) (local $sel i32) (local $joy i32) (local $nib i32)
    (local.set $sel (i32.and (i32.load8_u (i32.const 0xFF00)) (i32.const 0x30)))
    (local.set $joy (i32.atomic.load (i32.const 0x10008)))
    (local.set $nib (i32.const 0xF))
    (if (i32.eqz (i32.and (local.get $sel) (i32.const 0x10)))
      (then (local.set $nib (i32.and (local.get $nib)
              (i32.xor (i32.and (local.get $joy) (i32.const 0xF)) (i32.const 0xF))))))
    (if (i32.eqz (i32.and (local.get $sel) (i32.const 0x20)))
      (then (local.set $nib (i32.and (local.get $nib)
              (i32.xor (i32.and (i32.shr_u (local.get $joy) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))))))
    (i32.or (i32.or (i32.const 0xC0) (local.get $sel)) (local.get $nib)))

  ;; Read for 0xE000-0xFFFF (translated code inlines the fast path below 0xE000).
  (func $rd (param $addr i32) (param $cyc i32) (result i32)
    (if (i32.lt_u (local.get $addr) (i32.const 0xE000))
      (then (return (i32.load8_u (local.get $addr)))))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFE00))
      (then (return (i32.load8_u (i32.sub (local.get $addr) (i32.const 0x2000))))))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFEA0))
      (then (return (i32.load8_u (local.get $addr)))))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFF00))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF00)) (then (return (call $joypad))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF02))
      (then (return (i32.or (i32.load8_u (i32.const 0xFF02)) (i32.const 0x7E)))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF04))
      (then (return (i32.and (i32.shr_u (i32.sub (local.get $cyc) (global.get $DIV_T0)) (i32.const 8))
                             (i32.const 0xFF)))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF05))
      (then (return (call $tima_at (local.get $cyc)))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF0F))
      (then (return (i32.or (i32.load8_u (i32.const 0xFF0F)) (i32.const 0xE0)))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF41))
      (then (return (i32.or (i32.or (i32.const 0x80)
                                    (i32.and (i32.load8_u (i32.const 0xFF41)) (i32.const 0x78)))
                            (i32.or (call $mode_at (local.get $cyc))
                                    (i32.shl (i32.eq (call $ly_at (local.get $cyc))
                                                     (i32.load8_u (i32.const 0xFF45)))
                                             (i32.const 2)))))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF44))
      (then (return (call $ly_at (local.get $cyc)))))
    (i32.load8_u (local.get $addr)))

  (func $set_rom_bank (param $b i32)
    (local.set $b (i32.and (local.get $b) (global.get $BANK_MASK)))
    (if (i32.ne (local.get $b) (global.get $BANK))
      (then
        (global.set $BANK (local.get $b))
        (memory.copy (i32.const 0x4000)
                     (i32.add (i32.const 0x70000) (i32.shl (local.get $b) (i32.const 14)))
                     (i32.const 0x4000)))))

  (func $set_ram_bank (param $b i32)
    (if (i32.eqz (global.get $RAM_BANKS)) (then (return)))
    (local.set $b (i32.rem_u (local.get $b) (global.get $RAM_BANKS)))
    (if (i32.ne (local.get $b) (global.get $RAM_BANK))
      (then
        (memory.copy (i32.add (i32.const 0x50000) (i32.shl (global.get $RAM_BANK) (i32.const 13)))
                     (i32.const 0xA000) (i32.const 0x2000))
        (memory.copy (i32.const 0xA000)
                     (i32.add (i32.const 0x50000) (i32.shl (local.get $b) (i32.const 13)))
                     (i32.const 0x2000))
        (global.set $RAM_BANK (local.get $b)))))

  ;; Writes to 0x0000-0x7FFF program the cartridge's MBC.
  (func $mbc_write (param $addr i32) (param $v i32)
    (if (i32.eqz (global.get $MBC)) (then (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0x2000))
      (then (global.set $RAM_EN (i32.eq (i32.and (local.get $v) (i32.const 0xF)) (i32.const 0xA))) (return)))
    (if (i32.eq (global.get $MBC) (i32.const 5))
      (then
        (if (i32.lt_u (local.get $addr) (i32.const 0x3000))
          (then (global.set $MBC_LO (local.get $v))
                (call $set_rom_bank (i32.or (i32.shl (global.get $MBC_HI) (i32.const 8)) (global.get $MBC_LO)))
                (return)))
        (if (i32.lt_u (local.get $addr) (i32.const 0x4000))
          (then (global.set $MBC_HI (i32.and (local.get $v) (i32.const 1)))
                (call $set_rom_bank (i32.or (i32.shl (global.get $MBC_HI) (i32.const 8)) (global.get $MBC_LO)))
                (return)))
        (if (i32.lt_u (local.get $addr) (i32.const 0x6000))
          (then (call $set_ram_bank (i32.and (local.get $v) (i32.const 0xF)))))
        (return)))
    (if (i32.eq (global.get $MBC) (i32.const 3))
      (then
        (if (i32.lt_u (local.get $addr) (i32.const 0x4000))
          (then (local.set $v (i32.and (local.get $v) (i32.const 0x7F)))
                (call $set_rom_bank (select (local.get $v) (i32.const 1) (local.get $v)))
                (return)))
        (if (i32.and (i32.lt_u (local.get $addr) (i32.const 0x6000)) (i32.lt_u (local.get $v) (i32.const 4)))
          (then (call $set_ram_bank (local.get $v))))                  ;; RTC registers 08-0C not emulated
        (return)))
    ;; MBC1
    (if (i32.lt_u (local.get $addr) (i32.const 0x4000))
      (then (local.set $v (i32.and (local.get $v) (i32.const 0x1F)))
            (global.set $MBC_LO (select (local.get $v) (i32.const 1) (local.get $v))))
      (else (if (i32.lt_u (local.get $addr) (i32.const 0x6000))
              (then (global.set $MBC_HI (i32.and (local.get $v) (i32.const 3))))
              (else (global.set $MBC_MODE (i32.and (local.get $v) (i32.const 1)))))))
    (call $set_rom_bank (i32.or (i32.shl (global.get $MBC_HI) (i32.const 5)) (global.get $MBC_LO)))
    (call $set_ram_bank (select (global.get $MBC_HI) (i32.const 0) (global.get $MBC_MODE))))

  ;; Records a sound register write for the host; a full log drops the rest.
  (func $snd_log (param $addr i32) (param $v i32) (param $cyc i32) (local $n i32) (local $p i32)
    (local.set $n (i32.load (i32.const 0x10024)))
    (if (i32.ge_u (local.get $n) (i32.const 2048)) (then (return)))
    (local.set $p (i32.add (i32.const 0x14000) (i32.shl (local.get $n) (i32.const 3))))
    (i32.store (local.get $p) (i32.sub (global.get $FRAME_END) (local.get $cyc)))
    (i32.store8 offset=4 (local.get $p) (local.get $addr))
    (i32.store8 offset=5 (local.get $p) (local.get $v))
    (i32.store (i32.const 0x10024) (i32.add (local.get $n) (i32.const 1))))

  ;; Write for everything outside 0x8000-0xDFFF.
  (func $wr (param $addr i32) (param $v i32) (param $cyc i32) (local $old i32)
    (if (i32.lt_u (i32.sub (local.get $addr) (i32.const 0x8000)) (i32.const 0x6000))
      (then (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0x8000))
      (then (call $mbc_write (local.get $addr) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFE00))
      (then (i32.store8 (i32.sub (local.get $addr) (i32.const 0x2000)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFEA0))
      (then (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFF00))
      (then (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF02))                ;; serial control
      (then
        (i32.store8 (local.get $addr) (local.get $v))
        (if (i32.eq (i32.and (local.get $v) (i32.const 0x81)) (i32.const 0x81))
          (then                                                        ;; master: start a transfer
            (i32.atomic.store (i32.const 0x10014) (i32.load8_u (i32.const 0xFF01)))
            (i32.atomic.store (i32.const 0x1001C) (i32.const 0))
            (global.set $SER_DONE (i32.add (local.get $cyc) (i32.const 4096)))
            (i32.atomic.store (i32.const 0x10010) (i32.const 1))
            (global.set $DEADLINE (local.get $cyc))))
        (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF04))
      (then (call $tima_sync (local.get $cyc))
            (global.set $DIV_T0 (local.get $cyc)) (global.set $TIMA_T (local.get $cyc))
            (global.set $DEADLINE (local.get $cyc)) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF05))
      (then (call $tima_sync (local.get $cyc)) (global.set $TIMA (local.get $v))
            (global.set $DEADLINE (local.get $cyc)) (return)))
    (if (i32.or (i32.eq (local.get $addr) (i32.const 0xFF06)) (i32.eq (local.get $addr) (i32.const 0xFF07)))
      (then (call $tima_sync (local.get $cyc)) (i32.store8 (local.get $addr) (local.get $v))
            (global.set $DEADLINE (local.get $cyc)) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF44))
      (then (return)))
    (if (i32.lt_u (i32.sub (local.get $addr) (i32.const 0xFF10)) (i32.const 0x30))   ;; sound
      (then
        (if (i32.and (i32.eq (local.get $addr) (i32.const 0xFF26))
                     (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
          (then (memory.fill (i32.const 0xFF10) (i32.const 0) (i32.const 0x16))))   ;; power off clears
        (i32.store8 (local.get $addr) (local.get $v))
        (call $snd_log (local.get $addr) (local.get $v) (local.get $cyc))
        (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF46))                ;; OAM DMA, done at once
      (then (memory.copy (i32.const 0xFE00) (i32.shl (local.get $v) (i32.const 8)) (i32.const 160))
            (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF40))
      (then
        (local.set $old (call $lcd_on))
        (i32.store8 (local.get $addr) (local.get $v))
        (if (i32.and (i32.eqz (local.get $old)) (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))
          (then                                                        ;; LCD on: line 0 starts now
            (global.set $LINE_T (local.get $cyc)) (global.set $LY_CUR (i32.const 0))
            (global.set $RENDERED (i32.const 0)) (global.set $MODE (i32.const 2))
            (global.set $WIN_LINE (i32.const 0))
            (i32.store8 (i32.const 0xFF44) (i32.const 0))
            (call $stat_eval)))
        (if (i32.and (i32.ne (local.get $old) (i32.const 0)) (i32.eqz (i32.and (local.get $v) (i32.const 0x80))))
          (then                                                        ;; LCD off: blank screen
            (global.set $LY_CUR (i32.const 0)) (global.set $MODE (i32.const 0))
            (i32.store8 (i32.const 0xFF44) (i32.const 0))
            (call $fill_back_white) (call $flip)))
        (global.set $DEADLINE (local.get $cyc))
        (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF41))
      (then (i32.store8 (local.get $addr) (i32.and (local.get $v) (i32.const 0x78)))
            (call $stat_eval) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF45))
      (then (i32.store8 (local.get $addr) (local.get $v)) (call $stat_eval) (return)))
    (if (i32.or (i32.eq (local.get $addr) (i32.const 0xFF0F)) (i32.eq (local.get $addr) (i32.const 0xFFFF)))
      (then (i32.store8 (local.get $addr) (local.get $v))
            (global.set $DEADLINE (local.get $cyc)) (return)))      ;; re-check interrupts soon
    (i32.store8 (local.get $addr) (local.get $v)))

  ;; ---------------------------------------------------------------- interrupts and the frame loop
  (func $push_pc (param $pc i32)
    (global.set $SP (i32.and (i32.sub (global.get $SP) (i32.const 1)) (i32.const 0xFFFF)))
    (call $wr (global.get $SP) (i32.shr_u (local.get $pc) (i32.const 8)) (global.get $CYC))
    (global.set $SP (i32.and (i32.sub (global.get $SP) (i32.const 1)) (i32.const 0xFFFF)))
    (call $wr (global.get $SP) (i32.and (local.get $pc) (i32.const 0xFF)) (global.get $CYC)))

  ;; Services the highest-priority pending interrupt, if enabled. Returns the PC to run next.
  (func $irq_check (param $pc i32) (result i32) (local $pending i32) (local $bit i32)
    (local.set $pending (i32.and (i32.and (i32.load8_u (i32.const 0xFFFF))
                                          (i32.load8_u (i32.const 0xFF0F))) (i32.const 0x1F)))
    (if (i32.eqz (local.get $pending)) (then (return (local.get $pc))))
    (global.set $HALT (i32.const 0))
    (if (i32.eqz (global.get $IME)) (then (return (local.get $pc))))
    (local.set $bit (i32.ctz (local.get $pending)))
    (i32.store8 (i32.const 0xFF0F) (i32.and (i32.load8_u (i32.const 0xFF0F))
                                            (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const 0xFF))))
    (global.set $IME (i32.const 0))
    (call $push_pc (local.get $pc))
    (global.set $CYC (i32.add (global.get $CYC) (i32.const 20)))
    (i32.add (i32.const 0x40) (i32.shl (local.get $bit) (i32.const 3))))

  ;; Runs translated code for `budget` cycles (70224 = one frame). Traps on a jump to an
  ;; address with no translated code; $PC and $BANK then name it.
  (func $run_frame (export "run_frame") (param $budget i32) (local $k i32)
    (if (i32.gt_u (global.get $CYC) (i32.const 0x40000000))        ;; keep cycle counts small
      (then
        (local.set $k (i32.const 0x3FF00000))
        (global.set $CYC (i32.sub (global.get $CYC) (local.get $k)))
        (global.set $LINE_T (i32.sub (global.get $LINE_T) (local.get $k)))
        (global.set $DIV_T0 (i32.sub (global.get $DIV_T0) (local.get $k)))
        (global.set $TIMA_T (i32.sub (global.get $TIMA_T) (local.get $k)))
        (global.set $SER_DONE (i32.sub (global.get $SER_DONE) (local.get $k)))
        (global.set $FRAME_END (i32.sub (global.get $FRAME_END) (local.get $k)))))
    ;; Budgets add up from the previous end, so overshoot past one end is paid back.
    (global.set $FRAME_END (i32.add (global.get $FRAME_END) (local.get $budget)))
    (call $hw_catch_up)
    (loop $next
      (if (global.get $HALT)
        (then (if (i32.lt_s (i32.sub (global.get $CYC) (global.get $DEADLINE)) (i32.const 0))
                (then (global.set $CYC (global.get $DEADLINE)))))
        (else
          (i32.atomic.store (i32.const 0x10020) (global.get $BANK))
          (global.set $PC (call_indirect $jt (type $blk) (call $slot (call $ram_jump (global.get $PC)))))))
      (call $hw_catch_up)
      (global.set $PC (call $irq_check (global.get $PC)))
      (br_if $next (i32.lt_s (i32.sub (global.get $CYC) (global.get $FRAME_END)) (i32.const 0)))))

  ;; Loads the ROM and sets the state the DMG boot ROM leaves behind.
  (func $reset (export "reset")
    (memory.fill (i32.const 0) (i32.const 0) (i32.const 0x20000))
    (memory.init $rom (i32.const 0) (i32.const 0) (i32.const __BANK_LEN__))
    (memory.init $rom (i32.const 0x70000) (i32.const 0) (i32.const __ROM_LEN__))
    (memory.fill (i32.const 0x50000) (i32.const 0) (i32.const 0x20000))
    ;; DMG shades (RGBA, little-endian) and timer period shifts
    (i32.store (i32.const 0x13100) (i32.const 0xFFD0F8E0))
    (i32.store (i32.const 0x13104) (i32.const 0xFF70C088))
    (i32.store (i32.const 0x13108) (i32.const 0xFF566834))
    (i32.store (i32.const 0x1310C) (i32.const 0xFF201808))
    (i32.store (i32.const 0x13110) (i32.const 0x0806040A))
    (global.set $A (i32.const 0x01)) (global.set $B (i32.const 0x00))
    (global.set $C (i32.const 0x13)) (global.set $D (i32.const 0x00))
    (global.set $E (i32.const 0xD8)) (global.set $H (i32.const 0x01))
    (global.set $L (i32.const 0x4D)) (global.set $SP (i32.const 0xFFFE))
    (global.set $PC (i32.const 0x0100))
    (global.set $ZF (i32.const 1)) (global.set $NF (i32.const 0))
    (global.set $HF (i32.const 1)) (global.set $CF (i32.const 1))
    (global.set $IME (i32.const 0)) (global.set $HALT (i32.const 0))
    (global.set $CYC (i32.const 0)) (global.set $FRAME_END (i32.const 0)) (global.set $DIV_T0 (i32.const 0))
    (global.set $TIMA (i32.const 0)) (global.set $TIMA_T (i32.const 0))
    (global.set $LINE_T (i32.const 0)) (global.set $LY_CUR (i32.const 0))
    (global.set $RENDERED (i32.const 0)) (global.set $MODE (i32.const 2))
    (global.set $STAT_SIG (i32.const 0)) (global.set $WIN_LINE (i32.const 0))
    (global.set $BANK (i32.const 1)) (global.set $RAM_BANK (i32.const 0)) (global.set $RAM_EN (i32.const 0))
    (global.set $MBC_LO (i32.const 1)) (global.set $MBC_HI (i32.const 0)) (global.set $MBC_MODE (i32.const 0))
    (i32.atomic.store (i32.const 0x10000) (i32.const 0))
    (i32.atomic.store (i32.const 0x10004) (i32.const 0))
    (i32.atomic.store (i32.const 0x10010) (i32.const 0))
    (i32.store8 (i32.const 0xFF00) (i32.const 0xCF))
    (i32.store8 (i32.const 0xFF0F) (i32.const 0xE1))
    (i32.store8 (i32.const 0xFF40) (i32.const 0x91))
    (i32.store8 (i32.const 0xFF41) (i32.const 0x00))
    (i32.store8 (i32.const 0xFF47) (i32.const 0xFC))
    (i32.store8 (i32.const 0xFF48) (i32.const 0xFF))
    (i32.store8 (i32.const 0xFF49) (i32.const 0xFF))
    (call $fill_back_white) (call $flip) (call $fill_back_white))
