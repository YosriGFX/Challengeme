"""Control-flow discovery: entry points, basic blocks, functions and flag liveness.

Code is found by recursive traversal from the entry points, never by a linear
sweep, so data bytes are never decoded. Every address that can be reached
through the jump table at runtime (call targets, return sites, interrupt
vectors, resume points) becomes an entry and gets its own WASM function.

Banked ROMs: code in 0x4000-0x7FFF is identified by a key that includes its bank,
the same number the runtime's $slot computes from PC and the mapped bank:
    key = addr                                   outside 0x4000-0x7FFF
    key = 0x10000 + bank * 0x4000 + (addr & 0x3FFF)   inside it
Code in a bank jumps freely inside its own bank. A jump from bank 0 (or RAM) into
0x4000-0x7FFF always leaves through the jump table, so the bank mapped at runtime
decides where it lands. Its target bank is taken from a constant bank switch seen
earlier on the same path (`ld a,n` then `ld ($2000-$3FFF),a`), or from hints.
"""
import re
from collections import Counter
from dataclasses import dataclass, field

from .decoder import ALL_FLAGS, DecodeError, decode

CART_ENTRY = 0x0100
IRQ_VECTORS = (0x40, 0x48, 0x50, 0x58, 0x60)

# The OAM DMA routine games copy to HRAM: the classic one (`ld a,hi; ldh ($46),a; ...`) or
# GBDK's (`ldh a,(hi_var); or a; ret z; ldh ($46),a; ...`).
DMA_ROUTINE = re.compile(rb"(?:\x3E.|\xF0.\xB7\xC8)\xE0\x46\x3E.\x3D\x20\xFD\xC9", re.S)

# Cartridge header byte 0x147 -> MBC family; 0x149 -> number of 8 KiB RAM banks.
MBC_OF = {0x00: 0, 0x08: 0, 0x09: 0, 0x01: 1, 0x02: 1, 0x03: 1,
          0x0F: 3, 0x10: 3, 0x11: 3, 0x12: 3, 0x13: 3,
          0x19: 5, 0x1A: 5, 0x1B: 5, 0x1C: 5, 0x1D: 5, 0x1E: 5}
RAM_BANKS_OF = {0: 0, 1: 1, 2: 1, 3: 4, 4: 16, 5: 8}

# Instructions that leave A unchanged (for tracking `ld a,n` into a bank switch).
KEEPS_A = frozenset(("nop", "st_ind_a", "st_a16_a", "st_c_a", "ld_rp_d16", "inc_rp", "dec_rp",
                     "push", "di", "ei", "ld_a16_sp", "ld_sp_hl", "add_hl_rp", "cb_bit",
                     "scf", "ccf", "add_sp_e", "ld_hl_sp_e"))


def in_window(addr):
    return 0x4000 <= addr < 0x8000


def key(bank, addr):
    return 0x10000 + bank * 0x4000 + (addr & 0x3FFF) if in_window(addr) else addr


def fmt_key(k):
    return f"{(k - 0x10000) >> 14:02X}:{0x4000 + (k & 0x3FFF):04X}" if k >= 0x10000 else f"{k:04X}"


def parse_key(text):
    """'4A20' (bank 1 if banked) or '05:4A20'."""
    bank, _, addr = text.rpartition(":")
    return key(int(bank, 16) if bank else 1, int(addr, 16))


class Cart:
    def __init__(self, rom):
        self.rom = rom
        ctype = rom[0x147] if len(rom) > 0x147 else 0
        if ctype not in MBC_OF:
            raise TranslateError(f"cartridge type {ctype:#04x} is not supported (ROM-only, MBC1, MBC3, MBC5)")
        self.mbc = MBC_OF[ctype]
        self.banks = 2
        while self.banks * 0x4000 < len(rom):
            self.banks *= 2
        self.ram_banks = RAM_BANKS_OF.get(rom[0x149] if len(rom) > 0x149 else 0, 0)
        if self.mbc == 0:
            self.ram_banks = 0
        self.table = 0x10000 + self.banks * 0x4000


class BankView:
    """The 64 KiB address space as seen with `bank` mapped at 0x4000-0x7FFF."""
    def __init__(self, image, rom, bank):
        self.image, self.rom, self.bank = image, rom, bank

    def __len__(self):
        return 0x10000

    def _byte(self, a):
        if in_window(a):
            off = self.bank * 0x4000 + (a - 0x4000)
            if off >= len(self.rom):
                raise DecodeError(f"bank {self.bank:02X} address {a:04X} is past the end of the ROM")
            return self.rom[off]
        return self.image[a]

    def __getitem__(self, i):
        if isinstance(i, slice):
            return bytes(self._byte(a) for a in range(i.start, i.stop))
        return self._byte(i)


