"""WAT emitter: one WASM function per entry point, one template per SM83 instruction.

Inside a function, blocks are laid out by address and selected with a local
br_table (label switch). That is ordinary WASM control flow: nothing reads an
opcode at runtime. Only exits (call, ret, jp hl, rst, halt, budget yield) return
the next GB address to the jump table in the runtime.
"""
from pathlib import Path

from .cfg import fmt_key, intra_successors

RUNTIME = Path(__file__).with_name("runtime.wat")
REG8 = ("a", "b", "c", "d", "e", "h", "l")
FLAGS = ("z", "n", "h", "c")
HOST_ROM = 0x70000
LOCALS = REG8 + ("sp", "zf", "nf", "hf", "cf", "cyc", "t", "u", "ma", "mv", "lbl", "nx")
GLOBAL_OF = {**{r: r.upper() for r in REG8}, "sp": "SP", "zf": "ZF", "nf": "NF",
             "hf": "HF", "cf": "CF", "cyc": "CYC"}


def g(name):
    return f"(local.get ${name})"


def k(n):
    return f"(i32.const {n:#x})" if n >= 10 else f"(i32.const {n})"


def op(name, *xs):
    return f"(i32.{name} {' '.join(xs)})"


def band(x, m):
    return op("and", x, k(m))


