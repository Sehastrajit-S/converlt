import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunManifest } from "@converge/run-protocol";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { checkoutAt, fingerprint, removeCheckout } from "./git.ts";
import { RunManager } from "./runManager.ts";
import { RunStore } from "./runStore.ts";
import { requirementsFrom } from "./service.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Ana", ...a], { cwd, stdio: "pipe" }).toString();

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cv-share-"));
  git(dir, "init", "-q");
  await writeFile(path.join(dir, "train.py"), "lr = 0.1\n");
  git(dir, "add", "train.py");
  git(dir, "commit", "-qm", "init");
  return dir;
}

test("a run's patch includes new files, and checking it out rebuilds the exact code", async () => {
  const dir = await repo();
  try {
    const commit = git(dir, "rev-parse", "HEAD").trim();
    await writeFile(path.join(dir, "train.py"), "lr = 0.01\n");
    await writeFile(path.join(dir, "helper.py"), "X = 1\n");
    const fp = await fingerprint(dir);
    assert.ok(fp?.patch?.includes("helper.py"), "untracked file is in the patch");
    // Move on: new commit and different files, then rebuild the run's code elsewhere.
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "later");
    await writeFile(path.join(dir, "train.py"), "lr = 5\n");
    const out = path.join(dir, ".converge", "repro", "r1");
    await checkoutAt(dir, out, commit, fp!.patch);
    const read = async (f: string) => (await readFile(f, "utf8")).replace(/\r\n/g, "\n"); // git may check out CRLF on Windows
    assert.equal(await read(path.join(out, "train.py")), "lr = 0.01\n");
    assert.equal(await read(path.join(out, "helper.py")), "X = 1\n");
    assert.equal(await readFile(path.join(dir, "train.py"), "utf8"), "lr = 5\n", "the user's own files are untouched");
    await removeCheckout(dir, out);
    await assert.rejects(checkoutAt(dir, out, "0123456789abcdef0123456789abcdef01234567", null), /isn't in your repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a shared run opens in another project once, named after who shared it", async () => {
  const a = await repo();
  const b = await repo();
  try {
    const manifest: RunManifest = {
      schemaVersion: 1,
      runId: "20261105-120000-abcd",
      number: 7,
      name: "run-007",
      project: "a",
      createdAt: 1,
      command: "python train.py --lr 0.1",
      hyperparameters: { lr: 0.1 },
      framework: "pytorch",
      machine: { id: "m", name: "ana-gpu", host: "ana@gpu", python: "python3" },
      workdir: "~/converge/a",
      git: { commit: git(a, "rev-parse", "HEAD").trim(), branch: "main", dirty: false, diffStat: "", untracked: [] },
      sync: { files: 1, bytes: 1, skipped: 0 },
      options: DEFAULT_SETTINGS.defaultOptions,
    };
    const store = new RunStore(a);
    await store.init();
    await store.createRun(manifest, null);
    await store.appendEvents(manifest.runId, [
      { type: "status", seq: 1, ts: 1, status: "running" } as never,
      { type: "metric", seq: 2, ts: 2, step: 1, values: { "val/loss": 0.5 } } as never,
      { type: "status", seq: 3, ts: 3, status: "completed", exitCode: 0 } as never,
    ]);
    const hooks = { onRunsChanged() {}, onLaunchProgress() {}, onRunFinished() {} };
    const ma = new RunManager(a, () => DEFAULT_SETTINGS, hooks, a);
    await ma.init();
    const file = await ma.exportRun(manifest.runId, { by: "Ana", remote: "git@example.com:ana/a.git", data: [{ name: "iris", path: "/home/ana/iris", source: { hub: "huggingface", id: "scikit-learn/iris" }, fingerprint: "f1" }] });
    const mb = new RunManager(b, () => DEFAULT_SETTINGS, hooks, b);
    await mb.init();
    const r = await mb.importRun(JSON.parse(JSON.stringify(file)));
    assert.deepEqual(r, { runId: manifest.runId, existed: false });
    assert.equal((await mb.importRun(file)).existed, true);
    const v = mb.getRun(r.runId)!;
    assert.equal(v.manifest.name, "Ana/run-007");
    assert.equal(v.manifest.shared?.remote, "git@example.com:ana/a.git");
    assert.equal(v.status, "completed");
    assert.ok(v.summary.metrics["val/loss"]);
    // Still there after reopening the project, with the data it used.
    const mb2 = new RunManager(b, () => DEFAULT_SETTINGS, hooks, b);
    await mb2.init();
    const plan = await mb2.planReproduce(r.runId, []);
    assert.equal(plan.shared?.by, "Ana");
    assert.equal(plan.data[0]?.source?.id, "scikit-learn/iris");
    assert.equal(plan.machineId, null);
    assert.equal(mb2.listRuns()[0]?.number, 0, "doesn't take a number from this project's runs");
    await assert.rejects(mb2.importRun({ format: "other" } as never), /isn't a Converlt run file/);
    ma.dispose();
    mb.dispose();
    mb2.dispose();
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("an environment is rebuilt from pinned packages, with PyTorch's index for CUDA builds", () => {
  const r = requirementsFrom(["numpy==2.1.0", "torch==2.4.1+cu121", "mylib @ file:///home/ana/mylib", "-e git+https://x/y.git#egg=y", "pandas==2.2.3", ""]);
  assert.equal(r.packages, 3);
  assert.deepEqual(r.skipped, ["mylib @ file:///home/ana/mylib", "-e git+https://x/y.git#egg=y"]);
  assert.equal(r.text, "--extra-index-url https://download.pytorch.org/whl/cu121\nnumpy==2.1.0\ntorch==2.4.1+cu121\npandas==2.2.3\n");
});
