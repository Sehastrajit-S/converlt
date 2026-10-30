// Datasets and models from Hugging Face and Kaggle: search from the editor, download straight onto
// a GPU machine (never through the laptop). Downloads run as detached jobs on the machine, so they
// survive SSH drops and closing the editor; the editor polls their status.
import { randomUUID } from "node:crypto";
import type { HubDetails, HubItem, HubJob, HubKind, HubSource } from "./api.ts";
import { lastJsonLine, remotePath, shq, type RemoteTransport } from "./transport.ts";

export const HUB_ROOT = "~/.converge/hub";
/** On cloud pods only the /workspace volume survives a stop. */
export const CLOUD_HUB_ROOT = "/workspace/.converge/hub";

const UA = { "User-Agent": "Converlt" };
const HF_ID = /^[\w.-]+\/[\w.-]+$|^[\w.-]+$/;
const KAGGLE_REF = /^[\w.-]+\/[\w.-]+(\/[\w.-]+\/[\w.-]+(\/\d+)?)?$/;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}${res.status === 401 || res.status === 403 ? " (check your token)" : ""}`);
  return (await res.json()) as T;
}

const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
const tagValue = (tags: string[], prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? null;

// ------------------------------------------------------------ search

type HfListItem = { id: string; downloads?: number; likes?: number; lastModified?: string; createdAt?: string; tags?: string[]; pipeline_tag?: string; gated?: boolean | string; private?: boolean; description?: string };

export async function hubSearch(source: HubSource, kind: HubKind, query: string, hfToken?: string): Promise<HubItem[]> {
  const q = encodeURIComponent(query.trim());
  if (source === "huggingface") {
    const path = kind === "model" ? "models" : "datasets";
    const list = await getJson<HfListItem[]>(`https://huggingface.co/api/${path}?search=${q}&sort=downloads&direction=-1&limit=40`, hfToken ? { Authorization: `Bearer ${hfToken}` } : {});
    return list.map((m) => {
      const tags = m.tags ?? [];
      return {
        source,
        kind,
        id: m.id,
        title: m.id,
        subtitle: kind === "model" ? (m.pipeline_tag ?? tagValue(tags, "task_categories:") ?? "") : (m.description ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        downloads: m.downloads ?? null,
        likes: m.likes ?? null,
        updated: m.lastModified ?? m.createdAt ?? null,
        sizeBytes: null,
        license: tagValue(tags, "license:"),
        tags: tags.filter((t) => !t.includes(":")).slice(0, 6),
        gated: !!m.gated,
        url: `https://huggingface.co/${kind === "dataset" ? "datasets/" : ""}${m.id}`,
      };
    });
  }
  if (kind === "dataset") {
    const list = await getJson<Record<string, unknown>[]>(`https://www.kaggle.com/api/v1/datasets/list?search=${q}&sortBy=hottest&page=1`);
    return list.slice(0, 40).map((d) => ({
      source,
      kind,
      id: String(d.ref),
      title: String(d.title ?? d.ref),
      subtitle: String(d.subtitle ?? ""),
      downloads: n(d.downloadCount),
      likes: n(d.voteCount),
      updated: (d.lastUpdated as string) ?? null,
      sizeBytes: n(d.totalBytes),
      license: (d.licenseName as string) ?? null,
      tags: ((d.tags as { name?: string }[]) ?? []).map((t) => t.name ?? "").filter(Boolean).slice(0, 6),
      gated: false,
      url: String(d.url ?? `https://www.kaggle.com/datasets/${d.ref}`),
    }));
  }
  const res = await getJson<{ models?: Record<string, unknown>[] }>(`https://www.kaggle.com/api/v1/models/list?search=${q}`);
  return (res.models ?? []).slice(0, 40).map((m) => ({
    source,
    kind,
    id: String(m.ref),
    title: String(m.title ?? m.ref),
    subtitle: String(m.subtitle ?? ""),
    downloads: null,
    likes: n(m.voteCount),
    updated: (m.updateTime as string) ?? (m.publishTime as string) ?? null,
    sizeBytes: null,
    license: null,
    tags: ((m.tags as { name?: string }[]) ?? []).map((t) => t.name ?? "").filter(Boolean).slice(0, 6),
    gated: false,
    url: String(m.url ?? `https://www.kaggle.com/models/${m.ref}`),
  }));
}

