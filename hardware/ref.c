/* ref.c — the reference client for hardware, as a desktop program.
 *
 *   ref <packet file> <out.ppm> [pixels]
 *
 * It does what a device does with a packet: hands it to the PPU (ppu/ppu.c, the same file
 * the browser runs as WASM), asks for the OP buffer at the packet's tick, and draws it with
 * hardware/raster.c. No browser, no float. `make hardware` runs it for every game.
 *
 * A real device adds three things around this: a WebSocket to /match/<cart>/<room>, a
 * display to copy the frame to, and buttons to build the input byte from (sdk/console.h).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "raster.h"
#include "../sdk/wire.h"

u8 *ppu_rx(void); u32 ppu_apply(u32 len); u8 *ppu_view(u32 tick); u32 ppu_frame(void);
u8 *ppu_strs(void); u8 *ppu_pal(void); u32 ppu_tick(void);

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: ref <packet file> <out.ppm> [pixels]\n"); return 2; }
  u32 n = argc > 3 ? (u32)atoi(argv[3]) : 240;
  if (n < 16 || n > 2048) { fprintf(stderr, "pixels: 16 to 2048\n"); return 2; }

  FILE *in = fopen(argv[1], "rb");
  if (!in) { perror(argv[1]); return 1; }
  u32 len = (u32)fread(ppu_rx(), 1, WIRE_MAX_PACKET, in);
  fclose(in);
  u32 flags = ppu_apply(len);
  if (flags & 128) { fprintf(stderr, "the PPU refused the packet\n"); return 1; }

  u16 *px = malloc((size_t)n * n * sizeof *px);
  if (!px) return 1;
  raster_frame(px, n, ppu_view(ppu_frame()), ppu_strs(), ppu_pal());

  FILE *out = fopen(argv[2], "wb");
  if (!out) { perror(argv[2]); return 1; }
  fprintf(out, "P6\n%u %u\n255\n", n, n);
  for (u32 i = 0; i < n * n; i++) {
    u8 rgb[3] = { (u8)((px[i] >> 11) << 3), (u8)(((px[i] >> 5) & 63) << 2), (u8)((px[i] & 31) << 3) };
    fwrite(rgb, 1, 3, out);
  }
  fclose(out);
  free(px);
  printf("%s: %u bytes, tick %u, %u Hz -> %s (%ux%u)\n", argv[1], len, ppu_frame(), ppu_tick(), argv[2], n, n);
  return 0;
}
