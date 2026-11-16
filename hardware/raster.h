/* raster.h — draw the OP buffer into a square frame of 16-bit pixels, with integers only. */
#ifndef RASTER_H
#define RASTER_H
#include "../sdk/console.h"

/* px: n x n pixels, RGB565. ops: 256 slots x 8 bytes (what ppu_view(tick) returns).
 * strs: 16 x 16 bytes. pal: 8 roles x RGB. */
void raster_frame(u16 *px, u32 n, const u8 *ops, const u8 *strs, const u8 *pal);

#endif
