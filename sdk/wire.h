/* wire.h — the byte protocol between the CPU (server) and the PPU/APU (client).
 * One WebSocket binary message = one atomic packet = a sequence of records.
 * Every record carries absolute values, so the protocol is datagram-ready.
 */
#ifndef WIRE_H
#define WIRE_H

#define WIRE_MAX_PACKET 4096

/* ---- server -> client records --------------------------------------- */
#define W_RESET    0x01  /* clear OP buffer and strings (join / resync)            */
#define W_FRAME    0x02  /* [lo][hi] the server tick this packet belongs to         */
#define W_OPS_LIST 0x10  /* [n] then n x ([slot][8 B])                             */
#define W_OPS_MASK 0x11  /* [32 B dirty mask] then changed slots packed, 8 B each  */
#define W_STR      0x20  /* [id][len][bytes]                                       */
#define W_BEGIN    0x30  /* BEGIN_TRANSITION                                       */
#define W_END      0x31  /* END_TRANSITION: apply everything since BEGIN at once   */
#define W_PAL      0x32  /* [role 1..7][R][G][B]          (transition only)        */
#define W_LABEL    0x33  /* [button 2..4][8 B text]       (transition only)        */
#define W_TICK     0x34  /* [hz]                          (transition only)        */
#define W_SFXDEF   0x35  /* [id][8 B APU preset]          (transition only)        */
#define W_MUSDEF   0x36  /* [id][step_10ms][steps][vol][steps x 4 notes] (transition only) */
#define W_SFX      0x40  /* [id]  play a preset from the sound bank                */
#define W_MUSIC    0x41  /* [cmd][pattern]  0 = stop, 1 = play (loop)              */

/* ---- client -> server ------------------------------------------------ */
#define C_IN       0x01  /* [input byte]   sent only on change                     */
#define C_SYS      0x02  /* [code]         from the HOME overlay                   */
#define C_RESYNC   0x03  /* ask for a full dump                                    */

#endif
