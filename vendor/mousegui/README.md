# MOUSEGUI

This directory contains only the source needed by C64 Adventure Maker:

- `mousegui.asm`: 1351 mouse/joystick pointer and 32 hot-area driver.
- `tools/asm6502.py`: small two-pass assembler used to build the driver.
- `tools/dis6502.py`: 6502 opcode table imported by the assembler.

`tools/build_mousegui.py` adds the generated pointer sprites and writes
`build/mousegui.prg`. The driver is then embedded in the C64 game at build time.

The source is covered by the repository's MIT License.
