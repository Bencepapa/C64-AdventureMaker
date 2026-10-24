// Text screen helpers: direct writes to screen RAM ($0400) and colour RAM.
// Strings are ASCII (letters in either case print as upper case).
#ifndef SCREEN_H
#define SCREEN_H

enum {
    BLACK, WHITE, RED, CYAN, PURPLE, GREEN, BLUE, YELLOW,
    ORANGE, BROWN, LRED, DGREY, GREY, LGREEN, LBLUE, LGREY
};

// screen codes of the PETSCII graphics used
#define SC_HLINE    0x40
#define SC_VLINE    0x5D
#define SC_RTL      0x55    // rounded corners
#define SC_RTR      0x49
#define SC_RBL      0x4A
#define SC_RBR      0x4B
#define SC_STL      0x70    // square corners
#define SC_STR      0x6E
#define SC_SBL      0x6D
#define SC_SBR      0x7D
#define SC_CHECK    0x66
#define SC_BLOCK    0xA0
#define SC_BALL     0x51
#define SC_CIRCLE   0x57

extern char * const screen;     // shadow buffers: draw here, then scr_present()
extern char * const colram;

void scr_mark(char y0, char y1);   // rows written directly through screen/colram
void scr_present(void);            // copy the changed rows to the real screen

void scr_clear(char color);
void put_char(char x, char y, char code, char color);
void put_text(char x, char y, const char *s, char color);
void put_text_rev(char x, char y, const char *s, char color);
void fill(char x, char y, char w, char h, char code, char color);
void paint(char x, char y, char w, char h, char color);
void box(char x, char y, char w, char h, char color, bool square);

#pragma compile("screen.c")

#endif
