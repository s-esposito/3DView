#!/usr/bin/env bash
# Build the VS Code extension: build the monorepo (shared webview bundle + the
# extension) and package a distributable .vsix.
#
# Requires node/npm/npx on PATH (activate the env that provides them — e.g. the
# conda env — if node isn't found). Output: vscode/<name>-<version>.vsix
# Install the result with: code --install-extension <vsix> --force
#
# Usage: ./vscode_build.sh
set -euo pipefail

# Run from the repo root (this script's directory).
cd "$(dirname "${BASH_SOURCE[0]}")"

for cmd in node npm npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found on PATH — activate the env that provides node/npm/npx (e.g. your conda env)." >&2
    exit 1
  fi
done

echo "==> Building monorepo (core's shared webview bundle, then the extension)"
npm run build

echo "==> Packaging the .vsix"
cd vscode
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
VSIX="${NAME}-${VERSION}.vsix"
npx --yes @vscode/vsce package --allow-missing-repository --no-dependencies --out "$VSIX"

echo
echo "Done: vscode/${VSIX}"
echo "Install with: code --install-extension vscode/${VSIX} --force"
