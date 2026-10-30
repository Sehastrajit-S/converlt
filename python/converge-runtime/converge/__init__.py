"""Converlt runtime SDK.

Optional instrumentation for training scripts. Scripts that use it still run
normally outside Converlt: every call becomes a no-op when the script was not
launched by the Converlt agent.

    import converge

    with converge.run(config={"lr": 1e-4, "batch_size": 32}) as run:
        for step, batch in enumerate(loader):
            loss = train_step(batch)
            run.log({"train/loss": loss}, step=step)
        run.log_checkpoint("checkpoints/last.pt")
"""

import hashlib
import json
import math
import os
import sys
import threading
import time
import traceback

__version__ = "0.1.0"
__all__ = ["Run", "run", "log", "log_checkpoint", "current_run", "is_active"]

_SIZE_HASH_LIMIT = 4 * 2 ** 30
_BATCH_HINT_KEYS = ("batch_size", "micro_batch_size", "seq_len", "sequence_length", "max_length", "block_size", "context_length")
_current = None


def is_active():
    """True when this process was launched by the Converlt agent."""
    return bool(os.environ.get("CONVERGE_SDK_FILE"))


def _to_number(v):
    if hasattr(v, "item") and callable(v.item):  # torch / numpy scalars
        try:
            v = v.item()
        except Exception:
            return None
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return v
    return None


def _jsonable(obj, depth=0):
    if depth > 6:
        return repr(obj)
    if isinstance(obj, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in obj]
    if isinstance(obj, (str, bool)) or obj is None:
        return obj
    n = _to_number(obj)
    if n is not None:
        return n
    if hasattr(obj, "__dict__") and not callable(obj):
        return _jsonable(vars(obj), depth + 1)  # argparse.Namespace, simple dataclasses
    return repr(obj)


def _cuda_memory_stats():
    torch = sys.modules.get("torch")
    if torch is None:
        return {}
    try:
        if not torch.cuda.is_available():
            return {}
        dev = torch.cuda.current_device()
        mib = 1024 * 1024
        stats = {
            "device": dev,
            "deviceName": torch.cuda.get_device_name(dev),
            "allocatedMiB": round(torch.cuda.memory_allocated(dev) / mib, 1),
            "reservedMiB": round(torch.cuda.memory_reserved(dev) / mib, 1),
            "peakAllocatedMiB": round(torch.cuda.max_memory_allocated(dev) / mib, 1),
            "totalMiB": round(torch.cuda.get_device_properties(dev).total_memory / mib, 1),
        }
        try:
            free, _total = torch.cuda.mem_get_info(dev)
            stats["freeMiB"] = round(free / mib, 1)
        except Exception:
            pass
        return stats
    except Exception:
        return {}


def _is_oom(exc):
    name = type(exc).__name__
    return name == "OutOfMemoryError" or "out of memory" in str(exc).lower()


class Run:
    """A Converlt run handle. Safe to use whether or not Converlt launched the script."""

    def __init__(self, project=None, config=None, name=None):
        self.id = os.environ.get("CONVERGE_RUN_ID")
        self.project = project or os.environ.get("CONVERGE_PROJECT")
        self.name = name
        self.config = dict(config or {}) if not hasattr(config, "__dict__") or isinstance(config, dict) else dict(vars(config))
        self.active = is_active()
        self._lock = threading.Lock()
        self._fh = None
        self._next_step = 0
        self._closed = False
        if self.active:
            self._fh = open(os.environ["CONVERGE_SDK_FILE"], "a", encoding="utf-8")
            if self.config:
                self._write({"type": "config", "values": _jsonable(self.config)})
            self._install_excepthook()

    # -- public API

    def log(self, values, step=None):
        """Record scalar metrics. Tensors/numpy scalars are converted; non-numbers are skipped."""
        if step is None:
            step = self._next_step
        self._next_step = int(step) + 1
        if not self.active:
            return
        clean = {}
        for k, v in dict(values).items():
            n = _to_number(v)
            if n is not None:
                clean[str(k)] = n
        if clean:
            self._write({"type": "metric", "step": int(step), "values": clean})

    def update_config(self, values):
        self.config.update(values)
        if self.active:
            self._write({"type": "config", "values": _jsonable(dict(values))})

    def log_checkpoint(self, path, step=None, compute_hash=True):
        """Link a checkpoint file to this run, with its size and SHA-256."""
        if not self.active:
            return
        path = os.path.abspath(path)
        size = digest = None
        try:
            size = os.path.getsize(path)
            if compute_hash and size <= _SIZE_HASH_LIMIT:
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        h.update(chunk)
                digest = h.hexdigest()
        except OSError:
            pass
        self._write({"type": "artifact", "path": path, "sizeBytes": size, "sha256": digest, "step": step})

    def finish(self):
        with self._lock:
            if self._fh is not None and not self._closed:
                self._fh.close()
            self._closed = True

    # -- context manager

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self._report_exception(exc, tb)
        self.finish()
        return False

    # -- internals

    def _write(self, record):
        with self._lock:
            if self._fh is None or self._closed:
                return
            record.setdefault("ts", round(time.time(), 3))
            self._fh.write(json.dumps(record, separators=(",", ":"), allow_nan=False, default=repr) + "\n")
            self._fh.flush()

    def _report_exception(self, exc, tb):
        if not self.active or getattr(exc, "_converge_reported", False):
            return
        try:
            exc._converge_reported = True
        except Exception:
            pass
        if _is_oom(exc):
            data = _cuda_memory_stats()
            data["message"] = str(exc)[:1000]
            hints = {k: self.config[k] for k in _BATCH_HINT_KEYS if k in self.config}
            if hints:
                data["batchHints"] = _jsonable(hints)
            frames = traceback.extract_tb(tb)
            if frames:
                last = frames[-1]
                data["failingFrame"] = "%s:%d in %s" % (last.filename, last.lineno, last.name)
            self._write({"type": "oom", "data": data})
        elif not isinstance(exc, (KeyboardInterrupt, SystemExit)):
            self._write(
                {
                    "type": "exception",
                    "excType": type(exc).__name__,
                    "message": str(exc)[:2000],
                    "traceback": "".join(traceback.format_exception(type(exc), exc, tb))[-6000:],
                }
            )

    def _install_excepthook(self):
        previous = sys.excepthook

        def hook(exc_type, exc, tb):
            try:
                self._report_exception(exc, tb)
            finally:
                previous(exc_type, exc, tb)

        sys.excepthook = hook


def run(project=None, config=None, name=None):
    """Start (or return) the current run."""
    global _current
    if _current is None or _current._closed:
        _current = Run(project=project, config=config, name=name)
    elif config:
        _current.update_config(config)
    return _current


def current_run():
    return _current


def log(values, step=None):
    run().log(values, step=step)


def log_checkpoint(path, step=None):
    run().log_checkpoint(path, step=step)
