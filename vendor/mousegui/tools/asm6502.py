"""Small 2-pass 6502 assembler (64tass-like subset).

usage: python asm6502.py src.asm out.prg [listing.txt]

Syntax:
  label:            label (colon required); 'label = expr' defines a constant
  * = expr          set program counter (the first one is the PRG load address)
  .byte e,e,"txt"   bytes (strings are copied as raw ASCII)
  .word e,e         16-bit little endian
  .fill n[,v]       n bytes of value v (default 0)
  ; comment
Expressions: numbers ($hex, %bin, decimal, 'c'), labels, * (current pc),
  + - * / & | ^ << >> ( ), unary - < (low byte) > (high byte).
Zero-page addressing is used when the operand value is < $100 and known
in pass 1 (i.e. defined above the line); the size chosen in pass 1 is kept.
"""
import re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dis6502 import ops

OPC = {(m, a): op for op, (m, a) in ops.items()}
MNEM = {m for m, a in ops.values()}
BR = {'BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ'}


class AsmError(Exception):
    pass


def tokenize(s):
    toks = []
    i = 0
    while i < len(s):
        c = s[i]
        if c.isspace():
            i += 1
        elif c == '$':
            m = re.match(r'\$[0-9A-Fa-f]+', s[i:]); toks.append(('n', int(m.group()[1:], 16))); i += len(m.group())
        elif c == '%':
            m = re.match(r'%[01]+', s[i:]); toks.append(('n', int(m.group()[1:], 2))); i += len(m.group())
        elif c.isdigit():
            m = re.match(r'\d+', s[i:]); toks.append(('n', int(m.group()))); i += len(m.group())
        elif c == "'" and i + 2 < len(s) and s[i + 2] == "'":
            toks.append(('n', ord(s[i + 1]))); i += 3
        elif c.isalpha() or c == '_':
            m = re.match(r'\w+', s[i:]); toks.append(('s', m.group())); i += len(m.group())
        elif s[i:i + 2] in ('<<', '>>'):
            toks.append(('o', s[i:i + 2])); i += 2
        elif c in '+-*/&|^()<>':
            toks.append(('o', c)); i += 1
        else:
            raise AsmError(f'bad char {c!r} in expression {s!r}')
    return toks


