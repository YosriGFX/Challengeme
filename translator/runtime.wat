  ;; ===== Runtime library (hand-written native WASM; the game's code is in $f_XXXX) =====
  ;; Memory layout is Phase 1, section 3: GB bus at 0x0000, control block at 0x10000,
  ;; full ROM image at 0x70000.
  (import "env" "mem" (memory __PAGES__ __PAGES__ shared))

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
  ;; the earlier of the frame end and the next hardware event (V-Blank start).
  (global $DEADLINE (mut i32) (i32.const 0))
  (global $FRAME_END (mut i32) (i32.const 0))
  (global $LCD_T0 (mut i32) (i32.const 0))    ;; cycle when the LCD was switched on
  (global $DIV_T0 (mut i32) (i32.const 0))    ;; cycle when DIV was last reset
  (global $VBL_SEEN (mut i32) (i32.const 0))  ;; V-Blank starts already signalled

  (type $blk (func (result i32)))
  (table $jt 65536 funcref)

  ;; Control block (shared with JS): 0x10000 frame_seq, 0x10008 joypad bits
  ;; (bit0 Right, 1 Left, 2 Up, 3 Down, 4 A, 5 B, 6 Select, 7 Start; 1 = pressed).

  (func $lcd_on (result i32)
    (i32.and (i32.load8_u (i32.const 0xFF40)) (i32.const 0x80)))

  (func $ly (param $cyc i32) (result i32)
    (if (result i32) (call $lcd_on)
      (then (i32.rem_u (i32.div_u (i32.sub (local.get $cyc) (global.get $LCD_T0)) (i32.const 456))
                       (i32.const 154)))
      (else (i32.const 0))))

  (func $stat_mode (param $cyc i32) (result i32) (local $dot i32)
    (if (i32.eqz (call $lcd_on)) (then (return (i32.const 0))))
    (if (i32.ge_u (call $ly (local.get $cyc)) (i32.const 144)) (then (return (i32.const 1))))
    (local.set $dot (i32.rem_u (i32.sub (local.get $cyc) (global.get $LCD_T0)) (i32.const 456)))
    (if (i32.lt_u (local.get $dot) (i32.const 80)) (then (return (i32.const 2))))
    (if (i32.lt_u (local.get $dot) (i32.const 252)) (then (return (i32.const 3))))
    (i32.const 0))

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

  ;; Slow-path read for 0xE000-0xFFFF (translated code inlines the fast path below 0xE000).
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
    (if (i32.eq (local.get $addr) (i32.const 0xFF04))
      (then (return (i32.and (i32.shr_u (i32.sub (local.get $cyc) (global.get $DIV_T0)) (i32.const 8))
                             (i32.const 0xFF)))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF41))
      (then (return (i32.or (i32.or (i32.const 0x80)
                                    (i32.and (i32.load8_u (i32.const 0xFF41)) (i32.const 0x78)))
                            (i32.or (call $stat_mode (local.get $cyc))
                                    (i32.shl (i32.eq (call $ly (local.get $cyc))
                                                     (i32.load8_u (i32.const 0xFF45)))
                                             (i32.const 2)))))))
    (if (i32.eq (local.get $addr) (i32.const 0xFF44))
      (then (return (call $ly (local.get $cyc)))))
    (i32.load8_u (local.get $addr)))

  ;; Slow-path write for everything outside 0x8000-0xDFFF.
  (func $wr (param $addr i32) (param $v i32) (param $cyc i32)
    (if (i32.lt_u (i32.sub (local.get $addr) (i32.const 0x8000)) (i32.const 0x6000))
      (then (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0x8000))
      (then (return)))                                   ;; MBC control: ROM-only carts ignore it
    (if (i32.lt_u (local.get $addr) (i32.const 0xFE00))
      (then (i32.store8 (i32.sub (local.get $addr) (i32.const 0x2000)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFEA0))
      (then (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $addr) (i32.const 0xFF00))
      (then (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF04))
      (then (global.set $DIV_T0 (local.get $cyc)) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF44))
      (then (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF46))                ;; OAM DMA, done at once
      (then (memory.copy (i32.const 0xFE00) (i32.shl (local.get $v) (i32.const 8)) (i32.const 160))
            (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.eq (local.get $addr) (i32.const 0xFF40))
      (then
        (if (i32.and (i32.eqz (call $lcd_on)) (i32.ne (i32.and (local.get $v) (i32.const 0x80)) (i32.const 0)))
          (then (global.set $LCD_T0 (local.get $cyc)) (global.set $VBL_SEEN (i32.const 0))))
        (i32.store8 (local.get $addr) (local.get $v)) (return)))
    (if (i32.or (i32.eq (local.get $addr) (i32.const 0xFF0F)) (i32.eq (local.get $addr) (i32.const 0xFFFF)))
      (then (i32.store8 (local.get $addr) (local.get $v))
            (global.set $DEADLINE (local.get $cyc)) (return)))      ;; re-check interrupts soon
    (i32.store8 (local.get $addr) (local.get $v)))

  ;; Brings hardware state up to $CYC: raises V-Blank and recomputes the deadline.
  (func $hw_catch_up (local $since i32) (local $n i32) (local $next i32)
    (global.set $DEADLINE (global.get $FRAME_END))
    (if (i32.eqz (call $lcd_on)) (then (return)))
    (local.set $since (i32.sub (global.get $CYC) (global.get $LCD_T0)))
    (local.set $n (if (result i32) (i32.ge_u (local.get $since) (i32.const 65664))
      (then (i32.add (i32.div_u (i32.sub (local.get $since) (i32.const 65664)) (i32.const 70224)) (i32.const 1)))
      (else (i32.const 0))))
    (if (i32.ne (local.get $n) (global.get $VBL_SEEN))
      (then
        (global.set $VBL_SEEN (local.get $n))
        (i32.store8 (i32.const 0xFF0F) (i32.or (i32.load8_u (i32.const 0xFF0F)) (i32.const 1)))
        (drop (i32.atomic.rmw.add (i32.const 0x10000) (i32.const 1)))))
    (local.set $next (i32.add (i32.add (global.get $LCD_T0) (i32.const 65664))
                              (i32.mul (global.get $VBL_SEEN) (i32.const 70224))))
    (if (i32.lt_s (i32.sub (local.get $next) (global.get $DEADLINE)) (i32.const 0))
      (then (global.set $DEADLINE (local.get $next)))))

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
  ;; address with no translated code; $PC then holds that address.
  (func $run_frame (export "run_frame") (param $budget i32) (local $k i32)
    (if (i32.gt_u (global.get $CYC) (i32.const 0x40000000))        ;; keep cycle counts small
      (then
        (local.set $k (i32.const 0x3FF00000))
        (global.set $CYC (i32.sub (global.get $CYC) (local.get $k)))
        (global.set $LCD_T0 (i32.sub (global.get $LCD_T0) (local.get $k)))
        (global.set $DIV_T0 (i32.sub (global.get $DIV_T0) (local.get $k)))))
    (global.set $FRAME_END (i32.add (global.get $CYC) (local.get $budget)))
    (call $hw_catch_up)
    (loop $next
      (if (global.get $HALT)
        (then (if (i32.lt_s (i32.sub (global.get $CYC) (global.get $DEADLINE)) (i32.const 0))
                (then (global.set $CYC (global.get $DEADLINE)))))
        (else (global.set $PC (call_indirect $jt (type $blk) (global.get $PC)))))
      (call $hw_catch_up)
      (global.set $PC (call $irq_check (global.get $PC)))
      (br_if $next (i32.lt_s (i32.sub (global.get $CYC) (global.get $FRAME_END)) (i32.const 0)))))

  ;; Loads the ROM and sets the state the DMG boot ROM leaves behind.
  (func $reset (export "reset")
    (memory.fill (i32.const 0) (i32.const 0) (i32.const 0x10000))
    (memory.init $rom (i32.const 0) (i32.const 0) (i32.const __BANK_LEN__))
    (memory.init $rom (i32.const 0x70000) (i32.const 0) (i32.const __ROM_LEN__))
    (global.set $A (i32.const 0x01)) (global.set $B (i32.const 0x00))
    (global.set $C (i32.const 0x13)) (global.set $D (i32.const 0x00))
    (global.set $E (i32.const 0xD8)) (global.set $H (i32.const 0x01))
    (global.set $L (i32.const 0x4D)) (global.set $SP (i32.const 0xFFFE))
    (global.set $PC (i32.const 0x0100))
    (global.set $ZF (i32.const 1)) (global.set $NF (i32.const 0))
    (global.set $HF (i32.const 1)) (global.set $CF (i32.const 1))
    (global.set $IME (i32.const 0)) (global.set $HALT (i32.const 0))
    (global.set $CYC (i32.const 0)) (global.set $LCD_T0 (i32.const 0))
    (global.set $DIV_T0 (i32.const 0)) (global.set $VBL_SEEN (i32.const 0))
    (i32.store8 (i32.const 0xFF00) (i32.const 0xCF))
    (i32.store8 (i32.const 0xFF0F) (i32.const 0xE1))
    (i32.store8 (i32.const 0xFF40) (i32.const 0x91))
    (i32.store8 (i32.const 0xFF41) (i32.const 0x85))
    (i32.store8 (i32.const 0xFF47) (i32.const 0xFC)))
