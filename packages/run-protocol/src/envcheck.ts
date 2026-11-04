// Before a run starts: does this machine's PyTorch build fit its GPU and driver? Each problem
// comes with a fix where one is known: the pip requirements that install a matching build.

export interface EnvCheckInput {
  /** e.g. "2.8.0+cu129"; null when PyTorch isn't installed. */
  torch: string | null | undefined;
  /** CUDA version PyTorch was built with, e.g. "12.9"; null for a CPU-only build. */
  torchCuda: string | null | undefined;
  cudaAvailable: boolean | null | undefined;
  /** Highest CUDA version the driver supports (nvidia-smi's "CUDA Version"), e.g. "12.4". */
  driverCuda: string | null | undefined;
  driver: string | null | undefined;
  gpuName: string | null | undefined;
  /** Compute capability of GPU 0, e.g. "12.0". */
  gpuCapability: string | null | undefined;
  /** torch.cuda.get_arch_list(), e.g. ["sm_80", "sm_90", "compute_90"]. */
  archList: string[] | null | undefined;
  /** Installed packages that must match torch's build, e.g. ["torchvision"]. */
  companions?: string[] | null;
}

export interface EnvFix {
  label: string;
  /** Contents of a requirements file to pip install with the machine's interpreter. */
  requirements: string;
}

export interface EnvIssue {
  id: "no-torch" | "cpu-build" | "driver-too-old" | "driver-minor" | "arch" | "cuda-unavailable";
  severity: "error" | "warning";
  title: string;
  detail: string;
  fix: EnvFix | null;
}

/**
 * CUDA builds published for each PyTorch release, oldest first. Read from the download.pytorch.org
 * indexes (whl/cuXXX/torch/) on 2026-11-04; add new releases here as they ship.
 */
const WHEELS: [string, string[]][] = [
  ["2.0", ["11.7", "11.8"]],
  ["2.1", ["11.8", "12.1"]],
  ["2.2", ["11.8", "12.1"]],
  ["2.3", ["11.8", "12.1"]],
  ["2.4", ["11.8", "12.1", "12.4"]],
  ["2.5", ["11.8", "12.1", "12.4"]],
  ["2.6", ["11.8", "12.4", "12.6"]],
  ["2.7", ["11.8", "12.6", "12.8"]],
  ["2.8", ["12.6", "12.8", "12.9"]],
  ["2.9", ["12.6", "12.8", "12.9", "13.0"]],
  ["2.10", ["12.6", "12.8", "12.9", "13.0"]],
  ["2.11", ["12.6", "12.8", "12.9", "13.0"]],
  ["2.12", ["12.6", "12.9", "13.0", "13.2"]],
  ["2.13", ["12.6", "12.9", "13.0", "13.2"]],
  ["2.14", ["12.6", "13.0", "13.2"]],
  ["2.15", ["13.2", "13.4"]],
];

