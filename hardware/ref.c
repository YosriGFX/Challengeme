/* ref.c — the reference client for hardware, as a desktop program.
 *
 *   ref <packet file> <out.ppm> [pixels] [dump prefix]
 *
 * It does what a device does with a packet: hands it to the PPU (ppu/ppu.c, the same file
 * the browser runs as WASM), asks for the OP buffer at the packet's tick, and draws it with
 * hardware/raster.c. No browser, no float. `make hardware` runs it for every game.
 *
 * A real device adds three things around this: a WebSocket to /match/<cart>/<room>, a
 * display to copy the frame to, and buttons to build the input byte from (sdk/console.h).
 *
 * With a dump prefix it also writes what the FPGA client needs to draw the same frame
 * (<prefix>.ops.hex, .strs.hex, .pal.hex) and the frame itself (<prefix>.rgb565.hex),
 * one value per line, for `make fpga-check`.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "raster.h"
#include "../sdk/wire.h"

u8 *ppu_rx(void); u32 ppu_apply(u32 len); u8 *ppu_view(u32 tick); u32 ppu_frame(void);
u8 *ppu_strs(void); u8 *ppu_pal(void); u32 ppu_tick(void);

static int hex_file(const char *prefix, const char *what, const u8 *bytes, u32 n, u32 width) {
  char path[512];
  snprintf(path, sizeof path, "%s.%s.hex", prefix, what);
  FILE *f = fopen(path, "w");
  if (!f) { perror(path); return 1; }
  for (u32 i = 0; i < n; i++) {
    u32 v = 0;
    for (u32 k = 0; k < width; k++) v = (v << 8) | bytes[i * width + k];
    fprintf(f, "%0*x\n", (int)(width * 2), v);
  }
  fclose(f);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: ref <packet file> <out.ppm> [pixels] [dump prefix]\n"); return 2; }
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
  const u8 *view = ppu_view(ppu_frame());
  raster_frame(px, n, view, ppu_strs(), ppu_pal());
  if (argc > 4) {
    u8 *be = malloc((size_t)n * n * 2);                    /* the frame, high byte first */
    if (!be) return 1;
    for (u32 i = 0; i < n * n; i++) { be[i * 2] = (u8)(px[i] >> 8); be[i * 2 + 1] = (u8)px[i]; }
    if (hex_file(argv[4], "ops", view, CON_SLOTS * CON_OP_SIZE, 1) || hex_file(argv[4], "strs", ppu_strs(), CON_STRS * CON_STR_LEN, 1) ||
        hex_file(argv[4], "pal", ppu_pal(), CON_ROLES, 3) || hex_file(argv[4], "rgb565", be, n * n, 2)) return 1;
    free(be);
  }

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
