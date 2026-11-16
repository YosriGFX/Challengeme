/* wire.h — the bytes between the CPU (server) and the PPU / APU (client).
 * One WebSocket binary message = one packet = a row of records. A packet is
 * applied whole or not at all. Every value is absolute, never a difference.
 */
#ifndef WIRE_H
#define WIRE_H

#define WIRE_MAX_PACKET 4096   /* the largest full dump is about 3.7 KB */

/* ---- server -> client ------------------------------------------------- */
#define W_RESET    0x01  /* forget OPs, strings, motion and bindings (join / resync)   */
#define W_FRAME    0x02  /* [lo][hi]  the server tick this packet belongs to; first    */
#define W_ACK      0x03  /* [n]  inputs of this player handled since they joined       */
#define W_MID      0x04  /* made between two ticks (an input was answered, or a join): */
                         /* its arrival time says nothing about the server's clock     */
#define W_OPS_LIST 0x10  /* [n] then n x ([slot][8 B])                                 */
#define W_OPS_MASK 0x11  /* [32 B dirty mask] then the changed slots, 8 B each         */
#define W_MOVE     0x12  /* [n] then n x ([slot][fx][fy][vx lo][vx hi][vy lo][vy hi])  */
#define W_BIND     0x13  /* [id][slot][kind][sx][sy][xmin][xmax][ymin][ymax]           */
#define W_STR      0x20  /* [id][len][bytes]                                           */
#define W_BEGIN    0x30  /* start of a transition                                      */
#define W_END      0x31  /* apply everything since BEGIN at once                       */
#define W_PAL      0x32  /* [role 1..7][R][G][B]                  transition only      */
#define W_LABEL    0x33  /* [button 2..4][8 B text]               transition only      */
#define W_TICK     0x34  /* [hz 0..60]                            transition only      */
#define W_SFXDEF   0x35  /* [id][8 B preset]                      transition only      */
#define W_MUSDEF   0x36  /* [id][step_10ms][steps][vol][steps x 4 notes]  transition only */
#define W_SFX      0x40  /* [id]  play a preset                                        */
#define W_MUSIC    0x41  /* [cmd][pattern]  0 stop, 1 play in a loop                   */
/* Writing a slot (OPS_LIST / OPS_MASK) stops its motion; a MOVE record later in the
 * same packet starts a new one. Motion counts from the packet's FRAME tick. */

/* ---- client -> server -------------------------------------------------- */
#define C_IN       0x01  /* [input byte] or [input byte][low 8 bits of the tick on screen] */
#define C_SYS      0x02  /* [code]  from the HOME overlay                               */
#define C_RESYNC   0x03  /* ask for a full dump                                         */

#endif
