// ADVGUI v2 - data-driven adventure engine on top of the MOUSEGUI driver.
// The game itself (items, rooms, doors, rules, graphics) comes from
// build/game.bin, packed by tools/pack.py from the editor's JSON.
// Layout (40x25 text screen):
//   rows 0-1    description (black on white, click it for the next page)
//   rows 2-17   playfield (cols 0-26) | inventory (cols 27-39)
//   rows 18-24  avatar, name, HP, MP | ATTACK, SEARCH, hover line, hint
#include <string.h>
#include "mousegui.h"
#include "screen.h"

static const char gd[] = {
#embed "../build/game.bin"
};
// 16-bit reads go through one non-inlined function: Oscar64 1.32.273 -O2 miscompiled
// the inlined form (the high byte was read from the table base + 1, not offset + 1).
static __noinline unsigned rd16(unsigned o)
{
    const char *p = gd + o;
    return p[0] | (p[1] << 8);
}
#define RD16(o)     rd16(o)
#define STR(o)      ((const char *)gd + (o))

// ---- game data layout (see tools/pack.py) ----
#define H_NITEMS    3
#define H_NROOMS    4
#define H_NRULES    5
#define H_NINST     7
#define H_ITEMS     8
#define H_ROOMS     10
#define H_RULES     12
#define H_PLAYER    14
#define H_INSTS     16
#define H_INTRO     18

#define ITEM(i)     (RD16(H_ITEMS) + ((i) - 1) * 11)
#define IT_NAME     0
#define IT_DESC     2
#define IT_FLAGS    4
#define IT_HP       5
#define IT_GLYPH    6
#define IT_ICON     8
#define IT_POWER    10      // attack damage when carried (0 = not a weapon)
#define IF_PICK     1
#define IF_LIGHT    2
#define IF_ENEMY    4

#define ROOM(r)     (RD16(H_ROOMS) + (r) * 8)

enum { T_COMBINE = 1, T_USE, T_USE_PLAYER, T_CLICK, T_ATTACK, T_DEFEAT, T_SEARCH, T_ENTER, T_LOOK, T_TAKE };
enum { C_FLAG = 1, C_NOT_FLAG, C_HAS, C_NOT_HAS, C_LIT, C_NOT_LIT, C_IN_ROOM };
enum { A_MSG = 1, A_SET_FLAG, A_CLEAR_FLAG, A_REMOVE_A, A_REMOVE_TARGET, A_REPLACE_TARGET, A_REPLACE_A,
       A_GIVE, A_SPAWN, A_REVEAL, A_HP, A_HURT, A_DAMAGE, A_MP, A_GOTO, A_END, A_SWAP };

// ---- layout ----
#define PF_X    1
#define PF_Y    3
#define PF_W    25
#define PF_H    14
#define INV_X   28
#define INV_Y   4
#define INV_W   11
#define NSLOTS  12
#define NOBJ    12
#define BTN_Y   18
#define ATK_X   23
#define SRC_X   32
#define BTN_W   8
#define HOVER_X 23
#define HOVER_Y 22
#define MSG_W   38

// ---- hot areas (lower number wins where they overlap) ----
enum {
    A_SLOT0 = 0,
    A_ATTACK = A_SLOT0 + NSLOTS,
    A_SEARCH,
    A_AVATAR,
    A_OBJ0,
    A_HPBAR = A_OBJ0 + NOBJ,    // 27
    A_MPBAR,
    A_HEADER,
    A_INVPANEL,
    A_PLAYFIELD
};

// ---- run-time state ----
// "None" is 255 everywhere. Tests that guard an array index compare against the
// array size instead (k < MAXINST, s < NSLOTS): Oscar64 infers from inv[s] that
// s < NSLOTS and would drop a "s != 255" test as always true.
#define MAXINST 96
struct Inst {
    char room, item, x, y;      // x, y relative to the playfield
    bool hidden;
    char hp, door_to, door_flag;
    unsigned locked;            // message offset
    char frame, timer;
};
static struct Inst inst[MAXINST];
static char room_obj[NOBJ];     // instance per object area, 255 = none
static char inv[NSLOTS], inv_frame[NSLOTS], inv_timer[NSLOTS];
static char flagbits[32];
static char cur_room;
static char hp, hpmax, mp, mpmax;
static bool game_over;

static char hover_area = MG_NONE, pressed_btn = MG_NONE, highlighted = MG_NONE, drag_src = MG_NONE;
static char last_jiffy, more_timer, more_phase;

// rule context
// A = the dragged thing (inventory slot or floor object), B = the target (slot or object)
static char ctx_slot_a, ctx_inst_a, ctx_slot_b, ctx_inst, pending_goto;

