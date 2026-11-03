#!/usr/bin/env bash
# Builds the Converlt IDE from the pinned Code-OSS checkout.
#   bash ide/build.sh          # packaged, minified app -> ide/out/Converlt-win32-x64/
#   bash ide/build.sh --dev    # compile only; run with ide/vscode/scripts/code.bat
# Run `bash ide/fetch.sh` once first.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"
mode="${1:-}"

echo "==> Building the Converlt extension"
(cd "$IDE_DIR/extensions/converge" && node scripts/build.mjs)

echo "==> Applying Converlt branding, patches and built-in extensions"
node "$IDE_DIR/apply.mjs"

cd "$IDE_DIR/vscode"
export NODE_OPTIONS="--max-old-space-size=8192"
if [ "$mode" = "--dev" ]; then
  echo "==> Compiling (dev)"
  npm run compile
  echo "==> Done. Launch: ide/vscode/scripts/code.bat"
  exit 0
fi

# A running Converlt locks its files, and a half-deleted install breaks it: check first.
OUT="${CONVERLT_OUT:-$IDE_DIR/out/Converlt-win32-x64}"
if [ -d "$OUT" ] && ! mv "$OUT" "$OUT.old" 2>/dev/null; then
  echo "Converlt is running from $OUT. Close it and run the build again." >&2
  exit 1
fi
[ -d "$OUT.old" ] && mv "$OUT.old" "$OUT"

echo "==> Packaging Converlt (win32-x64, minified). This takes a while."
npm run gulp -- vscode-win32-x64-min
mkdir -p "$IDE_DIR/out"
rm -rf "$OUT"
mv "$IDE_DIR/VSCode-win32-x64" "$OUT"
echo "==> Done: $IDE_DIR/out/Converlt-win32-x64/Converlt.exe"
