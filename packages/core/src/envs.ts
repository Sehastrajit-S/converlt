// Python environment management on a machine: discover environments (the machine's Python,
// Converlt venvs/conda envs in ~/.converge/envs, and conda's own envs), create them, and
// install packages. Everything runs through the machine's transport, like the agent does.
import type { EnvCreateSpec, EnvInstallSpec, EnvList, EnvOpResult, EnvPackage } from "./api.ts";
import { lastJsonLine, remotePath, shq, type RemoteTransport } from "./transport.ts";

export const ENV_ROOT = "~/.converge/envs";
/** On cloud pods only the /workspace volume survives a stop, so environments live there. */
export const CLOUD_ENV_ROOT = "/workspace/.converge/envs";

const NAME_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const PKG_RE = /^[A-Za-z0-9][\w.\-[\],<>=!~*+ ]*$/;
const PY_VERSION_RE = /^3\.\d{1,2}$/;

/** Discovery runs under the machine's own Python (stdlib only, 3.8+) and prints one JSON line. */
const DISCOVER = String.raw`
import glob, json, os, shutil, subprocess, sys
PROBE = r'''
import json, platform
r = {"version": platform.python_version(), "torch": None, "cuda": None, "cudaAvailable": False, "packages": None}
try:
    import importlib.metadata as md
    r["packages"] = len({d.metadata["Name"].lower() for d in md.distributions() if d.metadata["Name"]})
except Exception:
    pass
try:
    import torch
    r["torch"] = torch.__version__
    r["cuda"] = torch.version.cuda
    r["cudaAvailable"] = bool(torch.cuda.is_available())
except Exception:
    pass
print(json.dumps(r))
'''
home = os.path.expanduser("~")
root = os.path.expanduser(os.environ.get("CONVERLT_ENV_ROOT") or "~/.converge/envs")
seen, envs = set(), []
def add(kind, name, py, prefix):
    real = os.path.realpath(py)
    if not os.path.exists(py) or (real, prefix) in seen:
        return
    seen.add((real, prefix))
    info = {"error": None, "version": None, "torch": None, "cuda": None, "cudaAvailable": False, "packages": None}
    try:
        out = subprocess.run([py, "-c", PROBE], capture_output=True, text=True, timeout=120)
        info.update(json.loads(out.stdout.strip().splitlines()[-1]))
    except Exception as e:
        info["error"] = str(e)[:300]
    envs.append(dict(kind=kind, name=name, python=py, prefix=prefix, managed=prefix.startswith(root), **info))
add("system", "Machine Python", sys.executable, sys.prefix)
for d in sorted(glob.glob(os.path.join(root, "*"))):
    add("conda" if os.path.isdir(os.path.join(d, "conda-meta")) else "venv", os.path.basename(d), os.path.join(d, "bin", "python"), d)
conda = shutil.which("conda") or next((c for c in [os.path.join(home, p, "bin", "conda") for p in ("miniconda3", "anaconda3", "miniforge3")] + ["/opt/conda/bin/conda"] if os.path.exists(c)), None)
if conda:
    try:
        listed = json.loads(subprocess.run([conda, "env", "list", "--json"], capture_output=True, text=True, timeout=60).stdout)["envs"]
        for p in listed:
            add("conda", os.path.basename(p) if "envs" in p.split(os.sep) else "base", os.path.join(p, "bin", "python"), p)
    except Exception:
        pass
print(json.dumps({"envs": envs, "conda": conda, "root": root}))
`;

export class EnvManager {
  private readonly t: RemoteTransport;
  private readonly python: string;
  private readonly explain: (stderr: string) => string;
  private readonly root: string;

  constructor(transport: RemoteTransport, python: string, explain: (stderr: string) => string, root = ENV_ROOT) {
    this.t = transport;
    this.python = python;
    this.explain = explain;
    this.root = root;
  }

  async list(): Promise<EnvList> {
    const r = await this.t.exec(`CONVERLT_ENV_ROOT=${remotePath(this.root)} ${this.python} -`, { input: DISCOVER, timeoutMs: 10 * 60_000 });
    const parsed = lastJsonLine<EnvList>(r.stdout);
    if (r.code !== 0 || !parsed) throw new Error(this.explain(r.stderr) || "Could not list environments");
    return parsed;
  }