// message being shown, with paging
static char msgbuf[256];
static char msglen;
static char msgpos;

// ---------------------------------------------------------------- helpers
static char rnd_state = 0x5A;
static char rnd(void)
{
    rnd_state ^= *(volatile char *)0xD012;
    rnd_state = (rnd_state << 1) ^ ((rnd_state & 0x80) ? 0x1D : 0);
    return rnd_state;
}

static bool flag_get(char f) { return (flagbits[f >> 3] >> (f & 7)) & 1; }
static void flag_set(char f, bool v)
{
    if (v) flagbits[f >> 3] |= 1 << (f & 7);
    else flagbits[f >> 3] &= ~(1 << (f & 7));
}

static char item_flags(char i) { return i ? gd[ITEM(i) + IT_FLAGS] : 0; }
static const char *item_name(char i) { return i ? STR(RD16(ITEM(i) + IT_NAME)) : ""; }

static bool have(char item)
{
    for (char s = 0; s < NSLOTS; s++)
        if (inv[s] == item)
            return true;
    return false;
}

static bool is_lit(void)
{
    for (char s = 0; s < NSLOTS; s++)
        if (item_flags(inv[s]) & IF_LIGHT)
            return true;
    for (char k = 0; k < MAXINST; k++)          // a light source lying in this room
        if (inst[k].item && inst[k].room == cur_room && !inst[k].hidden && (item_flags(inst[k].item) & IF_LIGHT))
            return true;
    return false;
}

// damage of the best weapon carried (at least 1: bare hands)
static char weapon_power(void)
{
    char best = 1;
    for (char s = 0; s < NSLOTS; s++)
        if (inv[s] && gd[ITEM(inv[s]) + IT_POWER] > best)
            best = gd[ITEM(inv[s]) + IT_POWER];
    return best;
}

static char *utoa3(char v, char *p)
{
    if (v >= 100) *p++ = '0' + v / 100;
    if (v >= 10) *p++ = '0' + v / 10 % 10;
    *p++ = '0' + v % 10;
    *p = 0;
    return p;
}

// ---------------------------------------------------------------- messages
static void show_page(void)
{
    char line[MSG_W + 1];
    fill(0, 0, 40, 2, SC_BLOCK, WHITE);
    for (char y = 0; y < 2 && msgpos < msglen; y++) {
        char n = msglen - msgpos;
        if (n > MSG_W) {
            n = MSG_W;
            while (n > 0 && msgbuf[msgpos + n] != ' ')
                n--;
            if (n == 0)
                n = MSG_W;
        }
        memcpy(line, msgbuf + msgpos, n);
        line[n] = 0;
        put_text_rev(1, y, line, WHITE);
        msgpos += n;
        while (msgpos < msglen && msgbuf[msgpos] == ' ')
            msgpos++;
    }
    bool more = msgpos < msglen;
    if (more)
        put_char(39, 1, 0x3E, WHITE);       // '>' (normal on white = black arrow)
    mg_area(A_HEADER, 0, 0, 40, 2, more ? AF_CLICK : 0);
}

static void msg_clear(void) { msglen = 0; }

static void msg_add(const char *s)
{
    if (!*s)
        return;
    if (msglen && msglen < 254)
        msgbuf[msglen++] = ' ';
    while (*s && msglen < 255)
        msgbuf[msglen++] = *s++;
}

static void msg_show(void)
{
    msgpos = 0;
    if (msglen)
        show_page();
}

static void say(const char *s)
{
    msg_clear();
    msg_add(s);
    msg_show();
}

// ---------------------------------------------------------------- graphics
static void draw_gfx(unsigned g, char frame, char x, char y, char dim)
{
    char w = gd[g], h = gd[g + 1];
    unsigned p = g + 4 + frame * (w * h * 2);
    unsigned c = p + w * h;
    for (char j = 0; j < h; j++)
        for (char i = 0; i < w; i++) {
            put_char(x + i, y + j, gd[p++], dim ? dim : gd[c] & 15);
            c++;
        }
}

static void inst_size(char k, char *w, char *h)
{
    unsigned g = RD16(ITEM(inst[k].item) + IT_GLYPH);
    *w = gd[g];
    *h = gd[g + 1];
}

static void draw_inst(char k, char dim)
{
    struct Inst *o = inst + k;
    draw_gfx(RD16(ITEM(o->item) + IT_GLYPH), o->frame, PF_X + o->x, PF_Y + o->y, dim);
}

