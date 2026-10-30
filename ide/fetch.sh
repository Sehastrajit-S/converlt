#!/usr/bin/env bash
# Downloads the pinned toolchain and Code-OSS source, then installs dependencies.
#   bash ide/fetch.sh
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# 1. Portable Node matching vscode/.nvmrc (no system install).
if [ ! -x "$IDE_NODE_DIR/node.exe" ]; then
  echo "==> Node $IDE_NODE_VERSION"
  zip="$CACHE_DIR/toolchain/node.zip"
  curl -fsSL "https://nodejs.org/dist/v$IDE_NODE_VERSION/node-v$IDE_NODE_VERSION-win-x64.zip" -o "$zip"
  (cd "$CACHE_DIR/toolchain" && unzip -q "$zip" && rm "$zip")
  export PATH="$IDE_NODE_DIR:$PATH"
fi
echo "node $(node -v), npm $(npm -v)"

# 2. Code-OSS source at the pinned tag (shallow).
if [ ! -d "$IDE_DIR/vscode/.git" ]; then
  echo "==> Cloning microsoft/vscode@$VSCODE_TAG"
  git -c core.longpaths=true clone --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode.git "$IDE_DIR/vscode"
fi
git -C "$IDE_DIR/vscode" config core.longpaths true

# 3. Spectre-mitigated MSVC libs are not installed (and C: has no room for them).
#    MSBuild reads Directory.Build.rsp from ancestor folders; its /p: switch is a global
#    property, so it overrides every native module's project settings below.
cp "$IDE_DIR/msbuild/Directory.Build.rsp" "$IDE_DIR/vscode/Directory.Build.rsp"

# 4. Dependencies (native modules compile against Electron headers).
echo "==> npm ci"
cd "$IDE_DIR/vscode"
npm ci
echo "==> fetch complete"