class FunctionEmitter:
    def __init__(self, prog, fn):
        self.prog, self.fn = prog, fn
        self.lines, self.written = [], set()
        self.pend = 0           # cycles of the current block not yet added to $cyc
        self.flushed = False    # True once $cyc already includes the current instruction
        self.skipped = 0        # flag computations removed by liveness
        self.ins = None

    # ---- small helpers ----
    def out(self, line):
        self.lines.append("      " + line)

    def set(self, name, expr):
        self.written.add(name)
        self.out(f"(local.set ${name} {expr})")

    def live(self, flag):
        return flag in self.fn.live_after[id(self.ins)] and flag in self.ins.writes

    def set_flag(self, flag, expr):
        if self.live(flag):
            self.set(flag + "f", expr)
        else:
            self.skipped += 1

    def cyc_now(self):
        if self.flushed:
            return g("cyc")
        return op("add", g("cyc"), k(self.pend + self.ins.cycles))

    def pair(self, rp):
        if rp == "sp":
            return g("sp")
        if rp == "af":
            return op("or", op("shl", g("a"), k(8)), self.packed_f())
        hi, lo = rp
        return op("or", op("shl", g(hi), k(8)), g(lo))

    def set_pair(self, rp, expr):
        if rp == "sp":
            self.set("sp", band(expr, 0xFFFF))
            return
        self.set("t", expr)
        hi, lo = rp
        self.set(hi, band(op("shr_u", g("t"), k(8)), 0xFF))
        self.set(lo, band(g("t"), 0xFF))

    def packed_f(self):
        return op("or", op("or", op("shl", g("zf"), k(7)), op("shl", g("nf"), k(6))),
                  op("or", op("shl", g("hf"), k(5)), op("shl", g("cf"), k(4))))

    # ---- memory ----
    def read8(self, addr_expr, const=None):
        if const is not None:
            if const < 0xE000:
                return f"(i32.load8_u {k(const)})"
            return f"(call $rd {k(const)} {self.cyc_now()})"
        return (f"(if (result i32) {op('lt_u', f'(local.tee $ma {addr_expr})', k(0xE000))} "
                f"(then (i32.load8_u {g('ma')})) (else (call $rd {g('ma')} {self.cyc_now()})))")

    def write8(self, addr_expr, val_expr, const=None):
        self.set("mv", val_expr)
        if const is not None:
            if 0x8000 <= const < 0xE000:
                self.out(f"(i32.store8 {k(const)} {g('mv')})")
            else:
                self.out(f"(call $wr {k(const)} {g('mv')} {self.cyc_now()})")
            return
        self.set("ma", addr_expr)
        self.out(f"(if {op('lt_u', op('sub', g('ma'), k(0x8000)), k(0x6000))} "
                 f"(then (i32.store8 {g('ma')} {g('mv')})) "
                 f"(else (call $wr {g('ma')} {g('mv')} {self.cyc_now()})))")

    def get_r(self, r):
        return self.read8(self.pair("hl")) if r == "(hl)" else g(r)

    def put_r(self, r, expr):
        if r == "(hl)":
            self.write8(self.pair("hl"), expr)
        else:
            self.set(r, expr)

    def push16(self, expr):
        self.set("u", expr)
        self.set("sp", band(op("sub", g("sp"), k(1)), 0xFFFF))
        self.write8(g("sp"), op("shr_u", g("u"), k(8)))
        self.set("sp", band(op("sub", g("sp"), k(1)), 0xFFFF))
        self.write8(g("sp"), band(g("u"), 0xFF))

    def pop16(self, dest):
        """Pops into local `dest` (t or u)."""
        self.set("mv", self.read8(g("sp")))
        self.set("sp", band(op("add", g("sp"), k(1)), 0xFFFF))
        self.set(dest, op("or", g("mv"), op("shl", self.read8(g("sp")), k(8))))
        self.set("sp", band(op("add", g("sp"), k(1)), 0xFFFF))

    # ---- control flow ----
    def cond(self, cc):
        return {"nz": f"(i32.eqz {g('zf')})", "z": g("zf"),
                "nc": f"(i32.eqz {g('cf')})", "c": g("cf")}[cc]

    def flush(self, cycles):
        total = self.pend + cycles
        if total:
            self.set("cyc", op("add", g("cyc"), k(total)))
        self.flushed = True

    def exit_to(self, target_expr):
        self.set("nx", target_expr)
        self.out("(br $out)")

    def goto(self, target):
        """Transfer to `target` after cycles were flushed."""
        tk = self.prog.key_of(self.ins, target)
        idx = self.fn.index.get(tk)
        intra = idx is not None and (tk not in self.prog.hard or tk == self.fn.entry)
        if not intra:
            self.exit_to(k(target))
            return
        self.set("lbl", k(idx))
        if tk <= self.ins.key:   # back-edge: yield when the deadline is reached
            self.out(f"(if {op('ge_s', op('sub', g('cyc'), '(global.get $DEADLINE)'), k(0))} "
                     f"(then (local.set $nx {k(target)}) (br $out)))")
        self.out("(br $sw)")

    # ---- per-instruction templates ----
    def emit_instr(self, ins):
        self.ins, self.flushed = ins, False
        self.out(f";; {fmt_key(ins.key)}  {ins.raw.hex(' ').upper():<8}  {ins.text}")
        getattr(self, "i_" + ins.kind)(*ins.args)
        if ins.flow == "next":
            self.pend += ins.cycles

    def i_nop(self):
        pass

    def i_ld_r_r(self, dst, src):
        self.put_r(dst, self.get_r(src))

    def i_ld_r_d8(self, r, n):
        self.put_r(r, k(n))

    def i_ld_rp_d16(self, rp, n):
        if rp == "sp":
            self.set("sp", k(n))
        else:
            self.set(rp[0], k(n >> 8))
            self.set(rp[1], k(n & 0xFF))

    def i_ld_a16_sp(self, n):
        self.write8(None, band(g("sp"), 0xFF), const=n)
        self.write8(None, op("shr_u", g("sp"), k(8)), const=(n + 1) & 0xFFFF)

    def _ind(self, src):
        rp = {"(bc)": "bc", "(de)": "de"}.get(src, "hl")
        return rp, {"(hl+)": 1, "(hl-)": -1}.get(src, 0)

    def i_st_ind_a(self, dst):
        rp, step = self._ind(dst)
        self.write8(self.pair(rp), g("a"))
        if step:
            self.set_pair("hl", band(op("add", self.pair("hl"), k(step & 0xFFFF)), 0xFFFF))

    def i_ld_a_ind(self, src):
        rp, step = self._ind(src)
        self.set("a", self.read8(self.pair(rp)))
        if step:
            self.set_pair("hl", band(op("add", self.pair("hl"), k(step & 0xFFFF)), 0xFFFF))

    def i_st_a16_a(self, n):
        self.write8(None, g("a"), const=n)

    def i_ld_a_a16(self, n):
        self.set("a", self.read8(None, const=n))

    def i_st_c_a(self):
        self.write8(op("or", k(0xFF00), g("c")), g("a"))

    def i_ld_a_c(self):
        self.set("a", self.read8(op("or", k(0xFF00), g("c"))))

    def i_ld_sp_hl(self):
        self.set("sp", self.pair("hl"))

    def i_inc_rp(self, rp):
        self.set_pair(rp, band(op("add", self.pair(rp), k(1)), 0xFFFF))

    def i_dec_rp(self, rp):
        self.set_pair(rp, band(op("sub", self.pair(rp), k(1)), 0xFFFF))

    def i_add_hl_rp(self, rp):
        self.set("u", self.pair(rp))
        self.set("ma", self.pair("hl"))
        self.set_flag("h", op("gt_u", op("add", band(g("ma"), 0xFFF), band(g("u"), 0xFFF)), k(0xFFF)))
        self.set("ma", op("add", g("ma"), g("u")))
        self.set_flag("c", op("shr_u", g("ma"), k(16)))
        self.set_flag("n", k(0))
        self.set_pair("hl", band(g("ma"), 0xFFFF))

    def _sp_plus_e(self, e):
        e16 = e & 0xFFFF
        self.set_flag("h", op("gt_u", op("add", band(g("sp"), 0xF), k(e16 & 0xF)), k(0xF)))
        self.set_flag("c", op("gt_u", op("add", band(g("sp"), 0xFF), k(e16 & 0xFF)), k(0xFF)))
        self.set_flag("z", k(0))
        self.set_flag("n", k(0))
        return band(op("add", g("sp"), k(e16)), 0xFFFF)

    def i_add_sp_e(self, e):
        self.set("sp", self._sp_plus_e(e))

    def i_ld_hl_sp_e(self, e):
        self.set_pair("hl", self._sp_plus_e(e))

    def i_inc_r(self, r):
        self.set("t", self.get_r(r))
        self.put_r(r, band(op("add", g("t"), k(1)), 0xFF))
        self.set_flag("z", op("eq", band(g("t"), 0xFF), k(0xFF)))
        self.set_flag("n", k(0))
        self.set_flag("h", op("eq", band(g("t"), 0xF), k(0xF)))

    def i_dec_r(self, r):
        self.set("t", self.get_r(r))
        self.put_r(r, band(op("sub", g("t"), k(1)), 0xFF))
        self.set_flag("z", op("eq", g("t"), k(1)))
        self.set_flag("n", k(1))
        self.set_flag("h", f"(i32.eqz {band(g('t'), 0xF)})")

    def i_alu(self, name, src):
        self.set("u", k(src) if isinstance(src, int) else self.get_r(src))
        v, a = g("u"), g("a")
        if name in ("add", "adc", "sub", "sbc", "cp"):
            sub = name in ("sub", "sbc", "cp")
            t = op("sub" if sub else "add", a, v)
            if name in ("adc", "sbc"):
                t = op("sub" if sub else "add", t, g("cf"))
            self.set("t", t)
            self.set_flag("h", band(op("shr_u", op("xor", op("xor", a, v), g("t")), k(4)), 1))
            self.set_flag("c", op("lt_s", g("t"), k(0)) if sub else op("shr_u", g("t"), k(8)))
            self.set_flag("n", k(1 if sub else 0))
            if name == "cp":
                self.set_flag("z", f"(i32.eqz {band(g('t'), 0xFF)})")
            else:
                self.set("a", band(g("t"), 0xFF))
                self.set_flag("z", f"(i32.eqz {a})")
            return
        self.set("a", op(name, a, v))
        self.set_flag("z", f"(i32.eqz {a})")
        self.set_flag("n", k(0))
        self.set_flag("h", k(1 if name == "and" else 0))
        self.set_flag("c", k(0))

    def _acc_rot(self, new_a, new_c):
        self.set("t", g("a"))
        self.set("u", new_c)
        self.set("a", new_a)
        self.set_flag("c", g("u"))
        for f in "znh":
            self.set_flag(f, k(0))

    def i_rlca(self):
        self._acc_rot(band(op("or", op("shl", g("t"), k(1)), op("shr_u", g("t"), k(7))), 0xFF),
                      op("shr_u", g("a"), k(7)))

    def i_rrca(self):
        self._acc_rot(op("or", op("shr_u", g("t"), k(1)), band(op("shl", g("t"), k(7)), 0x80)),
                      band(g("a"), 1))

    def i_rla(self):
        self._acc_rot(band(op("or", op("shl", g("t"), k(1)), g("cf")), 0xFF),
                      op("shr_u", g("a"), k(7)))

    def i_rra(self):
        self._acc_rot(op("or", op("shr_u", g("t"), k(1)), op("shl", g("cf"), k(7))),
                      band(g("a"), 1))

    def i_daa(self):
        self.set("u", k(0))            # correction
        self.set("t", g("cf"))         # new carry
        self.out(f"(if (i32.eqz {g('nf')}) (then")
        self.out(f"  (if (i32.or {g('cf')} {op('gt_u', g('a'), k(0x99))}) "
                 f"(then (local.set $u (i32.const 0x60)) (local.set $t (i32.const 1))))")
        self.out(f"  (if (i32.or {g('hf')} {op('gt_u', band(g('a'), 0xF), k(9))}) "
                 f"(then (local.set $u (i32.or (local.get $u) (i32.const 6)))))")
        self.out(f"  (local.set $a {band(op('add', g('a'), g('u')), 0xFF)}))")
        self.out("(else")
        self.out(f"  (if {g('cf')} (then (local.set $u (i32.const 0x60))))")
        self.out(f"  (if {g('hf')} (then (local.set $u (i32.or (local.get $u) (i32.const 6)))))")
        self.out(f"  (local.set $a {band(op('sub', g('a'), g('u')), 0xFF)})))")
        self.written.update(("a", "u", "t"))
        self.set_flag("c", g("t"))
        self.set_flag("z", f"(i32.eqz {g('a')})")
        self.set_flag("h", k(0))

    def i_cpl(self):
        self.set("a", op("xor", g("a"), k(0xFF)))
        self.set_flag("n", k(1))
        self.set_flag("h", k(1))

    def i_scf(self):
        self.set_flag("n", k(0))
        self.set_flag("h", k(0))
        self.set_flag("c", k(1))

    def i_ccf(self):
        self.set_flag("n", k(0))
        self.set_flag("h", k(0))
        self.set_flag("c", op("xor", g("cf"), k(1)))

    def i_cb_rot(self, name, r):
        self.set("t", self.get_r(r))
        t = g("t")
        res, carry = {
            "rlc": (band(op("or", op("shl", t, k(1)), op("shr_u", t, k(7))), 0xFF), op("shr_u", t, k(7))),
            "rrc": (op("or", op("shr_u", t, k(1)), band(op("shl", t, k(7)), 0x80)), band(t, 1)),
            "rl": (band(op("or", op("shl", t, k(1)), g("cf")), 0xFF), op("shr_u", t, k(7))),
            "rr": (op("or", op("shr_u", t, k(1)), op("shl", g("cf"), k(7))), band(t, 1)),
            "sla": (band(op("shl", t, k(1)), 0xFF), op("shr_u", t, k(7))),
            "sra": (op("or", op("shr_u", t, k(1)), band(t, 0x80)), band(t, 1)),
            "swap": (band(op("or", op("shl", t, k(4)), op("shr_u", t, k(4))), 0xFF), k(0)),
            "srl": (op("shr_u", t, k(1)), band(t, 1)),
        }[name]
        self.set("u", res)
        self.put_r(r, g("u"))
        self.set_flag("c", carry)
        self.set_flag("z", f"(i32.eqz {g('u')})")
        self.set_flag("n", k(0))
        self.set_flag("h", k(0))

    def i_cb_bit(self, bit, r):
        self.set_flag("z", f"(i32.eqz {band(op('shr_u', self.get_r(r), k(bit)), 1)})")
        self.set_flag("n", k(0))
        self.set_flag("h", k(1))

    def i_cb_res(self, bit, r):
        self.set("t", self.get_r(r))
        self.put_r(r, band(g("t"), 0xFF ^ (1 << bit)))

    def i_cb_set(self, bit, r):
        self.set("t", self.get_r(r))
        self.put_r(r, op("or", g("t"), k(1 << bit)))

    def i_push(self, rp):
        self.push16(self.pair(rp))

    def i_pop(self, rp):
        self.pop16("u")
        if rp == "af":
            self.set("a", op("shr_u", g("u"), k(8)))
            for bit, f in zip((7, 6, 5, 4), FLAGS):
                self.set_flag(f, band(op("shr_u", g("u"), k(bit)), 1))
        else:
            self.set_pair(rp, g("u"))

    def i_di(self):
        self.out("(global.set $IME (i32.const 0))")

    def i_ei(self):
        self.out("(global.set $IME (i32.const 1))")

    def i_halt(self):
        self.out("(global.set $HALT (i32.const 1))")
        self.flush(self.ins.cycles)
        self.exit_to(k(self.ins.next))

    i_stop = i_halt

    def i_jp(self):
        ins = self.ins
        if ins.cond:
            self.out(f"(if {self.cond(ins.cond)} (then")
            self.flush(ins.cycles_taken)
            self.goto(ins.target)
            self.out("))")
            self.flushed = False
            self.pend += ins.cycles
        else:
            self.flush(ins.cycles)
            self.goto(ins.target)

    def i_jp_hl(self):
        self.flush(self.ins.cycles)
        self.exit_to(self.pair("hl"))

    def i_call(self):
        ins = self.ins
        if ins.cond:
            self.out(f"(if {self.cond(ins.cond)} (then")
            self.flush(ins.cycles_taken)
            self.push16(k(ins.next))
            self.exit_to(k(ins.target))
            self.out("))")
            self.flushed = False
            self.pend += ins.cycles
        else:
            self.flush(ins.cycles)
            self.push16(k(ins.next))
            self.exit_to(k(ins.target))

    def i_ret(self):
        ins = self.ins
        if ins.cond:
            self.out(f"(if {self.cond(ins.cond)} (then")
            self.flush(ins.cycles_taken)
            self.pop16("t")
            self.exit_to(g("t"))
            self.out("))")
            self.flushed = False
            self.pend += ins.cycles
        else:
            self.flush(ins.cycles)
            self.pop16("t")
            self.exit_to(g("t"))

    def i_reti(self):
        self.out("(global.set $IME (i32.const 1))")
        self.i_ret()

    # ---- whole function ----
    def emit(self):
        fn = self.fn
        for label, block in enumerate(fn.blocks):
            body_start = len(self.lines)
            self.pend = 0
            for ins in block.instrs:
                self.emit_instr(ins)
            last = block.last
            if last.flow in ("next", "branch", "cexit"):
                self.flush(0)
                nxt = self.prog.key_of(last, last.next)
                succ = intra_successors(self.prog, fn.entry, block)
                follows = label + 1 < len(fn.blocks) and fn.blocks[label + 1].start == nxt
                if nxt in succ and follows and nxt > last.key:
                    pass                                   # falls into the next label
                else:
                    self.goto(last.next)
            self.lines.insert(body_start, f"    ;; ---- block {fmt_key(block.start)} (label {label})")
            if label:
                self.lines.insert(body_start, ")")       # closes $L<label>; its code follows
        return self.assemble()

    def assemble(self):
        fn, n = self.fn, len(self.fn.blocks)
        written = sorted(self.written & set(GLOBAL_OF))
        head = [f"  (func {fname(fn.entry)} (type $blk)"]
        head.append("    " + " ".join(f"(local ${x} i32)" for x in LOCALS))
        for x in GLOBAL_OF:
            head.append(f"    (local.set ${x} (global.get ${GLOBAL_OF[x]}))")
        head.append(f"    (local.set $lbl {k(fn.index[fn.entry])})")
        head.append("    (block $out")
        head.append("    (loop $sw")
        for i in reversed(range(n)):
            head.append(f"    (block $L{i}")
        labels = " ".join(f"$L{i}" for i in range(n))
        head.append(f"      (br_table {labels} (local.get $lbl)))")
        body = []
        for line in self.lines:
            if line == ")":
                body.append("    )")
            elif line:
                body.append(line)
        tail = ["    ))"]
        for x in written:
            tail.append(f"    (global.set ${GLOBAL_OF[x]} (local.get ${x}))")
        tail.append("    (local.get $nx))")
        return head + body + tail