static void draw_background(unsigned p)
{
    for (char pass = 0; pass < 2; pass++) {
        char *dst = (pass ? colram : screen) + PF_Y * 40 + PF_X;
        char x = 0;
        unsigned cells = 0;
        while (cells < PF_W * PF_H) {
            char n = gd[p], v = gd[p + 1];
            p += 2;
            cells += n;
            while (n--) {
                *dst++ = v;
                if (++x == PF_W) {
                    x = 0;
                    dst += 40 - PF_W;
                }
            }
        }
    }
}

static void draw_playfield(void)
{
    scr_mark(PF_Y, PF_Y + PF_H - 1);
    unsigned r = ROOM(cur_room);
    unsigned lit = RD16(r + 6);
    draw_background(lit && is_lit() ? lit : RD16(r + 4));
    fill(1, 2, 25, 1, SC_HLINE, LGREY);            // room name in the frame
    put_text(2, 2, STR(RD16(r)), WHITE);
    for (char i = 0; i < NOBJ; i++) {
        char k = room_obj[i];
        if (k < MAXINST && !inst[k].hidden)
            draw_inst(k, 0);
    }
}

static void draw_slot(char s)
{
    char y = INV_Y + s;
    fill(INV_X, y, INV_W, 1, ' ', LGREY);
    if (inv[s]) {
        draw_gfx(RD16(ITEM(inv[s]) + IT_ICON), inv_frame[s], INV_X, y, 0);
        char name[10];
        strncpy(name, item_name(inv[s]), 9);
        name[9] = 0;
        put_text(INV_X + 2, y, name, WHITE);
    } else
        put_char(INV_X, y, '.', DGREY);
}

static void draw_inventory_frame(char color)
{
    box(27, 2, 13, 16, color, false);
    put_text(29, 2, "INVENTORY", color == LGREY ? WHITE : color);
}

static void draw_button(char x, const char *label, bool pressed)
{
    char lc = pressed ? LRED : WHITE;
    box(x, BTN_Y, BTN_W, 3, pressed ? LRED : LGREY, pressed);
    fill(x + 1, BTN_Y + 1, BTN_W - 2, 1, pressed ? SC_BLOCK : ' ', lc);
    if (pressed)
        put_text_rev(x + 1, BTN_Y + 1, label, lc);
    else
        put_text(x + 1, BTN_Y + 1, label, lc);
}

static void draw_bar(char y, const char *label, char v, char max, char color)
{
    put_text(8, y, label, LGREY);
    for (char i = 0; i < 10; i++)
        put_char(11 + i, y, SC_BLOCK, i * max < v * 10 ? color : DGREY);
}

static void draw_stats(void)
{
    unsigned p = RD16(H_PLAYER);
    draw_gfx(RD16(p + 9), 0, 1, 19, hp > hpmax / 4 ? 0 : RED);
    fill(8, 19, 14, 1, ' ', WHITE);
    put_text(8, 19, STR(RD16(p)), WHITE);
    draw_bar(21, "HP", hp, hpmax, hp > hpmax / 4 ? GREEN : RED);
    draw_bar(23, "MP", mp, mpmax, LBLUE);
}

// ---------------------------------------------------------------- objects and areas
static void build_room_list(void)
{
    char n = 0;
    for (char k = 0; k < MAXINST && n < NOBJ; k++)
        if (inst[k].item && inst[k].room == cur_room)
            room_obj[n++] = k;
    while (n < NOBJ)
        room_obj[n++] = 255;
}

static void update_areas(void)
{
    for (char s = 0; s < NSLOTS; s++)
        mg_area(A_SLOT0 + s, INV_X, INV_Y + s, INV_W, 1,
                inv[s] ? AF_CLICK | AF_DRAG | AF_DROP : AF_DROP);
    for (char i = 0; i < NOBJ; i++) {
        char k = room_obj[i], f = 0, w = 0, h = 0;
        if (k < MAXINST && !inst[k].hidden) {
            inst_size(k, &w, &h);
            f = (item_flags(inst[k].item) & IF_PICK) ? AF_CLICK | AF_DRAG | AF_DROP : AF_CLICK | AF_DROP;
        }
        mg_area(A_OBJ0 + i, PF_X + (k < MAXINST ? inst[k].x : 0), PF_Y + (k < MAXINST ? inst[k].y : 0), w, h, f);
    }
}

