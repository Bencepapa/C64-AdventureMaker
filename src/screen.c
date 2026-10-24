#include "screen.h"

// Everything is drawn into a shadow copy of the screen and colour RAM.
// scr_present() copies the rows that changed to the real screen, so a cell
// goes straight from its old to its new look (no flash while a room redraws).
static char shadow_ch[1000];
static char shadow_co[1000];
char * const screen = shadow_ch;
char * const colram = shadow_co;

static char dirty_lo = 0, dirty_hi = 24;

static const unsigned rowofs[25] = {
    0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400, 440, 480,
    520, 560, 600, 640, 680, 720, 760, 800, 840, 880, 920, 960
};

void scr_mark(char y0, char y1)
{
    if (y0 < dirty_lo) dirty_lo = y0;
    if (y1 > dirty_hi) dirty_hi = y1;
}

void scr_present(void)
{
    if (dirty_lo > dirty_hi)
        return;
    unsigned o = rowofs[dirty_lo];
    char *dst = (char *)0x0400 + o, *src = shadow_ch + o;
    char *dco = (char *)0xD800 + o, *sco = shadow_co + o;
    for (char y = dirty_lo; y <= dirty_hi; y++) {
        for (char i = 0; i < 40; i++) {
            dst[i] = src[i];
            dco[i] = sco[i];
        }
        dst += 40; src += 40; dco += 40; sco += 40;
    }
    dirty_lo = 25;
    dirty_hi = 0;
}

static char scode(char c)
{
    if (c >= 96 && c < 128)
        return c - 96;
    if (c >= 64 && c < 96)
        return c - 64;
    return c;
}

void scr_clear(char color)
{
    for (unsigned i = 0; i < 1000; i++) {
        screen[i] = ' ';
        colram[i] = color;
    }
    scr_mark(0, 24);
}

void put_char(char x, char y, char code, char color)
{
    unsigned o = rowofs[y] + x;
    screen[o] = code;
    colram[o] = color;
    scr_mark(y, y);
}

void put_text(char x, char y, const char *s, char color)
{
    unsigned o = rowofs[y] + x;
    while (*s) {
        screen[o] = scode(*s++);
        colram[o++] = color;
    }
    scr_mark(y, y);
}

void put_text_rev(char x, char y, const char *s, char color)
{
    unsigned o = rowofs[y] + x;
    while (*s) {
        screen[o] = scode(*s++) | 0x80;
        colram[o++] = color;
    }
    scr_mark(y, y);
}

void fill(char x, char y, char w, char h, char code, char color)
{
    for (char j = 0; j < h; j++) {
        unsigned o = rowofs[y + j] + x;
        for (char i = 0; i < w; i++) {
            screen[o + i] = code;
            colram[o + i] = color;
        }
    }
    if (h)
        scr_mark(y, y + h - 1);
}

void paint(char x, char y, char w, char h, char color)
{
    for (char j = 0; j < h; j++) {
        unsigned o = rowofs[y + j] + x;
        for (char i = 0; i < w; i++)
            colram[o + i] = color;
    }
    if (h)
        scr_mark(y, y + h - 1);
}

void box(char x, char y, char w, char h, char color, bool square)
{
    char x1 = x + w - 1, y1 = y + h - 1;
    fill(x + 1, y, w - 2, 1, SC_HLINE, color);
    fill(x + 1, y1, w - 2, 1, SC_HLINE, color);
    fill(x, y + 1, 1, h - 2, SC_VLINE, color);
    fill(x1, y + 1, 1, h - 2, SC_VLINE, color);
    put_char(x, y, square ? SC_STL : SC_RTL, color);
    put_char(x1, y, square ? SC_STR : SC_RTR, color);
    put_char(x, y1, square ? SC_SBL : SC_RBL, color);
    put_char(x1, y1, square ? SC_SBR : SC_RBR, color);
}
