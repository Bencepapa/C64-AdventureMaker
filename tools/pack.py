"""Pack an ADVGUI game (JSON, written by the editor) into the binary the engine embeds.

usage: python pack.py game.json out.bin
Prints warnings (long texts, too many objects) and fails on hard errors.

Binary layout (all offsets 16-bit little endian, from the start of the blob):
  header  'A','G', version, nitems, nrooms, nrules, nflags, ninst,
          items, rooms, rules, player, insts, intro, title          (offsets)
  item    name, desc, flags(1 pick,2 light,4 enemy), hp, glyph, icon, power  (11 bytes)
  graphic w, h, nframes, delay, then per frame w*h chars + w*h colours
  room    name, desc, dark background, lit background (0 = none)     (8 bytes)
  bg      RLE (count, value) pairs: 350 screen codes, then 350 colours (25x14)
  inst    room, item, x, y, flags(1 hidden), door_to, door_flag, locked_msg(2)  (9 bytes)
  rule    trigger, a, b, ncond, nact, ncond*(type,arg), nact*(type,p1,p2lo,p2hi)
          (p2 = string offset for msg/end/hurt, x/y for spawn)
  player  name, desc, hp, hpmax, mp, mpmax, start room, avatar graphic
Item numbers start at 1 (0 = none), 255 = any. Rooms and flags start at 0.
"""
import json, sys

PF_W, PF_H = 25, 14
MAX_ROOM_OBJ = 12
MAX_INSTANCES = 96
VERSION = 1

TRIGGERS = {'combine': 1, 'use': 2, 'use_player': 3, 'click': 4, 'attack': 5,
            'defeat': 6, 'search': 7, 'enter': 8, 'look': 9, 'take': 10}
CONDS = {'flag': 1, 'not_flag': 2, 'has': 3, 'not_has': 4, 'lit': 5, 'not_lit': 6, 'in_room': 7}
ACTIONS = {'msg': 1, 'set_flag': 2, 'clear_flag': 3, 'remove_a': 4, 'remove_target': 5,
           'replace_target': 6, 'replace_a': 7, 'give': 8, 'spawn': 9, 'reveal': 10,
           'hp': 11, 'hurt': 12, 'damage': 13, 'mp': 14, 'goto': 15, 'end': 16, 'swap': 17}
# which parameter each action uses
ACTION_ARGS = {'msg': 'text', 'set_flag': 'flag', 'clear_flag': 'flag', 'replace_target': 'item',
               'replace_a': 'item', 'give': 'item', 'spawn': 'item', 'reveal': 'item_any',
               'hp': 'n', 'hurt': 'n', 'damage': 'n', 'mp': 'n', 'goto': 'room', 'end': 'text',
               'swap': 'item'}   # swap: every 'item' in the room becomes 'to'
TEXT_OK = set(' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?\'"-:;()/+*=<>#$%&@')


class PackError(Exception):
    pass