export async function hubDetails(source: HubSource, kind: HubKind, id: string, hfToken?: string): Promise<HubDetails> {
  if (source === "huggingface") {
    if (!HF_ID.test(id)) throw new Error("Invalid Hugging Face id");
    const path = kind === "model" ? "models" : "datasets";
    const d = await getJson<HfListItem & { siblings?: { rfilename: string; size?: number }[]; cardData?: { license?: string }; usedStorage?: number }>(
      `https://huggingface.co/api/${path}/${id}?blobs=true`,
      hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
    );
    const [item] = await hubSearch(source, kind, id, hfToken).catch(() => [] as HubItem[]);
    const files = (d.siblings ?? []).map((s) => ({ path: s.rfilename, size: s.size ?? null }));
    const total = files.reduce((a, f) => a + (f.size ?? 0), 0);
    return {
      ...(item?.id === id ? item : { source, kind, id, title: id, subtitle: "", downloads: d.downloads ?? null, likes: d.likes ?? null, updated: d.lastModified ?? null, sizeBytes: null, license: null, tags: [], gated: !!d.gated, url: `https://huggingface.co/${kind === "dataset" ? "datasets/" : ""}${id}` }),
      license: d.cardData?.license ?? item?.license ?? null,
      gated: !!d.gated,
      sizeBytes: total || null,
      files: files.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)).slice(0, 200),
      fileCount: files.length,
      description: (d.description ?? item?.subtitle ?? "").slice(0, 2000),
      variants: [],
    };
  }
  if (!KAGGLE_REF.test(id)) throw new Error("Invalid Kaggle reference");
  const [owner, slug] = id.split("/");
  if (kind === "dataset") {
    const [item] = (await hubSearch(source, kind, id)).filter((x) => x.id === id);
    type KaggleFile = { name?: string; nameNullable?: string; totalBytes?: string | number };
    const res = await getJson<{ datasetFiles?: KaggleFile[] }>(`https://www.kaggle.com/api/v1/datasets/list/${owner}/${slug}`).catch(() => ({ datasetFiles: [] as KaggleFile[] }));
    const list = (res.datasetFiles ?? []).map((f) => ({ path: String(f.name ?? f.nameNullable ?? ""), size: n(f.totalBytes) }));
    return {
      ...(item ?? { source, kind, id, title: id, subtitle: "", downloads: null, likes: null, updated: null, sizeBytes: null, license: null, tags: [], gated: false, url: `https://www.kaggle.com/datasets/${id}` }),
      files: list.slice(0, 200),
      fileCount: list.length,
      description: item?.subtitle ?? "",
      variants: [],
    };
  }
  const res = await getJson<{ models?: { ref: string; title?: string; subtitle?: string; description?: string; voteCount?: number; url?: string; instances?: { slug: string; framework: string; versionNumber?: number; totalBytes?: number; licenseName?: string }[] }[] }>(
    `https://www.kaggle.com/api/v1/models/list?search=${encodeURIComponent(slug!)}&owner=${encodeURIComponent(owner!)}`,
  );
  const m = res.models?.find((x) => x.ref === id);
  if (!m) throw new Error(`Kaggle model ${id} not found`);
  const variants = (m.instances ?? []).map((i) => ({
    handle: `${id}/${i.framework}/${i.slug}`,
    label: `${i.framework} · ${i.slug}${i.versionNumber ? ` · v${i.versionNumber}` : ""}`,
    sizeBytes: i.totalBytes ?? null,
  }));
  return {
    source,
    kind,
    id,
    title: m.title ?? id,
    subtitle: m.subtitle ?? "",
    downloads: null,
    likes: m.voteCount ?? null,
    updated: null,
    sizeBytes: null,
    license: m.instances?.[0]?.licenseName ?? null,
    tags: [],
    gated: false,
    url: m.url ?? `https://www.kaggle.com/models/${id}`,
    files: [],
    fileCount: 0,
    description: (m.description ?? "").slice(0, 2000),
    variants,
  };
}

