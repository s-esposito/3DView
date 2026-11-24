#!/usr/bin/env bash
# Rebuilds core/vendor/box3d-wasm-0.2.0-noeval.tgz: box3d-wasm 0.2.0's single-threaded "standard"
# flavour (Box3D, Erin Catto, MIT), linked with -sDYNAMIC_EXECUTION=0 so its embind bindings never
# call new Function / eval: the VS Code panel's CSP allows 'wasm-unsafe-eval', not 'unsafe-eval'.
# Otherwise box3d-wasm's own scripts/build.sh recipe, linked with em++ (emsdk 7 no longer brings
# the C++ runtime to an emcc link). ~2 min on a CPU (most of it the first emsdk install).
#
#   bash core/vendor/box3d-wasm-noeval.sh <work_dir>      # needs git, cmake, python3, node >= 22
#
# Leaves <work_dir>/out/box3d.{mjs,wasm}; repack them into the tarball's dist/ (npm pack).
set -euo pipefail
W="$(realpath "${1:?usage: box3d-wasm-noeval.sh <work_dir>}")"
mkdir -p "$W/out"

# emsdk (prebuilt toolchain)
[ -d "$W/emsdk" ] || git clone -q https://github.com/emscripten-core/emsdk.git "$W/emsdk"
(cd "$W/emsdk" && ./emsdk install latest > /dev/null && ./emsdk activate latest > /dev/null)
source "$W/emsdk/emsdk_env.sh" > /dev/null 2>&1

# box3d-wasm at the commit npm 0.2.0 was published from (no release tags), and its pinned Box3D
[ -d "$W/box3d-wasm" ] || git clone -q https://github.com/monteslu/box3d-wasm.git "$W/box3d-wasm"
cd "$W/box3d-wasm"
git checkout -q "$(git rev-list -n1 --before='2026-07-02T14:27:06Z' origin/HEAD)"   # 3c71b9c
bash scripts/fetch-deps.sh                                                          # box3d 29bf523

BUILD=build/cmake-standard-Release
emcmake cmake -S deps/box3d -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DBOX3D_SAMPLES=OFF \
  -DBOX3D_UNIT_TESTS=OFF -DBOX3D_BENCHMARKS=OFF -DBOX3D_DOCS=OFF -DBOX3D_VALIDATE=OFF > /dev/null
cmake --build "$BUILD" -j"$(nproc)" > /dev/null
em++ csrc/glue.cpp "$BUILD/src/libbox3d.a" -I deps/box3d/include \
  -std=c++17 -lembind -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=Box3D \
  -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,HEAPU32 -msimd128 -msse2 -O3 \
  -sDYNAMIC_EXECUTION=0 \
  -o "$W/out/box3d.mjs"

echo "new Function: $(grep -o 'new Function' "$W/out/box3d.mjs" | wc -l) (must be 0)"
