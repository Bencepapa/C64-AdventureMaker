; =====================================================================
; MOUSEGUI v1 - mouse/joystick pointer + hot areas for C64 BASIC V2
; 1351 mouse (proportional mode) in port 1 or 2, or joystick in either.
; Assemble: python tools/asm6502.py mousegui.asm mousegui.prg
; Load address $C000 (49152). See README.md for the BASIC interface.
; =====================================================================

CHKCOM  = $AEFD         ; BASIC: check for comma
GETBYT  = $B79E         ; BASIC: evaluate byte expression -> X
ILLQ    = $B248         ; BASIC: ?ILLEGAL QUANTITY ERROR
HIBASE  = $0288         ; KERNAL: screen page (hi byte)
KBDCNT  = $C6           ; KERNAL: chars in keyboard buffer
IRQVEC  = $0314
MAXA    = 32            ; number of hot areas
QMAX    = 4             ; latched event queue length

; ---- public registers (fixed addresses, see README) ----
EVT     = $C010         ; 49168 event/state, POKE 0 = acknowledge
EAREA   = $C011         ; 49169 area of EVT (255 = none)
ESRC    = $C012         ; 49170 source area (press / drag source)
ECOL    = $C013         ; 49171 pointer column at the event
EROW    = $C014         ; 49172 pointer row at the event
LSTATE  = $C015         ; 49173 live state (0 none,1 hover,3 held,5 dragon)
HOVER   = $C016         ; 49174 live area under pointer (255 = none)
PRESS   = $C017         ; 49175 live pressed/dragged area (255 = none)
BUTTONS = $C018         ; 49176 bit0 left/fire, bit1 right
CCOL    = $C019         ; 49177 pointer column 0-39
CROW    = $C01A         ; 49178 pointer row 0-24
XL      = $C01B         ; 49179 pointer x low  (0-319)
XH      = $C01C         ; 49180 pointer x high
YP      = $C01D         ; 49181 pointer y (0-199)
INDEV   = $C01E         ; 49182 last input: 1/2 mouse port1/2, 3/4 joy port1/2
QN      = $C01F         ; 49183 latched events waiting
; ---- configuration ----
SPRNO   = $C020         ; 49184 sprite number 0-7
SPRBLK  = $C021         ; 49185 first of 3 sprite blocks (shapes)
COL0    = $C022         ; 49186 colour normal
COL1    = $C023         ; 49187 colour over clickable area
COL2    = $C024         ; 49188 colour while dragging
NAREA   = $C025         ; 49189 areas in use (0-32)
TMOUT   = $C026         ; 49190 latch timeout in frames, 0 = wait for ack
INMASK  = $C027         ; 49191 b0 mouse p1, b1 mouse p2, b2 joy p1, b3 joy p2
JSPEED  = $C028         ; 49192 joystick max speed (pixels/frame)
DTHRESH = $C029         ; 49193 drag threshold (pixels moved)
FLAGS   = $C02A         ; 49194 b0 pointer visible, b1 flush keys on port-1 fire
ECOUNT  = $C02B         ; 49195 event counter (+1 per latched event)
WXL     = $C02C         ; 49196 warp x low
WXH     = $C02D         ; 49197 warp x high
WY      = $C02E         ; 49198 warp y
WFLAG   = $C02F         ; 49199 POKE 1 = move pointer to WXL/WXH/WY
; ---- hot area tables (MAXA entries each) ----
AX      = $C040         ; 49216 column
AY      = $C060         ; 49248 row
AW      = $C080         ; 49280 width  (columns)
AH      = $C0A0         ; 49312 height (rows)
AF      = $C0C0         ; 49344 flags: 1 click, 2 drag, 4 drop target, 0 off

        * = $C000
        JMP INIT        ; SYS 49152            install / re-init
        JMP OFF         ; SYS 49155            remove
        JMP DEFAREA     ; SYS 49158,N,X,Y,W,H,F define area N
        JMP INVERT      ; SYS 49161,X,Y,W,H     toggle reverse video
        JMP PAINT       ; SYS 49164,X,Y,W,H,C   set colour RAM
        .byte 1         ; $C00F version

        * = $C010       ; registers with defaults
        .byte 0,255,255,0,0,0,255,255,0,20,12
        .byte <160,>160,100,0,0
        .byte 0,13,1,7,13,0,50,15,4,3,3,0,0,0,0,0
        .fill 16,0
        .fill MAXA*5,0  ; area tables $C040-$C0DF
        .fill 32,0      ; $C0E0-$C0FF reserved