def evaluate(s, sym, pc, strict):
    """returns (value, known)"""
    toks = tokenize(s)
    pos = [0]
    known = [True]

    def peek():
        return toks[pos[0]] if pos[0] < len(toks) else (None, None)

    def take():
        t = peek(); pos[0] += 1; return t

    def atom():
        t, v = take()
        if t == 'n':
            return v
        if t == 's':
            if v in sym:
                return sym[v]
            if strict:
                raise AsmError(f'undefined symbol {v}')
            known[0] = False
            return 0x1000  # placeholder (absolute-sized)
        if t == 'o' and v == '(':
            r = expr(0)
            if take() != ('o', ')'):
                raise AsmError(f'missing ) in {s!r}')
            return r
        if t == 'o' and v == '*':
            return pc
        if t == 'o' and v == '-':
            return -atom()
        if t == 'o' and v == '<':
            return expr(5) & 0xFF
        if t == 'o' and v == '>':
            return (expr(5) >> 8) & 0xFF
        raise AsmError(f'syntax error in {s!r}')

    PREC = {'|': 1, '^': 2, '&': 3, '<<': 4, '>>': 4, '+': 5, '-': 5, '*': 6, '/': 6}

    def expr(minp):
        left = atom()
        while True:
            t, v = peek()
            if t != 'o' or v not in PREC or PREC[v] < minp:
                return left
            take()
            right = expr(PREC[v] + 1)
            left = {'|': lambda a, b: a | b, '^': lambda a, b: a ^ b, '&': lambda a, b: a & b,
                    '<<': lambda a, b: a << b, '>>': lambda a, b: a >> b, '+': lambda a, b: a + b,
                    '-': lambda a, b: a - b, '*': lambda a, b: a * b, '/': lambda a, b: a // b}[v](left, right)

    v = expr(0)
    if pos[0] != len(toks):
        raise AsmError(f'trailing junk in {s!r}')
    return v, known[0]


def split_args(a):
    out, cur, q = [], '', False
    for c in a:
        if c == '"':
            q = not q
        if c == ',' and not q:
            out.append(cur.strip()); cur = ''
        else:
            cur += c
    if cur.strip():
        out.append(cur.strip())
    return out


def strip_comment(line):
    q = False
    for i, c in enumerate(line):
        if c == '"':
            q = not q
        if c == ';' and not q:
            return line[:i]
    return line


def assemble(src):
    sym = {}
    sizes = {}
    for p2 in (False, True):
        pc = None
        out = {}  # addr -> byte
        listing = []
        for ln, raw in enumerate(src.splitlines(), 1):
            line = strip_comment(raw).rstrip()
            if not line.strip():
                continue
            try:
                ev = lambda e: evaluate(e, sym, pc, p2)
                m = re.match(r'^\s*(\w+)\s*=\s*(.+)$', line)
                if m:
                    v, k = ev(m.group(2))
                    if not k and not p2:
                        raise AsmError('constant must be defined before use: ' + m.group(1))
                    sym[m.group(1)] = v
                    continue
                m = re.match(r'^\s*\*\s*=\s*(.+)$', line)
                if m:
                    pc = ev(m.group(1))[0]
                    continue
                m = re.match(r'^\s*(\w+):(.*)$', line)
                if m:
                    name = m.group(1)
                    if not p2 and name in sym:
                        raise AsmError('duplicate label ' + name)
                    sym[name] = pc
                    line = m.group(2)
                    if not line.strip():
                        continue
                parts = line.strip().split(None, 1)
                mn = parts[0].upper()
                arg = parts[1].strip() if len(parts) > 1 else ''
                start = pc
                if mn == '.BYTE':
                    b = bytearray()
                    for a in split_args(arg):
                        if a.startswith('"'):
                            b += a[1:-1].encode('latin1')
                        else:
                            b.append(ev(a)[0] & 0xFF)
                elif mn == '.WORD':
                    b = bytearray()
                    for a in split_args(arg):
                        v = ev(a)[0] & 0xFFFF; b += bytes([v & 255, v >> 8])
                elif mn == '.FILL':
                    a = split_args(arg)
                    n = ev(a[0])[0]
                    v = ev(a[1])[0] if len(a) > 1 else 0
                    b = bytes([v & 255]) * n
                elif mn in MNEM:
                    b = encode(mn, arg, ev, pc, ln, sizes, p2)
                else:
                    raise AsmError('unknown mnemonic ' + mn)
                for i, x in enumerate(b):
                    if p2 and (pc + i) in out:
                        raise AsmError(f'overlap at ${pc + i:04X}')
                    out[pc + i] = x
                pc += len(b)
                if p2:
                    listing.append(f'{start:04X}  {" ".join(f"{x:02X}" for x in b[:3]):9} {raw.rstrip()}')
            except AsmError as e:
                raise AsmError(f'line {ln}: {e}\n  {raw.strip()}')
    return out, sym, listing


def encode(mn, arg, ev, pc, ln, sizes, p2):
    if mn in BR:
        t = ev(arg)[0]
        d = t - (pc + 2)
        if p2 and not -128 <= d <= 127:
            raise AsmError(f'branch out of range ({d})')
        return bytes([OPC[(mn, 'rel')], d & 255])
    if arg == '':
        return bytes([OPC[(mn, 'imp')] if (mn, 'imp') in OPC else OPC[(mn, 'acc')]])
    if arg.upper() == 'A':
        return bytes([OPC[(mn, 'acc')]])
    if arg.startswith('#'):
        return bytes([OPC[(mn, 'imm')], ev(arg[1:])[0] & 255])
    u = arg.upper().replace(' ', '')
    if u.startswith('(') and u.endswith(',X)'):
        return bytes([OPC[(mn, 'izx')], ev(arg[1:arg.upper().rindex(',X')])[0] & 255])
    if u.startswith('(') and u.endswith('),Y'):
        return bytes([OPC[(mn, 'izy')], ev(arg[1:arg.rindex(')')])[0] & 255])
    if mn == 'JMP' and u.startswith('(') and u.endswith(')'):
        v = ev(arg[1:-1])[0]
        return bytes([OPC[(mn, 'ind')], v & 255, (v >> 8) & 255])
    idx = ''
    if u.endswith(',X'):
        idx = 'x'; arg = arg[:arg.upper().rindex(',X')]
    elif u.endswith(',Y'):
        idx = 'y'; arg = arg[:arg.upper().rindex(',Y')]
    v, known = ev(arg)
    zm = {'': 'zp', 'x': 'zpx', 'y': 'zpy'}[idx]
    am = {'': 'abs', 'x': 'abx', 'y': 'aby'}[idx]
    if not p2:
        sizes[ln] = 2 if (known and 0 <= v < 256 and (mn, zm) in OPC) else 3
    if sizes[ln] == 2:
        return bytes([OPC[(mn, zm)], v & 255])
    if (mn, am) not in OPC:
        raise AsmError(f'addressing mode not available for {mn}')
    return bytes([OPC[(mn, am)], v & 255, (v >> 8) & 255])


def to_prg(out):
    lo, hi = min(out), max(out)
    data = bytearray(out.get(a, 0) for a in range(lo, hi + 1))
    return bytes([lo & 255, lo >> 8]) + bytes(data), lo, hi


if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf8').read()
    try:
        out, sym, listing = assemble(src)
    except AsmError as e:
        print('error:', e); sys.exit(1)
    prg, lo, hi = to_prg(out)
    open(sys.argv[2], 'wb').write(prg)
    if len(sys.argv) > 3:
        with open(sys.argv[3], 'w') as f:
            f.write('\n'.join(listing) + '\n\n')
            for k in sorted(sym, key=lambda k: sym[k]):
                f.write(f'{k:12} = ${sym[k]:04X}  {sym[k]}\n')
    print(f'{sys.argv[2]}: ${lo:04X}-${hi:04X} ({hi - lo + 1} bytes)')
