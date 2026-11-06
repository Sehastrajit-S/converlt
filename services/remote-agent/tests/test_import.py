"""Tests for converge_import.py (code → Model Builder graph). Needs PyTorch.

    python3 -m unittest discover -s services/remote-agent/tests -v
"""

import json
import os
import subprocess
import sys
import textwrap
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(os.path.dirname(HERE), "converge_import.py")

try:
    import torch  # noqa: F401

    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

MODELS = textwrap.dedent(
    """
    import torch
    import torch.nn.functional as F
    from torch import nn
    from blocks import Residual

    INPUT_SHAPE = (3, 16, 16)

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.stem = nn.Sequential(nn.Conv2d(3, 16, 3, padding=1, bias=False), nn.BatchNorm2d(16), nn.ReLU())
            self.pool = nn.MaxPool2d(3, 2, padding=1)
            self.res = Residual(16)
            self.fc = nn.Linear(16, 5)

        def forward(self, x):
            x = self.res(self.pool(self.stem(x)))
            x = F.adaptive_avg_pool2d(x, 1).flatten(1)
            return self.fc(x)

    class Odd(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv = nn.Conv2d(3, 4, (3, 5), padding=(1, 2))
            self.fc = nn.Linear(4 * 16 * 16, 2)

        def forward(self, x):
            return self.fc(self.conv(x).view(x.size(0), -1))

    class NeedsArgs(nn.Module):
        def __init__(self, width):
            super().__init__()
    """
)
BLOCKS = textwrap.dedent(
    """
    from torch import nn
    import torch.nn.functional as F

    class Residual(nn.Module):
        def __init__(self, c):
            super().__init__()
            self.a = nn.Conv2d(c, c, 3, padding=1)
            self.b = nn.Conv2d(c, c, 3, padding=1)

        def forward(self, x):
            return F.relu(x + self.b(F.relu(self.a(x))))
    """
)


def run(**req):
    payload = dict(files={"models/net.py": MODELS, "blocks.py": BLOCKS}, file="models/net.py", **req)
    p = subprocess.run([sys.executable, TOOL], input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    return json.loads(p.stdout.decode().strip().splitlines()[-1])


@unittest.skipUnless(HAVE_TORCH, "needs PyTorch")
class ImportTest(unittest.TestCase):
    def test_lists_classes_and_reads_input_shape(self):
        r = run()
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["classes"], ["Net", "Odd", "NeedsArgs"])
        self.assertEqual(r["inputShape"], [3, 16, 16])
        self.assertEqual(r["need"], "class")

    def test_traces_into_builder_layers_with_project_imports(self):
        r = run(className="Net")
        self.assertTrue(r["ok"], r)
        types = [n["type"] for n in r["graph"]["nodes"]]
        self.assertEqual(r["custom"], [])
        for t in ("Input", "Conv2d", "BatchNorm", "ReLU", "MaxPool2d", "Add", "AdaptiveAvgPool2d", "Flatten", "Linear", "Output"):
            self.assertIn(t, types)
        conv = next(n for n in r["graph"]["nodes"] if n["type"] == "Conv2d")
        self.assertEqual((conv["params"]["bias"], conv["params"]["out_channels"]), (False, 16))
        pool = next(n for n in r["graph"]["nodes"] if n["type"] == "MaxPool2d")
        self.assertEqual(pool["params"], {"kernel_size": 3, "stride": 2, "padding": 1})
        add = next(n for n in r["graph"]["nodes"] if n["type"] == "Add")
        self.assertEqual(len([e for e in r["graph"]["edges"] if e["to"] == add["id"]]), 2, "the residual joins two paths")
        self.assertEqual(r["torchParams"], 16 * 27 + 32 + 2 * (16 * 16 * 9 + 16) + 16 * 5 + 5)

    def test_unsupported_settings_become_blocks_with_real_shapes(self):
        r = run(className="Odd")
        self.assertTrue(r["ok"], r)
        block = next(n for n in r["graph"]["nodes"] if n["type"] == "Custom")
        self.assertEqual(block["params"]["shape"], "4,16,16")
        self.assertEqual(block["params"]["params"], 3 * 4 * 15 + 4)
        self.assertIn("conv (Conv2d)", r["custom"])

    def test_clear_errors(self):
        self.assertIn("needs arguments", run(className="NeedsArgs")["error"])
        self.assertIn("isn't defined", run(className="Nope")["error"])


if __name__ == "__main__":
    unittest.main()
