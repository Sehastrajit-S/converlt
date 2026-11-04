// "Why are these runs different?" end to end: two recorded runs in a real git repository, with
// different commits and different uncommitted patches, compared through the service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunEvent, RunManifest } from "@converge/run-protocol";
import { ConvergeService } from "./service.ts";
import { RunStore } from "./runStore.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();

function manifest(runId: string, n: number, commit: string): RunManifest {
  return {
    schemaVersion: 1, runId, number: n, name: `run-00${n}`, project: "p", createdAt: n, command: "python train.py",
    hyperparameters: {}, framework: "pytorch", machine: { id: "m", name: "box", host: "h", python: "python3" },
    workdir: "~/x", git: { commit, branch: "main", dirty: true, diffStat: "", untracked: [] },
    sync: { files: 1, bytes: 1, skipped: 0 }, options: { stopOnNan: false, telemetryIntervalSec: 10, stallMinutes: 0, cancelGraceSec: 5 },
  };
}

function events(lr: number, worseFrom: number | null): RunEvent[] {
  const out: RunEvent[] = [
    { seq: 1, ts: 1, type: "config", values: { lr, batch_size: 32 } },
    { seq: 2, ts: 1, type: "env", torch: "2.5.1", gpus: [{ index: 0, name: "RTX 4090", memTotalMiB: 24564 }], packages: [] },
  ];
  let seq = 3;
  for (let step = 0; step <= 2000; step += 20) {
    let v = 0.4 + 2 * Math.exp(-step / 300) + Math.sin(step) * 0.005;
    if (worseFrom !== null && step >= worseFrom) v += (step - worseFrom) / 3000;
    out.push({ seq: seq++, ts: step, type: "metric", step, values: { loss: v } });
  }
  return out;
}

test("explains a regression from recorded runs, including the code that changed", async () => {
  const dir = await mkdtemp(path.join(process.env.CONVERGE_TEST_TMP ?? os.tmpdir(), "cv-explain-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    await writeFile(path.join(dir, "train.py"), "lr = 3e-4\n");
    await writeFile(path.join(dir, "README.md"), "hi\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "a");
    const c1 = git(dir, "rev-parse", "HEAD");
    await writeFile(path.join(dir, "model.py"), "class Net: pass\n");
    await writeFile(path.join(dir, "README.md"), "hello\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "b");
    const c2 = git(dir, "rev-parse", "HEAD");

    const store = new RunStore(dir);
    await store.init();
    const patch = (body: string) => `diff --git a/data.py b/data.py\nindex 1..2 100644\n--- a/data.py\n+++ b/data.py\n@@ -1 +1 @@\n-x\n+${body}\n`;
    await store.createRun(manifest("ra", 1, c1), patch("shuffle=True"));
    await store.appendEvents("ra", events(3e-4, null));
    await store.createRun(manifest("rb", 2, c2), patch("shuffle=False"));
    await store.appendEvents("rb", events(3e-3, 500));

    const svc = new ConvergeService({
      store: { load: () => ({ machines: [], probes: {} }), save: async () => {} },
      settings: () => DEFAULT_SETTINGS,
      resourcesDir: dir,
      hooks: { runsChanged() {}, stateChanged() {}, launchProgress() {}, runFinished() {} },
    });
    await svc.openProject(dir);
    const x = await svc.explainRuns("ra", "rb");
    assert.equal(x.verdict, "worse");
    assert.equal(x.metric, "loss");
    assert.ok(x.divergedAtStep !== null && x.divergedAtStep >= 500, `split at ${x.divergedAtStep}`);
    assert.equal(x.causes[0]!.subject, "lr");
    const files = x.causes.filter((c) => c.category === "code").map((c) => c.subject);
    assert.deepEqual(files.sort(), ["README.md", "data.py", "model.py"]);
    assert.equal(x.causes.find((c) => c.subject === "data.py")!.to, "uncommitted change");
    assert.equal(x.causes.find((c) => c.subject === "model.py")!.likelihood, "high");
    assert.ok(x.unchanged.includes("Environment"));

    // A commit that isn't in the repository: the code can't be compared, and the result says so.
    await store.createRun(manifest("rc", 3, "0123456789abcdef0123456789abcdef01234567"), null);
    await store.appendEvents("rc", events(3e-4, null));
    await svc.openProject(dir);
    const y = await svc.explainRuns("ra", "rc");
    assert.ok(y.notes.some((n) => /Couldn't compare the code/.test(n)));
    await assert.rejects(svc.explainRuns("ra", "nope"), /Run not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
