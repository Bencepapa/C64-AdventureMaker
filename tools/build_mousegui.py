"""Build the vendored MOUSEGUI driver used by the C64 engine."""
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor' / 'mousegui'
sys.path.insert(0, str(VENDOR / 'tools'))
from asm6502 import assemble, to_prg


ARROW = """
X...........
XX..........
XXX.........
XXXX........
XXXXX.......
XXXXXX......
XXXXXXX.....
XXXXXXXX....
XXXXXXXXX...
XXXXXX......
XX.XXX......
X...XXX.....
....XXX.....
.....XXX....
.....XXX....
"""
BANG = """
XX
XX
XX
XX
XX
XX
..
XX
XX
"""


def grid(art):
    return art.strip().splitlines()


def blank():
    return [[0] * 24 for _ in range(21)]


def put(image, art, ox, oy):
    for y, row in enumerate(grid(art)):
        for x, char in enumerate(row):
            if char == 'X':
                image[oy + y][ox + x] = 1


def put_cleared(image, art, ox, oy):
    for y, row in enumerate(grid(art)):
        for x, char in enumerate(row):
            if char != 'X':
                continue
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = oy + y + dy, ox + x + dx
                    if 0 <= yy < 21 and 0 <= xx < 24:
                        image[yy][xx] = 0
    put(image, art, ox, oy)


def shapes_asm():
    images = [blank(), blank(), blank()]
    put(images[0], ARROW, 0, 0)
    put(images[1], ARROW, 0, 0)
    put(images[1], BANG, 12, 1)
    x0, y0, x1, y1 = 6, 7, 23, 19
    for x in range(x0, x1 + 1):
        images[2][y0][x] = images[2][y1][x] = 1
    for y in range(y0, y1 + 1):
        images[2][y][x0] = images[2][y][x1] = 1
    for y in (10, 13, 16):
        for x in range(x0 + 3, x1 - 2):
            images[2][y][x] = int((x - x0) % 4 != 3)
    put_cleared(images[2], ARROW, 0, 0)
    lines = []
    for number, image in enumerate(images):
        lines.append(f'; shape {number}')
        for row in image:
            values = [f'%{"".join(map(str, row[k * 8:k * 8 + 8]))}' for k in range(3)]
            lines.append('        .byte ' + ','.join(values))
        lines.append('        .byte 0')
    return '\n'.join(lines) + '\n'


def build(destination=None):
    destination = Path(destination or ROOT / 'build' / 'mousegui.prg')
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = (VENDOR / 'mousegui.asm').read_text(encoding='utf8')
    output, _, _ = assemble(source.replace(';@SHAPES', shapes_asm()))
    prg, low, high = to_prg(output)
    if low != 0xC000 or high >= 0xD000:
        raise RuntimeError(f'MOUSEGUI outside $C000-$CFFF: ${low:04X}-${high:04X}')
    destination.write_bytes(prg)
    print(f'{destination}: ${low:04X}-${high:04X} ({high - low + 1} bytes)')
    return destination


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else None)