// ------------------------------------------------------------ jobs on the machine

/** Runs on the machine inside the hub tools venv. Reads its secrets file, then deletes it. */
const JOB = String.raw`
import json, os, sys, time, traceback
spec_path = sys.argv[1]
with open(spec_path) as f:
    spec = json.load(f)
os.remove(spec_path)
status_path = spec["status"]
st = {k: spec[k] for k in ("jobId", "source", "kind", "id", "path")}
st.update(status="downloading", startedAt=int(time.time() * 1000), endedAt=None, error=None)
def write():
    tmp = status_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, status_path)
write()
try:
    if spec["source"] == "huggingface":
        if spec.get("hfToken"):
            os.environ["HF_TOKEN"] = spec["hfToken"]
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=spec["id"], repo_type=spec["kind"], local_dir=spec["path"])
    else:
        if spec.get("kaggleToken"):
            os.environ["KAGGLE_API_TOKEN"] = spec["kaggleToken"]
        if spec.get("kaggleUser"):
            os.environ["KAGGLE_USERNAME"] = spec["kaggleUser"]
            os.environ["KAGGLE_KEY"] = spec["kaggleKey"]
        os.environ["KAGGLEHUB_CACHE"] = spec["kaggleCache"]
        import kagglehub
        got = kagglehub.dataset_download(spec["id"]) if spec["kind"] == "dataset" else kagglehub.model_download(spec["id"])
        st["path"] = got
    st["status"] = "completed"
except BaseException as e:
    st["status"] = "failed"
    st["error"] = (str(e) or type(e).__name__)[-1500:]
    traceback.print_exc()
st["endedAt"] = int(time.time() * 1000)
write()
`;

/** Starts the job in its own session, like the run supervisor, so it outlives the SSH/WSL command. */
const LAUNCH = `import subprocess, sys
base = sys.argv[1]
subprocess.Popen([sys.executable, base + ".py", base + ".spec"], stdin=subprocess.DEVNULL, stdout=open(base + ".log", "ab"), stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
print("started")`;

/** Lists jobs with live sizes; one JSON line. */
const LIST = String.raw`
import glob, json, os, sys
root = os.path.expanduser(sys.argv[1])
def size(p):
    total = 0
    for d, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(d, f))
            except OSError:
                pass
    return total
jobs = []
for s in sorted(glob.glob(os.path.join(root, ".jobs", "*.json"))):
    try:
        with open(s) as f:
            j = json.load(f)
    except Exception:
        continue
    j["bytes"] = size(j["path"]) if os.path.isdir(j.get("path") or "") else 0
    log = s[:-5] + ".log"
    try:
        with open(log, errors="replace") as f:
            j["log"] = f.read()[-1500:]
    except OSError:
        j["log"] = ""
    jobs.append(j)
print(json.dumps({"jobs": jobs}))
`;

export interface HubSecrets {
  hfToken?: string;
  kaggleToken?: string;
  kaggleUser?: string;
  kaggleKey?: string;
}

export class HubManager {
  private readonly t: RemoteTransport;
  private readonly python: string;
  private readonly root: string;
  private readonly explain: (stderr: string) => string;

  constructor(transport: RemoteTransport, python: string, root: string, explain: (stderr: string) => string) {
    this.t = transport;
    this.python = python;
    this.root = root;
    this.explain = explain;
  }

  private get toolsPython(): string {
    return `${remotePath(`${this.root}/.tools`)}/bin/python`;
  }

