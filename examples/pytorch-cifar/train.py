"""Small CIFAR-10 ResNet-style trainer instrumented with the Converlt SDK.

    pip install torch torchvision
    python train.py --epochs 2 --lr 0.001 --batch-size 128

Uses synthetic data with --synthetic so it runs without downloading CIFAR.
"""

import argparse
import os

import torch
import torch.nn as nn
import torch.nn.functional as F

try:
    import converge
except ImportError:
    converge = None

p = argparse.ArgumentParser()
p.add_argument("--epochs", type=int, default=2)
p.add_argument("--lr", type=float, default=1e-3)
p.add_argument("--batch-size", type=int, default=128)
p.add_argument("--width", type=int, default=64)
p.add_argument("--synthetic", action="store_true")
p.add_argument("--amp", action="store_true")
p.add_argument("--out", default="checkpoints")
args = p.parse_args()

device = "cuda" if torch.cuda.is_available() else "cpu"
run = converge.run(config=vars(args)) if converge else None


class Block(nn.Module):
    def __init__(self, cin, cout, stride):
        super().__init__()
        self.c1 = nn.Conv2d(cin, cout, 3, stride, 1, bias=False)
        self.b1 = nn.BatchNorm2d(cout)
        self.c2 = nn.Conv2d(cout, cout, 3, 1, 1, bias=False)
        self.b2 = nn.BatchNorm2d(cout)
        self.skip = nn.Sequential() if stride == 1 and cin == cout else nn.Sequential(nn.Conv2d(cin, cout, 1, stride, bias=False), nn.BatchNorm2d(cout))

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        return F.relu(self.b2(self.c2(y)) + self.skip(x))


class Net(nn.Module):
    def __init__(self, w):
        super().__init__()
        self.stem = nn.Sequential(nn.Conv2d(3, w, 3, 1, 1, bias=False), nn.BatchNorm2d(w), nn.ReLU())
        self.layers = nn.Sequential(Block(w, w, 1), Block(w, 2 * w, 2), Block(2 * w, 4 * w, 2))
        self.head = nn.Linear(4 * w, 10)

    def forward(self, x):
        x = self.layers(self.stem(x))
        return self.head(F.adaptive_avg_pool2d(x, 1).flatten(1))


def loaders():
    if args.synthetic:
        x = torch.randn(10000, 3, 32, 32)
        y = torch.randint(0, 10, (10000,))
        ds = torch.utils.data.TensorDataset(x, y)
        return torch.utils.data.DataLoader(ds, batch_size=args.batch_size, shuffle=True), torch.utils.data.DataLoader(ds, batch_size=512)
    import torchvision
    import torchvision.transforms as T

    tf = T.Compose([T.ToTensor(), T.Normalize((0.49, 0.48, 0.45), (0.25, 0.24, 0.26))])
    train = torchvision.datasets.CIFAR10("data", train=True, download=True, transform=tf)
    test = torchvision.datasets.CIFAR10("data", train=False, download=True, transform=tf)
    return (
        torch.utils.data.DataLoader(train, batch_size=args.batch_size, shuffle=True, num_workers=4),
        torch.utils.data.DataLoader(test, batch_size=512, num_workers=4),
    )


train_dl, test_dl = loaders()
model = Net(args.width).to(device)
opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
scaler = torch.amp.GradScaler(enabled=args.amp)
step = 0
for epoch in range(args.epochs):
    model.train()
    for x, y in train_dl:
        x, y = x.to(device, non_blocking=True), y.to(device, non_blocking=True)
        with torch.autocast(device, enabled=args.amp):
            loss = F.cross_entropy(model(x), y)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.step(opt)
        scaler.update()
        if step % 10 == 0 and run:
            run.log({"train/loss": loss, "lr": opt.param_groups[0]["lr"]}, step=step)
        if step % 50 == 0:
            print(f"epoch {epoch} step {step} loss={loss.item():.4f}", flush=True)
        step += 1

    model.eval()
    correct = total = 0
    val_loss = 0.0
    with torch.no_grad():
        for x, y in test_dl:
            x, y = x.to(device), y.to(device)
            out = model(x)
            val_loss += F.cross_entropy(out, y, reduction="sum").item()
            correct += (out.argmax(1) == y).sum().item()
            total += y.numel()
    print(f"epoch {epoch} val_loss={val_loss / total:.4f} val_acc={correct / total:.4f}", flush=True)
    if run:
        run.log({"val/loss": val_loss / total, "val/acc": correct / total}, step=step)

os.makedirs(args.out, exist_ok=True)
ckpt = os.path.join(args.out, "last.pt")
torch.save(model.state_dict(), ckpt)
if run:
    run.log_checkpoint(ckpt, step=step)