; =====================================================================
        * = $C100
INIT:   SEI
        LDA SPRBLK      ; copy the 3 shapes to SPRBLK*64
        LSR A
        LSR A
        STA CPD+2
        LDA SPRBLK
        ASL A
        ASL A
        ASL A
        ASL A
        ASL A
        ASL A
        STA CPD+1
        LDX #0
CPL:    LDA SHAPES,X
CPD:    STA $FFFF,X
        INX
        CPX #192
        BNE CPL
        JSR SPSETUP
        LDA IRQVEC      ; hook IRQ once
        CMP #<IRQ
        BNE HOOK
        LDA IRQVEC+1
        CMP #>IRQ
        BEQ HOOKED
HOOK:   LDA IRQVEC
        STA OLDIRQ
        LDA IRQVEC+1
        STA OLDIRQ+1
        LDA #<IRQ
        STA IRQVEC
        LDA #>IRQ
        STA IRQVEC+1
HOOKED: LDA #0
        STA QN
        STA MST
        STA MLOCK
        STA LASTB
        STA JCNT
        STA EVT
        LDA #255
        STA PRESS
        STA HOVER
        STA LAREA
        CLI
        RTS

OFF:    SEI
        LDA IRQVEC
        CMP #<IRQ
        BNE OFF1
        LDA IRQVEC+1
        CMP #>IRQ
        BNE OFF1
        LDA OLDIRQ
        STA IRQVEC
        LDA OLDIRQ+1
        STA IRQVEC+1
OFF1:   LDA $D015
        AND SPMASK
        STA $D015
        LDA #255
        STA SPMASK
        STA CURSP
        LDA #0
        STA SPBIT
        LDA #$7F
        STA $DC00
        CLI
        RTS

; set up the sprite named by SPRNO (disables the previous one)
SPSETUP: LDA $D015
        AND SPMASK
        STA $D015
        LDA SPRNO
        AND #7
        STA CURSP
        TAX
        LDA BITS,X
        STA SPBIT
        EOR #$FF
        STA SPMASK
        LDA $D017
        AND SPMASK
        STA $D017
        LDA $D01D
        AND SPMASK
        STA $D01D
        LDA $D01C
        AND SPMASK
        STA $D01C
        LDA $D01B
        AND SPMASK
        STA $D01B
        RTS

; =====================================================================
; IRQ wedge. The pots of the selected port have been stable since the
; end of the previous IRQ (POST), so they are read first.
IRQ:    CLD
        LDA $D419
        STA POTX
        LDA $D41A
        STA POTY
        LDA #$FF        ; read both ports without keyboard interference
        STA $DC00
        LDA $DC01
        STA JV          ; port 1 lines
        LDA $DC00
        STA JV+1        ; port 2 lines
        LDA #$7F        ; what the KERNAL (UDTIM / STOP key) expects
        STA $DC00
        LDA SPRNO
        AND #7
        CMP CURSP
        BEQ IRQ1
        JSR SPSETUP
IRQ1:   JSR QUEUE
        JSR MOUSE
        JSR JOY
        JSR MOVE
        JSR BUTTON
        JSR LOGIC
        JSR OUTPUT
        JSR SPRITE
        LDA #>POST      ; fake an interrupt frame so that the old
        PHA             ; handler's PLA/TAY/PLA/TAX/PLA/RTI returns
        LDA #<POST      ; to POST (after the keyboard scan)
        PHA
        PHP
        PHA
        PHA
        PHA
        JMP (OLDIRQ)
