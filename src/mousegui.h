// MOUSEGUI driver interface for Oscar64 (source: vendor/mousegui).
// The driver binary is embedded and copied to $C000 by mg_install().
#ifndef MOUSEGUI_H
#define MOUSEGUI_H

#define MG_REG(a)   (*(volatile char *)(a))

// status
#define MG_EVT      MG_REG(0xC010)  // event/state, write 0 = acknowledge
#define MG_AREA     MG_REG(0xC011)  // area of the event (255 = none)
#define MG_SRC      MG_REG(0xC012)  // source area (pressed / dragged)
#define MG_ECOL     MG_REG(0xC013)  // pointer column at the event
#define MG_EROW     MG_REG(0xC014)  // pointer row at the event
#define MG_LIVE     MG_REG(0xC015)  // live state 0/1/3/5
#define MG_HOVER    MG_REG(0xC016)  // live area under the pointer
#define MG_PRESS    MG_REG(0xC017)  // live pressed / dragged area
#define MG_BUTTONS  MG_REG(0xC018)
#define MG_COL      MG_REG(0xC019)
#define MG_ROW      MG_REG(0xC01A)
#define MG_INDEV    MG_REG(0xC01E)
#define MG_QN       MG_REG(0xC01F)
// configuration
#define MG_SPRNO    MG_REG(0xC020)
#define MG_SPRBLK   MG_REG(0xC021)
#define MG_COL0     MG_REG(0xC022)
#define MG_COL1     MG_REG(0xC023)
#define MG_COL2     MG_REG(0xC024)
#define MG_NAREA    MG_REG(0xC025)
#define MG_TMOUT    MG_REG(0xC026)
#define MG_INMASK   MG_REG(0xC027)
#define MG_JSPEED   MG_REG(0xC028)
#define MG_DTHRESH  MG_REG(0xC029)
#define MG_FLAGS    MG_REG(0xC02A)
// area tables (32 entries)
#define MG_AX       ((volatile char *)0xC040)
#define MG_AY       ((volatile char *)0xC060)
#define MG_AW       ((volatile char *)0xC080)
#define MG_AH       ((volatile char *)0xC0A0)
#define MG_AF       ((volatile char *)0xC0C0)

#define MG_MAXAREA  32
#define MG_NONE     255

enum {
    EV_NONE, EV_HOVER, EV_CLICK, EV_HELD, EV_DRAGSTART, EV_DRAGON, EV_DRAGEND, EV_RCLICK
};
enum { AF_CLICK = 1, AF_DRAG = 2, AF_DROP = 4 };

void mg_install(void);
void mg_remove(void);
void mg_area(char n, char x, char y, char w, char h, char flags);

#pragma compile("mousegui.c")

#endif
