"""Weight snapshots for the Model Builder's weights view: per parameter tensor, its statistics,
gradient norm, a value histogram and a coarse picture of the matrix. Small on purpose: a
snapshot of a few dozen tensors is tens of kilobytes."""

BINS = 24
GRID_ROWS = 12
GRID_COLS = 24
MAX_TENSORS = 160
MAX_GRIDS = 32


def _r(v):
    v = float(v)
    if v != v or v in (float("inf"), float("-inf")):
        return str(v)
    return float("%.5g" % v)


def _image(t, max_side=48):
    """[C, H, W] -> {kind: image, w, h, c, data: base64 HWC uint8}, scaled per example to 0-255."""
    import base64

    import torch

    t = t.float()
    c = 3 if t.shape[0] >= 3 else 1
    t = t[:c]
    h, w = t.shape[1], t.shape[2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1:
        t = torch.nn.functional.adaptive_avg_pool2d(t[None], (max(1, int(h * scale)), max(1, int(w * scale))))[0]
    lo, hi = float(t.min()), float(t.max())
    t = ((t - lo) / (hi - lo if hi > lo else 1.0) * 255).clamp(0, 255).to(torch.uint8)
    data = t.permute(1, 2, 0).contiguous().numpy().tobytes()
    return {"kind": "image", "w": int(t.shape[2]), "h": int(t.shape[1]), "c": c, "data": base64.b64encode(data).decode()}


def encode_one(t):
    """One example (no batch dimension) as something the UI can draw."""
    import torch

    if not t.is_floating_point():
        return {"kind": "tokens", "ids": [int(v) for v in t.flatten()[:64].tolist()], "length": int(t.numel())}
    if t.dim() == 3 and t.shape[0] <= 4:
        return _image(t)
    if t.dim() == 4 and t.shape[0] <= 4:  # video [C, T, H, W]: the middle frame
        return dict(_image(t[:, t.shape[1] // 2]), frames=int(t.shape[1]))
    if t.dim() == 2 and t.shape[0] <= 2 and t.shape[1] >= 256:  # audio [channels, samples]
        wave = t[0].float()
        n = 200
        chunks = wave[: (wave.numel() // n) * n].reshape(n, -1)
        return {"kind": "wave", "min": [_r(v) for v in chunks.min(1).values.tolist()], "max": [_r(v) for v in chunks.max(1).values.tolist()]}
    if t.dim() >= 2:  # sequences, spectrogram-like arrays
        m = t.float().reshape(t.shape[0], -1)
        rows, cols = min(32, m.shape[0]), min(64, m.shape[1])
        cell = torch.nn.functional.adaptive_avg_pool2d(m[None, None], (rows, cols))[0, 0]
        return {"kind": "heatmap", "rows": rows, "cols": cols, "shape": list(t.shape), "values": [[float("%.3g" % v) for v in r] for r in cell.tolist()]}
    return {"kind": "vector", "values": [_r(v) for v in t.float()[:64].tolist()], "length": int(t.numel())}


def encode_examples(x, y=None, class_names=None):
    out = {"inputs": [encode_one(t) for t in x], "shape": list(x.shape[1:])}
    if y is not None:
        labels = []
        for v in y:
            if v.numel() == 1 and not v.is_floating_point():
                i = int(v)
                labels.append({"class": i, "name": str(class_names[i]) if class_names and 0 <= i < len(class_names) else None})
            elif v.numel() == 1:
                labels.append({"value": _r(v)})
            else:
                labels.append({"values": [_r(u) for u in v.flatten()[:8].tolist()]})
        out["labels"] = labels
    if class_names:
        out["classNames"] = [str(c) for c in list(class_names)[:1000]]
    return out


def predictions(model, x):
    """The model's outputs for the recorded examples, at this point in training."""
    import torch

    was = model.training
    dev = next(model.parameters()).device
    model.eval()
    try:
        with torch.no_grad():
            out = model(x.to(dev)).float().cpu()
    finally:
        model.train(was)
    if x.is_floating_point() and out.shape == x.shape:
        return [dict(encode_one(o), kind="recon:" + encode_one(o)["kind"]) for o in out]
    if out.dim() == 2 and out.shape[1] > 1:
        p = out.softmax(-1)
        top = p.max(-1)
        return [{"class": int(i), "p": _r(v)} for v, i in zip(top.values.tolist(), top.indices.tolist())]
    if out.dim() == 2:
        return [{"value": _r(v), "p": _r(torch.sigmoid(torch.tensor(v)))} for v in out[:, 0].tolist()]
    if out.dim() == 3:
        return [{"tokens": [int(i) for i in o.argmax(-1)[:64].tolist()]} for o in out]
    return [{"values": [_r(u) for u in o.flatten()[:8].tolist()]} for o in out]


def snapshot(model):
    import torch

    tensors = []
    grids = 0
    with torch.no_grad():
        for name, p in list(model.named_parameters())[:MAX_TENSORS]:
            n = p.numel()
            if n == 0:
                continue
            w = p.detach().float()
            finite = torch.isfinite(w)
            bad = int(n - int(finite.sum()))
            vals = w[finite] if bad else w.reshape(-1)
            rec = {"name": name, "shape": list(p.shape), "numel": int(n)}
            if bad:
                rec["nonFinite"] = bad
            if vals.numel() == 0:
                rec.update(mean=0.0, std=0.0, absMax=0.0, hist={"min": 0.0, "max": 0.0, "counts": [0] * BINS})
            else:
                lo, hi = float(vals.min()), float(vals.max())
                counts = torch.histc(vals, bins=BINS, min=lo, max=hi).long().tolist() if hi > lo else [int(vals.numel())]
                rec.update(
                    mean=_r(vals.mean()),
                    std=_r(vals.std()) if vals.numel() > 1 else 0.0,
                    absMax=_r(max(abs(lo), abs(hi))),
                    hist={"min": _r(lo), "max": _r(hi), "counts": counts},
                )
            if p.grad is not None:
                g = p.grad.detach().float()
                rec["gradNorm"] = _r(g.norm()) if bool(torch.isfinite(g).all()) else None
            if p.dim() >= 2 and not bad and grids < MAX_GRIDS:
                m = w.reshape(p.shape[0], -1)
                rows, cols = min(GRID_ROWS, m.shape[0]), min(GRID_COLS, m.shape[1])
                cell = torch.nn.functional.adaptive_avg_pool2d(m[None, None], (rows, cols))[0, 0]
                rec["grid"] = [[float("%.3g" % v) for v in row] for row in cell.tolist()]
                grids += 1
            tensors.append(rec)
    return tensors