  /** A private venv with huggingface_hub and kagglehub, so the user's environments stay untouched. */
  private async ensureTools(): Promise<void> {
    const venv = remotePath(`${this.root}/.tools`);
    const script = [
      `mkdir -p ${remotePath(`${this.root}/.jobs`)}`,
      `[ -x ${venv}/bin/python ] || ${this.python} -m venv ${venv} || { echo "Could not create a Python venv on this machine (on Ubuntu: apt install python3-venv)."; exit 3; }`,
      `${venv}/bin/python -c "import huggingface_hub, kagglehub" 2>/dev/null || ${venv}/bin/python -m pip install -q --disable-pip-version-check huggingface_hub kagglehub`,
    ].join(" && ");
    const r = await this.t.exec(script, { timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().split("\n").slice(-4).join("\n") || this.explain(r.stderr));
  }

  async start(source: HubSource, kind: HubKind, id: string, secrets: HubSecrets): Promise<string> {
    if (source === "huggingface" ? !HF_ID.test(id) : !KAGGLE_REF.test(id)) throw new Error(`Invalid ${source} id: ${id}`);
    await this.ensureTools();
    const jobId = randomUUID().slice(0, 12);
    const home = (await this.t.exec(`cd ${remotePath(this.root)} && pwd`)).stdout.trim().split("\n").pop()!;
    const target = source === "huggingface" ? `${home}/hf/${kind}s/${id}` : `${home}/kaggle`;
    const spec = {
      jobId,
      source,
      kind,
      id,
      path: target,
      status: `${home}/.jobs/${jobId}.json`,
      kaggleCache: `${home}/kaggle`,
      ...(source === "huggingface" ? { hfToken: secrets.hfToken } : { kaggleToken: secrets.kaggleToken, kaggleUser: secrets.kaggleUser, kaggleKey: secrets.kaggleKey }),
    };
    // The spec (with tokens) arrives on stdin into a 0600 file the job deletes on start: never in argv or env of the shell.
    const jobs = `${home}/.jobs`;
    const r = await this.t.exec(
      `umask 077 && cat > ${shq(`${jobs}/${jobId}.spec`)} && printf %s ${shq(JOB)} > ${shq(`${jobs}/${jobId}.py`)} && ` +
        `cd ${shq(home)} && ${this.toolsPython} -c ${shq(LAUNCH)} ${shq(`${jobs}/${jobId}`)}`,
      { input: JSON.stringify(spec) },
    );
    if (r.code !== 0 || !r.stdout.includes("started")) throw new Error(this.explain(r.stderr) || "Could not start the download");
    return jobId;
  }

  async jobs(): Promise<HubJob[]> {
    const r = await this.t.exec(`[ -d ${remotePath(`${this.root}/.jobs`)} ] || { echo '{"jobs":[]}'; exit 0; }; ${this.python} - ${remotePath(this.root)}`, { input: LIST, timeoutMs: 120_000 });
    const parsed = lastJsonLine<{ jobs: HubJob[] }>(r.stdout);
    if (r.code !== 0 || !parsed) throw new Error(this.explain(r.stderr) || "Could not list downloads");
    return parsed.jobs.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Deletes a download and its job record. Only paths under the hub root are touched. */
  async remove(jobId: string): Promise<void> {
    if (!/^[\w-]{1,40}$/.test(jobId)) throw new Error("Invalid job id");
    const job = (await this.jobs()).find((j) => j.jobId === jobId);
    if (!job) return;
    const home = (await this.t.exec(`cd ${remotePath(this.root)} && pwd`)).stdout.trim().split("\n").pop()!;
    if (job.status === "downloading") throw new Error("Wait for the download to finish before deleting it.");
    if (!job.path.startsWith(`${home}/`) || job.path.split("/").includes("..")) throw new Error("Refusing to delete outside the hub folder");
    const r = await this.t.exec(`rm -rf -- ${shq(job.path)} && rm -f -- ${shq(`${home}/.jobs/${jobId}`)}.*`, { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(this.explain(r.stderr) || "Could not delete");
  }
}
