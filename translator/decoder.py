"""SM83 instruction decoder.

Pure function from (ROM bytes, address) to an Instr record. The emitter and the
flag-liveness pass both work from these records, so the decoding rules live here
only. Opcodes are split into the classic fields  xx yyy zzz  (p = y >> 1, q = y & 1).
"""
from dataclasses import dataclass, field

R = ("b", "c", "d", "e", "h", "l", "(hl)", "a")
RP = ("bc", "de", "hl", "sp")
RP2 = ("bc", "de", "hl", "af")
CC = ("nz", "z", "nc", "c")
ALU = ("add", "adc", "sub", "sbc", "and", "xor", "or", "cp")
ROT = ("rlc", "rrc", "rl", "rr", "sla", "sra", "swap", "srl")
ALL_FLAGS = frozenset("znhc")
CC_FLAG = {"nz": "z", "z": "z", "nc": "c", "c": "c"}

# Opcodes that lock up real hardware; reaching one is a build error.
ILLEGAL = frozenset((0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD))


class DecodeError(Exception):
    pass


@dataclass
class Instr:
    addr: int
    length: int
    text: str                 # assembly text, used for comments in the .wat
    kind: str                 # what the emitter switches on
    args: tuple = ()
    cycles: int = 4           # not taken / unconditional
    cycles_taken: int = 0     # conditional branches only
    reads: frozenset = frozenset()   # flags read
    writes: frozenset = frozenset()  # flags written
    target: int = None        # direct jump/call target known at build time
    cond: str = None          # nz / z / nc / c
    # How control leaves this instruction:
    #   "next"   falls through
    #   "jump"   unconditional direct jump to target
    #   "branch" conditional direct jump to target, else falls through
    #   "exit"   leaves through the jump table (call, ret, jp hl, rst, halt, stop)
    #   "cexit"  conditional exit (call cc, ret cc), else falls through
    flow: str = "next"
    raw: bytes = field(default=b"", repr=False)

    @property
    def next(self):
        return (self.addr + self.length) & 0xFFFF


def _r_cost(reg, base, hl_cost):
    return hl_cost if reg == "(hl)" else base