static void setup_areas(void)
{
    MG_NAREA = 0;
    for (char n = 0; n < MG_MAXAREA; n++)
        MG_AF[n] = 0;
    mg_area(A_ATTACK, ATK_X, BTN_Y, BTN_W, 3, AF_CLICK);
    mg_area(A_SEARCH, SRC_X, BTN_Y, BTN_W, 3, AF_CLICK);
    mg_area(A_AVATAR, 1, 19, 5, 5, AF_CLICK | AF_DROP);
    mg_area(A_HPBAR, 8, 21, 13, 1, AF_DROP);    // hover shows the numbers, drop = use on the hero
    mg_area(A_MPBAR, 8, 23, 13, 1, AF_DROP);
    mg_area(A_INVPANEL, INV_X, PF_Y, INV_W, PF_H, AF_DROP);
    mg_area(A_PLAYFIELD, PF_X, PF_Y, PF_W, PF_H, AF_CLICK | AF_DROP);
    build_room_list();
    update_areas();
    MG_NAREA = MG_MAXAREA;
}

static bool is_slot(char a) { return a < A_SLOT0 + NSLOTS; }
static bool is_obj(char a) { return a >= A_OBJ0 && a < A_OBJ0 + NOBJ && room_obj[a - A_OBJ0] < MAXINST; }
static bool is_hero(char a) { return a == A_AVATAR || a == A_HPBAR || a == A_MPBAR; }

static char new_inst(char room, char item, char x, char y)
{
    for (char k = 0; k < MAXINST; k++)
        if (!inst[k].item) {
            struct Inst *o = inst + k;
            memset(o, 0, sizeof(*o));
            o->room = room;
            o->item = item;
            o->x = x;
            o->y = y;
            o->hp = gd[ITEM(item) + IT_HP];
            o->door_to = o->door_flag = 255;
            return k;
        }
    return 255;
}

static void set_inst_item(char k, char item)
{
    inst[k].item = item;
    inst[k].frame = inst[k].timer = 0;
    if (item)
        inst[k].hp = gd[ITEM(item) + IT_HP];
}

// place an item on the floor near col, row (playfield-relative), keeping it inside
static void put_down(char item, signed char col, signed char row)
{
    unsigned g = RD16(ITEM(item) + IT_GLYPH);
    char w = gd[g], h = gd[g + 1];
    if (col < 0) col = 0;
    if (row < 3) row = 3;
    if (col + w > PF_W) col = PF_W - w;
    if (row + h > PF_H) row = PF_H - h;
    new_inst(cur_room, item, col, row);
}

static char free_slot(char prefer)
{
    if (prefer < NSLOTS && !inv[prefer])
        return prefer;
    for (char s = 0; s < NSLOTS; s++)
        if (!inv[s])
            return s;
    return 255;
}

// ---------------------------------------------------------------- feedback
static void show_hover(char a)
{
    char buf[18];
    char *p = buf;
    const char *n = "";
    if (is_slot(a))
        n = item_name(inv[a - A_SLOT0]);
    else if (is_obj(a))
        n = item_name(inst[room_obj[a - A_OBJ0]].item);
    else if (a == A_ATTACK)
        n = "ATTACK";
    else if (a == A_SEARCH)
        n = "SEARCH";
    else if (a == A_AVATAR)
        n = STR(RD16(RD16(H_PLAYER)));
    fill(HOVER_X, HOVER_Y, 17, 1, ' ', YELLOW);
    if (a == A_HPBAR || a == A_MPBAR) {
        strcpy(buf, a == A_HPBAR ? "> HP " : "> MP ");
        p = utoa3(a == A_HPBAR ? hp : mp, buf + 5);
        *p++ = '/';
        utoa3(a == A_HPBAR ? hpmax : mpmax, p);
        put_text(HOVER_X, HOVER_Y, buf, YELLOW);
    } else if (*n) {
        buf[0] = '>';
        buf[1] = ' ';
        strncpy(buf + 2, n, 15);
        buf[17] = 0;
        put_text(HOVER_X, HOVER_Y, buf, YELLOW);
    }
}

static void mark_target(char a, bool on)
{
    if (is_slot(a)) {
        if (on)
            paint(INV_X, INV_Y + a - A_SLOT0, INV_W, 1, YELLOW);
        else
            draw_slot(a - A_SLOT0);
    } else if (is_obj(a)) {
        char k = room_obj[a - A_OBJ0];
        if (on) {
            char w, h;
            inst_size(k, &w, &h);
            paint(PF_X + inst[k].x, PF_Y + inst[k].y, w, h, YELLOW);
        } else
            draw_inst(k, 0);
    } else if (a == A_INVPANEL)
        draw_inventory_frame(on ? YELLOW : LGREY);
    else if (is_hero(a))
        draw_gfx(RD16(RD16(H_PLAYER) + 9), 0, 1, 19, on ? YELLOW : 0);
}