POST:   LDA PSEL        ; select the mouse port's pots for next frame
        STA $DC00
        LDA FLAGS
        AND #2
        BEQ POST1
        LDA KILLKB
        BEQ POST1
        LDA #0          ; port-1 fire/buttons ghost as keys: drop them
        STA KBDCNT
POST1:  PLA
        TAY
        PLA
        TAX
        PLA
        RTI

; ---- latched event queue: acknowledge / timeout ----
QUEUE:  LDA QN
        BEQ QX
        LDA EVT
        BEQ POP         ; BASIC wrote 0: acknowledged
        LDA TMOUT
        BEQ QX
        INC QT
        LDA QT
        CMP TMOUT
        BCS POP
QX:     RTS

POP:    LDX #0
POP1:   LDA QC+1,X
        STA QC,X
        LDA QA+1,X
        STA QA,X
        LDA QS+1,X
        STA QS,X
        LDA QXC+1,X
        STA QXC,X
        LDA QYC+1,X
        STA QYC,X
        INX
        CPX #QMAX-1
        BNE POP1
        DEC QN
        LDA #0
        STA QT
        RTS

; A = event code, X = area, Y = source area
PUSH:   STA TMP
        STX TMP2
        LDX QN
        CPX #QMAX
        BCC PUSH1
        DEX             ; queue full: overwrite the newest
        DEC QN
PUSH1:  LDA TMP
        STA QC,X
        LDA TMP2
        STA QA,X
        TYA
        STA QS,X
        LDA CCOL
        STA QXC,X
        LDA CROW
        STA QYC,X
        INC QN
        INC ECOUNT
        CPX #0
        BNE PUSH2
        LDA #0          ; new head: restart its timeout
        STA QT
PUSH2:  RTS

; ---- 1351 mouse: detect, deltas into DX/DY ----
MOUSE:  LDA #0
        STA DX
        STA DY
        LDA INMASK
        AND #3
        BNE MS0
        STA MLOCK       ; no mouse port allowed
        LDA #$7F
        STA PSEL
        RTS
MS0:    LDA MPORT       ; current port still allowed?
        AND INMASK
        BNE MS1
        LDA #0
        STA MLOCK
        LDA INMASK
        AND #3
        CMP #3
        BNE MSA
        LDA #2
MSA:    STA MPORT
MS1:    LDA POTX
        AND POTY
        CMP #$FF        ; empty port / joystick reads $FF
        BEQ MNONE
        LDA MLOCK
        BNE MHAVE
        LDA POTX        ; first sighting: no jump
        STA OLDX
        LDA POTY
        STA OLDY
        LDA #1
        STA MLOCK
        LDA #0
        STA FFCNT
        JMP MPS
MHAVE:  LDA #0
        STA FFCNT
        LDA POTX
        LDY OLDX
        JSR MOVCHK
        STY OLDX
        STA DX
        LDA POTY
        LDY OLDY
        JSR MOVCHK
        STY OLDY
        EOR #$FF        ; pot Y grows upward
        CLC
        ADC #1
        STA DY
        ORA DX
        BEQ MPS
        LDA MPORT
        STA INDEV
        JMP MPS
MNONE:  LDA MLOCK
        BEQ MSCAN
        INC FFCNT
        LDA FFCNT
        CMP #50
        BCC MPS
        LDA #0
        STA MLOCK
MSCAN:  INC SCNT        ; no mouse: try the other port every 8 frames
        LDA SCNT
        AND #7
        BNE MPS
        LDA INMASK
        AND #3
        CMP #3
        BNE MSB
        LDA MPORT
        EOR #3
MSB:    STA MPORT
MPS:    LDX MPORT
        LDA PSELT-1,X
        STA PSEL
        RTS

