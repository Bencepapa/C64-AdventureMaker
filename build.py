"""Pack a game and build the C64 PRG/D64 with the local or configured tools.

usage: python build.py [version] [game.json]
"""
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'tools'))
from build_mousegui import build as build_mousegui
from pack import PackError, pack_file
from toolchain import c1541, oscar64


version = sys.argv[1] if len(sys.argv) > 1 else 'dev'
game = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / 'game' / 'demo.json'
build_dir = ROOT / 'build'
out_dir = ROOT / 'out'
build_dir.mkdir(exist_ok=True)
out_dir.mkdir(exist_ok=True)

build_mousegui(build_dir / 'mousegui.prg')
try:
    blob, packer = pack_file(game, build_dir / 'game.bin')
except PackError as error:
    raise SystemExit(f'game data error: {error}') from error
for warning in packer.warnings:
    print('warning:', warning)
print(f'game data: {len(blob)} bytes')

prg = build_dir / 'advgui.prg'
subprocess.run([oscar64(), '-n', '-O2', '-o=' + str(prg), str(ROOT / 'src' / 'game.c')], check=True)
out_prg = out_dir / f'advgui_v{version}.prg'
shutil.copyfile(prg, out_prg)

d64 = out_dir / f'advgui_v{version}.d64'
if d64.exists():
    d64.unlink()
subprocess.run([c1541(), '-format', f'advgui v{version},ag', 'd64', str(d64),
                '-write', str(prg), 'advgui'], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(f'{out_prg} ({prg.stat().st_size - 2} bytes), {d64}')
