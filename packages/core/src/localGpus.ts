// This computer's own NVIDIA GPUs. On Windows they're reachable through WSL2: each installed
// distribution that sees a GPU becomes a machine automatically, with the best Python it has
// (one whose PyTorch can use CUDA, else one with PyTorch, else python3).
import { LocalTransport, runProcess, WslTransport } from "./transport.ts";

export interface LocalGpu {
  distro: string;
  gpus: string[];
  /** The interpreter runs should use. */
  python: string;
  /** Whether that interpreter's PyTorch can use the GPU. */
  torchCuda: boolean;
}

/** Ordered by preference: Converlt's own environments, then conda and common venv spots. */
const DETECT = String.raw`
gpus=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null)
[ -z "$gpus" ] && exit 0
echo "GPUS:$gpus" | tr '\n' ';'; echo
best=""; fallback=""
for p in ~/.converge/envs/*/bin/python ~/miniconda3/envs/*/bin/python ~/anaconda3/envs/*/bin/python ~/miniforge3/envs/*/bin/python ~/.virtualenvs/*/bin/python ~/venv*/bin/python ~/.venv/bin/python ~/*/.venv/bin/python ~/.cache/*/bin/python ~/miniconda3/bin/python ~/anaconda3/bin/python $(command -v python3); do
  [ -x "$p" ] || continue
  r=$(timeout 30 "$p" -c "import torch; print('cuda' if torch.cuda.is_available() else 'cpu')" 2>/dev/null)
  if [ "$r" = cuda ]; then best="$p"; break; fi
  [ "$r" = cpu ] && [ -z "$fallback" ] && fallback="$p"
done
if [ -n "$best" ]; then echo "PY:cuda:$best"; elif [ -n "$fallback" ]; then echo "PY:cpu:$fallback"; else echo "PY:none:python3"; fi
`;

/** This computer on macOS / Linux: its GPU (NVIDIA or Apple) and the best Python (CUDA, then MPS, then any PyTorch). */
const NATIVE_DETECT = String.raw`
gpus=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null)
if [ -z "$gpus" ] && [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then gpus="$(sysctl -n machdep.cpu.brand_string 2>/dev/null) GPU"; fi
echo "GPUS:$gpus" | tr '\n' ';'; echo
best=""; mps=""; fallback=""
for p in ~/.converge/envs/*/bin/python ~/miniconda3/envs/*/bin/python ~/anaconda3/envs/*/bin/python ~/miniforge3/envs/*/bin/python ~/.virtualenvs/*/bin/python ~/venv*/bin/python ~/.venv/bin/python ~/*/.venv/bin/python /opt/homebrew/bin/python3 ~/miniconda3/bin/python ~/miniforge3/bin/python ~/anaconda3/bin/python $(command -v python3); do
  [ -x "$p" ] || continue
  r=$(timeout 30 "$p" -c "import torch; print('cuda' if torch.cuda.is_available() else 'mps' if getattr(torch.backends, 'mps', None) is not None and torch.backends.mps.is_available() else 'cpu')" 2>/dev/null)
  if [ "$r" = cuda ]; then best="$p"; break; fi
  [ "$r" = mps ] && [ -z "$mps" ] && mps="$p"
  [ "$r" = cpu ] && [ -z "$fallback" ] && fallback="$p"
done
if [ -n "$best" ]; then echo "PY:cuda:$best"; elif [ -n "$mps" ]; then echo "PY:mps:$mps"; elif [ -n "$fallback" ]; then echo "PY:cpu:$fallback"; else echo "PY:none:python3"; fi
`;

export interface ThisComputer {
  /** GPU names; empty for a CPU-only computer. */
  gpus: string[];
  python: string;
  accelerator: "cuda" | "mps" | "cpu" | "none";
}

/** macOS and Linux only (Windows uses WSL; see detectLocalGpus). */
export async function detectThisComputer(): Promise<ThisComputer | null> {
  if (process.platform === "win32") return null;
  const r = await new LocalTransport().exec("bash -s", { input: NATIVE_DETECT, timeoutMs: 180_000 }).catch(() => null);
  if (!r) return null;
  const gpus = /^GPUS:(.*)$/m.exec(r.stdout)?.[1]?.split(";").map((s) => s.trim()).filter(Boolean) ?? [];
  const py = /^PY:(\w+):(.+)$/m.exec(r.stdout);
  return { gpus, python: py?.[2]?.trim() ?? "python3", accelerator: (py?.[1] ?? "none") as ThisComputer["accelerator"] };
}

/** WSL prints its distribution list in UTF-16 with a BOM. */
function wslNames(stdout: string): string[] {
  return stdout
    .replace(/\0/g, "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^docker-desktop/i.test(s) && /^[\w.-]+$/.test(s));
}

export async function detectLocalGpus(): Promise<LocalGpu[]> {
  if (process.platform !== "win32") return [];
  const list = await runProcess("wsl.exe", ["-l", "-q"], { timeoutMs: 15_000 });
  if (list.code !== 0) return [];
  const found = await Promise.all(
    wslNames(list.stdout).map(async (distro): Promise<LocalGpu | null> => {
      // Over stdin: Windows argument quoting mangles the script's double quotes on the way into wsl.exe.
      const r = await new WslTransport(distro).exec("bash -s", { input: DETECT, timeoutMs: 120_000 });
      const gpus = /^GPUS:(.*)$/m.exec(r.stdout)?.[1]?.split(";").map((s) => s.trim()).filter(Boolean) ?? [];
      if (!gpus.length) return null;
      const py = /^PY:(\w+):(.+)$/m.exec(r.stdout);
      return { distro, gpus, python: py?.[2]?.trim() ?? "python3", torchCuda: py?.[1] === "cuda" };
    }),
  );
  return found.filter((x): x is LocalGpu => x !== null);
}