def fname(key):
    """$f_0150 for fixed addresses, $f_03_4A20 for bank 3 address 4A20."""
    return "$f_" + fmt_key(key).replace(":", "_")


def wat_string(data):
    return "".join(chr(b) if 0x20 <= b < 0x7F and b not in (0x22, 0x5C) else f"\\{b:02x}"
                   for b in data)


# The browser build imports a shared memory (SharedArrayBuffer, one per Game Boy). The
# server build, run inside a Cloudflare Durable Object, owns a plain exported memory:
# Workers have no shared memory, and nothing else touches it while a frame runs.
SERVER_EDITS = (
    ('(import "env" "mem" (memory __PAGES__ __PAGES__ shared))', '(memory (export "mem") __PAGES__ __PAGES__)'),
    ("(drop (i32.atomic.rmw.add (i32.const 0x10000) (i32.const 1)))",
     "(i32.store (i32.const 0x10000) (i32.add (i32.load (i32.const 0x10000)) (i32.const 1)))"),
    ("i32.atomic.load", "i32.load"),
    ("i32.atomic.store", "i32.store"),
)
TARGETS = ("server", "browser")


def emit_module(prog, rom, target="server"):
    funcs, stats = [], {"functions": 0, "blocks": 0, "instructions": 0, "dead_flags": 0}
    for fn in prog.functions:
        fe = FunctionEmitter(prog, fn)
        funcs.extend(fe.emit())
        stats["dead_flags"] += fe.skipped
        stats["functions"] += 1
        stats["blocks"] += len(fn.blocks)
        stats["instructions"] += sum(len(b.instrs) for b in fn.blocks)
    pages = max(8, -(-(HOST_ROM + len(rom)) // 0x10000))
    runtime = RUNTIME.read_text()
    if target == "server":
        for old, new in SERVER_EDITS:
            assert old in runtime, old
            runtime = runtime.replace(old, new)
    runtime = runtime.replace("__PAGES__", str(pages)).replace("__ROM_LEN__", str(len(rom)))
    runtime = runtime.replace("__BANK_LEN__", str(min(len(rom), 0x8000)))
    cart = prog.cart
    runtime = (runtime.replace("__MBC__", str(cart.mbc)).replace("__BANK_MASK__", str(cart.banks - 1))
               .replace("__RAM_BANKS__", str(cart.ram_banks)).replace("__TABLE__", str(cart.table)))
    elems = [f"  (elem (table $jt) (i32.const {fn.entry:#07x}) func {fname(fn.entry)})"
             for fn in prog.functions]
    text = ["(module", runtime, *funcs, *elems,
            f"  (data $rom \"{wat_string(rom)}\")", ")"]
    return "\n".join(text) + "\n", stats