; CBM MOVCHK: A = new pot, Y = old -> A = signed delta, Y = value to keep
MOVCHK: STY MOLD
        STA MNEW
        SEC
        SBC MOLD
        AND #$7F
        CMP #$40
        BCS MVNEG
        LSR A
        BEQ MVZERO
        LDY MNEW
        RTS
MVNEG:  ORA #$C0
        CMP #$FF
        BEQ MVZERO
        SEC
        ROR A
        LDY MNEW
        RTS
MVZERO: LDA #0
        LDY MOLD
        RTS

; ---- joysticks (ports not used by the mouse) ----
JOY:    LDA #0
        STA JDIR
        STA JFIRE
        LDX #0          ; X = 0 port 1, 1 port 2
JOY1:   LDA INMASK
        AND JBIT,X
        BEQ JOYN
        LDA MLOCK
        BEQ JOY2
        TXA
        CLC
        ADC #1
        CMP MPORT
        BEQ JOYN        ; that port has the mouse
JOY2:   LDA JV,X
        EOR #$FF
        AND #$1F
        BEQ JOYN
        STA JTMP
        AND #$0F
        ORA JDIR
        STA JDIR
        LDA JTMP
        AND #$10
        ORA JFIRE
        STA JFIRE
        TXA
        CLC
        ADC #3
        STA INDEV
JOYN:   INX
        CPX #2
        BNE JOY1
        LDA JDIR
        BNE JMV
        STA JCNT
        RTS
JMV:    LDA JCNT        ; accelerate: 1 + frames/8, up to JSPEED
        CMP #255
        BEQ JMV1
        INC JCNT
JMV1:   LDA JCNT
        LSR A
        LSR A
        LSR A
        CLC
        ADC #1
        CMP JSPEED
        BCC JMV2
        LDA JSPEED
JMV2:   STA JSPD
        LDA JDIR
        AND #8
        BEQ JMV3
        LDA DX
        CLC
        ADC JSPD
        STA DX
JMV3:   LDA JDIR
        AND #4
        BEQ JMV4
        LDA DX
        SEC
        SBC JSPD
        STA DX
JMV4:   LDA JDIR
        AND #2
        BEQ JMV5
        LDA DY
        CLC
        ADC JSPD
        STA DY
JMV5:   LDA JDIR
        AND #1
        BEQ JMV6
        LDA DY
        SEC
        SBC JSPD
        STA DY
JMV6:   RTS

; ---- move pointer, clamp to 0-319 / 0-199, character cell ----
MOVE:   LDA WFLAG
        BEQ MV0
        LDA #0
        STA WFLAG
        STA DX
        STA DY
        LDA WXL
        STA XL
        LDA WXH
        STA XH
        LDA WY
        CMP #200
        BCC MVW
        LDA #199
MVW:    STA YP
MV0:    LDX #0
        LDA DX
        BPL MV1
        DEX
MV1:    CLC
        ADC XL
        STA XL
        TXA
        ADC XH
        STA XH
        BMI XNEG
        CMP #1
        BCC XOK
        BNE XMAX
        LDA XL
        CMP #<320
        BCC XOK
XMAX:   LDA #<319
        STA XL
        LDA #>319
        STA XH
        JMP XOK
XNEG:   LDA #0
        STA XL
        STA XH
XOK:    LDX #0
        LDA DY
        BPL MV2
        DEX
MV2:    CLC
        ADC YP
        STA YP
        TXA
        ADC #0
        BMI YNEG
        BNE YMAX
        LDA YP
        CMP #200
        BCC YOK
YMAX:   LDA #199
        STA YP
        JMP YOK
YNEG:   LDA #0
        STA YP
YOK:    LDA XH
        LSR A
        LDA XL
        ROR A
        LSR A
        LSR A
        STA CCOL
        LDA YP
        LSR A
        LSR A
        LSR A
        STA CROW
        RTS

