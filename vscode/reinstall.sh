#!/usr/bin/env bash
# Repackage the extension and (re)install it into VS Code.
#
# Builds the bundles, packages a .vsix, and installs it with --force so the same
# version (0.0.1) reinstalls cleanly without a version bump. Run after code
# changes to refresh the installed extension. Requires: node/npm, npx, and the
# `code` CLI on PATH (activate your env first if node isn't found).
#
# Usage: ./reinstall.sh
set -euo pipefail

# Operate from this package dir (vscode/); the repo root is its parent.
cd "$(dirname "${BASH_SOURCE[0]}")"

# Fail early with a clear message if a required tool is missing.
for cmd in node npm npx code; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found on PATH." >&2
    [ "$cmd" = node ] || [ "$cmd" = npm ] || [ "$cmd" = npx ] && \
      echo "  (node/npm/npx: activate the environment that provides them, e.g. your conda env.)" >&2
    exit 1
  fi
done

# Derive artifact name and extension id from package.json.
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
VSIX="${NAME}-${VERSION}.vsix"
EXT_ID="${PUBLISHER}.${NAME}"

echo "==> Building monorepo (core builds the shared webview bundle, then the extension)"
( cd .. && npm run build )

echo "==> Packaging ${VSIX}"
npx --yes @vscode/vsce package --allow-missing-repository --out "$VSIX"

echo "==> Installing ${EXT_ID} from ${VSIX}"
code --install-extension "$VSIX" --force

echo
echo "Done. Run 'Developer: Reload Window' in VS Code to load the new build."