static void update_pressed(char p)
{
    if (p == pressed_btn)
        return;
    if (pressed_btn == A_ATTACK) draw_button(ATK_X, "ATTACK", false);
    if (pressed_btn == A_SEARCH) draw_button(SRC_X, "SEARCH", false);
    if (p == A_ATTACK) draw_button(ATK_X, "ATTACK", true);
    if (p == A_SEARCH) draw_button(SRC_X, "SEARCH", true);
    pressed_btn = p;
}

static void button_flash(char a)
{
    if (pressed_btn != a) {
        update_pressed(a);
        scr_present();
        for (volatile unsigned d = 0; d < 1500; d++) ;
        update_pressed(MG_NONE);
    }
}

static void refresh(void)
{
    if (highlighted != MG_NONE) {
        mark_target(highlighted, false);
        highlighted = MG_NONE;
    }
    build_room_list();
    draw_playfield();
    for (char s = 0; s < NSLOTS; s++)
        draw_slot(s);
    draw_inventory_frame(LGREY);
    draw_stats();
    update_areas();
    hover_area = MG_NONE;       // redraw the hover line
}

// step animations by the jiffy clock
static void animate(void)
{
    char now = *(volatile char *)0xA2;
    char dt = now - last_jiffy;
    if (!dt)
        return;
    last_jiffy = now;
    if (msgpos < msglen) {                  // blink the "more" marker: > / ) and normal / reverse
        more_timer += dt;
        if (more_timer >= 15) {
            more_timer = 0;
            more_phase ^= 1;
            put_char(39, 1, more_phase ? 0x29 | 0x80 : 0x3E, WHITE);
        }
    }
    for (char i = 0; i < NOBJ; i++) {
        char k = room_obj[i];
        if (k >= MAXINST || inst[k].hidden || A_OBJ0 + i == drag_src || A_OBJ0 + i == highlighted)
            continue;
        unsigned g = RD16(ITEM(inst[k].item) + IT_GLYPH);
        if (gd[g + 2] < 2)
            continue;
        inst[k].timer += dt;
        if (inst[k].timer >= gd[g + 3]) {
            inst[k].timer = 0;
            if (++inst[k].frame >= gd[g + 2])
                inst[k].frame = 0;
            draw_inst(k, 0);
        }
    }
    for (char s = 0; s < NSLOTS; s++) {
        if (!inv[s] || A_SLOT0 + s == drag_src || A_SLOT0 + s == highlighted)
            continue;
        unsigned g = RD16(ITEM(inv[s]) + IT_ICON);
        if (gd[g + 2] < 2)
            continue;
        inv_timer[s] += dt;
        if (inv_timer[s] >= gd[g + 3]) {
            inv_timer[s] = 0;
            if (++inv_frame[s] >= gd[g + 2])
                inv_frame[s] = 0;
            draw_gfx(g, inv_frame[s], INV_X, INV_Y + s, 0);
        }
    }
}

// ---------------------------------------------------------------- rules
static bool conds_ok(unsigned p, char n)
{
    for (char i = 0; i < n; i++, p += 2) {
        char a = gd[p + 1];
        bool ok;
        switch (gd[p]) {
        case C_FLAG:     ok = flag_get(a); break;
        case C_NOT_FLAG: ok = !flag_get(a); break;
        case C_HAS:      ok = have(a); break;
        case C_NOT_HAS:  ok = !have(a); break;
        case C_LIT:      ok = is_lit(); break;
        case C_NOT_LIT:  ok = !is_lit(); break;
        case C_IN_ROOM:  ok = cur_room == a; break;
        default:         ok = false;
        }
        if (!ok)
            return false;
    }
    return true;
}

static bool run_rules(char trig, char a, char b);

static void change_hp(signed char d)
{
    int v = hp + d;
    if (v > hpmax) v = hpmax;
    if (v <= 0) {
        msg_add("YOU COLLAPSE... AND WAKE UP AGAIN, WEAKER.");
        v = 1;
    }
    hp = v;
}

// hurt the target object; at 0 HP its "defeat" rule runs (default: it vanishes)
static void damage(char n)
{
    if (ctx_inst >= MAXINST || !inst[ctx_inst].item)
        return;
    struct Inst *o = inst + ctx_inst;
    o->hp = o->hp > n ? o->hp - n : 0;
    if (!o->hp && !run_rules(T_DEFEAT, 255, o->item)) {
        o->item = 0;
        msg_add("IT IS DEFEATED.");
    }
}

