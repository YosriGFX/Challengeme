# op-console — build the cartridges and the client PPU to WebAssembly.
#
#   make          build everything (needs clang with the wasm32 target + wasm-ld)
#   make run      start the local simulator (needs only Node.js; prebuilt .wasm files are included)
#   make test     run the automated tests (needs only Node.js 18+)
#   make dev      run the real Worker + Durable Object locally (needs: cd worker && npm install)
#   make deploy   deploy to Cloudflare
#   make clean
#
# macOS: Apple's clang has no wasm target. Use LLVM from Homebrew:
#   brew install llvm lld && make WASM_CC=$$(brew --prefix llvm)/bin/clang

WASM_CC ?= clang
PORT    ?= 8787
CFLAGS  := --target=wasm32 -nostdlib -ffreestanding -O2 -Wall -Wextra -fno-builtin
LDFLAGS := -Wl,--no-entry -Wl,--strip-all -Wl,-z,stack-size=16384 -Wl,--initial-memory=131072

CARTS   := dama pong flap keys
SDK     := sdk/console.h sdk/wire.h sdk/runtime.c

all: $(CARTS:%=dist/%.wasm) public/ppu.wasm tests/build/dama_test.wasm tests/build/six.wasm
	@mkdir -p worker/src/carts && cp dist/*.wasm worker/src/carts/
	@echo "built: $^"

dist/%.wasm: carts/%/*.c $(SDK)
	@mkdir -p dist
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -Isdk -o $@ sdk/runtime.c $(wildcard carts/$*/*.c)

public/ppu.wasm: ppu/ppu.c sdk/console.h sdk/wire.h
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -o $@ ppu/ppu.c

# test-only builds: never served, never copied into the Worker
tests/build/dama_test.wasm: tests/dama_harness.c carts/dama/dama.c $(SDK)
	@mkdir -p tests/build
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -Isdk -o $@ sdk/runtime.c tests/dama_harness.c

tests/build/six.wasm: tests/carts/six.c $(SDK)
	@mkdir -p tests/build
	$(WASM_CC) $(CFLAGS) $(LDFLAGS) -Isdk -o $@ sdk/runtime.c tests/carts/six.c

run:
	PORT=$(PORT) node host/sim.mjs

test:
	node --test $(wildcard tests/*.test.mjs)

dev:
	cd worker && npx wrangler dev

deploy:
	cd worker && npx wrangler deploy

clean:
	rm -f dist/*.wasm public/ppu.wasm worker/src/carts/*.wasm tests/build/*.wasm

.PHONY: all run test dev deploy clean
