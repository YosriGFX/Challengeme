# OP Console — build the cartridges and the client memory map to WebAssembly.
#
#   make          build everything (clang with the wasm32 target, and wasm-ld)
#   make run      start the local simulator (Node.js only; the built .wasm files are in the repo)
#   make dev      the real Worker + Durable Objects, locally (first: cd worker && npm install)
#   make deploy   deploy to Cloudflare
#   make clean
#
# macOS: Apple's clang has no wasm target. Use LLVM from Homebrew:
#   brew install llvm lld && make WASM_CC=$$(brew --prefix llvm)/bin/clang

WASM_CC ?= clang
PORT    ?= 8787
CFLAGS  := --target=wasm32 -nostdlib -ffreestanding -O2 -Wall -Wextra -fno-builtin
LDFLAGS := -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=16384 -Wl,--initial-memory=196608

CARTS   := dama pong flap keys trail
OFFLINE := dama                 # games whose manifest says "offline": they may also be kept on a device
SDK     := sdk/console.h sdk/wire.h sdk/runtime.c

all: $(CARTS:%=dist/%.wasm) public/ppu.wasm
	@mkdir -p worker/src/carts && cp dist/*.wasm worker/src/carts/
	@for g in $(OFFLINE); do cp dist/$$g.wasm worker/src/carts/$$g.bin; done
	@cp host/match.mjs public/match.mjs
	@echo "built: $^"

dist/%.wasm: carts/%/*.c $(SDK)
	@mkdir -p dist
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -Isdk -o $@ sdk/runtime.c $(wildcard carts/$*/*.c)

public/ppu.wasm: ppu/ppu.c sdk/console.h sdk/wire.h
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -o $@ ppu/ppu.c

# the console font and its C stroke table (needs: pip install fonttools)
font:
	python3 font/build.py

# the reference client for hardware: draws a game's screen with integers only, no browser
hardware: all
	@mkdir -p hardware/out
	$(CC) -O2 -Wall -Wextra -o hardware/out/ref hardware/ref.c hardware/raster.c ppu/ppu.c
	@for g in $(CARTS); do node hardware/dump.mjs $$g 240 > hardware/out/$$g.bin && hardware/out/ref hardware/out/$$g.bin hardware/out/$$g.ppm 240; done
	@echo "pictures: hardware/out/*.ppm"

# the FPGA line renderer against raster.c, pixel for pixel, for a frame of every game (needs Icarus Verilog)
fpga-check: hardware
	@command -v iverilog >/dev/null || { echo "fpga-check needs Icarus Verilog (iverilog, vvp)"; exit 1; }
	@mkdir -p hardware/out/fpga
	iverilog -g2005 -Ifpga -o hardware/out/fpga/tb fpga/tb_ppu_line.v fpga/ppu_line.v
	@for g in $(CARTS); do \
	  hardware/out/ref hardware/out/$$g.bin hardware/out/fpga/$$g.ppm 256 hardware/out/fpga/in > /dev/null && \
	  (cd hardware/out/fpga && vvp -n tb > /dev/null) && \
	  if cmp -s hardware/out/fpga/out.rgb565.hex hardware/out/fpga/in.rgb565.hex; then echo "$$g: the same 65536 pixels as raster.c"; \
	  else echo "$$g: DIFFERENT from raster.c"; fi; done

# is hardware/esp32/main/main.c valid C? (stand-in headers; a real build needs ESP-IDF and a board)
esp32-check:
	$(CC) -fsyntax-only -Wall -Wextra -Ihardware/esp32/check -Ihardware -Isdk -Ippu hardware/esp32/main/main.c && echo "main.c: valid C against the stand-in headers"

run:
	PORT=$(PORT) node host/sim.mjs

dev:
	cd worker && npx wrangler dev

deploy:
	cd worker && npx wrangler deploy

clean:
	rm -f dist/*.wasm public/ppu.wasm public/match.mjs worker/src/carts/*.wasm worker/src/carts/*.bin
	rm -rf hardware/out

.PHONY: all font hardware fpga-check esp32-check run dev deploy clean