static void exec(unsigned p, char n)
{
    for (char i = 0; i < n; i++, p += 4) {
        char p1 = gd[p + 1];
        unsigned p2 = RD16(p + 2);
        switch (gd[p]) {
        case A_MSG:
            msg_add(STR(p2));
            break;
        case A_SET_FLAG:
            flag_set(p1, true);
            break;
        case A_CLEAR_FLAG:
            flag_set(p1, false);
            break;
        case A_REMOVE_A:
            if (ctx_slot_a < NSLOTS) inv[ctx_slot_a] = 0;
            else if (ctx_inst_a < MAXINST) inst[ctx_inst_a].item = 0;
            break;
        case A_REMOVE_TARGET:
            if (ctx_inst < MAXINST) inst[ctx_inst].item = 0;
            else if (ctx_slot_b < NSLOTS) inv[ctx_slot_b] = 0;
            break;
        case A_REPLACE_TARGET:
            if (ctx_inst < MAXINST) set_inst_item(ctx_inst, p1);
            else if (ctx_slot_b < NSLOTS) inv[ctx_slot_b] = p1;
            break;
        case A_REPLACE_A:
            if (ctx_slot_a < NSLOTS) inv[ctx_slot_a] = p1;
            else if (ctx_inst_a < MAXINST) set_inst_item(ctx_inst_a, p1);
            break;
        case A_SWAP:                    // every p1 in this room becomes item p2
            for (char k = 0; k < MAXINST; k++)
                if (inst[k].item == p1 && inst[k].room == cur_room)
                    set_inst_item(k, gd[p + 2]);
            break;
        case A_GIVE: {
            char s = free_slot(255);
            if (s < NSLOTS) inv[s] = p1;
            else put_down(p1, 12, 8);
            break;
        }
        case A_SPAWN:
            new_inst(cur_room, p1, gd[p + 2], gd[p + 3]);
            break;
        case A_REVEAL:
            for (char k = 0; k < MAXINST; k++)
                if (inst[k].item && inst[k].room == cur_room && (p1 == 255 || inst[k].item == p1))
                    inst[k].hidden = false;
            break;
        case A_HP:
            change_hp((signed char)p1);
            break;
        case A_HURT:
            // an enemy that was just defeated does not strike back
            if (ctx_inst < MAXINST && !(item_flags(inst[ctx_inst].item) & IF_ENEMY))
                break;
            if (p2) msg_add(STR(p2));
            change_hp(-(signed char)(1 + rnd() % p1));
            break;
        case A_DAMAGE:
            damage(p1 ? p1 : weapon_power());
            break;
        case A_MP: {
            int v = mp + (signed char)p1;
            mp = v < 0 ? 0 : v > mpmax ? mpmax : v;
            break;
        }
        case A_GOTO:
            pending_goto = p1;
            break;
        case A_END:
            msg_add(STR(p2));
            game_over = true;
            break;
        }
    }
}

static bool run_rules(char trig, char a, char b)
{
    unsigned p = RD16(H_RULES);
    for (char r = gd[H_NRULES]; r; r--) {
        char nc = gd[p + 3], na = gd[p + 4];
        unsigned c = p + 5, act = c + nc * 2;
        if (gd[p] == trig && (gd[p + 1] == 255 || gd[p + 1] == a) && (gd[p + 2] == 255 || gd[p + 2] == b)
                && conds_ok(c, nc)) {
            exec(act, na);
            return true;
        }
        p = act + na * 4;
    }
    return false;
}

static void ctx_reset(void)
{
    ctx_slot_a = ctx_inst_a = ctx_slot_b = ctx_inst = pending_goto = 255;
    msg_clear();
}

static void enter_room(char r)
{
    cur_room = r;
    msg_add(STR(RD16(ROOM(r) + 2)));
    run_rules(T_ENTER, r, 255);
}

// show the collected message, change room if asked, redraw
static void finish(void)
{
    while (pending_goto != 255) {
        char r = pending_goto;
        pending_goto = 255;
        if (msglen) {                   // the action said something: keep it instead of the room text
            cur_room = r;
            run_rules(T_ENTER, r, 255);
        } else
            enter_room(r);
    }
    msg_show();
    refresh();
}

