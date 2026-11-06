"""SDK tests. Hook tests run a script in a subprocess the way the agent launches training: the SDK
folder first on PYTHONPATH and CONVERGE_SDK_FILE set. Tests that need PyTorch skip without it.

    python3 -m unittest discover -s python/converge-runtime/tests -v
"""

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

SDK_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, SDK_DIR)

from converge import _inputs  # noqa: E402

try:
    import torch  # noqa: F401

    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(textwrap.dedent(text))


class FingerprintTest(unittest.TestCase):
    def test_folder_fingerprint_changes_with_files_and_sizes_not_location(self):
        with tempfile.TemporaryDirectory() as d:
            a = os.path.join(d, "a")
            for i in range(5):
                write(os.path.join(a, "part-%d.txt" % i), "row %d\n" % i * 100)
            fp1, method, files, size = _inputs.fingerprint_path(a)
            self.assertEqual(files, 5)
            self.assertIn("sampled", method)
            b = os.path.join(d, "copy")
            subprocess.run(["cp", "-r", a, b], check=True)
            self.assertEqual(_inputs.fingerprint_path(b)[0], fp1, "a copy elsewhere is the same data")
            write(os.path.join(b, "part-5.txt"), "new\n")
            self.assertNotEqual(_inputs.fingerprint_path(b)[0], fp1)
            write(os.path.join(a, "part-0.txt"), "changed\n")
            self.assertNotEqual(_inputs.fingerprint_path(a)[0], fp1)

    def test_small_file_is_hashed_whole(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "train.csv")
            write(p, "a,b\n1,2\n")
            fp, method, files, size = _inputs.fingerprint_path(p)
            self.assertEqual(method, "sha256 of the file")
            self.assertEqual((files, size), (1, 8))

    def test_hugging_face_dataset_and_dataset_dict(self):
        class Info:
            dataset_name = "imdb"

        class Split:
            def __init__(self, fp):
                self._fingerprint = fp
                self.info = Info()

        rec = _inputs.describe(Split("abc123"))
        self.assertEqual((rec["name"], rec["fingerprint"]), ("imdb", "abc123"))
        dd = {"train": Split("t1"), "test": Split("t2")}
        r1 = _inputs.describe(dd)
        r2 = _inputs.describe({"train": Split("t1"), "test": Split("t3")})
        self.assertEqual(r1["name"], "imdb")
        self.assertNotEqual(r1["fingerprint"], r2["fingerprint"])
        self.assertIn("test, train", r1["method"])

    def test_missing_path_is_recorded_without_fingerprint(self):
        rec = _inputs.describe("/no/such/dir/xyz")
        self.assertEqual(rec["name"], "xyz")
        self.assertIsNone(rec["fingerprint"])


