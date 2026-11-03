import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiagnosticEvent } from "@converge/run-protocol";
import { locateDiagnostic, toProjectPath } from "./locations.ts";

const diag = (data: Record<string, unknown>): DiagnosticEvent => ({ seq: 1, ts: 0, type: "diagnostic", kind: "oom", severity: "error", message: "x", data });

test("remote paths map into the project", () => {
  assert.equal(toProjectPath("/home/u/converge/resnet/train.py", "resnet"), "train.py");
  assert.equal(toProjectPath("/home/u/converge/resnet/src/models/net.py", "resnet"), "src/models/net.py");
  assert.equal(toProjectPath("/usr/lib/python3/site-packages/torch/nn.py", "resnet"), null);
});

test("failing frame from the SDK", () => {
  assert.deepEqual(locateDiagnostic(diag({ failingFrame: "/home/u/converge/proj/train.py:45 in <module>" }), "proj"), { relPath: "train.py", line: 45 });
});

test("innermost project frame from a traceback", () => {
  const traceback = [
    "Traceback (most recent call last):",
    '  File "/home/u/converge/proj/train.py", line 80, in <module>',
    '  File "/home/u/converge/proj/model.py", line 12, in forward',
    '  File "/opt/conda/lib/python3.11/site-packages/torch/nn/modules/module.py", line 1736, in _call_impl',
    "RuntimeError: boom",
  ].join("\n");
  assert.deepEqual(locateDiagnostic(diag({ traceback }), "proj"), { relPath: "model.py", line: 12 });
  assert.deepEqual(locateDiagnostic(diag({ stderrTail: traceback.split("\n") }), "proj"), { relPath: "model.py", line: 12 });
  assert.equal(locateDiagnostic(diag({ message: "no frames" }), "proj"), null);
});