// ---------------------------------------------------------------- input
static void on_click(char a, bool look)
{
    if (a == A_HEADER) {
        if (msgpos < msglen)
            show_page();
        return;
    }
    if (game_over)
        return;
    ctx_reset();
    if (a == A_ATTACK || a == A_SEARCH) {
        button_flash(a);
        if (a == A_SEARCH) {
            if (!run_rules(T_SEARCH, cur_room, 255))
                msg_add("YOU FIND NOTHING SPECIAL.");
        } else {
            for (char i = 0; i < NOBJ; i++) {
                char k = room_obj[i];
                if (k < MAXINST && !inst[k].hidden && (item_flags(inst[k].item) & IF_ENEMY)) {
                    ctx_inst = k;
                    break;
                }
            }
            if (ctx_inst >= MAXINST)
                msg_add("THERE IS NOTHING TO ATTACK.");
            else if (!run_rules(T_ATTACK, 255, inst[ctx_inst].item)) {
                msg_add("YOU ATTACK.");
                damage(weapon_power());
            }
        }
    } else if (is_hero(a))
        msg_add(STR(RD16(RD16(H_PLAYER) + 2)));
    else if (is_obj(a)) {
        char k = room_obj[a - A_OBJ0];
        ctx_inst = k;
        char item = inst[k].item;
        if (!run_rules(look ? T_LOOK : T_CLICK, 255, item)) {
            if (!look && inst[k].door_to != 255) {
                if (inst[k].door_flag == 255 || flag_get(inst[k].door_flag))
                    pending_goto = inst[k].door_to;
                else
                    msg_add(STR(inst[k].locked));
            } else
                msg_add(STR(RD16(ITEM(item) + IT_DESC)));
        }
    } else if (is_slot(a)) {
        char item = inv[a - A_SLOT0];
        ctx_slot_b = a - A_SLOT0;
        if (item && !run_rules(T_LOOK, 255, item))
            msg_add(STR(RD16(ITEM(item) + IT_DESC)));
    } else if (a == A_PLAYFIELD)
        msg_add(STR(RD16(ROOM(cur_room) + 2)));
    else
        return;
    finish();
}

// item in inventory slot s, or else in object k (not inlined: Oscar64 -O2 dropped
// the test when this was written as a ?: expression)
static __noinline char thing(char s, char k)
{
    if (s < NSLOTS)
        return inv[s];
    return inst[k].item;
}

// A (slot sa or object ia) dropped on B (slot sb or object ib): combine rules, both ways round
static bool try_combine(char sa, char ia, char sb, char ib)
{
    char a = thing(sa, ia), b = thing(sb, ib);
    ctx_slot_a = sa; ctx_inst_a = ia; ctx_slot_b = sb; ctx_inst = ib;
    if (run_rules(T_COMBINE, a, b))
        return true;
    ctx_slot_a = sb; ctx_inst_a = ib; ctx_slot_b = sa; ctx_inst = ia;
    if (run_rules(T_COMBINE, b, a))
        return true;
    ctx_slot_a = sa; ctx_inst_a = ia; ctx_slot_b = sb; ctx_inst = ib;
    return false;
}

static void take(char k, char prefer)
{
    char item = inst[k].item;
    char s = free_slot(prefer);
    if (s >= NSLOTS) {
        msg_add("YOUR INVENTORY IS FULL.");
        return;
    }
    inv[s] = item;
    inv_frame[s] = inv_timer[s] = 0;
    inst[k].item = 0;
    ctx_slot_a = s;
    ctx_inst_a = 255;
    if (!run_rules(T_TAKE, item, 255))
        msg_add("TAKEN.");
}

static void on_drop(char src, char dst, char col, char row)
{
    if (game_over) {
        refresh();
        return;
    }
    ctx_reset();
    signed char rc = col - PF_X, rr = row - PF_Y;
    if (is_obj(src)) {
        char k = room_obj[src - A_OBJ0];
        if (is_slot(dst) && inv[dst - A_SLOT0]) {           // onto an inventory item: combine, else take
            if (!try_combine(255, k, dst - A_SLOT0, 255))
                take(k, 255);
        } else if (is_slot(dst) || dst == A_INVPANEL)
            take(k, is_slot(dst) ? dst - A_SLOT0 : 255);
        else if (dst == A_PLAYFIELD) {
            char w, h;
            inst_size(k, &w, &h);
            if (rc + w > PF_W) rc = PF_W - w;
            if (rr < 3) rr = 3;
            if (rr + h > PF_H) rr = PF_H - h;
            inst[k].x = rc < 0 ? 0 : rc;
            inst[k].y = rr;
        } else if (is_obj(dst) && dst != src) {             // two things on the floor
            char t = room_obj[dst - A_OBJ0];
            ctx_inst_a = k;
            ctx_inst = t;
            if (!run_rules(T_USE, inst[k].item, inst[t].item) && !try_combine(255, k, 255, t))
                msg_add("NOTHING HAPPENS.");
        } else if (is_hero(dst)) {
            ctx_inst_a = k;
            if (!run_rules(T_USE_PLAYER, inst[k].item, 255))
                msg_add("YOU CAN'T USE THAT ON YOURSELF.");
        }
    } else if (is_slot(src)) {
        char s = src - A_SLOT0, item = inv[s];
        ctx_slot_a = s;
        if (is_slot(dst) && dst != src) {
            char t = dst - A_SLOT0;
            if (inv[t]) {
                if (!try_combine(s, 255, t, 255))
                    msg_add("THAT DOES NOT WORK.");
            } else {
                inv[t] = item;
                inv[s] = 0;
                inv_frame[t] = inv_timer[t] = 0;
            }
        } else if (is_obj(dst)) {
            char t = room_obj[dst - A_OBJ0];
            ctx_inst = t;
            if (!run_rules(T_USE, item, inst[t].item) && !try_combine(s, 255, 255, t))
                msg_add("NOTHING HAPPENS.");
        } else if (is_hero(dst)) {
            if (!run_rules(T_USE_PLAYER, item, 255))
                msg_add("YOU CAN'T USE THAT ON YOURSELF.");
        } else if (dst == A_PLAYFIELD) {
            put_down(item, rc, rr);
            inv[s] = 0;
            msg_add("DROPPED.");
        }
    }
    finish();
}

