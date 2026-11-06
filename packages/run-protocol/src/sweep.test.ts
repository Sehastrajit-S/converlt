import { test } from "node:test";
import assert from "node:assert/strict";
import { expandSweep, parseSweepValues, setArg, sweepGridSize } from "./index.ts";

test("setArg replaces an option in place (either spelling, either form) or adds it", () => {
  assert.equal(setArg("python train.py --lr 0.1 --epochs 3", "lr", "3e-4"), "python train.py --lr 3e-4 --epochs 3");
  assert.equal(setArg("python train.py --batch-size=32", "batch_size", "64"), "python train.py --batch-size=64");
  assert.equal(setArg("python train.py --fast --lr 1", "fast", "x"), "python train.py --fast --lr 1 --fast x", "a bare flag isn't given the next option as its value");
  assert.equal(setArg("python train.py", "--name", "a b"), "python train.py --name 'a b'");
  assert.equal(setArg("pip install -q x && python train.py --lr 1", "lr", "2"), "pip install -q x && python train.py --lr 2");
});

test("sweep values: lists, linear and log ranges, and errors for what can't be read", () => {
  const { values, errors } = parseSweepValues("lr = 1e-4..1e-2 x3 log\nbatch-size = 32, 64, 32\n--epochs=10..30 x3\nnonsense");
  assert.deepEqual(values.lr, ["0.0001", "0.001", "0.01"]);
  assert.deepEqual(values["batch-size"], ["32", "64"]);
  assert.deepEqual(values.epochs, ["10", "20", "30"]);
  assert.equal(errors.length, 1);
  assert.equal(sweepGridSize(values), 18);
});

test("a grid gives every combination; a random sample stays within the limit; oversized grids are refused", () => {
  const values = { lr: ["0.1", "0.01"], "batch-size": ["32", "64"] };
  const grid = expandSweep("python train.py --lr 1", values, { mode: "grid", max: 10 });
  assert.ok(Array.isArray(grid));
  assert.equal(grid.length, 4);
  assert.deepEqual(grid.map((p) => p.command), [
    "python train.py --lr 0.1 --batch-size 32",
    "python train.py --lr 0.1 --batch-size 64",
    "python train.py --lr 0.01 --batch-size 32",
    "python train.py --lr 0.01 --batch-size 64",
  ]);
  assert.equal(grid[1]!.label, "lr=0.1 batch-size=64");
  const big = { a: ["1", "2", "3", "4"], b: ["1", "2", "3", "4"] };
  assert.match((expandSweep("python t.py", big, { mode: "grid", max: 8 }) as { error: string }).error, /16 runs/);
  const sample = expandSweep("python t.py", big, { mode: "random", max: 5, seed: 7 });
  assert.ok(Array.isArray(sample));
  assert.equal(sample.length, 5);
  assert.equal(new Set(sample.map((p) => p.command)).size, 5, "no setting twice");
});
