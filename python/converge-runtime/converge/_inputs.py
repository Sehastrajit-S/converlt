"""Fingerprints for datasets and pretrained weights, so two runs can tell whether they read the same data.

A fingerprint never reads a whole dataset: for files it combines every file's relative path and
size with sampled bytes from up to 64 of them, which catches added, removed, resized and most
rewritten files in a fraction of a second.
"""

import hashlib
import os

_SAMPLE_FILES = 64
_SAMPLE_BYTES = 64 * 1024
_MAX_FILES = 200_000
_FULL_HASH_LIMIT = 256 * 2 ** 20


def _sample(h, path, size):
    try:
        with open(path, "rb") as f:
            h.update(f.read(_SAMPLE_BYTES))
            if size > 2 * _SAMPLE_BYTES:
                f.seek(size - _SAMPLE_BYTES)
                h.update(f.read(_SAMPLE_BYTES))
    except OSError:
        pass


def fingerprint_path(path):
    """(fingerprint, method, files, bytes) for a file or directory, or None if it doesn't exist."""
    path = os.path.abspath(os.path.expanduser(str(path)))
    if os.path.isfile(path):
        size = os.path.getsize(path)
        h = hashlib.sha256()
        if size <= _FULL_HASH_LIMIT:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            return h.hexdigest(), "sha256 of the file", 1, size
        h.update(str(size).encode())
        _sample(h, path, size)
        return h.hexdigest(), "file size and sampled contents", 1, size
    if not os.path.isdir(path):
        return None
    entries = []
    for root, dirs, files in os.walk(path):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "__pycache__")
        for name in sorted(files):
            if name.startswith("."):
                continue
            full = os.path.join(root, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            entries.append((os.path.relpath(full, path).replace(os.sep, "/"), size, full))
            if len(entries) >= _MAX_FILES:
                break
        if len(entries) >= _MAX_FILES:
            break
    h = hashlib.sha256()
    total = 0
    for rel, size, _ in entries:
        h.update(("%s\0%d\n" % (rel, size)).encode("utf-8", "replace"))
        total += size
    if entries:
        stride = max(1, len(entries) // _SAMPLE_FILES)
        for rel, size, full in entries[::stride][:_SAMPLE_FILES]:
            _sample(h, full, size)
    return h.hexdigest(), "file names, sizes and sampled contents", len(entries), total


def describe(source, name=None, kind="dataset"):
    """An input record for a path, a Hugging Face Dataset/DatasetDict, or a torch dataset with a root."""
    rec = {"kind": kind, "name": name, "path": None, "fingerprint": None, "method": None, "files": None, "bytes": None}
    fp = getattr(source, "_fingerprint", None)
    if isinstance(fp, str):  # datasets.Dataset
        rec.update(fingerprint=fp, method="Hugging Face datasets fingerprint")
        info = getattr(source, "info", None)
        rec["name"] = name or getattr(info, "dataset_name", None) or getattr(info, "builder_name", None) or "dataset"
        return rec
    if hasattr(source, "keys") and hasattr(source, "values") and not isinstance(source, (str, bytes, os.PathLike)):
        splits = {}
        try:
            for split in sorted(source.keys()):
                sfp = getattr(source[split], "_fingerprint", None)
                if isinstance(sfp, str):
                    splits[split] = sfp
        except Exception:
            splits = {}
        if splits:  # datasets.DatasetDict
            h = hashlib.sha256("".join("%s:%s\n" % kv for kv in sorted(splits.items())).encode())
            first = source[sorted(splits)[0]]
            info = getattr(first, "info", None)
            rec.update(fingerprint=h.hexdigest(), method="Hugging Face datasets fingerprint (%s)" % ", ".join(sorted(splits)))
            rec["name"] = name or getattr(info, "dataset_name", None) or getattr(info, "builder_name", None) or "dataset"
            return rec
    root = source if isinstance(source, (str, os.PathLike)) else getattr(source, "root", None)
    if isinstance(root, (str, os.PathLike)):
        rec["path"] = os.path.abspath(os.path.expanduser(str(root)))
        rec["name"] = name or (os.path.basename(rec["path"].rstrip("/")) if isinstance(source, (str, os.PathLike)) else type(source).__name__)
        got = fingerprint_path(rec["path"])
        if got:
            rec["fingerprint"], rec["method"], rec["files"], rec["bytes"] = got
        return rec
    rec["name"] = name or type(source).__name__
    return rec