// ---------------------------------------------------------------- main
static void new_game(void)
{
    unsigned p = RD16(H_INSTS);
    memset(inst, 0, sizeof(inst));
    for (char k = 0; k < gd[H_NINST]; k++, p += 9) {
        struct Inst *o = inst + k;
        o->room = gd[p];
        o->item = gd[p + 1];
        o->x = gd[p + 2];
        o->y = gd[p + 3];
        o->hidden = gd[p + 4] & 1;
        o->door_to = gd[p + 5];
        o->door_flag = gd[p + 6];
        o->locked = RD16(p + 7);
        o->hp = gd[ITEM(o->item) + IT_HP];
    }
    memset(inv, 0, sizeof(inv));
    memset(flagbits, 0, sizeof(flagbits));
    p = RD16(H_PLAYER);
    hp = gd[p + 4];
    hpmax = gd[p + 5];
    mp = gd[p + 6];
    mpmax = gd[p + 7];
    cur_room = gd[p + 8];
    game_over = false;
}

int main(void)
{
    *(volatile char *)0xD020 = BLACK;
    *(volatile char *)0xD021 = BLACK;
    *(volatile char *)0xD018 = 0x15;        // upper case / graphics set
    new_game();
    scr_clear(LGREY);
    box(0, 2, 27, 16, LGREY, false);
    box(0, 18, 7, 7, LGREY, false);
    draw_button(ATK_X, "ATTACK", false);
    draw_button(SRC_X, "SEARCH", false);
    put_text(HOVER_X, 24, "L:USE/DRAG R:LOOK", DGREY);
    mg_install();           // copies the driver image, which clears the area tables
    setup_areas();
    ctx_reset();
    msg_add(STR(RD16(H_INTRO)));
    run_rules(T_ENTER, cur_room, 255);
    finish();

    for (;;) {
        char e = MG_EVT;
        if (e == EV_CLICK || e == EV_DRAGSTART || e == EV_DRAGEND || e == EV_RCLICK) {
            char a = MG_AREA, src = MG_SRC, col = MG_ECOL, row = MG_EROW;
            MG_EVT = 0;                     // acknowledge
            if (e == EV_CLICK || e == EV_RCLICK)
                on_click(a, e == EV_RCLICK);
            else if (e == EV_DRAGSTART) {
                drag_src = src;
                if (is_obj(src))
                    draw_inst(room_obj[src - A_OBJ0], DGREY);
                else if (is_slot(src))
                    paint(INV_X, INV_Y + src - A_SLOT0, INV_W, 1, DGREY);
            } else {
                drag_src = MG_NONE;
                on_drop(src, a, col, row);
            }
        }

        char live = MG_LIVE, h = MG_HOVER, p = MG_PRESS;
        update_pressed(p == h && (p == A_ATTACK || p == A_SEARCH) ? p : MG_NONE);

        char t = MG_NONE;
        if (live == EV_DRAGON && h != MG_NONE && (MG_AF[h] & AF_DROP) && h != p && h != A_PLAYFIELD)
            t = h;
        if (is_hero(t))
            t = A_AVATAR;                   // one highlight for portrait and bars
        if (t != highlighted) {
            if (highlighted != MG_NONE)
                mark_target(highlighted, false);
            if (t != MG_NONE)
                mark_target(t, true);
            highlighted = t;
        }

        if (h != hover_area) {
            show_hover(h);
            hover_area = h;
        }
        animate();
        scr_present();
    }
    return 0;
}