class TranslateError(Exception):
    pass


@dataclass
class Block:
    start: int
    instrs: list = field(default_factory=list)

    @property
    def last(self):
        return self.instrs[-1]



@dataclass
class Function:
    entry: int
    blocks: list            # sorted by address; blocks[i] is label i
    index: dict             # block start -> label
    live_after: dict        # id(instr) -> flags live after that instruction


@dataclass
class Program:
    image: bytearray        # 64 KiB code image (ROM plus RAM code from hints)
    instrs: dict            # addr -> Instr
    hard: set               # entries reached through the jump table
    soft: set               # loop heads: inside other functions, but resumable
    blocks: dict            # start -> Block
    functions: list
    unresolved: set         # jump-table targets with no code we could decode (keys)
    cart: Cart = None
    unknown_bank: set = field(default_factory=set)   # 0x4000-0x7FFF targets from bank 0, bank unknown

    def key_of(self, ins, addr):
        """Key of `addr` reached from `ins` without a bank switch; None if the bank is unknown."""
        if not in_window(addr):
            return addr
        return key(ins.bank, addr) if ins.bank is not None else None


def discover(rom, ram_code=(), entries=()):
    """ram_code: (ram_addr, rom_src, length) routines the game copies to RAM.
    entries: extra jump-table entries as keys, e.g. JP (HL) targets reported by a trap."""
    cart = Cart(rom)
    image = bytearray(0x10000)
    image[:min(len(rom), 0x4000)] = rom[:0x4000]
    code_ok = [i < min(len(rom), 0x4000) for i in range(0x10000)]
    hard = {CART_ENTRY, *entries}
    for ram_addr, src, length in ram_code:
        image[ram_addr:ram_addr + length] = rom[src:src + length]
        for i in range(ram_addr, ram_addr + length):
            code_ok[i] = True
        hard.add(ram_addr)
    views = {}

    def view(bank):
        if bank not in views:
            views[bank] = BankView(image, rom, bank if bank is not None else 1)
        return views[bank]

    def bank_of(k):
        return (k - 0x10000) >> 14 if k >= 0x10000 else None

    def addr_of(k):
        return 0x4000 + (k & 0x3FFF) if k >= 0x10000 else k

    def valid(k):
        if k >= 0x10000:
            return bank_of(k) < cart.banks and bank_of(k) * 0x4000 + (k & 0x3FFF) < len(rom)
        return code_ok[k]

    default_bank = 1 if cart.mbc == 0 else None
    instrs, owner, soft, unresolved, unknown_bank = {}, {}, set(), set(), set()
    # Work items: (key, bank switched to by a constant earlier on this path, constant in A,
    # tentative). Tentative code was found only through a guessed inline jump table: if it
    # fails to decode or overlaps other code, it is dropped instead of failing the build.
    work = [(k, None, None, False) for k in sorted(hard)]
    deferred = []                     # inline jump table entries, taken after certain code
    guessed = Counter()               # how many places guessed each entry

    def map_dma_routine(at):
        """Almost every game copies the same OAM DMA routine into HRAM and calls it there
        (`ld a,hi; ldh ($46),a; ld a,n; dec a; jr nz,-3; ret`). When code jumps into HRAM
        and no hint says what is there, use that routine from the ROM."""
        m = DMA_ROUTINE.search(rom[:0x8000])
        if not m:
            return False
        code = m.group(0)
        image[at:at + len(code)] = code
        for i in range(at, at + len(code)):
            code_ok[i] = True
        return True

    def consumes_return(bank, addr):
        """True if the routine at addr pops its own return address before pushing, calling
        or returning: the bytes after a call to it are then data (an inline jump table,
        the classic RST $28 dispatcher), not code."""
        v = view(bank)
        for _ in range(8):
            if not valid(key(bank, addr) if bank is not None else addr):
                return False
            try:
                i = decode(v, addr)
            except DecodeError:
                return False
            if i.kind == "pop":
                return True
            if i.kind in ("push", "call", "ret", "reti", "jp_hl", "ld_sp_hl", "add_sp_e") or i.flow != "next":
                return False
            addr = i.next
        return False

    def looks_like_code(bank, addr):
        """A guess that `addr` starts a routine: straight-line code that decodes cleanly
        and reaches a return or jump soon, without the runs of NOP or RST $38 that data
        and padding decode to."""
        v, nops = view(bank), 0
        for _ in range(48):
            if bank is None and in_window(addr):
                return False                       # ran off bank 0 into an unknown bank
            k = key(bank, addr)
            if not valid(k) or is_padding(k):
                return False
            try:
                i = decode(v, addr)
            except DecodeError:
                return False
            nops += i.kind == "nop"
            if nops > 3:
                return False
            if i.kind in ("ret", "reti", "jp_hl") or i.flow == "jump":
                return True
            addr = i.next
        return False

    def bank_for(bank, addr):
        return (bank if bank is not None else default_bank) if in_window(addr) else None

    def key_or_none(bank, addr):
        if not in_window(addr):
            return addr
        b = bank_for(bank, addr)
        return None if b is None else key(b, addr)

    def is_padding(k):
        """An unused 0xFF byte: as code it is RST $38, which recurses forever when $38 is
        0xFF too. No game runs that, so it is padding, not a routine."""
        b = rom[bank_of(k) * 0x4000 + (k & 0x3FFF)] if k >= 0x10000 else image[k]
        return b == 0xFF and len(rom) > 0x38 and rom[0x38] == 0xFF

    def inline_table(bank, at):
        """Code addresses listed as 16-bit words from `at`. The table ends at the first word
        that cannot be a code address, or where an entry says code starts."""
        out, end, zeros = [], 0x10000, 0
        while at < end and len(out) < 256:
            tk0 = key(bank, at) if bank is not None else at
            if tk0 in owner or not valid(tk0) or not valid(key(bank, at + 1) if bank is not None else at + 1):
                break
            w = rom[at] | (rom[at + 1] << 8) if bank is None or not in_window(at) else \
                rom[bank * 0x4000 + (at - 0x4000)] | (rom[bank * 0x4000 + (at - 0x3FFF)] << 8)
            if w == 0 and zeros < 8:                  # an unused slot inside the table
                zeros += 1
                at += 2
                continue
            if w < 0x0100 or w >= 0x8000 or (in_window(w) and bank is None and cart.mbc != 0):
                break
            zeros = 0
            out.append(w)
            if at < w:
                end = min(end, w)
            at += 2
        return out
    def chain_before(k, limit=16):
        """The straight-line instructions that end right before key k, nearest first."""
        out, at = [], k
        while len(out) < limit:
            prev = next((instrs[at - n] for n in (1, 2, 3) if at - n in instrs
                         and instrs[at - n].length == n), None)
            if prev is None or (prev.flow != "next" and prev.kind != "call"):   # a call returns here
                break
            out.append(prev)
            at -= prev.length
        return out

    def table_bases(before):
        """Constant table addresses that HL was computed from, as code that indexes a table
        of code addresses does it: `ld hl,table` (maybe with a call to an index helper),
        `ld de,table / add hl,de`, or `add a,low / ... / adc a,high`."""
        bases, added, adc_hi = [], set(), None
        for prev in before:
            kind, args = prev.kind, prev.args
            if kind == "add_hl_rp":
                added.add(args[0])
            elif kind == "ld_rp_d16" and (args[0] == "hl" or args[0] in added):
                bases.append(args[1])
                if args[0] == "hl":
                    break
            elif kind == "alu" and args[0] == "adc" and isinstance(args[1], int):
                adc_hi = args[1]
            elif kind == "alu" and args[0] == "add" and isinstance(args[1], int) and adc_hi is not None:
                bases.append(adc_hi << 8 | args[1])
                adc_hi = None
        return bases

    def follow_tables(bases, bank, follow):
        for tb in bases:
            if tb >= 0x8000:
                continue
            tbank = None
            if in_window(tb):
                tbank = bank if bank is not None else default_bank
                if tbank is None:
                    continue
            # Index 0 may be unused, so the base can point into the dispatch code itself.
            for t in inline_table(tbank, tb) or inline_table(tbank, tb + 2):
                follow(t, as_entry=True, to=deferred, guess=True)

    # Interrupt vectors are only code if the game can enable interrupts; otherwise they
    # are usually padding. A vector that fails to decode is left unresolved.
    optional, vectors_added = set(IRQ_VECTORS), False

    while work or deferred or not vectors_added:
        if not work and not vectors_added:
            # Interrupt handlers before any guess: their code is certain once they exist,
            # and a guess decoded first could take bytes a handler needs.
            vectors_added = True
            if any(i.kind in ("ei", "reti") for i in instrs.values()):
                hard.update(IRQ_VECTORS)
                # Lowest first (work is a stack): a handler longer than its 8 bytes runs
                # on over the next vector, which is then not code of its own.
                work.extend((v, None, None, True) for v in reversed(IRQ_VECTORS))   # may be padding
            continue
        if not work:
            # Guesses named in more places go first: when two guesses overlap, the better
            # supported one is kept and the other dropped.
            work, deferred = sorted(deferred[::-1], key=lambda w: guessed[w[0]]), []
            continue
        k, hint, a_const, tent = work.pop()
        if k in instrs:
            continue
        if not valid(k) and 0xFF80 <= k < 0xFFFF and map_dma_routine(k):
            pass
        if not valid(k) or is_padding(k):
            unresolved.add(k)
            continue
        bank, a = bank_of(k), addr_of(k)
        try:
            ins = decode(view(bank), a)
        except DecodeError:
            if k in optional or tent:
                unresolved.add(k)
                continue
            raise
        ins.bank, ins.key = bank, k
        span = [key(bank, i) if bank is not None else i for i in range(a, a + ins.length)]
        clash = next((owner[bk] for bk in span if bk in owner and owner[bk] != k), None)
        if clash is not None:
            if k in optional or tent:         # a vector inside another handler's code, or a bad guess
                unresolved.add(k)
                continue
            raise TranslateError(f"overlapping instructions at {fmt_key(k)} and {fmt_key(clash)}")
        for bk in span:
            owner[bk] = k
        instrs[k] = ins
        optional.discard(k)

        # Track a constant ROM bank switch along this path.
        if ins.kind == "ld_r_d8" and ins.args[0] == "a":
            a_const = ins.args[1]
        elif ins.kind == "st_a16_a" and 0x2000 <= ins.args[0] < 0x4000 and a_const is not None:
            hint = a_const & (cart.banks - 1)
            if cart.mbc in (1, 3) and hint == 0:
                hint = 1
        elif ins.kind not in KEEPS_A and not (ins.kind in ("ld_r_d8", "ld_r_r", "inc_r", "dec_r")
                                             and ins.args[0] != "a"):
            a_const = None

        def follow(addr, as_entry=False, to=None, guess=False):
            to = work if to is None else to
            if guess:
                guessed[key(bank, addr) if bank is not None or not in_window(addr) else addr] += 1
            if in_window(addr) and bank is None:          # bank 0 / RAM into the switchable bank
                tb = hint if hint is not None else default_bank
                if tb is None:
                    unknown_bank.add(addr)
                    return
                tk = key(tb, addr)
                hard.add(tk)
                to.append((tk, hint, None, tent or guess))
                return
            tk = key(bank, addr) if bank is not None else addr
            if as_entry:
                hard.add(tk)
            to.append((tk, hint, a_const, tent or guess))
            return tk

        if ins.kind == "st_a16_a" and ins.args[0] >= 0x8000:
            # ld a,lo / ld (nn),a / ld a,hi / ld (nn+1),a: a code address stored in RAM
            # byte by byte, to be jumped to later (F-1 Pole Position's LCD handler).
            p = chain_before(k, 3)
            if len(p) == 3 and p[0].kind == p[2].kind == "ld_r_d8" and p[0].args[0] == p[2].args[0] == "a" \
                    and p[1].kind == "st_a16_a" and p[1].args[0] + 1 == ins.args[0]:
                nn = p[0].args[1] << 8 | p[2].args[1]
                if 0x0040 <= nn < 0x4000 and nn not in owner and looks_like_code(None, nn):
                    follow(nn, as_entry=True, to=deferred, guess=True)
        if ins.flow in ("next", "branch", "cexit"):
            follow(ins.next)
        if ins.flow in ("jump", "branch"):
            tk = follow(ins.target)
            if tk is not None and tk <= k:
                soft.add(tk)
        if ins.kind == "call":
            follow(ins.target, as_entry=True)
            # LD rr,nn right before a call: nn may be a routine handed over to be called
            # later, as GBDK's add_VBL(handler) does. Taken only if it looks like code.
            for prev in chain_before(k, 3):
                nn = prev.args[1] if prev.kind == "ld_rp_d16" else None
                if nn is not None and 0x0040 <= nn < 0x8000 and key_or_none(bank, nn) not in owner \
                        and key_or_none(bank, nn) is not None and looks_like_code(bank_for(bank, nn), nn):
                    follow(nn, as_entry=True, to=deferred, guess=True)
            if consumes_return(bank, ins.target) and not (in_window(ins.target) and bank is None):
                for t in inline_table(bank, ins.next):
                    follow(t, as_entry=True, to=deferred, guess=True)
            else:
                follow(ins.next, as_entry=True)
        elif ins.kind in ("halt", "stop"):
            follow(ins.next, as_entry=True)
        elif ins.kind == "jp_hl":
            before = chain_before(k)
            if before and before[0].kind == "ld_rp_d16" and before[0].args[0] == "hl":
                follow(before[0].args[1], as_entry=True)      # LD HL,nn right before JP (HL)
            else:
                follow_tables(table_bases(before), bank, follow)
        elif ins.kind == "push":
            # LD rr,nn / PUSH rr: nn is where a later RET goes (a return address pushed
            # before jumping through a table).
            before = chain_before(k, 1)
            if before and before[0].kind == "ld_rp_d16" and before[0].args[0] == ins.args[0] \
                    and 0x0100 <= before[0].args[1] < 0x8000:
                follow(before[0].args[1], as_entry=True, to=deferred, guess=True)
        elif ins.kind == "ret":
            # PUSH HL ... RET jumps to HL, often a word from a table of code addresses.
            before = chain_before(k)
            for n, prev in enumerate(before):
                if prev.kind in ("pop", "call", "ret", "push") and not (prev.kind == "push" and prev.args[0] == "hl"):
                    break
                if prev.kind == "push":
                    follow_tables(table_bases(before[n + 1:]), bank, follow)
                    break
        elif ins.kind == "st_a16_a" and ins.args[0] < 0x8000 and bank is not None:
            # Banked code switching banks: continue through the jump table so the
            # newly mapped bank decides what runs next.
            follow(ins.next, as_entry=True)

    hard = {a for a in hard if a in instrs}
    soft = {a for a in soft if a in instrs} - hard
    prog = Program(image, instrs, hard, soft, {}, [], unresolved, cart, unknown_bank)

    leaders = set(hard) | soft
    for ins in instrs.values():
        if ins.flow in ("jump", "branch"):
            tk = prog.key_of(ins, ins.target)
            if tk in instrs:
                leaders.add(tk)
        if ins.flow in ("branch", "cexit"):
            leaders.add(prog.key_of(ins, ins.next))

    for start in sorted(leaders):
        if start not in instrs:
            continue
        b, k = Block(start), start
        while True:
            ins = instrs[k]
            b.instrs.append(ins)
            nk = prog.key_of(ins, ins.next)
            if ins.flow != "next" or nk in leaders or nk not in instrs:
                break
            k = nk
        prog.blocks[start] = b

    for entry in sorted(hard | soft):
        prog.functions.append(_function(prog, entry))
    return prog


