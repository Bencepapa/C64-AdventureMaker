# C64 Adventure Maker

A data-driven point-and-click adventure maker for the C64 and HTML5. The C64
engine is written in C with Oscar64 and uses a 1351 mouse or joystick through
the included MOUSEGUI driver. Items, rooms, doors, interactions and animated
PETSCII graphics are authored in the browser editor and saved as JSON. The same
JSON runs directly in the HTML5 player or is packed into the C64 program.

```
editor (browser) ──save──> game/<name>.json ───────> HTML5 player
                                  │
                                  └──tools/pack.py──> build/game.bin
                                                          │ #embed
src/*.c + vendored MOUSEGUI driver ──Oscar64──> out/*.prg / *.d64
```

## Quick start (Windows)

Python 3 and PowerShell are required. Install the pinned Oscar64 and VICE
toolchain locally into the ignored `.tools/` directory:

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup.ps1
```

No administrator access or global installation is needed. Start the editor:

```bash
python editor/server.py
```

Open http://127.0.0.1:8064/ for the editor or
http://127.0.0.1:8064/player/ for the HTML5 player.

- **Save** writes `game/<name>.json`; the old file goes to the ignored `game/backups/`.
- **Validate** checks and packs the C64 game data.
- **Build** produces `out/advgui_vdev.prg` and `out/advgui_vdev.d64`.
- **Build & run in VICE** starts VICE with a 1351 mouse in port 2.
- **Play HTML5** saves and launches the same JSON in the web player.

To build without the editor:

```bash
python build.py 1 game/demo.json
```

This writes `out/advgui_v1.prg` and `out/advgui_v1.d64`. The MOUSEGUI driver is
built automatically from `vendor/mousegui/`.

`setup.ps1` installs Oscar64 v1.32.273 and VICE 3.10. Existing installations
can be used through `PATH` or these variables:

| Variable | Tool |
|---|---|
| `ADVGUI_OSCAR64` | Oscar64 compiler or containing directory |
| `ADVGUI_C1541` | VICE `c1541` or containing directory |
| `ADVGUI_X64SC` | VICE `x64sc` or containing directory |
| `ADVGUI_CHARGEN` | VICE `chargen-901225-01.bin` or containing directory |

The Commodore character ROM is loaded from VICE and is not redistributed here.
Oscar64 and VICE remain under their respective third-party licenses.

`game/demo.json` is the authoritative sample adventure. It can be edited and
played on both targets without an export or format conversion step.

## Playing

Screen layout:

| Rows | Contents |
|---|---|
| 0–1 | Description, black on white. Longer texts are paged: a blinking `>`/`)` marks more, click the text to continue. |
| 2–17 | Playfield 25×14 on the left (room name in the frame), inventory with 12 slots on the right |
| 18–24 | Portrait, name, HP and MP bars, ATTACK and SEARCH buttons, the hover line (`> NAME`), a hint |

| Action | Result |
|---|---|
| Click an object | Its description. A door leads to another room (or shows its "locked" text). |
| Right click | Look (description) |
| Drag a floor object into the inventory | Take it (onto an inventory item: combine if a rule exists, else take) |
| Drag an item onto another item | Combine: works in the inventory, on the floor, and between the two |
| Drag an item onto a room object | Use it on the object (falls back to combine) |
| Drag an item onto the portrait or the HP/MP bars | Use it on the hero (eat, drink, …) |
| Drag onto the floor | Drop or move it |
| Hover the HP / MP bar | Exact value, e.g. `> HP 10/15` |
| ATTACK / SEARCH | Fight the enemy in the room with the best weapon carried (bare hands = 1) / search the room |

Feedback:
- The pointer changes over anything clickable and while dragging.
- The dragged source is dimmed, and the drop target turns yellow (the whole portrait for hero drops).
- Buttons look pressed while held.

**Demo** (`game/demo.json`, four rooms):
1. **Cellar:** STICK + CLOTH = RAG STICK, then + OIL = TORCH, in the inventory or on the floor. A torch lights the room whether you carry it or it lies on the floor. In the dark the door can't be found.
2. With the light, SEARCH reveals the KEY. KEY on CHEST reveals the GOLD. Taking it no longer ends the game.
3. **Hall:** the apple can be eaten by dropping it on the portrait. SEARCH finds a CRANK under the table. A second door leads to the gates.
4. **The gates:** the gate is locked. Use the CRANK on the WINCH: the winch shows the crank, the gate turns into an open gate, and the `gate_open` flag unlocks it.
5. **Wilderness:** every PATH leads back to the same wilderness, with alternating "lost" messages. Only the TRAIL goes back to the gates.

The RAT can be fought: ATTACK uses the best weapon carried (STICK 2, RAG STICK 2, TORCH 3, CRANK 2, bare hands 1). Dragging a weapon onto it uses that item's own rule. It leaves a BONE.

There is no ending at the moment, because taking the gold used to end the game. Add one with an `end` action wherever you want it.

## The editor

| Tab | What you edit |
|---|---|
| **Game & player** | Title, intro text, hero name, description, HP/MP, start room, 5×5 portrait |
| **Items** | Id, name, description, flags (*pickable*, *light source*, *enemy* + HP), *attack power* (ATTACK damage while carried), the room graphic (up to 8×6, frames + delay) and the inventory icon (1×1, frames). A "Used in" list shows where the item appears. |
| **Rooms & doors** | Id, name, description (shown on entering), the 25×14 background, an optional **lit background** (shown while the hero carries a light source). **Place objects** mode: pick an item, click to place it, drag to move it, click to select it. An object can be *hidden* (revealed by an action) or a **door**: target room, optional lock flag, locked message. A list shows all door connections. |
| **Interactions** | The rule list: trigger, item/room A and B, conditions, actions (see below). The first matching rule runs, so order matters. |

**PETSCII editor**, used everywhere:
- **Palette:** the 256 screen codes (128–255 are reversed) and 16 colours.
- **Tools:** draw, colour only, pick, type text, clear. The right button erases.
- **Frames:** duplicate, delete, reorder, delay (in 1/60 s), play preview.
- **Size:** set for room graphics.

The character images come from VICE's `chargen` ROM, served by the editor server.

**Text counters** show how many 2×38-character pages a text needs on the C64.
Ids are renamed everywhere they are used. Ctrl+Z undoes, Ctrl+S saves.
Deleting something that is in use, and removing a lit background, ask for a second click; the editor uses no browser dialogs, so it works in embedded browsers.
Colours use the Colodore palette, which is close to a real C64. VICE's default palette can differ; choose "colodore" in VICE's video settings to match.

### Interactions

| Trigger | When | A | B |
|---|---|---|---|
| `combine` | item A dropped on item B, in the inventory or on the floor (the engine also tries B+A) | item | item |
| `use` | item A (inventory or floor) dropped on room object B | item | item |
| `use_player` | item A dropped on the portrait / HP / MP | item | – |
| `click` | room object B clicked (runs before the default door/description) | – | item |
| `look` | right click on B | – | item |
| `attack` | ATTACK button, B = first enemy in the room | – | item |
| `defeat` | enemy B reaches 0 HP | – | item |
| `search` | SEARCH button in room A | room | – |
| `enter` | entering room A (and at the start) | room | – |
| `take` | item A was taken into the inventory | item | – |

A and B can be "any".

**Conditions:** flag set / not set, hero has / doesn't have an item, lit / not
lit (a light-source item is carried or lies in the room), current room is.

**Actions:**
- **Messages and flags:** show message, set/clear flag, end the game with a message.
- **Items:** remove A (the dragged item), remove target B, turn A or B into another item, **swap** (every item X in this room becomes Y: a winch opening a gate), give an item, spawn an item in the room at x,y, reveal hidden objects. A and B work wherever they are, in the inventory or on the floor.
- **Hero and enemies:** change HP/MP, enemy hits back for 1..n (with its message, skipped when the enemy was just defeated), damage the target by n (**0 = the hero's best weapon**; at 0 HP its `defeat` rule runs).
- **Movement:** go to a room. When the actions show a message, it replaces the new room's description.

The messages of all actions are joined. Without a matching rule the engine
uses defaults:
- clicking an object shows its description, or goes through a door;
- combining shows "THAT DOES NOT WORK.";
- ATTACK does damage with the best weapon carried;
- a defeated enemy without a `defeat` rule disappears.

### Doors and paths

A door is any room object with the *door* box ticked, so it can look like a
door, a gate or a path. Clicking it goes to the target room unless its lock
flag is not set yet. A `click` rule on the item runs first and can replace
that. The wilderness paths use this: their rule shows a message and does a
`goto` back to the same room. A gate that opens is two items, closed and open,
exchanged by a `swap` action. The door settings belong to the object, so they
are kept when the item changes.

## Data format

| Stage | Format |
|---|---|
| **JSON** (`game/*.json`, editor) | `{title, intro, player{name, desc, hp, hpmax, mp, mpmax, start, avatar}, items[{id, name, desc, pickable, light, enemy, hp, power, glyph, icon}], rooms[{id, name, desc, dark, lit, objects[{item, x, y, hidden, door{to, flag, locked}}]}], rules[{trigger, a, b, if[], do[]}]}`. A graphic is `{w, h, delay, frames[{ch[], co[]}]}`. A background is `{ch[350], co[350]}`. |
| **Binary** (`build/game.bin`) | Described at the top of `tools/pack.py`: a header with counts and offsets, fixed-size item/room/object records, variable-size rules, graphics as raw frames, backgrounds RLE-compressed. Item ids start at 1 (0 = none, 255 = any), flags are collected from their names. The demo is 6.6 KB. |
| **HTML5** (`player/`) | Reads the JSON directly and renders its screen codes with the same C64 character ROM and Colodore palette as the editor. No separate web export is needed. |

Limits:
- 12 objects per room (on screen at once) and 96 objects at run time;
- 254 items, 255 flags, 12 inventory slots;
- room graphic 8×6, icon 1×1, portrait 5×5;
- 32 KB of game data.

## Engine (`src/`)

| File | Contents |
|---|---|
| `game.c` | Data access, drawing (RLE background, objects, inventory, stats), hot areas, animation (jiffy clock `$A2`, per graphic frame delay), the rule interpreter (`run_rules` → `conds_ok` → `exec`), event loop, message paging |
| `mousegui.h/.c` | Driver interface. `mg_install()` copies the embedded driver to `$C000` and runs it, which clears the area tables, so areas are defined after it. |
| `screen.h/.c` | Screen helpers. They draw into a shadow copy of screen and colour RAM, and `scr_present()` copies only the changed rows to the real screen once per loop. A redraw therefore never shows the bare background under the objects. |

## Repository contents

| Path | Purpose |
|---|---|
| `game/demo.json` | Editable sample adventure and common C64/HTML5 game format |
| `editor/` | Browser editor and local Python server |
| `player/` | HTML5 PETSCII game engine |
| `src/` | C64 game engine source |
| `tools/pack.py` | JSON-to-C64 binary packer; only Python 3 is required |
| `vendor/mousegui/` | Minimal source of the embedded mouse/joystick driver |
| `tools/setup.ps1` | Local Oscar64 and VICE installer |
| `tests/` | HTML5 smoke test |

Generated files are written to `build/` and `out/` and are not versioned.
Publish PRG and D64 builds as GitHub Release assets rather than source files.

## Testing

Install the optional browser-test dependency and Chromium once:

```bash
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
```

With the editor server running, execute `python tests/player_smoke.py`.

## License

The Adventure Maker and vendored MOUSEGUI source are available under the MIT
License. See `LICENSE`. Oscar64 is GPL-3.0 and VICE is GPL-2.0; neither project
is included in this repository.

Hot areas (32):

| Area | Use |
|---|---|
| 0–11 | inventory slots |
| 12, 13 | ATTACK, SEARCH |
| 14 | portrait |
| 15–26 | room objects |
| 27, 28 | HP and MP bars (hover + drop) |
| 29 | description (click for the next page) |
| 30 | inventory panel |
| 31 | playfield |

Memory:
- PRG at `$0801` (19 KB with the four-room demo).
- Oscar64 heap/stack up to `$A000`.
- Driver at `$C000`, pointer sprites at `$0340`.

## Oscar64 pitfalls

Oscar64 1.32.273 at `-O2` miscompiled two patterns in this engine:
- An inlined 16-bit table read gave the wrong high byte, so item names and
  rules pointed to the wrong place. All such reads now go through the
  non-inlined `rd16()`.
- A `slot != 255 ? inv[slot] : ...` test was removed as "always true", because
  the compiler assumes `slot` is inside `inv[]`. Tests that guard an array
  index now compare with the array size (`s < NSLOTS`, `k < MAXINST`), and
  `thing()` is not inlined.

If something behaves impossibly, check the generated `build/advgui.asm`.

## Later: character graphics

The editor draws through a 256-character sheet built from the character ROM
(`loadCharset` → `sheets`). A char editor can replace that sheet with a game's
own charset, stored as a `charset` field (2 KB) in the JSON. The engine would
copy it to RAM and point `$D018` at it. The packer ignores unknown JSON
fields, so the field can be added without breaking existing games. The engine
and the packer still need the code to use it.

## Verification (v4)

VICE 3.9, with the same simulated input as below:
- STICK and CLOTH combined on the floor into a RAG STICK; OIL dropped on it on the floor gave a TORCH there, and the cellar turned lit.
- With the torch carried, one ATTACK defeated the rat (power 3), and "it bites you back" was skipped.
- The hall SEARCH found the CRANK. The gate said it was locked; CRANK on WINCH opened it.
- The wilderness paths looped with alternating messages, and the TRAIL led back to the gates.

## Verification (v2)

| Where | What was checked |
|---|---|
| VICE 3.9, remote monitor | Pointer moved with the driver's warp registers; buttons faked by pointing its port reads at RAM. Played through: crafting (inventory animation, lit room), the `HP 10/15` hover, torch on the portrait (yellow highlight, HP loss), a paged description (`>` then the second page), SEARCH → KEY, the door to the HALL and back, the apple eaten via the portrait (HP up), KEY → CHEST → GOLD → the end. The rat's frames and the torch's flicker change on screen. |
| Editor, in the browser | Loaded the demo, viewed all tabs, selected objects and doors, built from the button. An intro text edited in the editor appeared in the C64 build. |
| Not checked | Real host mouse in VICE. In the PETSCII editor only picking a character and drawing one cell were tried, not frames or the text tool. |
