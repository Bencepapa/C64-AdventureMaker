"""Locate the optional C64 toolchain without machine-specific paths."""
from pathlib import Path
import os
import shutil


ROOT = Path(__file__).resolve().parents[1]
LOCAL_TOOLS = ROOT / '.tools'


def _from_env(name, filenames):
    value = os.environ.get(name)
    if not value:
        return None
    path = Path(value).expanduser()
    if path.is_file():
        return path
    if path.is_dir():
        for filename in filenames:
            matches = list(path.rglob(filename))
            if matches:
                return matches[0]
    return None


def find_tool(env_name, *filenames, required=True):
    path = _from_env(env_name, filenames)
    if not path:
        for filename in filenames:
            found = shutil.which(filename)
            if found:
                path = Path(found)
                break
    if not path and LOCAL_TOOLS.exists():
        for filename in filenames:
            matches = list(LOCAL_TOOLS.rglob(filename))
            if matches:
                path = matches[0]
                break
    if path:
        return str(path.resolve())
    if required:
        names = ', '.join(filenames)
        raise FileNotFoundError(
            f'Could not find {names}. Run tools/setup.ps1 or set {env_name}.')
    return None


def oscar64(required=True):
    return find_tool('ADVGUI_OSCAR64', 'oscar64.exe', 'oscar64', required=required)


def c1541(required=True):
    return find_tool('ADVGUI_C1541', 'c1541.exe', 'c1541', required=required)


def x64sc(required=True):
    return find_tool('ADVGUI_X64SC', 'x64sc.exe', 'x64sc', required=required)


def chargen(required=True):
    return find_tool('ADVGUI_CHARGEN', 'chargen-901225-01.bin', 'chargen', required=required)