def intra_successors(prog, fn_entry, block):
    """Successor block starts that stay inside the function rooted at fn_entry."""
    ins, out = block.last, []
    cands = []
    if ins.flow in ("next", "branch", "cexit"):
        cands.append(prog.key_of(ins, ins.next))
    if ins.flow in ("jump", "branch"):
        cands.append(prog.key_of(ins, ins.target))
    for t in cands:
        if t in prog.blocks and (t not in prog.hard or t == fn_entry):
            out.append(t)
    return out


def _function(prog, entry):
    seen, work = set(), [entry]
    while work:
        s = work.pop()
        if s in seen:
            continue
        seen.add(s)
        work.extend(intra_successors(prog, entry, prog.blocks[s]))
    blocks = [prog.blocks[s] for s in sorted(seen)]
    index = {b.start: i for i, b in enumerate(blocks)}
    return Function(entry, blocks, index, _liveness(prog, entry, blocks, index))


def _liveness(prog, entry, blocks, index):
    """Backward flag liveness. Anything that leaves through the jump table keeps all flags live."""
    def block_out(b, live_in):
        ins, live = b.last, frozenset()
        succ = intra_successors(prog, entry, b)
        n_possible = (ins.flow in ("next", "branch", "cexit")) + (ins.flow in ("jump", "branch"))
        if ins.flow in ("exit", "cexit") or len(succ) < n_possible:
            live = ALL_FLAGS
        for s in succ:
            live |= live_in[s]
        return live

    live_in = {b.start: frozenset() for b in blocks}
    changed = True
    while changed:
        changed = False
        for b in reversed(blocks):
            live = block_out(b, live_in)
            for ins in reversed(b.instrs):
                live = (live - ins.writes) | ins.reads
            if live != live_in[b.start]:
                live_in[b.start], changed = live, True

    live_after = {}
    for b in blocks:
        live = block_out(b, live_in)
        for ins in reversed(b.instrs):
            live_after[id(ins)] = live
            live = (live - ins.writes) | ins.reads
    return live_after