def decode(rom, addr):
    """Decode the instruction at `addr` of `rom` (bytes-like, indexed by GB address)."""
    def byte(i):
        a = addr + i
        if a >= len(rom):
            raise DecodeError(f"instruction at {addr:04X} runs past the end of the ROM")
        return rom[a]

    op = byte(0)
    if op in ILLEGAL:
        raise DecodeError(f"illegal opcode {op:02X} at {addr:04X}")
    if op == 0xCB:
        return _decode_cb(addr, byte(1))

    x, y, z = op >> 6, (op >> 3) & 7, op & 7
    p, q = y >> 1, y & 1
    d8 = lambda: byte(1)
    d16 = lambda: byte(1) | (byte(2) << 8)
    e8 = lambda: byte(1) - 256 if byte(1) & 0x80 else byte(1)

    def I(length, text, kind, args=(), cycles=4, **kw):
        ins = Instr(addr, length, text, kind, args, cycles, **kw)
        ins.raw = bytes(rom[addr:addr + length])
        return ins

    if x == 0:
        if z == 0:
            if y == 0:
                return I(1, "nop", "nop")
            if y == 1:
                n = d16()
                return I(3, f"ld (${n:04X}),sp", "ld_a16_sp", (n,), 20)
            if y == 2:
                return I(2, "stop", "stop", flow="exit")
            t = (addr + 2 + e8()) & 0xFFFF
            if y == 3:
                return I(2, f"jr ${t:04X}", "jp", cycles=12, target=t, flow="jump")
            cc = CC[y - 4]
            return I(2, f"jr {cc},${t:04X}", "jp", cycles=8, cycles_taken=12, target=t,
                     cond=cc, reads=frozenset(CC_FLAG[cc]), flow="branch")
        if z == 1:
            if q == 0:
                n = d16()
                return I(3, f"ld {RP[p]},${n:04X}", "ld_rp_d16", (RP[p], n), 12)
            return I(1, f"add hl,{RP[p]}", "add_hl_rp", (RP[p],), 8, writes=frozenset("nhc"))
        if z == 2:
            src = ("(bc)", "(de)", "(hl+)", "(hl-)")[p]
            if q == 0:
                return I(1, f"ld {src},a", "st_ind_a", (src,), 8)
            return I(1, f"ld a,{src}", "ld_a_ind", (src,), 8)
        if z == 3:
            kind = "inc_rp" if q == 0 else "dec_rp"
            return I(1, f"{kind[:3]} {RP[p]}", kind, (RP[p],), 8)
        if z in (4, 5):
            kind = "inc_r" if z == 4 else "dec_r"
            return I(1, f"{kind[:3]} {R[y]}", kind, (R[y],), _r_cost(R[y], 4, 12),
                     writes=frozenset("znh"))
        if z == 6:
            n = d8()
            return I(2, f"ld {R[y]},${n:02X}", "ld_r_d8", (R[y], n), _r_cost(R[y], 8, 12))
        # z == 7: accumulator rotates and flag ops
        name = ("rlca", "rrca", "rla", "rra", "daa", "cpl", "scf", "ccf")[y]
        reads = {"rla": "c", "rra": "c", "daa": "nhc", "ccf": "c"}.get(name, "")
        writes = {"cpl": "nh", "daa": "zhc"}.get(name, "znhc" if name.startswith("r") else "nhc")
        return I(1, name, name, reads=frozenset(reads), writes=frozenset(writes))

    if x == 1:
        if op == 0x76:
            return I(1, "halt", "halt", flow="exit")
        cost = 8 if "(hl)" in (R[y], R[z]) else 4
        return I(1, f"ld {R[y]},{R[z]}", "ld_r_r", (R[y], R[z]), cost)

    if x == 2:
        return _alu(I, ALU[y], R[z], 1, _r_cost(R[z], 4, 8))

    # x == 3
    if z == 0:
        if y < 4:
            cc = CC[y]
            return I(1, f"ret {cc}", "ret", cycles=8, cycles_taken=20, cond=cc,
                     reads=frozenset(CC_FLAG[cc]), flow="cexit")
        if y == 4:
            n = d8()
            return I(2, f"ldh (${n:02X}),a", "st_a16_a", (0xFF00 | n,), 12)
        if y == 5:
            return I(2, f"add sp,{e8()}", "add_sp_e", (e8(),), 16, writes=ALL_FLAGS)
        if y == 6:
            n = d8()
            return I(2, f"ldh a,(${n:02X})", "ld_a_a16", (0xFF00 | n,), 12)
        return I(2, f"ld hl,sp{e8():+d}", "ld_hl_sp_e", (e8(),), 12, writes=ALL_FLAGS)
    if z == 1:
        if q == 0:
            return I(1, f"pop {RP2[p]}", "pop", (RP2[p],), 12,
                     writes=ALL_FLAGS if p == 3 else frozenset())
        if p == 0:
            return I(1, "ret", "ret", cycles=16, flow="exit")
        if p == 1:
            return I(1, "reti", "reti", cycles=16, flow="exit")
        if p == 2:
            return I(1, "jp hl", "jp_hl", flow="exit")
        return I(1, "ld sp,hl", "ld_sp_hl", cycles=8)
    if z == 2:
        if y < 4:
            cc, n = CC[y], d16()
            return I(3, f"jp {cc},${n:04X}", "jp", cycles=12, cycles_taken=16, target=n,
                     cond=cc, reads=frozenset(CC_FLAG[cc]), flow="branch")
        if y == 4:
            return I(1, "ld ($ff00+c),a", "st_c_a", cycles=8)
        if y == 5:
            n = d16()
            return I(3, f"ld (${n:04X}),a", "st_a16_a", (n,), 16)
        if y == 6:
            return I(1, "ld a,($ff00+c)", "ld_a_c", cycles=8)
        n = d16()
        return I(3, f"ld a,(${n:04X})", "ld_a_a16", (n,), 16)
    if z == 3:
        if y == 0:
            n = d16()
            return I(3, f"jp ${n:04X}", "jp", cycles=16, target=n, flow="jump")
        if y == 6:
            return I(1, "di", "di")
        if y == 7:
            return I(1, "ei", "ei")
    if z == 4:
        cc, n = CC[y], d16()
        return I(3, f"call {cc},${n:04X}", "call", cycles=12, cycles_taken=24, target=n,
                 cond=cc, reads=frozenset(CC_FLAG[cc]), flow="cexit")
    if z == 5:
        if q == 0:
            return I(1, f"push {RP2[p]}", "push", (RP2[p],), 16,
                     reads=ALL_FLAGS if p == 3 else frozenset())
        n = d16()
        return I(3, f"call ${n:04X}", "call", cycles=24, target=n, flow="exit")
    if z == 6:
        return _alu(I, ALU[y], d8(), 2, 8)
    # z == 7
    return I(1, f"rst ${y * 8:02X}", "call", cycles=16, target=y * 8, flow="exit")


def _alu(I, name, src, length, cycles):
    text = f"{name} a,{src if isinstance(src, str) else f'${src:02X}'}"
    reads = frozenset("c") if name in ("adc", "sbc") else frozenset()
    return I(length, text, "alu", (name, src), cycles, reads=reads, writes=ALL_FLAGS)


def _decode_cb(addr, op):
    x, y, z = op >> 6, (op >> 3) & 7, op & 7
    reg = R[z]
    hl = reg == "(hl)"
    if x == 0:
        name = ROT[y]
        reads = frozenset("c") if name in ("rl", "rr") else frozenset()
        ins = Instr(addr, 2, f"{name} {reg}", "cb_rot", (name, reg), 16 if hl else 8,
                    reads=reads, writes=ALL_FLAGS)
    elif x == 1:
        ins = Instr(addr, 2, f"bit {y},{reg}", "cb_bit", (y, reg), 12 if hl else 8,
                    writes=frozenset("znh"))
    else:
        name = "res" if x == 2 else "set"
        ins = Instr(addr, 2, f"{name} {y},{reg}", "cb_" + name, (y, reg), 16 if hl else 8)
    ins.raw = bytes((0xCB, op))
    return ins
