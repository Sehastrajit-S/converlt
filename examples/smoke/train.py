"""Simulated training loop with no dependencies. Exercises every Converlt path.

    python train.py --steps 200 --lr 0.01
    python train.py --nan-at 50          # non-finite loss
    python train.py --oom-at 30          # CUDA OOM-style crash
    python train.py --exit-code 3        # plain failure
"""

import argparse
import math
import random
import sys
import time

try:
    import converge
except ImportError:  # runs fine without Converlt
    converge = None

p = argparse.ArgumentParser()
p.add_argument("--steps", type=int, default=120)
p.add_argument("--lr", type=float, default=0.01)
p.add_argument("--batch-size", type=int, default=32)
p.add_argument("--sleep", type=float, default=0.05)
p.add_argument("--nan-at", type=int, default=-1)
p.add_argument("--oom-at", type=int, default=-1)
p.add_argument("--exit-code", type=int, default=0)
p.add_argument("--seed", type=int, default=0)
args = p.parse_args()

random.seed(args.seed)
run = converge.run(config=vars(args)) if converge else None


class OutOfMemoryError(RuntimeError):
    pass


loss = 2.5
for step in range(args.steps):
    loss = loss * (1 - args.lr * 0.8) + random.uniform(-0.02, 0.02)
    if step == args.nan_at:
        loss = float("nan")
    if step == args.oom_at:
        raise OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB (simulated)")
    acc = 1 - math.exp(-step / max(1, args.steps / 4)) * 0.9
    if run:
        run.log({"train/loss": loss, "train/acc": acc, "lr": args.lr}, step=step)
    if step % 10 == 0:
        print("step %d loss=%.4f acc=%.3f" % (step, loss, acc), flush=True)
    time.sleep(args.sleep)

print("done", flush=True)
if args.exit_code:
    print("simulated failure", file=sys.stderr)
    sys.exit(args.exit_code)
