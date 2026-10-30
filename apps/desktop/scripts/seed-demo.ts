// Creates a demo project with real runs executed on the local GPU through WSL.
//   node scripts/seed-demo.ts <projectDir> [userDataDir]
// With userDataDir, also writes a desktop-app profile that opens the project.
import { execFileSync } from "node:child_process";
import { appendFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "@converge/run-protocol";
import { AgentClient, DEFAULT_SETTINGS, RunManager, WslTransport, type Settings } from "@converge/core";
import { AppStore } from "../src/main/settings.ts";

const [projectDir, userData] = process.argv.slice(2);
if (!projectDir) throw new Error("usage: seed-demo.ts <projectDir> [userDataDir]");
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(appDir, "../..");
const resources = path.join(appDir, "dist/remote");

await rm(projectDir, { recursive: true, force: true });
await mkdir(projectDir, { recursive: true });
await cp(path.join(repo, "examples/smoke/train.py"), path.join(projectDir, "train.py"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=demo@converge.dev", "-c", "user.name=demo", ...a], { cwd: projectDir, stdio: "ignore" });
git("init", "-q");
git("add", ".");
git("commit", "-qm", "baseline trainer");

const machine: Machine = { id: "wsl-local", name: "Local GPU (Ubuntu)", host: "wsl:Ubuntu", python: "python3", hourlyRate: 0.35, createdAt: Date.now() };
const settings: Settings = { ...DEFAULT_SETTINGS, remoteRoot: "~/converge-demo" };

const mgr = new RunManager(projectDir, () => settings, { onRunsChanged() {}, onLaunchProgress() {}, onRunFinished() {} }, resources);
await mgr.init();
const opts = { stopOnNan: false, telemetryIntervalSec: 2, stallMinutes: 0, cancelGraceSec: 3 };

async function run(command: string, extra: Partial<typeof opts> = {}, cancelAfterMs?: number) {
  const { runId } = await mgr.launch({ machineId: machine.id, command, options: { ...opts, ...extra } }, machine);
  if (cancelAfterMs) {
    await new Promise((r) => setTimeout(r, cancelAfterMs));
    await mgr.cancel(runId);
  }
  for (;;) {
    const v = mgr.getRun(runId);
    if (v && ["completed", "failed", "cancelled"].includes(v.status)) return runId;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const a = await run("python3 train.py --steps 300 --sleep 0.02 --lr 0.01 --seed 1");
await mgr.saveNotes(a, { group: "lr-sweep", hypothesis: "Baseline at lr=0.01", expected: "Smooth convergence", changes: "", observed: "Converges slowly", conclusion: "Try 3x higher lr" });
const b = await run("python3 train.py --steps 300 --sleep 0.02 --lr 0.03 --seed 1");
await mgr.saveNotes(b, { group: "lr-sweep", hypothesis: "Higher lr converges faster", expected: "Lower loss at step 300", changes: "lr 0.01 → 0.03", observed: "", conclusion: "" });
await appendFile(path.join(projectDir, "train.py"), "\n# warmup experiment\n");
await run("python3 train.py --steps 400 --sleep 0.02 --lr 0.2 --nan-at 140", { stopOnNan: true });
await run("python3 train.py --steps 200 --sleep 0.02 --batch-size 512 --oom-at 60");
await run("python3 train.py --steps 100000 --sleep 0.03 --lr 0.02", {}, 6000);
await run("python3 train.py --steps 250 --sleep 0.02 --lr 0.05 --seed 2");
mgr.dispose();

if (userData) {
  const app = new AppStore(userData);
  await app.load();
  app.data.machines = [machine];
  app.data.settings = settings;
  const client = new AgentClient(new WslTransport("Ubuntu"), "python3", (s) => s);
  app.data.probes[machine.id] = { ...(await client.probe(settings.remoteRoot)), ok: true, at: Date.now() };
  app.touchProject(projectDir);
  await app.save();
}
await new Promise((r) => setTimeout(r, 1000));
console.log("seeded", projectDir);
