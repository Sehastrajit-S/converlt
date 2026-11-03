# Converlt

The ML-native IDE that connects your code, GPUs, and experiments.

Converlt is a code editor built on Code-OSS, the open-source core of VS Code, the same approach Cursor took. You write PyTorch code as in VS Code. From the editor you can launch training on any GPU you can reach: a cloud box over SSH, a RunPod GPU paid from Converlt credits, or your local GPU through WSL. Converlt syncs your code, runs it under a supervisor on that machine, and streams back logs, metrics, and GPU telemetry. It flags NaN losses, CUDA OOMs, and crashes (down to the failing line in your code), and records every run so you can compare and reproduce it. Training keeps running if you close the editor.

This is the MVP slice of the [product blueprint](docs/blueprint.md): remote GPU execution, automatic run history, failure diagnostics, and run comparison.

## Quick start

Prerequisites: Node 22+, pnpm, `ssh` and `tar` on PATH (both ship with Windows 10+, macOS, and Linux). The GPU machine needs Linux, Python 3.8+, `bash`, and key-based SSH access (or WSL2 for a local GPU). Building the IDE also needs the toolchain listed in [ide/README.md](ide/README.md).

The IDE bundles the gateway from the [Converlt-server](https://github.com/Sehastrajit-S/Converlt-server) repo, so check both out side by side (or set `CONVERLT_SERVER_DIR`):

```bash
git clone https://github.com/Sehastrajit-S/converlt Converlt
git clone https://github.com/Sehastrajit-S/Converlt-server
(cd Converlt-server && pnpm install)
cd Converlt
pnpm install
pnpm fetch        # once: portable Node, Code-OSS checkout, dependencies (~10 min)
pnpm build        # packaged IDE -> ide/out/Converlt-win32-x64/Converlt.exe
pnpm build:dev    # compile only; then ide/vscode/scripts/code.bat for a dev window
```

1. **Add a machine.** In the Converlt sidebar, click Compute → Add Machine. Choose an SSH host (`user@host` or an `~/.ssh/config` alias), or **Local GPU via WSL**. Converlt installs its agent into `~/.converge` on the machine and checks readiness (driver, PyTorch, CUDA, disk). For a new SSH host, run `ssh <host>` once to accept its key.
2. **Open your project folder.** You don't need to restructure it.
3. **Run.** Click **Run on GPU** above `if __name__ == "__main__":` or in the editor title bar, or run *Converlt: Run Training on GPU…*. Then pick the machine and confirm the command, e.g. `python train.py --lr 3e-4`.

For metric curves and precise diagnostics, add the optional SDK. It is uploaded to the machine automatically, so you don't need to `pip install` it there:

```python
import converge

run = converge.run(config=vars(args))
for step, batch in enumerate(loader):
    loss = train_step(batch)
    run.log({"train/loss": loss}, step=step)
run.log_checkpoint("checkpoints/last.pt")
```

Outside Converlt these calls are no-ops, so the script still runs normally.

## What it does

| Area | Behaviour |
| --- | --- |
| **Remote execution** | Code syncs with `git ls-files`, respecting `.gitignore`. Checkpoints, datasets, virtualenvs, and credentials (`.env`, keys) are always excluded. A detached supervisor (`setsid`) runs the training, so SSH drops and editor restarts never stop it. |
| **Live observation** | Logs (with progress bars throttled), SDK metrics, and GPU/host telemetry every 10s. The IDE follows `events.jsonl` with sequence-numbered replay, and reconnects with backoff. |
| **Run states** | `created → preparing → running → completed / failed / cancelled`, plus `unknown`. A lost connection shows **unknown**. It never reports **failed** unless the run actually failed. |
| **Diagnostics** | NaN/Inf detection (SDK metrics, or `loss=nan` in logs) with an optional stop on NaN. CUDA OOM with PyTorch allocator stats when using the SDK. Exit-code and signal analysis, including the host OOM killer. Stall alerts and low-GPU-utilization warnings. |
| **Run history** | Each run records an immutable manifest: command, parsed hyperparameters, git commit plus the uncommitted diff, machine, environment (Python, torch, CUDA, driver, `pip freeze`), checkpoints with SHA-256 hashes, and experiment notes (hypothesis → conclusion). |
| **Compare** | Overlaid curves with smoothing, best-value table, config diff (differences first), and commit diff between runs. |
| **Reproduce** | Re-launches with the same command and options. It warns when the commit, uncommitted changes, machine, data, or determinism differ. |
| **Cloud GPUs and credits** | Launch RunPod GPUs from the IDE and pay from Converlt credits (100 credits = $1), billed by the [Converlt Gateway](https://github.com/Sehastrajit-S/Converlt-server). Or choose Wallet → Use my own keys: paste a RunPod and/or OpenRouter API key and the gateway runs on this computer, keeps the keys in the OS keychain, and bills at cost against a budget you set. It keeps stopping pods when the budget runs out, even with the IDE closed. |
| **Assistant** | The chat panel is the Converlt assistant (OpenRouter models through the gateway, paid from credits). It can read and search the project, inspect runs and machines, and launch or stop runs. The same tools are available to Claude Code and Codex through the Converlt MCP server. |
| **Datasets & models** | Search Hugging Face (models, datasets) and Kaggle (datasets, models) in the IDE and download straight onto a GPU machine as a background job: `/workspace/.converge/hub` on cloud pods (kept when the pod stops), `~/.converge/hub` elsewhere. Gated models and Kaggle need a token (stored in the OS keychain). The assistant knows the paths. |
| **Cost** | Estimates for your own machines from a user-entered hourly rate, always labelled as estimates. |

## Repository layout

```
ide/                         Converlt IDE: Code-OSS pin, branding, overlays, patches, build scripts
  extensions/converge/       The Converlt extension, built in: sidebar, CodeLens, Problems, status bar, run tabs, chat
  extensions/converge-defaults/  Converlt themes and default settings
packages/core/               Engine: ConvergeService, run manager, SSH/WSL transport, sync, git, run store, MCP server
packages/ui/                 React screens rendered in the IDE's webviews (runs, run detail, compare, compute)
packages/run-protocol/       Shared types, run state machine, event reducer, config diff
services/remote-agent/       converge_agent.py (stdlib-only Python, runs on the GPU machine)
python/converge-runtime/     Optional SDK (converge.run / log / log_checkpoint)
examples/                    smoke (no deps, simulates NaN/OOM/failures) and pytorch-cifar
docs/                        blueprint.md, run-protocol.md
```

Run history is local-first: it lives in `<project>/.converge/` (git-ignored automatically). Settings live in the IDE's user-data folder. The only machine details stored are host names. SSH keys stay in your SSH setup.

## Development

```bash
pnpm watch:extension    # rebuild the Converlt extension on change
pnpm typecheck          # every package
pnpm test               # protocol, core, and extension unit tests
pnpm test:agent         # remote agent (Linux/WSL)

# End-to-end through the production WSL transport: RunManager → sync → agent → tail → persist
cd packages/core && CONVERGE_E2E=wsl node --test src/e2e.test.ts

# Screenshots of the IDE, driven over CDP
node ide/screenshot.mjs ide/out/Converlt-win32-x64/Converlt.exe <project> <outDir>
```

To try an extension change without a full IDE build, run `pnpm build:dev` once, then `pnpm watch:extension` and `node ide/apply.mjs` after each change.

## Not built yet (by design)

These are deferred per the blueprint until users show sustained demand: cloud providers beyond RunPod, idle shutdown, team sync and control plane, automatic AI run analysis, gradient/profiler instrumentation, a dataset workbench, and deployment.
