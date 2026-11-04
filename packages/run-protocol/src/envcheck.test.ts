import { test } from "node:test";
import assert from "node:assert/strict";
import { archSupported, checkEnvironment, checkProbe, type EnvCheckInput } from "./index.ts";

const healthy: EnvCheckInput = {
  torch: "2.5.1+cu124",
  torchCuda: "12.4",
  cudaAvailable: true,
  driverCuda: "12.4",
  driver: "550.54",
  gpuName: "NVIDIA GeForce RTX 4090",
  gpuCapability: "8.9",
  archList: ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"],
};

test("a matching build, driver and GPU has no issues", () => {
  assert.deepEqual(checkEnvironment(healthy), []);
});

test("binary kernels run on later minor versions of the same major; PTX runs forward", () => {
  assert.ok(archSupported(["sm_80"], [8, 9]));
  assert.ok(!archSupported(["sm_90"], [12, 0]));
  assert.ok(archSupported(["sm_80", "compute_90"], [12, 0]));
  assert.ok(!archSupported(["sm_86"], [8, 0]));
});

test("torch built for a newer CUDA major than the driver: error, fix installs the same release for the driver", () => {
  const issues = checkEnvironment({ ...healthy, torch: "2.8.0+cu128", torchCuda: "12.8", driverCuda: "11.8", driver: "520.61" });
  assert.equal(issues.length, 1);
  const i = issues[0]!;
  assert.equal(i.id, "driver-too-old");
  assert.equal(i.severity, "error");
  assert.match(i.detail, /driver 520\.61 supports CUDA up to 11\.8/);
  // 2.8 has no CUDA 11 build, so the fix moves to the newest release that has one (2.7).
  assert.equal(i.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu118\ntorch==2.7.*");
  assert.equal(i.fix!.label, "Switch to PyTorch 2.7 for CUDA 11.8");
});

test("newer CUDA minor than the driver: warning, with the same release built for the driver", () => {
  const issues = checkEnvironment({ ...healthy, torch: "2.8.0+cu129", torchCuda: "12.9", driverCuda: "12.6", companions: ["torchvision", "numpy"] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.id, "driver-minor");
  assert.equal(issues[0]!.severity, "warning");
  assert.equal(issues[0]!.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu126\ntorch==2.8.0\ntorchvision");
});

test("a CPU-only build on a GPU machine is an error with a CUDA build as the fix", () => {
  const issues = checkEnvironment({ ...healthy, torch: "2.6.0+cpu", torchCuda: null, cudaAvailable: false, driverCuda: "12.8" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.id, "cpu-build");
  assert.equal(issues[0]!.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu126\ntorch==2.6.0");
});

test("Blackwell on a build without sm_120: needs CUDA 12.8, so an older release is replaced", () => {
  const issues = checkEnvironment({ ...healthy, gpuName: "NVIDIA GeForce RTX 5090", gpuCapability: "12.0", driverCuda: "12.8", torch: "2.6.0+cu124", torchCuda: "12.4" });
  const arch = issues.find((i) => i.id === "arch")!;
  assert.equal(arch.severity, "error");
  assert.match(arch.title, /sm_120/);
  // The driver tops out at CUDA 12.8, and 2.11 is the newest release with a 12.8 build.
  assert.equal(arch.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu128\ntorch==2.11.*");
});

test("Blackwell with a driver below CUDA 12.8: no pip fix, update the driver", () => {
  const issues = checkEnvironment({ ...healthy, gpuName: "NVIDIA GeForce RTX 5090", gpuCapability: "12.0", driverCuda: "12.4", torch: "2.5.1+cu124", torchCuda: "12.4" });
  const arch = issues.find((i) => i.id === "arch")!;
  assert.equal(arch.fix, null);
  assert.match(arch.detail, /needs CUDA 12\.8 or newer/);
});

test("Pascal on a CUDA 12.8 build (which dropped it): fix stays at CUDA 12.6", () => {
  const issues = checkEnvironment({ ...healthy, gpuName: "Tesla P100", gpuCapability: "6.0", driverCuda: "12.8", torch: "2.8.0+cu128", torchCuda: "12.8", archList: ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"] });
  const arch = issues.find((i) => i.id === "arch")!;
  assert.equal(arch.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu126\ntorch==2.8.0");
});

test("no torch: install the newest release for the driver", () => {
  const issues = checkEnvironment({ ...healthy, torch: null, torchCuda: null, cudaAvailable: null, archList: null, driverCuda: "12.4" });
  assert.equal(issues[0]!.id, "no-torch");
  // 2.7's CUDA 11.8 build is the newest release that runs on a CUDA 12.4 driver.
  assert.equal(issues[0]!.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu118\ntorch==2.7.*");
});

test("everything matches but CUDA still isn't available: explain the usual causes", () => {
  const issues = checkEnvironment({ ...healthy, cudaAvailable: false });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.id, "cuda-unavailable");
  assert.equal(issues[0]!.fix, null);
});

test("no driver information: nothing to check", () => {
  assert.deepEqual(checkEnvironment({ ...healthy, driverCuda: null }), []);
});

test("a probe maps onto the check; unreachable or GPU-less machines have nothing to report", () => {
  const probe = { ok: true, driver: "550.54", cudaVersion: "12.4", gpuCapability: "8.6", gpus: [{ name: "NVIDIA GeForce RTX 3060" }], python: { torch: "2.6.0+cpu", torchCuda: null, cudaAvailable: false, companions: [] } };
  assert.equal(checkProbe(probe)[0]!.id, "cpu-build");
  assert.deepEqual(checkProbe({ ...probe, ok: false }), []);
  assert.deepEqual(checkProbe({ ...probe, gpus: [] }), []);
  assert.deepEqual(checkProbe(null), []);
});

test("a current driver gets the newest release, built for the newest CUDA it supports", () => {
  const issues = checkEnvironment({ ...healthy, torch: null, torchCuda: null, cudaAvailable: null, archList: null, driverCuda: "13.3", driver: "610.88" });
  assert.equal(issues[0]!.fix!.requirements, "--index-url https://download.pytorch.org/whl/cu132\ntorch==2.15.*");
});

test("a CUDA-minor warning never offers a different PyTorch release; it says to update the driver instead", () => {
  const issues = checkEnvironment({ ...healthy, torch: "2.8.0+cu129", torchCuda: "12.9", driverCuda: "12.4" });
  assert.equal(issues[0]!.id, "driver-minor");
  assert.equal(issues[0]!.fix, null);
  assert.match(issues[0]!.detail, /update the driver/);
});