class Packer:
    def __init__(self, game):
        self.g = game
        self.blob = bytearray(32)          # header placeholder
        self.strings = {}
        self.warnings = []
        self.item_ix = {it['id']: i + 1 for i, it in enumerate(game['items'])}
        self.room_ix = {r['id']: i for i, r in enumerate(game['rooms'])}
        self.flags = []

    def warn(self, msg):
        self.warnings.append(msg)

    def flag(self, name):
        if not name:
            raise PackError('empty flag name')
        if name not in self.flags:
            self.flags.append(name)
        return self.flags.index(name)

    def item(self, iid, where, allow_any=False):
        if allow_any and iid in (None, '', '*'):
            return 255
        if iid not in self.item_ix:
            raise PackError(f'{where}: unknown item "{iid}"')
        return self.item_ix[iid]

    def room(self, rid, where):
        if rid not in self.room_ix:
            raise PackError(f'{where}: unknown room "{rid}"')
        return self.room_ix[rid]

    def here(self):
        return len(self.blob)

    def string(self, s, where=''):
        s = (s or '').upper()
        bad = set(s) - TEXT_OK
        if bad:
            self.warn(f'{where}: characters {"".join(sorted(bad))!r} replaced by spaces')
            s = ''.join(c if c in TEXT_OK else ' ' for c in s)
        if s in self.strings:
            return self.strings[s]
        off = self.here()
        self.blob += s.encode('ascii') + b'\0'
        self.strings[s] = off
        return off

    def graphic(self, g, where, max_w=25, max_h=14):
        w, h = int(g['w']), int(g['h'])
        frames = g.get('frames') or []
        if not (1 <= w <= max_w and 1 <= h <= max_h):
            raise PackError(f'{where}: size {w}x{h} out of range (max {max_w}x{max_h})')
        if not frames:
            raise PackError(f'{where}: no frames')
        off = self.here()
        self.blob += bytes([w, h, len(frames), max(1, min(255, int(g.get('delay', 30))))])
        for k, f in enumerate(frames):
            ch, co = f['ch'], f['co']
            if len(ch) != w * h or len(co) != w * h:
                raise PackError(f'{where}: frame {k} has {len(ch)} cells, expected {w * h}')
            self.blob += bytes(c & 255 for c in ch) + bytes(c & 15 for c in co)
        return off

    def background(self, bg, where):
        off = self.here()
        for key in ('ch', 'co'):
            data = bg[key]
            if len(data) != PF_W * PF_H:
                raise PackError(f'{where}: background needs {PF_W * PF_H} cells')
            i = 0
            while i < len(data):
                v = data[i] & (255 if key == 'ch' else 15)
                n = 1
                while i + n < len(data) and n < 255 and (data[i + n] & (255 if key == 'ch' else 15)) == v:
                    n += 1
                self.blob += bytes([n, v])
                i += n
        return off

    def pack(self):
        g = self.g
        if not g['items'] or not g['rooms']:
            raise PackError('the game needs at least one item and one room')
        if len(g['items']) > 254:
            raise PackError('too many items (max 254)')

        # items
        item_recs = []
        for it in g['items']:
            w = f'item {it["id"]}'
            name = self.string(it['name'], w)
            if it.get('pickable') and len(it['name']) > 9:
                self.warn(f'{w}: name longer than 9 characters is cut in the inventory')
            desc = self.string(it.get('desc', ''), w)
            fl = (1 if it.get('pickable') else 0) | (2 if it.get('light') else 0) | (4 if it.get('enemy') else 0)
            glyph = self.graphic(it['glyph'], w + ' glyph', 8, 6)
            icon = self.graphic(it['icon'], w + ' icon', 1, 1)
            item_recs.append((name, desc, fl, int(it.get('hp', 0)) & 255, glyph, icon, int(it.get('power', 0)) & 255))

        # rooms and object instances
        room_recs, insts = [], []
        for ri, r in enumerate(g['rooms']):
            w = f'room {r["id"]}'
            name = self.string(r['name'], w)
            desc = self.string(r.get('desc', ''), w)
            dark = self.background(r['dark'], w + ' dark')
            lit = self.background(r['lit'], w + ' lit') if r.get('lit') else 0
            room_recs.append((name, desc, dark, lit))
            objs = r.get('objects', [])
            if len(objs) > MAX_ROOM_OBJ:
                raise PackError(f'{w}: {len(objs)} objects, max {MAX_ROOM_OBJ}')
            for o in objs:
                ow = f'{w} object {o.get("item")}'
                item = self.item(o['item'], ow)
                gl = g['items'][item - 1]['glyph']
                x, y = int(o['x']), int(o['y'])
                if not (0 <= x <= PF_W - gl['w'] and 0 <= y <= PF_H - gl['h']):
                    raise PackError(f'{ow}: position {x},{y} outside the playfield')
                door = o.get('door') or None
                door_to = self.room(door['to'], ow) if door else 255
                door_flag = self.flag(door['flag']) if door and door.get('flag') else 255
                locked = self.string(door.get('locked', ''), ow) if door else 0
                insts.append((ri, item, x, y, 1 if o.get('hidden') else 0, door_to, door_flag, locked))
        if len(insts) > MAX_INSTANCES:
            raise PackError(f'too many objects in total (max {MAX_INSTANCES})')

        # rules
        rule_bytes = bytearray()
        for k, ru in enumerate(g.get('rules', [])):
            w = f'rule {k + 1} ({ru.get("trigger")})'
            trig = ru['trigger']
            if trig not in TRIGGERS:
                raise PackError(f'{w}: unknown trigger')
            if trig in ('search', 'enter'):
                a = self.room(ru['a'], w) if ru.get('a') not in (None, '', '*') else 255
                b = 255
            else:
                a = self.item(ru.get('a'), w, allow_any=True)
                b = self.item(ru.get('b'), w, allow_any=True)
            conds = bytearray()
            for c in ru.get('if', []):
                t = c['type']
                if t not in CONDS:
                    raise PackError(f'{w}: unknown condition {t}')
                if t in ('flag', 'not_flag'):
                    arg = self.flag(c['flag'])
                elif t in ('has', 'not_has'):
                    arg = self.item(c['item'], w)
                elif t == 'in_room':
                    arg = self.room(c['room'], w)
                else:
                    arg = 0
                conds += bytes([CONDS[t], arg])
            acts = bytearray()
            for a_ in ru.get('do', []):
                t = a_['type']
                if t not in ACTIONS:
                    raise PackError(f'{w}: unknown action {t}')
                kind = ACTION_ARGS.get(t)
                p1, p2 = 0, 0
                if kind == 'text':
                    p2 = self.string(a_.get('text', ''), w)
                elif kind == 'flag':
                    p1 = self.flag(a_['flag'])
                elif kind == 'item':
                    p1 = self.item(a_['item'], w)
                elif kind == 'item_any':
                    p1 = self.item(a_.get('item'), w, allow_any=True)
                elif kind == 'n':
                    p1 = int(a_.get('n', 1)) & 255
                elif kind == 'room':
                    p1 = self.room(a_['room'], w)
                if t == 'hurt' and a_.get('text'):
                    p2 = self.string(a_['text'], w)   # shown only if the hurt happens
                if t == 'swap':
                    p2 = self.item(a_['to'], w)
                if t == 'spawn':
                    p2 = (int(a_.get('x', 0)) & 255) | (int(a_.get('y', 0)) & 255) << 8
                acts += bytes([ACTIONS[t], p1, p2 & 255, p2 >> 8])
            rule_bytes += bytes([TRIGGERS[trig], a, b, len(conds) // 2, len(acts) // 4]) + conds + acts
        if len(self.flags) > 255:
            raise PackError('too many flags')

        # player
        p = g['player']
        pname = self.string(p['name'], 'player')
        pdesc = self.string(p.get('desc', ''), 'player')
        avatar = self.graphic(p['avatar'], 'player avatar', 5, 5)
        if (p['avatar']['w'], p['avatar']['h']) != (5, 5):
            raise PackError('player avatar must be 5x5')
        start = self.room(p['start'], 'player start')
        intro = self.string(g.get('intro', ''), 'intro')
        title = self.string(g.get('title', ''), 'title')

        # tables
        items_off = self.here()
        for name, desc, fl, hp, glyph, icon, power in item_recs:
            self.blob += bytes([name & 255, name >> 8, desc & 255, desc >> 8, fl, hp,
                                glyph & 255, glyph >> 8, icon & 255, icon >> 8, power])
        rooms_off = self.here()
        for rec in room_recs:
            for v in rec:
                self.blob += bytes([v & 255, v >> 8])
        insts_off = self.here()
        for ri, item, x, y, fl, dt, df, lm in insts:
            self.blob += bytes([ri, item, x, y, fl, dt, df, lm & 255, lm >> 8])
        rules_off = self.here()
        self.blob += rule_bytes
        player_off = self.here()
        self.blob += bytes([pname & 255, pname >> 8, pdesc & 255, pdesc >> 8,
                            int(p['hp']), int(p['hpmax']), int(p['mp']), int(p['mpmax']), start,
                            avatar & 255, avatar >> 8])

        hdr = bytes([ord('A'), ord('G'), VERSION, len(item_recs), len(room_recs),
                     len(g.get('rules', [])), len(self.flags), len(insts)])
        for v in (items_off, rooms_off, rules_off, player_off, insts_off, intro, title):
            hdr += bytes([v & 255, v >> 8])
        self.blob[:len(hdr)] = hdr
        if len(self.blob) > 0x8000:
            raise PackError(f'game data is {len(self.blob)} bytes, the limit is 32768')
        return bytes(self.blob)


def pack_file(src, dst):
    game = json.load(open(src, encoding='utf8'))
    p = Packer(game)
    blob = p.pack()
    open(dst, 'wb').write(blob)
    return blob, p


if __name__ == '__main__':
    try:
        blob, p = pack_file(sys.argv[1], sys.argv[2])
    except PackError as e:
        print('error:', e)
        sys.exit(1)
    for w in p.warnings:
        print('warning:', w)
    print(f'{sys.argv[2]}: {len(blob)} bytes, {len(p.g["items"])} items, {len(p.g["rooms"])} rooms, '
          f'{len(p.g.get("rules", []))} rules, {len(p.flags)} flags')
