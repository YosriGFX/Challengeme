"""Control-flow discovery: entry points, basic blocks, functions and flag liveness.

Code is found by recursive traversal from the entry points, never by a linear
sweep, so data bytes are never decoded. Every address that can be reached
through the jump table at runtime (call targets, return sites, interrupt
vectors, resume points) becomes an entry and gets its own WASM function.
"""
from dataclasses import dataclass, field

from .decoder import ALL_FLAGS, DecodeError, decode

CART_ENTRY = 0x0100
IRQ_VECTORS = (0x40, 0x48, 0x50, 0x58, 0x60)


class TranslateError(Exception):
    pass


@dataclass
class Block:
    start: int
    instrs: list = field(default_factory=list)

    @property
    def last(self):
        return self.instrs[-1]

    @property
    def end(self):
        return self.last.next


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
    unresolved: set         # jump-table targets with no code we could decode


def discover(rom, ram_code=(), entries=()):
    """ram_code: (ram_addr, rom_src, length) routines the game copies to RAM.
    entries: extra jump-table entries, e.g. JP (HL) targets reported by a trap."""
    image = bytearray(0x10000)
    image[:min(len(rom), 0x8000)] = rom[:0x8000]
    code_ok = [i < min(len(rom), 0x8000) for i in range(0x10000)]
    hard = {CART_ENTRY, *entries}
    for ram_addr, src, length in ram_code:
        image[ram_addr:ram_addr + length] = rom[src:src + length]
        for i in range(ram_addr, ram_addr + length):
            code_ok[i] = True
        hard.add(ram_addr)

    instrs, owner, soft, unresolved = {}, {}, set(), set()
    work = sorted(hard)
    # Interrupt vectors are only code if the game can enable interrupts; otherwise they
    # are usually padding. A vector that fails to decode is left unresolved.
    optional, vectors_added = set(IRQ_VECTORS), False

    while work or not vectors_added:
        if not work:
            vectors_added = True
            if any(i.kind in ("ei", "reti") for i in instrs.values()):
                hard.update(IRQ_VECTORS)
                work.extend(IRQ_VECTORS)
            continue
        a = work.pop()
        if a in instrs:
            continue
        if not code_ok[a]:
            unresolved.add(a)
            continue
        try:
            ins = decode(image, a)
        except DecodeError:
            if a in optional:
                unresolved.add(a)
                continue
            raise
        for i in range(a, a + ins.length):
            if i in owner and owner[i] != a:
                raise TranslateError(f"overlapping instructions at {a:04X} and {owner[i]:04X}")
            owner[i] = a
        instrs[a] = ins
        optional.discard(a)

        if ins.flow in ("next", "branch", "cexit"):
            work.append(ins.next)
        if ins.flow in ("jump", "branch"):
            work.append(ins.target)
            if ins.target <= a:
                soft.add(ins.target)
        if ins.kind == "call":
            hard.update((ins.target, ins.next))
            work.extend((ins.target, ins.next))
        elif ins.kind in ("halt", "stop"):
            hard.add(ins.next)
            work.append(ins.next)
        elif ins.kind == "jp_hl":
            # LD HL,nn right before JP (HL) gives a target known at build time.
            prev = instrs.get(a - 3)
            if prev and prev.kind == "ld_rp_d16" and prev.args[0] == "hl":
                hard.add(prev.args[1])
                work.append(prev.args[1])

    hard = {a for a in hard if a in instrs}
    soft = {a for a in soft if a in instrs} - hard

    leaders = set(hard) | soft
    for ins in instrs.values():
        if ins.flow in ("jump", "branch") and ins.target in instrs:
            leaders.add(ins.target)
        if ins.flow in ("branch", "cexit"):
            leaders.add(ins.next)

    blocks = {}
    for start in sorted(leaders):
        if start not in instrs:
            continue
        b, a = Block(start), start
        while True:
            ins = instrs[a]
            b.instrs.append(ins)
            if ins.flow != "next" or ins.next in leaders or ins.next not in instrs:
                break
            a = ins.next
        blocks[start] = b

    prog = Program(image, instrs, hard, soft, blocks, [], unresolved)
    for entry in sorted(hard | soft):
        prog.functions.append(_function(prog, entry))
    return prog


def intra_successors(prog, fn_entry, block):
    """Successor block starts that stay inside the function rooted at fn_entry."""
    ins, out = block.last, []
    cands = []
    if ins.flow in ("next", "branch", "cexit"):
        cands.append(ins.next)
    if ins.flow in ("jump", "branch"):
        cands.append(ins.target)
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
