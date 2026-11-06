"""Tests for converge_data.py on array datasets (.npz / .pt).

    python3 -m unittest discover -s services/remote-agent/tests -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(os.path.dirname(HERE), "converge_data.py")

try:
    import numpy as np
except ImportError:
    np = None
try:
    import torch
except ImportError:
    torch = None


def run(*args):
    p = subprocess.run([sys.executable, TOOL] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    return json.loads(p.stdout.decode().strip().splitlines()[-1])


@unittest.skipUnless(np is not None, "needs numpy")
class TensorDatasetTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="converge-data-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_single_npz_with_class_labels(self):
        path = os.path.join(self.dir, "clips.npz")
        np.savez(path, x=np.random.rand(120, 1, 16000).astype("float32"), y=np.arange(120) % 4)
        p = run("profile", path)
        self.assertTrue(p["ok"], p)
        self.assertEqual((p["kind"], p["format"]), ("tensors", "tensors"))
        self.assertEqual(p["splits"], [{"name": "data", "file": path, "count": 120}])
        self.assertEqual(p["x"]["shape"], [1, 16000])
        self.assertFalse(p["x"]["integer"])
        self.assertEqual((p["y"]["classes"], p["y"]["shape"]), (4, []))
        self.assertEqual(sum(c["count"] for c in p["y"]["counts"]), 120)

    def test_split_folder_token_ids_and_alternate_key_names(self):
        for split, n in (("train", 50), ("val", 10)):
            np.savez(os.path.join(self.dir, split + ".npz"), input_ids=np.random.randint(0, 999, (n, 64)), labels=np.random.randint(0, 2, n))
        p = run("profile", self.dir)
        self.assertTrue(p["ok"], p)
        self.assertEqual([s["name"] for s in p["splits"]], ["train", "val"])
        self.assertEqual(p["keys"], {"x": "input_ids", "y": "labels"})
        self.assertTrue(p["x"]["integer"])
        self.assertLessEqual(p["x"]["max"], 998)

    def test_unlabeled_arrays_and_mismatched_lengths(self):
        path = os.path.join(self.dir, "latents.npz")
        np.savez(path, x=np.zeros((8, 4, 32, 32), "float32"))
        p = run("profile", path)
        self.assertTrue(p["ok"], p)
        self.assertIsNone(p["y"])
        bad = os.path.join(self.dir, "bad.npz")
        np.savez(bad, x=np.zeros((8, 3)), y=np.zeros(5))
        p = run("profile", bad)
        self.assertFalse(p["ok"])
        self.assertIn("8 inputs but 5 labels", p["error"])

    @unittest.skipUnless(torch is not None, "needs PyTorch")
    def test_pt_dict_and_pair(self):
        d = os.path.join(self.dir, "d.pt")
        torch.save({"inputs": torch.randn(30, 96, 8), "targets": torch.randn(30, 24)}, d)
        p = run("profile", d)
        self.assertTrue(p["ok"], p)
        self.assertEqual((p["x"]["shape"], p["y"]["shape"], p["y"]["classes"]), ([96, 8], [24], None))
        pair = os.path.join(self.dir, "pair.pt")
        torch.save((torch.randn(10, 5), torch.arange(10) % 3), pair)
        p = run("profile", pair)
        self.assertEqual(p["y"]["classes"], 3)

    def test_browse_lists_array_files(self):
        np.savez(os.path.join(self.dir, "a.npz"), x=np.zeros(3))
        open(os.path.join(self.dir, "notes.txt"), "w").close()
        b = run("browse", self.dir)
        self.assertEqual([(e["name"], e["format"]) for e in b["entries"]], [("a.npz", "tensors")])


if __name__ == "__main__":
    unittest.main()