; ---- buttons: bit0 left/fire, bit1 right ----
BUTTON: LDA #0
        STA BTMP
        LDA JFIRE
        BEQ BT0
        LDA #1
        STA BTMP
BT0:    LDA MLOCK
        BEQ BT2
        LDX MPORT
        LDA JV-1,X
        STA JTMP
        AND #$10        ; left = fire line
        BNE BT1
        LDA BTMP
        ORA #1
        STA BTMP
BT1:    LDA JTMP
        AND #$01        ; right = up line
        BNE BT2
        LDA BTMP
        ORA #2
        STA BTMP
BT2:    LDA BTMP
        STA BUTTONS
        BEQ BT2A
        LDA MLOCK       ; a mouse button counts as mouse input
        BEQ BT2A
        LDA JFIRE
        BNE BT2A
        LDA MPORT
        STA INDEV
BT2A:
        LDA #0
        STA KILLKB
        LDA JV
        AND #$1F
        CMP #$1F
        BEQ BT3
        LDA INMASK
        AND #5          ; port 1 in use (mouse or joystick)
        BEQ BT3
        INC KILLKB
BT3:    RTS

; ---- hit test: A = first active area containing CCOL/CROW, or 255 ----
HIT:    LDX #0
HIT1:   CPX NAREA
        BCS HITN
        CPX #MAXA
        BCS HITN
        LDA AF,X
        AND #7
        BEQ HIT2
        LDA CCOL
        SEC
        SBC AX,X
        BCC HIT2
        CMP AW,X
        BCS HIT2
        LDA CROW
        SEC
        SBC AY,X
        BCC HIT2
        CMP AH,X
        BCS HIT2
        TXA
        RTS
HIT2:   INX
        BNE HIT1
HITN:   LDA #255
        RTS

; ---- state machine: MST 0 idle, 1 pressed, 2 dragging ----
LOGIC:  JSR HIT
        STA HOVER
        LDA MST
        BEQ LIDLE
        CMP #1
        BEQ LPRESS
        JMP LDRAG
LIDLE:  LDA BUTTONS     ; right button pressed -> event 7
        AND #2
        BEQ LI1
        LDA LASTB
        AND #2
        BNE LI1
        LDA #7
        LDX HOVER
        LDY HOVER
        JSR PUSH
LI1:    LDA BUTTONS
        AND #1
        BEQ LI2
        LDA LASTB
        AND #1
        BNE LI2
        LDA HOVER       ; left pressed
        STA PRESS
        LDA #0
        STA MOVED
        LDA #1
        STA MST
        JMP LP4
LI2:    LDA #255
        STA PRESS
        LDA HOVER
        STA LAREA
        LDX #0
        CMP #255
        BEQ LI3
        INX
LI3:    STX LSTATE
        JMP LDONE
LPRESS: LDA BUTTONS
        AND #1
        BNE LP1
        LDA #0          ; released: click if still on the pressed area
        STA MST
        LDA HOVER
        CMP PRESS
        BNE LI2
        LDA #2
        LDX PRESS
        LDY PRESS
        JSR PUSH
        JMP LI2
LP1:    LDA DX
        JSR ABS
        CLC
        ADC MOVED
        BCC LP2
        LDA #255
LP2:    STA MOVED
        LDA DY
        JSR ABS
        CLC
        ADC MOVED
        BCC LP3
        LDA #255
LP3:    STA MOVED
        LDX PRESS
        CPX #255
        BEQ LP4
        LDA AF,X
        AND #2
        BEQ LP4
        LDA DTHRESH
        CMP MOVED
        BCS LP4         ; moved <= threshold
        LDA #2
        STA MST
        LDA #4
        LDX PRESS
        LDY PRESS
        JSR PUSH
        JMP LDRAG
LP4:    LDA #3
        STA LSTATE
        LDA PRESS
        STA LAREA
        JMP LDONE
