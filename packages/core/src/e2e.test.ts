// End-to-end: drives RunManager (sync → agent install → launch → tail → persist) against a real
// Linux environment through the production WSL transport (machine host "wsl:<distro>").
//
//   CONVERGE_E2E=wsl node --test src/e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine, RunStatus } from "@converge/run-protocol";
import type { Settings } from "./api.ts";
import { RunManager } from "./runManager.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { WslTransport } from "./transport.ts";

const enabled = process.env.CONVERGE_E2E === "wsl";
const distro = process.env.CONVERGE_WSL_DISTRO ?? "Ubuntu";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const machine: Machine = { id: "wsl", name: "WSL", host: `wsl:${distro}`, python: "python3", hourlyRate: 1.2, createdAt: 0 };

/** Lays out the agent + SDK the way the shells ship them (resources/{agent,sdk}). */
async function stageRemote(dir: string): Promise<string> {
  await mkdir(path.join(dir, "agent"), { recursive: true });
  await mkdir(path.join(dir, "sdk", "converge"), { recursive: true });
  await cp(path.join(repo, "services/remote-agent/converge_agent.py"), path.join(dir, "agent/converge_agent.py"));
  for (const f of ["__init__.py", "_inputs.py", "_autohook.py"]) await cp(path.join(repo, "python/converge-runtime/converge", f), path.join(dir, "sdk/converge", f));
  await cp(path.join(repo, "python/converge-runtime/sitecustomize.py"), path.join(dir, "sdk/sitecustomize.py"));
  return dir;
}

async function setup() {
  const tmpRoot = process.env.CONVERGE_TEST_TMP ?? os.tmpdir();
  const project = await mkdtemp(path.join(tmpRoot, "cv-e2e-proj-"));
  const resources = await stageRemote(await mkdtemp(path.join(tmpRoot, "cv-e2e-res-")));
  await cp(path.join(repo, "examples/smoke/train.py"), path.join(project, "train.py"));
  await writeFile(path.join(project, ".env"), "SECRET=1\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: project, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "train.py");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  await writeFile(path.join(project, "train.py"), "\n# local edit\n", { flag: "a" });

  const settings: Settings = { ...DEFAULT_SETTINGS, remoteRoot: `~/converge-e2e/${path.basename(project)}` };
  const finished: { name: string; status: RunStatus }[] = [];
  const make = () =>
    new RunManager(
      project,
      () => settings,
      { onRunsChanged() {}, onLaunchProgress() {}, onRunFinished: (name, status) => finished.push({ name, status }) },
      resources,
    );
  const cleanup = async () => {
    await new WslTransport(distro).exec(`rm -rf ~/converge-e2e/${path.basename(project)}`);
    await rm(project, { recursive: true, force: true });
    await rm(resources, { recursive: true, force: true });
  };
  return { project, make, finished, cleanup };
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 90_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out");
}

const opts = { stopOnNan: false, telemetryIntervalSec: 2, stallMinutes: 0, cancelGraceSec: 3 };

test("e2e: launch, observe, persist, compare-ready", { skip: !enabled, timeout: 240_000 }, async () => {
  const env = await setup();
  const mgr = env.make();
  try {
    await mgr.init();
    const plan = await mgr.planSync();
    assert.equal(plan.files, 1, "only train.py syncs");
    assert.ok(plan.skipped.some((s) => s.path === ".env"), ".env never syncs");

    const { runId } = await mgr.launch({ machineId: "wsl", command: "python3 train.py --steps 40 --sleep 0.02 --lr 0.05", options: opts }, machine);
    const view = await waitFor(() => {
      const v = mgr.getRun(runId);
      return v && v.status === "completed" && v.summary.metrics["train/loss"]?.length === 40 ? v : null;
    });
    assert.equal(view.manifest.hyperparameters.lr, 0.05);
    assert.equal(view.effectiveConfig.batch_size, 32, "SDK config merged");
    assert.equal(view.manifest.git?.dirty, true);
    assert.ok(view.hasPatch, "uncommitted diff captured");
    assert.ok(view.summary.env?.python, "environment fingerprint captured");
    assert.ok(view.summary.logs.some((l) => l.line === "done"));
    assert.ok(view.costUsd !== null && view.costUsd >= 0);
    assert.deepEqual(env.finished.at(-1), { name: view.manifest.name, status: "completed" });

    // NaN detection with stop-on-NaN.
    const nan = await mgr.launch({ machineId: "wsl", command: "python3 train.py --steps 500 --sleep 0.02 --nan-at 15", options: { ...opts, stopOnNan: true } }, machine);
    const nv = await waitFor(() => {
      const v = mgr.getRun(nan.runId);
      return v && v.status === "failed" ? v : null;
    });
    const d = nv.summary.diagnostics.find((x) => x.kind === "nan");
    assert.equal(d?.step, 15);
    assert.equal(nv.summary.reason, "stopped_on_nan");

    // Cancellation.
    const long = await mgr.launch({ machineId: "wsl", command: "python3 train.py --steps 100000 --sleep 0.05", options: opts }, machine);
    await waitFor(() => mgr.getRun(long.runId)?.status === "running");
    await mgr.cancel(long.runId);
    await waitFor(() => mgr.getRun(long.runId)?.status === "cancelled");

    const list = mgr.listRuns();
    assert.deepEqual(list.map((r) => r.status), ["cancelled", "failed", "completed"]);
    assert.deepEqual(list.map((r) => r.name), ["run-003", "run-002", "run-001"]);
  } finally {
    mgr.dispose();
    await env.cleanup();
  }
});

test("e2e: closing the app does not stop training; reopening resumes and replays", { skip: !enabled, timeout: 240_000 }, async () => {
  const env = await setup();
  let mgr = env.make();
  try {
    await mgr.init();
    const { runId } = await mgr.launch({ machineId: "wsl", command: "python3 train.py --steps 120 --sleep 0.05", options: opts }, machine);
    await waitFor(() => (mgr.getRun(runId)?.summary.metrics["train/loss"]?.length ?? 0) > 10);
    mgr.dispose(); // "close the app" mid-run
    await new Promise((r) => setTimeout(r, 2500));

    mgr = env.make();
    await mgr.init(); // resumes tail from the cached lastSeq
    const v = await waitFor(() => {
      const x = mgr.getRun(runId);
      return x && x.status === "completed" ? x : null;
    });
    assert.equal(v.summary.metrics["train/loss"]!.length, 120, "no gaps or duplicates after reconnect");
    const persisted = await mgr.store.readEvents(runId);
    await new Promise((r) => setTimeout(r, 800)); // let the write batch flush
    const seqs = (await mgr.store.readEvents(runId)).map((e) => e.seq);
    assert.ok(persisted.length > 0);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "local cache holds each event exactly once");
  } finally {
    mgr.dispose();
    await env.cleanup();
  }
});
