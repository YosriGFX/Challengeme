#!/bin/sh
# Puts the two tools a game build needs into rom_maker/.tools (nothing is installed
# system-wide): RGBDS (the Game Boy assembler) and wabt (wat2wasm, for the translator).
# Also needs Python 3 and Node.js 18 or newer, already on most machines.
# Skip it if `rgbasm` and `wat2wasm` already work in your terminal.
set -e
cd "$(dirname "$0")/.."
mkdir -p .tools && cd .tools
RGBDS=v0.9.4
WABT=1.0.36
case "$(uname -s)" in
  Linux)
    curl -sSLo rgbds.tar.xz "https://github.com/gbdev/rgbds/releases/download/$RGBDS/rgbds-linux-x86_64.tar.xz"
    mkdir -p rgbds && tar -xJf rgbds.tar.xz -C rgbds && rm rgbds.tar.xz
    curl -sSLo wabt.tar.gz "https://github.com/WebAssembly/wabt/releases/download/$WABT/wabt-$WABT-ubuntu-20.04.tar.gz" ;;
  Darwin)
    curl -sSLo rgbds.zip "https://github.com/gbdev/rgbds/releases/download/$RGBDS/rgbds-macos.zip"
    mkdir -p rgbds && unzip -oq rgbds.zip -d rgbds && rm rgbds.zip
    curl -sSLo wabt.tar.gz "https://github.com/WebAssembly/wabt/releases/download/$WABT/wabt-$WABT-macos-14.tar.gz" ;;
  *)
    echo "Install RGBDS (https://rgbds.gbdev.io/install) and wabt (https://github.com/WebAssembly/wabt) yourself."
    exit 1 ;;
esac
tar -xzf wabt.tar.gz && rm wabt.tar.gz && rm -rf wabt && mv "wabt-$WABT" wabt
./rgbds/rgbasm --version
./wabt/bin/wat2wasm --version
echo "ready: python3 tools/build.py template"
