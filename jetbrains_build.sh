#!/usr/bin/env bash
# Build the JetBrains / PyCharm plugin: build the shared webview bundle (which the
# plugin's copyWebview task copies into its resources), then run Gradle's
# buildPlugin. Output: jetbrains/build/distributions/<name>-<version>.zip
#
# Requires node/npm on PATH (activate the env that provides them — e.g. the conda
# env) and a Gradle launcher: the ./gradlew wrapper if present, else a system
# `gradle` (8.10+). JDK 21 is needed by the Gradle toolchain. See jetbrains/README.md.
#
# Usage: ./jetbrains_build.sh
set -euo pipefail

# Run from the repo root (this script's directory).
cd "$(dirname "${BASH_SOURCE[0]}")"

for cmd in node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found on PATH — activate the env that provides node/npm (e.g. your conda env)." >&2
    exit 1
  fi
done

echo "==> Building the shared webview bundle (core/out/webview.js)"
npm run build -w @3dview/core

cd jetbrains

# Pick a Gradle launcher: the committed wrapper if present, else a system gradle.
if [ -x ./gradlew ]; then
  GRADLE=(./gradlew)
elif command -v gradle >/dev/null 2>&1; then
  GRADLE=(gradle)
else
  echo "error: no Gradle launcher — run 'gradle wrapper' here once, or install Gradle 8.10+." >&2
  echo "  (see jetbrains/README.md for a download-by-URL fallback.)" >&2
  exit 1
fi

echo "==> Building the plugin with ${GRADLE[*]}"
if ! "${GRADLE[@]}" buildPlugin; then
  echo >&2
  echo "buildPlugin failed. If the error mentions configuration-cache serialization," >&2
  echo "retry with: (cd jetbrains && ${GRADLE[*]} buildPlugin --no-configuration-cache)" >&2
  exit 1
fi

echo
echo "Done: jetbrains/build/distributions/ (the plugin .zip)"