  /** Runs a long shell step, returning its exit status and the tail of its combined output. */
  private async step(script: string, input?: string): Promise<EnvOpResult> {
    const r = await this.t.exec(`set -o pipefail; { ${script}; } 2>&1 | tail -n 200`, { input, timeoutMs: 45 * 60_000 });
    const log = (r.stdout + r.stderr).trim();
    return { ok: r.code === 0, log: log.length > 20_000 ? log.slice(-20_000) : log };
  }

  async create(spec: EnvCreateSpec): Promise<EnvOpResult> {
    if (!NAME_RE.test(spec.name)) throw new Error("Environment names use letters, digits, dot, dash and underscore (max 40)");
    const prefix = `${this.root}/${spec.name}`;
    const dir = remotePath(prefix);
    let create: string;
    if (spec.kind === "conda") {
      const v = spec.pythonVersion ?? "3.11";
      if (!PY_VERSION_RE.test(v)) throw new Error("Python version must look like 3.11");
      create = `conda=$(command -v conda || ls "$HOME"/{miniconda3,anaconda3,miniforge3}/bin/conda /opt/conda/bin/conda 2>/dev/null | head -1); [ -n "$conda" ] || { echo "conda is not installed on this machine. Use a venv instead."; exit 3; }; "$conda" create -y -p ${dir} python=${v}`;
    } else {
      create = `${this.python} -m venv ${spec.systemSitePackages ? "--system-site-packages " : ""}${dir}`;
    }
    const py = `${dir}/bin/python`;
    const steps = [`mkdir -p ${remotePath(this.root)}`, `[ ! -e ${dir} ] || { echo "An environment named ${spec.name} already exists."; exit 4; }`, create, `${py} -m pip install --upgrade pip`];
    const res = await this.step(steps.join(" && "));
    if (!res.ok || (!spec.packages?.length && !spec.requirements)) return res;
    const install = await this.install(`${prefix}/bin/python`, { packages: spec.packages, requirements: spec.requirements });
    return { ok: install.ok, log: `${res.log}\n${install.log}`.trim() };
  }

  async install(python: string, spec: EnvInstallSpec): Promise<EnvOpResult> {
    const py = checkPython(python);
    const pkgs = (spec.packages ?? []).map((p) => p.trim()).filter(Boolean);
    for (const p of pkgs) if (!PKG_RE.test(p) || p.startsWith("-")) throw new Error(`Not a package spec: ${p}`);
    const parts: string[] = [];
    if (pkgs.length) parts.push(`${py} -m pip install ${pkgs.map(shq).join(" ")}`);
    if (spec.requirements?.trim()) parts.push(`f=$(mktemp) && cat > "$f" && ${py} -m pip install -r "$f"; rc=$?; rm -f "$f"; exit $rc`);
    if (!parts.length) throw new Error("Nothing to install");
    // Requirements arrive on stdin, so they never pass through the shell.
    return this.step(parts.join(" && "), spec.requirements?.trim() ? spec.requirements : undefined);
  }

  async packages(python: string): Promise<EnvPackage[]> {
    const r = await this.t.exec(`${checkPython(python)} -m pip list --format=json --disable-pip-version-check`, { timeoutMs: 120_000 });
    const line = r.stdout.trim().split(/\r?\n/).reverse().find((l) => l.startsWith("["));
    if (r.code !== 0 || !line) throw new Error(this.explain(r.stderr) || "pip list failed");
    return (JSON.parse(line) as EnvPackage[]).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Deletes a Converlt-managed environment (only ever under the env root). */
  async remove(name: string): Promise<void> {
    if (!NAME_RE.test(name)) throw new Error("Invalid environment name");
    const r = await this.t.exec(`rm -rf -- ${remotePath(`${this.root}/${name}`)}`, { timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(this.explain(r.stderr) || "Could not delete the environment");
  }
}

/** A Python path the user picked from the environment list: an absolute or ~/ path without shell metacharacters. */
export function checkPython(p: string): string {
  const s = p.trim();
  if (!/^(~\/|\/)[\w./+-]*python[\d.]*$/.test(s) || s.split("/").includes("..")) throw new Error(`Not a Python interpreter path: ${p}`);
  return s.startsWith("~/") ? remotePath(s) : shq(s);
}
