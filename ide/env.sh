# Source this before any IDE build step:  . ide/env.sh
# Every cache, temp dir and toolchain lives on E: (C: is full).

IDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$IDE_DIR")"
CACHE_DIR="$REPO_DIR/.cache"
export CONVERGE_IDE_DIR="$IDE_DIR"

# Pinned upstream and its required Node (from vscode/.nvmrc).
export VSCODE_TAG="1.143.1"
export IDE_NODE_VERSION="24.18.0"
export IDE_NODE_DIR="$CACHE_DIR/toolchain/node-v$IDE_NODE_VERSION-win-x64"

win() { cygpath -w "$1"; }
mkdir -p "$CACHE_DIR"/{tmp,npm,electron,node-gyp,toolchain}

export TEMP="$(win "$CACHE_DIR/tmp")" TMP="$(win "$CACHE_DIR/tmp")" TMPDIR="$CACHE_DIR/tmp"
export npm_config_cache="$(win "$CACHE_DIR/npm")"
export npm_config_devdir="$(win "$CACHE_DIR/node-gyp")"
export electron_config_cache="$(win "$CACHE_DIR/electron")" ELECTRON_CACHE="$(win "$CACHE_DIR/electron")"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLAYWRIGHT_BROWSERS_PATH="$(win "$CACHE_DIR/playwright")"
# Native modules need VS 2022's toolset. This machine's VS 2022 install doesn't list a Windows SDK
# component (the SDK on disk came with VS 2019 Build Tools), so node-gyp would skip it. Emulate a
# VS 2022 Developer Command Prompt instead: node-gyp then takes the toolset and SDK from these vars.
VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
if [ -x "$VSWHERE" ]; then
  VS2022_PATH="$("$VSWHERE" -version "[17.0,18.0)" -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath | tr -d '\r')"
  VS2022_VER="$("$VSWHERE" -version "[17.0,18.0)" -products '*' -latest -property installationVersion | tr -d '\r')"
  SDK_VER="$(ls "/c/Program Files (x86)/Windows Kits/10/Include" 2>/dev/null | grep -E '^10\.' | sort -V | tail -1)"
  if [ -n "$VS2022_PATH" ] && [ -n "$SDK_VER" ]; then
    export VCINSTALLDIR="$VS2022_PATH\\VC\\" VSCMD_VER="$VS2022_VER" WindowsSDKVersion="$SDK_VER\\"
  fi
fi
export npm_config_msvs_version=2022 GYP_MSVS_VERSION=2022
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
# VS Code terminals export this; it makes Electron start as plain Node.
unset ELECTRON_RUN_AS_NODE

if [ -x "$IDE_NODE_DIR/node.exe" ]; then
  export PATH="$IDE_NODE_DIR:$PATH"
fi