LDRAG:  LDX HOVER       ; drop target = hover area with flag 4
        CPX #255
        BEQ LD1
        LDA AF,X
        AND #4
        BNE LD1
        LDX #255
LD1:    STX TGT
        LDA BUTTONS
        AND #1
        BNE LD2
        LDA #0
        STA MST
        LDA #6
        LDX TGT
        LDY PRESS
        JSR PUSH
        JMP LI2
LD2:    LDA #5
        STA LSTATE
        LDA TGT
        STA LAREA
LDONE:  LDA BUTTONS
        STA LASTB
        RTS

ABS:    CMP #$80
        BCC ABS1
        EOR #$FF
        CLC
        ADC #1
ABS1:   RTS

; ---- what BASIC sees: oldest latched event, else the live state ----
OUTPUT: LDA QN
        BEQ OUT1
        LDA QC
        STA EVT
        LDA QA
        STA EAREA
        LDA QS
        STA ESRC
        LDA QXC
        STA ECOL
        LDA QYC
        STA EROW
        RTS
OUT1:   LDA LSTATE
        STA EVT
        LDA LAREA
        STA EAREA
        LDA PRESS
        STA ESRC
        LDA CCOL
        STA ECOL
        LDA CROW
        STA EROW
        RTS

; ---- pointer sprite: shape, colour, position ----
SPRITE: LDA MST
        CMP #2
        BNE SP1
        LDA #2
        STA SHAPE
        LDA COL2
        JMP SP3
SP1:    LDX HOVER
        CPX #255
        BEQ SP2
        LDA AF,X
        AND #3
        BEQ SP2
        LDA #1
        STA SHAPE
        LDA COL1
        JMP SP3
SP2:    LDA #0
        STA SHAPE
        LDA COL0
SP3:    LDX CURSP
        STA $D027,X
        TXA
        ASL A
        TAX
        LDA XL
        CLC
        ADC #24
        STA $D000,X
        LDA XH
        ADC #0
        STA TMP
        LDA YP
        CLC
        ADC #50
        STA $D001,X
        LDA $D010
        AND SPMASK
        LDY TMP
        BEQ SP4
        ORA SPBIT
SP4:    STA $D010
        LDA $DD00       ; sprite pointer = screen base + $3F8 + sprite
        AND #3
        EOR #3
        ASL A
        ASL A
        ASL A
        ASL A
        ASL A
        ASL A
        STA TMP
        LDA $D018
        AND #$F0
        LSR A
        LSR A
        ORA TMP
        CLC
        ADC #3
        STA SPP+2
        LDA CURSP
        CLC
        ADC #$F8
        STA SPP+1
        LDA SPRBLK
        CLC
        ADC SHAPE
SPP:    STA $07F8
        LDA FLAGS
        AND #1
        BEQ SP5
        LDA $D015
        ORA SPBIT
        STA $D015
        RTS
SP5:    LDA $D015
        AND SPMASK
        STA $D015
        RTS

; =====================================================================
; BASIC helpers
; SYS 49158,N,X,Y,W,H,F   define hot area N (0-31); NAREA grows to N+1
DEFAREA: JSR CHKCOM
        JSR GETBYT
        CPX #MAXA
        BCC DA1
        JMP ILLQ
DA1:    STX AN
        LDY #0
DA2:    STY AY_
        JSR CHKCOM
        JSR GETBYT
        TXA
        LDY AY_
        LDX AOFS,Y      ; table offset
        STX DA3+1
        LDX AN
DA3:    STA AX,X
        INY
        CPY #5
        BNE DA2
        LDX AN
        INX
        CPX NAREA
        BCC DA4
        STX NAREA
DA4:    RTS

