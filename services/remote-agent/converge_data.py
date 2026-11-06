#!/usr/bin/env python3
"""Converlt data tools. Runs on the machine that holds the data, with the training Python.

    browse DIR                     folders and data files in DIR (JSON)
    profile PATH [--target COL] [--sample N]
                                   column types, missing values, distributions, duplicates,
                                   target balance and leakage hints; or class counts and image
                                   sizes for an image folder (JSON)

Tabular profiling uses pandas when it's installed (CSV, TSV, Parquet, JSON lines) and falls back
to the standard library for CSV. Image folders (one sub-folder per class) use Pillow for sizes
when it's installed. Only a sample is read, so huge files profile in seconds.
"""

import argparse
import csv
import json
import math
import os
import random
import sys

DATA_EXT = {".csv": "csv", ".tsv": "tsv", ".parquet": "parquet", ".pq": "parquet", ".jsonl": "jsonl", ".ndjson": "jsonl", ".json": "json"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tif", ".tiff"}
TENSOR_EXT = {".npz", ".pt", ".pth"}
SPLITS = ("train", "val", "valid", "validation", "test")
X_KEYS = ("x", "X", "inputs", "input", "features", "data", "images", "tokens", "input_ids")
Y_KEYS = ("y", "Y", "labels", "label", "targets", "target")


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), default=str, allow_nan=False) + "\n")


def finite(v):
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def detect(path):
    """(format, files, bytes) for a file or folder."""
    if os.path.isfile(path):
        ext = os.path.splitext(path)[1].lower()
        return ("tensors" if ext in TENSOR_EXT else DATA_EXT.get(ext, "unknown")), 1, os.path.getsize(path)
    if tensor_splits(path):
        files = tensor_splits(path)
        return "tensors", len(files), sum(os.path.getsize(f) for f in files.values())
    files = size = images = 0
    tabular = {}
    for root, dirs, names in os.walk(path):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            ext = os.path.splitext(n)[1].lower()
            try:
                size += os.path.getsize(os.path.join(root, n))
            except OSError:
                continue
            files += 1
            if ext in IMAGE_EXT:
                images += 1
            elif ext in DATA_EXT:
                tabular[DATA_EXT[ext]] = tabular.get(DATA_EXT[ext], 0) + 1
            if files >= 200000:
                break
    if images and images >= files * 0.5:
        return "images", files, size
    if tabular:
        return max(tabular, key=tabular.get), files, size
    return "unknown", files, size


# ---------------------------------------------------------------- browse


def cmd_browse(args):
    d = os.path.abspath(os.path.expanduser(args.dir or "~"))
    if not os.path.isdir(d):
        emit({"ok": False, "error": "not a folder: %s" % d})
        return
    entries = []
    try:
        names = sorted(os.listdir(d), key=str.lower)
    except OSError as e:
        emit({"ok": False, "error": str(e)})
        return
    for n in names:
        if n.startswith("."):
            continue
        full = os.path.join(d, n)
        is_dir = os.path.isdir(full)
        ext = os.path.splitext(n)[1].lower()
        if not is_dir and ext not in DATA_EXT and ext not in TENSOR_EXT:
            continue
        try:
            size = None if is_dir else os.path.getsize(full)
        except OSError:
            size = None
        entries.append({"name": n, "path": full, "dir": is_dir, "size": size, "format": None if is_dir else ("tensors" if ext in TENSOR_EXT else DATA_EXT[ext])})
    emit({"ok": True, "dir": d, "parent": os.path.dirname(d) if d != "/" else None, "entries": entries[:500]})


# ---------------------------------------------------------------- tabular


def histogram(values, bins=20):
    lo, hi = min(values), max(values)
    if lo == hi:
        return {"edges": [lo, hi], "counts": [len(values)]}
    width = (hi - lo) / bins
    counts = [0] * bins
    for v in values:
        counts[min(bins - 1, int((v - lo) / width))] += 1
    return {"edges": [lo + i * width for i in range(bins + 1)], "counts": counts}


def quantile(sorted_vals, q):
    if not sorted_vals:
        return None
    i = (len(sorted_vals) - 1) * q
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (i - lo)


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sxx * syy)


