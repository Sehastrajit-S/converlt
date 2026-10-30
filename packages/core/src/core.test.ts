import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exclusionReason, globToRegExp, makeRules } from "./sync.ts";
import { explainSshError, lastJsonLine, parseWslHost, remotePath, shq, sshArgs, SshTransport, transportFor, WslTransport, wrapBash } from "./transport.ts";
import { RunStore } from "./runStore.ts";
import { projectSlug } from "./runManager.ts";
import { validateMachine } from "./service.ts";

test("wsl hosts select the WSL transport", () => {
  assert.equal(parseWslHost("wsl:Ubuntu"), "Ubuntu");
  assert.equal(parseWslHost("wsl:Ubuntu-22.04"), "Ubuntu-22.04");
  assert.equal(parseWslHost("user@wsl"), null);
  assert.ok(transportFor({ host: "wsl:Ubuntu" }, "ssh") instanceof WslTransport);
  assert.ok(transportFor({ host: "gpu-box" }, "ssh") instanceof SshTransport);
});

test("machine validation", () => {
  assert.equal(validateMachine({ name: "", host: "wsl:Ubuntu", python: "" }).name, "Local GPU (Ubuntu)");
  assert.equal(validateMachine({ name: "", host: " u@h ", python: "" }).python, "python3");
  assert.throws(() => validateMachine({ name: "", host: "-oProxyCommand=x", python: "" }));
  assert.throws(() => validateMachine({ name: "", host: "a b", python: "" }));
  assert.throws(() => validateMachine({ name: "", host: "h", python: "", port: 70000 }));
});

test("shell quoting", () => {
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(remotePath("~/a b/c"), `"$HOME"/'a b/c'`);
  assert.equal(remotePath("/opt/x"), `'/opt/x'`);
  assert.equal(wrapBash("echo 'hi'"), `bash -c 'echo '\\''hi'\\'''`);
});

test("ssh args never let the host be parsed as an option", () => {
  const args = sshArgs({ host: "u@h", port: 2222, identityFile: "~/.ssh/k" }, "true");
  assert.deepEqual(args.slice(-3), ["--", "u@h", "bash -c 'true'"]);
  assert.ok(args.includes("BatchMode=yes"));
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
});

test("ssh errors become actionable", () => {
  assert.match(explainSshError("Host key verification failed.", "gpu"), /ssh gpu/);
  assert.match(explainSshError("user@h: Permission denied (publickey).", "h"), /key/);
  assert.match(explainSshError("ssh: Could not resolve hostname nope", "nope"), /resolve/);
});

test("lastJsonLine skips banners", () => {
  assert.deepEqual(lastJsonLine<{ ok: boolean }>("Welcome to Ubuntu\n{bad\n{\"ok\":true}\n"), { ok: true });
  assert.equal(lastJsonLine("nothing"), null);
});

test("sync exclusion rules", () => {
  const rules = makeRules(["data/**"], 1);
  assert.equal(exclusionReason("train.py", 100, rules), null);
  assert.equal(exclusionReason("src/models/net.py", 100, rules), null);
  assert.ok(exclusionReason("checkpoints/last.pt", 100, rules));
  assert.ok(exclusionReason("model.safetensors", 100, rules));
  assert.ok(exclusionReason(".env", 10, rules));
  assert.ok(exclusionReason("configs/.env.local", 10, rules));
  assert.ok(exclusionReason("data/train.csv", 10, rules));
  assert.ok(exclusionReason("a/node_modules/x.js", 10, rules));
  assert.ok(exclusionReason("big.py", 2 * 1024 * 1024, rules));
  assert.ok(globToRegExp("**/*.pt").test("x.pt"));
  assert.ok(!globToRegExp("*.pt").test("a/x.pt"));
});

test("project slug", () => {
  assert.equal(projectSlug("C:\\work\\My Project!"), "My-Project");
  assert.equal(projectSlug("/x/resnet_v2"), "resnet_v2");
});

test("run store round-trip", async () => {
  const dir = await mkdtemp(path.join(process.env.CONVERGE_TEST_TMP ?? os.tmpdir(), "cv-store-"));
  try {
    const store = new RunStore(dir);
    await store.init();
    assert.equal(await store.nextNumber(), 1);
    const manifest = {
      schemaVersion: 1, runId: "r1", number: 1, name: "run-001", project: "p", createdAt: 1, command: "python t.py",
      hyperparameters: {}, framework: "pytorch" as const, machine: { id: "m", name: "m", host: "h", python: "python3" },
      workdir: "~/x", git: { commit: "abc", branch: "main", dirty: true, diffStat: "", untracked: [] },
      sync: { files: 1, bytes: 1, skipped: 0 }, options: { stopOnNan: false, telemetryIntervalSec: 10, stallMinutes: 0, cancelGraceSec: 5 },
    };
    await store.createRun(manifest, "diff --git a b\n");
    assert.equal((await store.readManifest("r1"))?.git?.patchFile, "code.patch");
    await store.appendEvents("r1", [{ seq: 1, ts: 1, type: "log", stream: "stdout", line: "x" }]);
    await writeFile(path.join(store.runDir("r1"), "events.jsonl"), '{"seq":2,"ts":1,"type":"log","stream":"stdout","line":"y"}\n{"seq":3', { flag: "a" });
    assert.equal((await store.readEvents("r1")).length, 2, "torn trailing line is ignored");
    assert.equal(await store.nextNumber(), 2);
    assert.throws(() => store.runDir("../evil"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