; parse ,X,Y,W,H and compute RA = Y*40+X
RECT:   JSR CHKCOM
        JSR GETBYT
        STX RX
        JSR CHKCOM
        JSR GETBYT
        STX RY
        JSR CHKCOM
        JSR GETBYT
        STX RW
        JSR CHKCOM
        JSR GETBYT
        STX RH
        LDA #0
        STA RA+1
        LDA RY
        ASL A           ; *8 (rows <= 31 fit in a byte)
        ASL A
        ASL A
        STA T8
        ASL A           ; *32
        ROL RA+1
        ASL A
        ROL RA+1
        CLC
        ADC T8
        BCC RC1
        INC RA+1
RC1:    CLC
        ADC RX
        STA RA
        BCC RC2
        INC RA+1
RC2:    RTS

; SYS 49161,X,Y,W,H   toggle reverse video of a screen rectangle
INVERT: JSR RECT
        LDA RA
        STA IV1+1
        STA IV2+1
        LDA RA+1
        CLC
        ADC HIBASE
        STA IV1+2
        STA IV2+2
        LDX RH
        BEQ IVX
IVR:    LDY #0
IVC:    CPY RW
        BCS IVN
IV1:    LDA $FFFF,Y
        EOR #$80
IV2:    STA $FFFF,Y
        INY
        BNE IVC
IVN:    LDA IV1+1
        CLC
        ADC #40
        STA IV1+1
        STA IV2+1
        BCC IVN1
        INC IV1+2
        INC IV2+2
IVN1:   DEX
        BNE IVR
IVX:    RTS

; SYS 49164,X,Y,W,H,C   fill the colour RAM of a rectangle with C
PAINT:  JSR RECT
        JSR CHKCOM
        JSR GETBYT
        STX RVAL
        LDA RA
        STA PV+1
        LDA RA+1
        CLC
        ADC #$D8
        STA PV+2
        LDX RH
        BEQ PVX
PVR:    LDY #0
        LDA RVAL
PVC:    CPY RW
        BCS PVN
PV:     STA $FFFF,Y
        INY
        BNE PVC
PVN:    LDA PV+1
        CLC
        ADC #40
        STA PV+1
        BCC PVN1
        INC PV+2
PVN1:   DEX
        BNE PVR
PVX:    RTS

; =====================================================================
; tables and variables
BITS:   .byte 1,2,4,8,16,32,64,128
PSELT:  .byte $7F,$BF   ; $DC00 for port 1 / port 2 pots
JBIT:   .byte 4,8       ; INMASK bits for joystick port 1 / 2
AOFS:   .byte <AX,<AY,<AW,<AH,<AF
OLDIRQ: .word $EA31
CURSP:  .byte 255
SPBIT:  .byte 0
SPMASK: .byte 255
MPORT:  .byte 2
PSEL:   .byte $7F
MLOCK:  .byte 0
FFCNT:  .byte 0
SCNT:   .byte 0
POTX:   .byte 0
POTY:   .byte 0
OLDX:   .byte 0
OLDY:   .byte 0
MOLD:   .byte 0
MNEW:   .byte 0
JV:     .byte 0,0
DX:     .byte 0
DY:     .byte 0
JDIR:   .byte 0
JFIRE:  .byte 0
JTMP:   .byte 0
JCNT:   .byte 0
JSPD:   .byte 0
BTMP:   .byte 0
KILLKB: .byte 0
MST:    .byte 0
LASTB:  .byte 0
MOVED:  .byte 0
LAREA:  .byte 255
TGT:    .byte 255
SHAPE:  .byte 0
TMP:    .byte 0
TMP2:   .byte 0
QT:     .byte 0
QC:     .fill QMAX+1,0
QA:     .fill QMAX+1,0
QS:     .fill QMAX+1,0
QXC:    .fill QMAX+1,0
QYC:    .fill QMAX+1,0
AN:     .byte 0
AY_:    .byte 0
RX:     .byte 0
RY:     .byte 0
RW:     .byte 0
RH:     .byte 0
RA:     .word 0
T8:     .byte 0
RVAL:   .byte 0

; pointer shapes: 0 normal, 1 over clickable area, 2 dragging
SHAPES:
;@SHAPES