def to_float(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = str(v).strip()
    if s == "":
        return None
    try:
        f = float(s)
        return f if math.isfinite(f) else None
    except ValueError:
        return None


MISSING = {"", "na", "nan", "null", "none", "n/a", "?"}


def is_missing(v):
    if v is None:
        return True
    if isinstance(v, float) and math.isnan(v):
        return True
    return isinstance(v, str) and v.strip().lower() in MISSING


def profile_columns(names, rows, target):
    """rows: list of dicts (sampled). Pure Python so it works with or without pandas."""
    n = len(rows)
    target_vals = [r.get(target) for r in rows] if target else None
    target_num = [to_float(v) for v in target_vals] if target_vals else None
    cols = []
    for name in names:
        vals = [r.get(name) for r in rows]
        present = [v for v in vals if not is_missing(v)]
        missing = n - len(present)
        nums = [to_float(v) for v in present]
        num_ok = [x for x in nums if x is not None]
        strs = [str(v) for v in present]
        unique = len(set(strs))
        col = {"name": name, "missing": missing, "unique": unique, "sample": strs[:5]}
        if present and len(num_ok) >= 0.95 * len(present):
            is_bool = set(strs) <= {"0", "1", "True", "False", "true", "false", "0.0", "1.0"}
            col["dtype"] = "boolean" if is_bool and unique <= 2 else "numeric"
            s = sorted(num_ok)
            mean = sum(s) / len(s)
            std = math.sqrt(sum((x - mean) ** 2 for x in s) / len(s)) if len(s) > 1 else 0.0
            p01, p50, p99 = quantile(s, 0.01), quantile(s, 0.5), quantile(s, 0.99)
            iqr = (quantile(s, 0.75) or 0) - (quantile(s, 0.25) or 0)
            lo, hi = (quantile(s, 0.25) or 0) - 3 * iqr, (quantile(s, 0.75) or 0) + 3 * iqr
            col["numeric"] = {
                "min": s[0], "max": s[-1], "mean": mean, "std": std, "p01": p01, "p50": p50, "p99": p99,
                "zeros": sum(1 for x in s if x == 0),
                "outliers": sum(1 for x in s if iqr > 0 and (x < lo or x > hi)),
                "integer": all(float(x).is_integer() for x in s[:2000]),
                "hist": histogram(s),
            }
            if unique <= 20:  # labels and flags: value counts, e.g. for class balance
                counts = {}
                for x in num_ok:
                    k = str(int(x)) if float(x).is_integer() else str(x)
                    counts[k] = counts.get(k, 0) + 1
                col["top"] = [{"value": k, "count": c} for k, c in sorted(counts.items(), key=lambda kv: -kv[1])]
        else:
            lengths = [len(x) for x in strs]
            mean_len = sum(lengths) / len(lengths) if lengths else 0
            col["dtype"] = "text" if mean_len > 40 and unique > 0.5 * max(1, len(present)) else "categorical"
            counts = {}
            for x in strs:
                counts[x] = counts.get(x, 0) + 1
            col["top"] = [{"value": k[:80], "count": c} for k, c in sorted(counts.items(), key=lambda kv: -kv[1])[:12]]
            if col["dtype"] == "text":
                col["text"] = {"meanLen": mean_len, "maxLen": max(lengths) if lengths else 0, "meanWords": sum(len(x.split()) for x in strs) / max(1, len(strs))}
        # How well this column alone predicts the target: |correlation| for numbers, and for
        # categories the share of rows whose value always maps to one target value (purity).
        if target and name != target:
            if col["dtype"] in ("numeric", "boolean") and target_num and sum(1 for t in target_num if t is not None) >= 0.95 * n:
                pairs = [(to_float(v), t) for v, t in zip(vals, target_num) if to_float(v) is not None and t is not None]
                r = pearson([p[0] for p in pairs], [p[1] for p in pairs]) if pairs else None
                if r is not None:
                    col["targetCorr"] = r
            if col["dtype"] == "categorical" and unique > 1 and unique < 0.9 * n:
                by = {}
                for v, t in zip(vals, target_vals):
                    if not is_missing(v):
                        by.setdefault(str(v), {}).setdefault(str(t), 0)
                        by[str(v)][str(t)] += 1
                pure = sum(max(c.values()) for c in by.values())
                col["targetPurity"] = pure / max(1, sum(sum(c.values()) for c in by.values()))
        cols.append(col)
    return cols


def read_tabular(path, fmt, sample):
    """(column names, sampled rows as dicts, total rows or None, engine)."""
    try:
        import pandas as pd  # noqa: F401

        have_pandas = True
    except ImportError:
        have_pandas = False
    files = [path] if os.path.isfile(path) else sorted(
        os.path.join(r, n)
        for r, _, ns in os.walk(path)
        # Converlt's own outputs aren't input data: <name>_processed folders and the preprocessing state.
        if not any(part.endswith("_processed") for part in os.path.relpath(r, path).split(os.sep))
        for n in ns
        if DATA_EXT.get(os.path.splitext(n)[1].lower()) == fmt and n != "preprocess_state.json"
    )
    if not files:
        raise SystemExit("no %s files in %s" % (fmt, path))
    if have_pandas:
        import pandas as pd

        frames, total = [], 0
        for f in files[:50]:
            if fmt in ("csv", "tsv"):
                df = pd.read_csv(f, sep="\t" if fmt == "tsv" else ",", nrows=sample, low_memory=False)
                with open(f, "rb") as fh:
                    total += max(0, sum(1 for _ in fh) - 1)
            elif fmt == "parquet":
                df = pd.read_parquet(f)
                total += len(df)
            else:
                df = pd.read_json(f, lines=fmt == "jsonl", nrows=sample if fmt == "jsonl" else None)
                total += len(df)
            frames.append(df)
            if sum(len(x) for x in frames) >= sample:
                break
        df = pd.concat(frames, ignore_index=True)
        if len(df) > sample:
            df = df.sample(sample, random_state=0)
        df = df.astype(object).where(df.notna(), None)
        return [str(c) for c in df.columns], df.to_dict("records"), total, "pandas"
    if fmt not in ("csv", "tsv"):
        raise SystemExit("reading %s needs pandas: pip install pandas pyarrow" % fmt)
    rows, total, names = [], 0, None
    rng = random.Random(0)
    for f in files:
        with open(f, newline="", encoding="utf-8", errors="replace") as fh:
            reader = csv.DictReader(fh, delimiter="\t" if fmt == "tsv" else ",")
            names = names or reader.fieldnames or []
            for row in reader:
                total += 1
                if len(rows) < sample:
                    rows.append(row)
                else:  # reservoir sampling keeps the sample uniform over the whole file
                    j = rng.randrange(total)
                    if j < sample:
                        rows[j] = row
    return list(names or []), rows, total, "csv"


def profile_tabular(path, fmt, target, sample):
    names, rows, total, engine = read_tabular(path, fmt, sample)
    if target and target not in names:
        raise SystemExit("target column %r isn't in the data (columns: %s)" % (target, ", ".join(names[:30])))
    keys = [json.dumps([r.get(c) for c in names], default=str) for r in rows]
    dupes = len(keys) - len(set(keys))
    return {
        "kind": "tabular",
        "format": fmt,
        "engine": engine,
        "rows": total,
        "rowsSampled": len(rows),
        "duplicates": dupes,
        "target": target,
        "columns": profile_columns(names, rows, target),
    }


# ---------------------------------------------------------------- images


def profile_images(path, sample):
    classes = {}
    files = []
    for root, dirs, names in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for n in names:
            if os.path.splitext(n)[1].lower() in IMAGE_EXT:
                full = os.path.join(root, n)
                rel = os.path.relpath(root, path)
                cls = rel.split(os.sep)[0] if rel != "." else "(no class folder)"
                # train/val/test folders hold the class folders one level down
                if cls.lower() in ("train", "val", "valid", "validation", "test") and rel.count(os.sep) >= 1:
                    cls = rel.split(os.sep)[1]
                classes[cls] = classes.get(cls, 0) + 1
                files.append(full)
    splits = sorted({os.path.relpath(f, path).split(os.sep)[0] for f in files} & {"train", "val", "valid", "validation", "test"})
    sizes, modes, corrupt, checked = {}, {}, 0, 0
    try:
        from PIL import Image

        rng = random.Random(0)
        for f in rng.sample(files, min(len(files), sample)):
            checked += 1
            try:
                with Image.open(f) as im:
                    im.verify()
                with Image.open(f) as im:
                    key = "%dx%d" % im.size
                    sizes[key] = sizes.get(key, 0) + 1
                    modes[im.mode] = modes.get(im.mode, 0) + 1
            except Exception:
                corrupt += 1
        pil = True
    except ImportError:
        pil = False
    return {
        "kind": "images",
        "format": "images",
        "files": len(files),
        "classes": [{"name": k, "count": v} for k, v in sorted(classes.items(), key=lambda kv: -kv[1])],
        "splits": splits,
        "checked": checked,
        "corrupt": corrupt,
        "sizes": [{"size": k, "count": v} for k, v in sorted(sizes.items(), key=lambda kv: -kv[1])[:12]],
        "modes": modes,
        "pillow": pil,
    }


# ---------------------------------------------------------------- arrays (.npz / .pt)


def tensor_splits(path):
    """{split: file} for a folder of train/val/test array files; {} if it isn't one."""
    if not os.path.isdir(path):
        return {}
    found = {}
    for n in os.listdir(path):
        stem, ext = os.path.splitext(n)
        if ext.lower() in TENSOR_EXT and stem.lower() in SPLITS:
            found[stem.lower()] = os.path.join(path, n)
    return found if "train" in found else {}


def load_arrays(path):
    """(keys, x, y) as numpy arrays (x memory-mapped where possible)."""
    import numpy as np

    if path.endswith(".npz"):
        f = np.load(path, mmap_mode="r")
        names = list(f.files)
        xk = next((k for k in X_KEYS if k in names), names[0] if names else None)
        yk = next((k for k in Y_KEYS if k in names and k != xk), None)
        if xk is None:
            raise SystemExit("%s has no arrays" % path)
        return (xk, yk), f[xk], (f[yk] if yk else None)
    import torch

    try:
        obj = torch.load(path, map_location="cpu", weights_only=True, mmap=True)
    except Exception:
        obj = torch.load(path, map_location="cpu", weights_only=True)
    if isinstance(obj, dict):
        xk = next((k for k in X_KEYS if k in obj), None)
        yk = next((k for k in Y_KEYS if k in obj), None)
        if xk is None:
            raise SystemExit("%s holds a dict without an x / inputs entry (keys: %s)" % (path, ", ".join(map(str, list(obj)[:10]))))
        x, y = obj[xk], obj.get(yk) if yk else None
    elif isinstance(obj, (list, tuple)) and obj:
        xk, yk = "0", ("1" if len(obj) > 1 else None)
        x, y = obj[0], (obj[1] if len(obj) > 1 else None)
    elif hasattr(obj, "shape"):
        xk, yk, x, y = "tensor", None, obj, None
    else:
        raise SystemExit("%s isn't a tensor, (x, y) pair or dict of tensors" % path)
    x = x.numpy() if hasattr(x, "numpy") else np.asarray(x)
    y = (y.numpy() if hasattr(y, "numpy") else np.asarray(y)) if y is not None else None
    return (xk, yk), x, y


def profile_tensors(path):
    import numpy as np

    files = tensor_splits(path) or {"data": path}
    splits, meta = [], None
    for name in sorted(files, key=lambda s: SPLITS.index(s) if s in SPLITS else 9):
        keys, x, y = load_arrays(files[name])
        if y is not None and len(y) != len(x):
            raise SystemExit("%s: %d inputs but %d labels" % (files[name], len(x), len(y)))
        splits.append({"name": name, "file": files[name], "count": int(len(x))})
        if meta is None:
            meta = (keys, x, y)
    keys, x, y = meta
    sample = np.asarray(x[: min(len(x), 2048)])
    integer = bool(np.issubdtype(sample.dtype, np.integer))
    fs = sample.astype("float64")
    out = {
        "kind": "tensors",
        "format": "tensors",
        "splits": splits,
        "keys": {"x": keys[0], "y": keys[1]},
        "x": {
            "shape": [int(d) for d in x.shape[1:]],
            "dtype": str(x.dtype),
            "integer": integer,
            "min": finite(float(fs.min())) if fs.size else None,
            "max": finite(float(fs.max())) if fs.size else None,
            "mean": finite(float(fs.mean())) if fs.size else None,
            "std": finite(float(fs.std())) if fs.size else None,
        },
        "y": None,
    }
    if y is not None:
        ya = np.asarray(y)
        yint = bool(np.issubdtype(ya.dtype, np.integer)) or bool(np.issubdtype(ya.dtype, np.bool_))
        values, counts = np.unique(ya, return_counts=True) if yint else (np.array([]), np.array([]))
        classes = int(ya.max()) + 1 if yint and ya.size and ya.min() >= 0 and len(values) <= 10000 else None
        top = sorted(zip(values.tolist(), counts.tolist()), key=lambda vc: -vc[1])[:50]
        out["y"] = {"shape": [int(d) for d in ya.shape[1:]], "dtype": str(ya.dtype), "integer": yint, "classes": classes, "counts": [{"value": str(v), "count": int(c)} for v, c in top]}
    return out


def cmd_profile(args):
    path = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.exists(path):
        emit({"ok": False, "error": "not found: %s" % path})
        return
    fmt, files, size = detect(path)
    try:
        if fmt == "images":
            prof = profile_images(path, min(args.sample, 400))
        elif fmt == "tensors":
            try:
                prof = profile_tensors(path)
            except ImportError as e:
                emit({"ok": False, "error": "reading array files needs numpy (and PyTorch for .pt) in this Python: %s" % e})
                return
        elif fmt in ("csv", "tsv", "parquet", "jsonl", "json"):
            prof = profile_tabular(path, fmt, args.target, args.sample)
        else:
            emit({"ok": False, "error": "no tables, images or array files (.npz, .pt) found in %s" % path})
            return
    except SystemExit as e:
        emit({"ok": False, "error": str(e)})
        return
    prof.update(ok=True, path=path, bytes=size, fileCount=files)
    emit(prof)


def main(argv=None):
    p = argparse.ArgumentParser(prog="converge_data")
    sub = p.add_subparsers(dest="cmd")
    b = sub.add_parser("browse")
    b.add_argument("dir", nargs="?")
    pr = sub.add_parser("profile")
    pr.add_argument("path")
    pr.add_argument("--target")
    pr.add_argument("--sample", type=int, default=50000)
    args = p.parse_args(argv)
    if args.cmd == "browse":
        cmd_browse(args)
    elif args.cmd == "profile":
        cmd_profile(args)
    else:
        p.print_help()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