type Ver = [number, number];
function ver(v: string | null | undefined): Ver | null {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const cmp = (a: Ver, b: Ver) => a[0] - b[0] || a[1] - b[1];
const tag = (cuda: string) => `cu${cuda.replace(".", "")}`;

/** The newest CUDA build of `release` that is at most `max` (what the driver and GPU allow) and at least `min`. */
function bestBuild(release: string, max: Ver, min: Ver | null): string | null {
  const builds = WHEELS.find(([r]) => r === release)?.[1] ?? [];
  const ok = builds.filter((c) => cmp(ver(c)!, max) <= 0 && (!min || cmp(ver(c)!, min) >= 0));
  return ok.at(-1) ?? null;
}

/**
 * Requirements that install a PyTorch build in [min, max]: the same release if a fitting build
 * exists, else (unless `sameRelease`) the newest release that has one.
 */
function torchFix(torch: string | null | undefined, max: Ver, min: Ver | null, companions: string[], sameRelease = false): EnvFix | null {
  const base = (torch ?? "").split("+")[0]!;
  const release = ver(base) ? `${ver(base)![0]}.${ver(base)![1]}` : null;
  const extra = companions.length ? `\n${companions.join("\n")}` : "";
  if (release) {
    const same = bestBuild(release, max, min);
    if (same) return { label: `Reinstall PyTorch ${base} for CUDA ${same}`, requirements: `--index-url https://download.pytorch.org/whl/${tag(same)}\ntorch==${base}${extra}` };
    if (sameRelease) return null;
  }
  for (const [r] of [...WHEELS].reverse()) {
    const build = bestBuild(r, max, min);
    if (build)
      return {
        label: release ? `Switch to PyTorch ${r} for CUDA ${build}` : `Install PyTorch ${r} for CUDA ${build}`,
        requirements: `--index-url https://download.pytorch.org/whl/${tag(build)}\ntorch==${r}.*${extra}`,
      };
  }
  return null;
}

/** Whether a build with these kernels runs on a GPU of compute capability `cap`. */
export function archSupported(archList: string[], cap: Ver): boolean {
  for (const a of archList) {
    const m = /^(sm|compute)_(\d+)(\d)[a-z]?$/.exec(a);
    if (!m) continue;
    const v: Ver = [Number(m[2]), Number(m[3])];
    // Binary kernels run on later minor versions of the same major; PTX JIT-compiles forward.
    if (m[1] === "sm" ? v[0] === cap[0] && v[1] <= cap[1] : cmp(v, cap) <= 0) return true;
  }
  return false;
}

/** The oldest CUDA release that supports a GPU generation (Blackwell needs 12.8, Hopper 11.8). */
function minCudaFor(cap: Ver): Ver | null {
  if (cap[0] >= 10) return [12, 8];
  if (cap[0] === 9) return [11, 8];
  if (cap[0] === 8 && cap[1] === 9) return [11, 8];
  return null;
}

export function checkEnvironment(e: EnvCheckInput): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const driverCuda = ver(e.driverCuda);
  const cap = ver(e.gpuCapability);
  const companions = (e.companions ?? []).filter((c) => /^(torchvision|torchaudio)$/.test(c));
  const gpu = e.gpuName ?? "this GPU";
  if (!driverCuda) return issues; // no NVIDIA driver: the machine checks already say so
  const min = cap ? minCudaFor(cap) : null;
  // CUDA 12.8+ builds dropped Maxwell, Pascal and Volta (below compute capability 7.5).
  const max: Ver = cap && cmp(cap, [7, 5]) < 0 && cmp(driverCuda, [12, 6]) > 0 ? [12, 6] : driverCuda;
  const fix = (torch: string | null) => torchFix(torch, max, min, companions);

  if (!e.torch) {
    issues.push({ id: "no-torch", severity: "error", title: "PyTorch isn't installed", detail: `The training Python has no torch package. The driver supports CUDA up to ${e.driverCuda}.`, fix: fix(null) });
    return issues;
  }
  if (!e.torchCuda) {
    issues.push({
      id: "cpu-build",
      severity: "error",
      title: "This PyTorch build can't use the GPU",
      detail: `torch ${e.torch} is a CPU-only build, so training would run on the CPU even though ${gpu} is available.`,
      fix: fix(e.torch),
    });
    return issues;
  }
  const built = ver(e.torchCuda);
  const driverName = e.driver ? `driver ${e.driver}` : "the driver";
  if (built && built[0] > driverCuda[0]) {
    issues.push({
      id: "driver-too-old",
      severity: "error",
      title: `The GPU driver is too old for torch ${e.torch}`,
      detail: `PyTorch was built for CUDA ${e.torchCuda}, but ${driverName} supports CUDA up to ${e.driverCuda}, so CUDA won't initialise. Update the driver, or install a build for CUDA ${e.driverCuda} or older.`,
      fix: fix(e.torch),
    });
  } else if (built && cmp(built, driverCuda) > 0) {
    // Only a warning, so only offer a rebuild of the same release, never a different PyTorch.
    const rebuild = torchFix(e.torch, max, min, companions, true);
    issues.push({
      id: "driver-minor",
      severity: "warning",
      title: `torch ${e.torch} is built for a newer CUDA than the driver`,
      detail: `PyTorch uses CUDA ${e.torchCuda}; ${driverName} supports up to ${e.driverCuda}. Plain training usually works, but torch.compile, Triton and custom CUDA kernels can fail with "unsupported toolchain" errors.${rebuild ? "" : ` There's no build of this PyTorch for CUDA ${e.driverCuda}, so update the driver if you hit those errors.`}`,
      fix: rebuild,
    });
  }
  if (cap && e.archList?.length && !archSupported(e.archList, cap)) {
    const sm = `sm_${cap[0]}${cap[1]}`;
    const driverBehind = min !== null && cmp(driverCuda, min) < 0;
    issues.push({
      id: "arch",
      severity: "error",
      title: `torch ${e.torch} has no kernels for ${gpu} (${sm})`,
      detail: `This build supports ${e.archList.join(", ")}, so training would fail with "no kernel image is available for execution on the device".${driverBehind ? ` This GPU needs CUDA ${min!.join(".")} or newer and ${driverName} supports ${e.driverCuda}: update the driver first.` : ""}`,
      fix: driverBehind ? null : fix(e.torch),
    });
  }
  if (e.cudaAvailable === false && !issues.some((i) => i.severity === "error"))
    issues.push({
      id: "cuda-unavailable",
      severity: "error",
      title: "PyTorch can't see the GPU",
      detail: "torch.cuda.is_available() is False although the driver and build match. Check CUDA_VISIBLE_DEVICES, that the container was started with GPU access, and that no other process holds the GPU in exclusive mode.",
      fix: null,
    });
  return issues;
}

/** The machine readiness probe's fields this check reads (structurally, so the UI needn't import core). */
export interface ProbeLike {
  ok: boolean;
  driver?: string | null;
  cudaVersion?: string | null;
  gpuCapability?: string | null;
  gpus?: { name: string }[];
  python?: { torch?: string | null; torchCuda?: string | null; cudaAvailable?: boolean; torchArchList?: string[]; gpuCapability?: string; companions?: string[] };
}

/** Problems with a probed machine's PyTorch setup; empty when it wasn't reachable or has no GPU. */
export function checkProbe(p: ProbeLike | null | undefined): EnvIssue[] {
  if (!p?.ok || !p.gpus?.length || !p.python) return [];
  return checkEnvironment({
    torch: p.python.torch,
    torchCuda: p.python.torchCuda,
    cudaAvailable: p.python.cudaAvailable,
    driverCuda: p.cudaVersion,
    driver: p.driver,
    gpuName: p.gpus[0]!.name,
    gpuCapability: p.python.gpuCapability ?? p.gpuCapability,
    archList: p.python.torchArchList,
    companions: p.python.companions,
  });
}
