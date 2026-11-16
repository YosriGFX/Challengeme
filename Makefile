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
SDK     := sdk/console.h sdk/wire.h sdk/runtime.c

all: $(CARTS:%=dist/%.wasm) public/ppu.wasm
	@mkdir -p worker/src/carts && cp dist/*.wasm worker/src/carts/
	@echo "built: $^"

dist/%.wasm: carts/%/*.c $(SDK)
	@mkdir -p dist
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -Isdk -o $@ sdk/runtime.c $(wildcard carts/$*/*.c)

public/ppu.wasm: ppu/ppu.c sdk/console.h sdk/wire.h
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -o $@ ppu/ppu.c

run:
	PORT=$(PORT) node host/sim.mjs

dev:
	cd worker && npx wrangler dev

deploy:
	cd worker && npx wrangler deploy

clean:
	rm -f dist/*.wasm public/ppu.wasm worker/src/carts/*.wasm

.PHONY: all run dev deploy clean
