#include "mousegui.h"
#include <string.h>

// mousegui.prg: 2-byte load address ($C000) + driver
static const char driver[] = {
#embed "../build/mousegui.prg"
};

void mg_install(void)
{
    memcpy((char *)0xC000, driver + 2, sizeof(driver) - 2);
    MG_SPRNO = 0;
    MG_SPRBLK = 13;     // shapes in the tape buffer, $0340-$03FF
    MG_NAREA = MG_MAXAREA;
    __asm { jsr $c000 }
}

void mg_remove(void)
{
    __asm { jsr $c003 }
}

void mg_area(char n, char x, char y, char w, char h, char flags)
{
    MG_AF[n] = 0;       // off while it changes (the IRQ may test it meanwhile)
    MG_AX[n] = x;
    MG_AY[n] = y;
    MG_AW[n] = w;
    MG_AH[n] = h;
    MG_AF[n] = flags;
}