class HookTest(unittest.TestCase):
    """Runs a script under the SDK's sitecustomize and returns the records it wrote."""

    def run_script(self, script, extra_path=None, env=None):
        with tempfile.TemporaryDirectory() as d:
            sdk_file = os.path.join(d, "sdk.jsonl")
            path = os.path.join(d, "main.py")
            write(path, script)
            pythonpath = [SDK_DIR] + ([extra_path] if extra_path else [])
            e = dict(os.environ, CONVERGE_SDK_FILE=sdk_file, PYTHONPATH=os.pathsep.join(pythonpath), CONVERGE_PERF_REPORT_SEC="0.5")
            e.update(env or {})
            p = subprocess.run([sys.executable, path], env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
            self.assertEqual(p.returncode, 0, p.stderr.decode())
            out = p.stdout.decode()
            records = []
            if os.path.exists(sdk_file):
                with open(sdk_file) as f:
                    records = [json.loads(line) for line in f if line.strip()]
            return records, out

    def test_load_dataset_and_from_pretrained_are_recorded(self):
        with tempfile.TemporaryDirectory() as libs:
            write(
                os.path.join(libs, "datasets", "__init__.py"),
                "from .load import load_dataset\n",
            )
            write(
                os.path.join(libs, "datasets", "load.py"),
                """
                class Info:
                    dataset_name = "glue"
                class Dataset:
                    def __init__(self, fp):
                        self._fingerprint = fp
                        self.info = Info()
                def load_dataset(path, name=None, split=None, revision=None):
                    return Dataset("fp-" + str(name))
                """,
            )
            write(os.path.join(libs, "transformers", "__init__.py"), "from .modeling_utils import PreTrainedModel\n")
            write(
                os.path.join(libs, "transformers", "modeling_utils.py"),
                """
                class Config:
                    _commit_hash = "c0ffee"
                class PreTrainedModel:
                    def __init__(self):
                        self.config = Config()
                    @classmethod
                    def from_pretrained(cls, name, **kw):
                        return cls()
                class Bert(PreTrainedModel):
                    pass
                """,
            )
            records, out = self.run_script(
                """
                from datasets import load_dataset
                from transformers.modeling_utils import Bert
                ds = load_dataset("glue", "mrpc", split="train")
                m = Bert.from_pretrained("bert-base-uncased")
                print(type(m).__name__, ds._fingerprint)
                """,
                extra_path=libs,
            )
        self.assertIn("Bert fp-mrpc", out, "the wrapped functions still return the real results")
        inputs = [r for r in records if r["type"] == "input"]
        self.assertEqual(len(inputs), 2, records)
        ds, w = inputs
        self.assertEqual((ds["kind"], ds["name"], ds["fingerprint"], ds["source"]), ("dataset", "glue/mrpc[train]", "fp-mrpc", "auto"))
        self.assertEqual((w["kind"], w["name"], w["revision"]), ("weights", "bert-base-uncased", "c0ffee"))

    def test_hooks_are_off_outside_converlt_and_with_the_opt_out(self):
        records, out = self.run_script("import sys; print(any(type(f).__name__ == '_PostImportFinder' for f in sys.meta_path))", env={"CONVERGE_NO_AUTOHOOK": "1"})
        self.assertEqual(out.strip(), "False")

    def test_an_existing_sitecustomize_still_runs(self):
        with tempfile.TemporaryDirectory() as other:
            write(os.path.join(other, "sitecustomize.py"), "import builtins\nbuiltins.OTHER_SITE = True\n")
            _, out = self.run_script("import builtins; print(getattr(builtins, 'OTHER_SITE', False))", extra_path=other)
        self.assertEqual(out.strip(), "True")

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_dataloader_wait_is_measured(self):
        records, _ = self.run_script(
            """
            import time, torch
            from torch.utils.data import DataLoader, Dataset
            class Slow(Dataset):
                def __len__(self): return 40
                def __getitem__(self, i):
                    time.sleep(0.04)
                    return torch.zeros(4)
            for epoch in range(2):
                for batch in DataLoader(Slow(), batch_size=2, num_workers=0):
                    time.sleep(0.01)  # the "GPU" step: far shorter than loading
            """
        )
        perf = [r for r in records if r["type"] == "perf"]
        self.assertTrue(perf, records)
        wait = sum(r["dataWaitSec"] for r in perf) / sum(r["wallSec"] for r in perf)
        self.assertGreater(wait, 0.6, perf)
        self.assertEqual(perf[0]["numWorkers"], 0)
        self.assertEqual(perf[0]["batchSize"], 2)

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_watched_model_weights_are_snapshotted_over_the_run(self):
        records, _ = self.run_script(
            """
            import torch, converge
            model = torch.nn.Sequential(torch.nn.Linear(4, 64), torch.nn.ReLU(), torch.nn.Linear(64, 2))
            torch.nn.init.zeros_(model[2].weight)
            run = converge.run(total_steps=400)
            run.watch(model)
            opt = torch.optim.SGD(model.parameters(), lr=0.1)
            for step in range(400):
                loss = model(torch.randn(8, 4)).pow(2).mean() + model[0].weight.sum() * 0
                opt.zero_grad(); loss.backward(); opt.step()
                run.log({"loss": loss}, step=step)
            """,
            env={"CONVERGE_WEIGHTS_MIN_SEC": "0"},
        )
        snaps = [r for r in records if r["type"] == "weights"]
        self.assertGreaterEqual(len(snaps), 2, "first snapshot plus the final one at exit")
        self.assertLessEqual(len(snaps), 42)
        self.assertEqual(snaps[0]["step"], 0)
        self.assertEqual(snaps[-1]["step"], 399, "a final snapshot is written at exit")
        names = [t["name"] for t in snaps[-1]["tensors"]]
        self.assertEqual(names, ["0.weight", "0.bias", "2.weight", "2.bias"])
        w0 = snaps[-1]["tensors"][0]
        self.assertEqual(w0["shape"], [64, 4])
        self.assertEqual(sum(w0["hist"]["counts"]), 256)
        self.assertEqual((len(w0["grid"]), len(w0["grid"][0])), (12, 4))
        self.assertIn("gradNorm", w0)
        self.assertLess(snaps[0]["tensors"][2]["std"], 0.01, "zero-initialized layer is near zero at the start")
        self.assertGreater(snaps[-1]["tensors"][2]["std"], snaps[0]["tensors"][2]["std"], "and spreads out as it trains")

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_examples_are_drawn_and_followed_by_predictions(self):
        records, _ = self.run_script(
            """
            import torch, converge
            model = torch.nn.Sequential(torch.nn.Conv2d(3, 4, 3, padding=1), torch.nn.Flatten(), torch.nn.Linear(4 * 8 * 8, 3))
            run = converge.run(total_steps=40)
            run.watch(model)
            run.log_examples(torch.rand(7, 3, 8, 8), torch.tensor([0, 1, 2, 0, 1, 2, 0]), class_names=["cat", "dog", "fox"])
            run.log_examples  # fine to call once
            for step in range(40):
                run.log({"loss": 1.0}, step=step)
            ae = torch.nn.Sequential(torch.nn.Linear(16000, 8), torch.nn.Linear(8, 16000))
            r2 = converge.Run()
            r2._examples = None
            """,
            env={"CONVERGE_WEIGHTS_MIN_SEC": "0"},
        )
        ex = [r for r in records if r["type"] == "examples"]
        self.assertEqual(len(ex), 1)
        self.assertEqual(len(ex[0]["inputs"]), 5, "at most five")
        img = ex[0]["inputs"][0]
        self.assertEqual((img["kind"], img["w"], img["h"], img["c"]), ("image", 8, 8, 3))
        self.assertEqual(ex[0]["labels"][1], {"class": 1, "name": "dog"})
        snaps = [r for r in records if r["type"] == "weights"]
        self.assertTrue(snaps and all(len(s["predictions"]) == 5 for s in snaps))
        self.assertEqual(set(snaps[-1]["predictions"][0]), {"class", "p"})

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_failures_after_training(self):
        records, _ = self.run_script(
            """
            import torch, converge
            model = torch.nn.Sequential(torch.nn.Flatten(), torch.nn.Linear(3 * 8 * 8, 3))
            run = converge.run()
            x, y = torch.rand(10, 3, 8, 8), torch.tensor([0, 1, 2, 0, 1, 2, 0, 1, 2, 0])
            run.log_failures(model, x, y, losses=torch.linspace(3, 1, 10), class_names=["cat", "dog", "fox"], total=200, wrong=17)
            """
        )
        f = [r for r in records if r["type"] == "failures"]
        self.assertEqual(len(f), 1)
        f = f[0]
        self.assertEqual((f["split"], f["total"], f["wrong"]), ("test", 200, 17))
        self.assertEqual(len(f["inputs"]), 8, "at most eight")
        self.assertEqual(len(f["predictions"]), 8)
        self.assertEqual(set(f["predictions"][0]), {"class", "p"})
        self.assertEqual(f["losses"][0], 3.0)
        self.assertEqual(f["labels"][1], {"class": 1, "name": "dog"})

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_kinds_of_examples(self):
        sys.path.insert(0, SDK_DIR)
        import torch
        from converge import _weights

        self.assertEqual(_weights.encode_one(torch.randint(0, 50, (100,)))["kind"], "tokens")
        self.assertEqual(_weights.encode_one(torch.randn(1, 16000))["kind"], "wave")
        self.assertEqual(_weights.encode_one(torch.randn(96, 8))["kind"], "heatmap")
        self.assertEqual(_weights.encode_one(torch.randn(30))["kind"], "vector")
        video = _weights.encode_one(torch.rand(3, 16, 64, 64))
        self.assertEqual((video["kind"], video["frames"], video["w"]), ("image", 16, 48), "middle frame, at most 48 px")
        ae = torch.nn.Sequential(torch.nn.Linear(10, 4), torch.nn.Linear(4, 10))
        self.assertEqual(_weights.predictions(ae, torch.randn(2, 10))[0]["kind"], "recon:vector")

    @unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
    def test_nan_report_says_where_the_nan_is(self):
        records, _ = self.run_script(
            """
            import torch, converge
            def go(kind):
                model = torch.nn.Sequential(torch.nn.Linear(4, 8), torch.nn.ReLU(), torch.nn.Linear(8, 1))
                run = converge.Run()
                run.watch(model)
                x = torch.randn(16, 4)
                if kind == "forward":
                    loss = torch.log(model(x) * 0 - 1).mean()      # log of a negative
                    loss.backward()
                elif kind == "gradients":
                    loss = model(x).mean()
                    loss.backward()
                    model[2].weight.grad[0, 0] = float("inf")
                    loss = torch.tensor(float("nan"))
                else:
                    with torch.no_grad():
                        model[0].weight[0, 0] = float("nan")
                    loss = model(x).mean()
                run.log({"train/loss": loss}, step=7)
            for kind in ("forward", "gradients", "weights"):
                go(kind)
            """
        )
        details = [r["data"] for r in records if r["type"] == "nan_detail"]
        self.assertEqual([d["nanWhere"] for d in details], ["forward", "gradients", "weights"])
        self.assertEqual(details[1]["nanLayer"], "2")
        self.assertEqual(details[2]["nanLayer"], "0")
        self.assertIn("forward pass", details[0]["nanVerdict"])
        metrics = [r for r in records if r["type"] == "metric"]
        self.assertEqual(len(metrics), 3)
        # Each report comes before its metric, so the agent has it when it reacts to the NaN.
        order = [r["type"] for r in records if r["type"] in ("nan_detail", "metric")]
        self.assertEqual(order, ["nan_detail", "metric"] * 3)


if __name__ == "__main__":
    unittest.main()
