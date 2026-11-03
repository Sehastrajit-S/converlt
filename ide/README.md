# Converlt IDE

Converlt's own editor, built on Code-OSS (the MIT-licensed core of VS Code) the way Cursor and VSCodium are. Upstream is never forked in git. Instead, this folder holds a small set of changes that are applied to a pinned upstream release on every build:

| Path | What it does |
| --- | --- |
| `env.sh` | Pins the upstream tag (`VSCODE_TAG`) and its Node version, and sends every cache, temp dir and toolchain to E: |
| `product.overrides.json` | Identity: name, app IDs, data folders, URL protocol, and Open VSX as the marketplace. `null` deletes a key. |
| `overlays/` | Files copied over the tree: app icons, title-bar icon, editor watermark, and the Converlt workbench code (`src/vs/workbench/contrib/converlt/`). Regenerate the icons with `electron branding/make-icons.cjs`. |
| `patches/*.patch` | Core source changes, applied in order with `git apply`. Keep them small; each must be rebased on upgrades. |
| `extensions/converge-defaults/` | Converlt Dark/Light themes and default settings, shipped as a built-in extension |
| `extensions/converge/` | The Converlt extension itself (runs, compute, cloud, diagnostics, assistant), built and shipped built-in |
| `apply.mjs` | Restores pristine upstream, then applies everything above. Idempotent. |
| `fetch.sh` / `build.sh` | Toolchain + source + dependencies, then the build. |

## Build (Windows)

```bash
bash ide/fetch.sh            # once: portable Node, Code-OSS clone, npm ci (~10 min)
bash ide/build.sh            # packaged app -> ide/out/Converlt-win32-x64/Converlt.exe (close Converlt first)
CONVERLT_OUT=/e/tmp/Converlt bash ide/build.sh   # or build into another folder
bash ide/build.sh --dev      # compile only; then ide/vscode/scripts/code.bat for a dev window
```

Requirements: Git, Python 3, Visual Studio 2022 with the C++ workload, and a Windows 10 SDK. `env.sh` handles two quirks of this machine:
- **Spectre-mitigated MSVC libraries** aren't installed. `msbuild/Directory.Build.rsp` turns that requirement off. Once the component is installed, delete the file.
- **VS 2022 doesn't list a Windows SDK component** (the SDK came with VS 2019 Build Tools). `env.sh` emulates a VS 2022 Developer Prompt so node-gyp uses the SDK that is on disk.

## Current patches

| Patch | Why |
| --- | --- |
| `0001-build-skip-copilot-shim-when-not-bundled` | The build assumes the GitHub Copilot extension is present |
| `0002-build-do-not-bundle-copilot-extension` | Converlt does not ship Microsoft's Copilot; its own ML-aware assistant goes in that slot |
| `0003-build-allow-missing-signtool` | Local builds have no Windows SDK signing tools |
| `0004-converlt-workbench-dashboard-titlebar-watermark` | Loads the Converlt workbench contribution and puts Converlt actions on the empty editor |

## Converlt workbench (native UI)

`overlays/src/vs/workbench/contrib/converlt/` adds, inside the workbench itself:

- **Dashboard and Code modes.** New windows open on the dashboard (setting `converlt.startup`). Dashboard mode hides the side bars, panel, status bar and tabs and gives the window to the Converlt dashboard; Code mode restores the layout. Opening any file switches to Code. Commands: `converlt.showDashboard`, `converlt.showCode`.
- **Title bar controls** next to the command center: the Dashboard/Code switch, the compute target (where runs go; opens the compute menu) and the credit balance. The Converlt extension pushes their state with `converlt.titleBar.setState`.

The chat panel is the Converlt assistant: the built-in Converlt extension contributes the default chat participant (the chat prefers an extension's default participant over its built-in setup agent) plus a `converlt` language-model provider (OpenRouter models through the Converlt Gateway, paid from credits). Copilot's `defaultChatAgent` stays in `product.json` because much of the workbench assumes it exists; its sign-in entry points are switched off in `converge-defaults`.

## Upgrading upstream

1. Bump `VSCODE_TAG` (and `IDE_NODE_VERSION` from the new `.nvmrc`) in `env.sh`.
2. Delete `ide/vscode` and run `fetch.sh`.
3. Run `node ide/apply.mjs`. If a patch fails, fix it against the new tree and regenerate it with `git diff`.

## Licensing notes

- Code-OSS is MIT. Microsoft's marketplace, Pylance, Remote-SSH, Live Share, and Copilot can't be used in a non-Microsoft build.
- Converlt uses Open VSX. Use basedpyright or Jedi for Python language features, and debugpy for debugging; both are on Open VSX.
- Converlt's own remote execution is SSH-based and doesn't depend on Remote-SSH.
