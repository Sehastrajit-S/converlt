"""Converlt runtime SDK.

Optional instrumentation for training scripts. Scripts that use it still run
normally outside Converlt: every call becomes a no-op when the script was not
launched by the Converlt agent.

    import converge

    with converge.run(config={"lr": 1e-4, "batch_size": 32}, total_steps=10_000) as run:
        run.watch(model)                 # on a NaN, find where it is (weights, gradients, or neither)
        run.log_dataset("data/train")    # fingerprint local data (Hugging Face datasets are automatic)
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

__version__ = "0.2.0"
__all__ = ["Run", "run", "log", "log_checkpoint", "log_dataset", "current_run", "is_active"]

_SIZE_HASH_LIMIT = 4 * 2 ** 30
_BATCH_HINT_KEYS = ("batch_size", "micro_batch_size", "seq_len", "sequence_length", "max_length", "block_size", "context_length")
_current = None

_emit_lock = threading.Lock()
_emit_fh = None


def _reset_after_fork():
    # A data-loader worker forked while the parent held the lock must not inherit it locked.
    global _emit_lock, _emit_fh
    _emit_lock = threading.Lock()
    _emit_fh = None


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_after_fork)


def _emit(record):
    """Appends one record to the run's SDK channel, read by the Converlt agent. No-op outside Converlt."""
    global _emit_fh
    path = os.environ.get("CONVERGE_SDK_FILE")
    if not path:
        return
    record.setdefault("ts", round(time.time(), 3))
    line = json.dumps(record, separators=(",", ":"), allow_nan=False, default=repr) + "\n"
    with _emit_lock:
        if _emit_fh is None:
            _emit_fh = open(path, "a", encoding="utf-8")
        _emit_fh.write(line)
        _emit_fh.flush()


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


def _module_of(param_name):
    for suffix in (".weight", ".bias"):
        if param_name.endswith(suffix):
            return param_name[: -len(suffix)]
    return param_name


def _nan_report(model):
    """Where a NaN is, right after the loss went non-finite: in the weights, the gradients, or neither.

    Parameters are checked in registration order, which roughly follows the forward pass, so the
    first bad name is the earliest layer involved. Runs once, at the moment of the NaN.
    """
    torch = sys.modules.get("torch")
    if torch is None or model is None or not hasattr(model, "named_parameters"):
        return None
    bad_weights, bad_grads, norms, with_grad = [], [], [], 0
    with torch.no_grad():
        for name, p in model.named_parameters():
            if not bool(torch.isfinite(p).all()):
                bad_weights.append(name)
            g = p.grad
            if g is None:
                continue
            with_grad += 1
            n = float(g.detach().float().norm())
            if math.isfinite(n):
                norms.append((n, name))
            else:
                bad_grads.append(name)
    norms.sort(reverse=True)
    report = {
        "nonFiniteWeights": bad_weights[:5],
        "nonFiniteWeightCount": len(bad_weights),
        "nonFiniteGrads": bad_grads[:5],
        "nonFiniteGradCount": len(bad_grads),
        "largestGradNorms": [{"name": n, "norm": round(v, 4)} for v, n in norms[:3]],
    }
    tensors = lambda n: "1 tensor" if n == 1 else "%d tensors" % n  # noqa: E731
    if bad_weights:
        report["nanWhere"] = "weights"
        report["nanLayer"] = _module_of(bad_weights[0])
        cause = (
            "Gradients are non-finite too (first in %s), so an overflowing backward pass fed a bad optimizer step." % _module_of(bad_grads[0])
            if bad_grads
            else "An optimizer step already applied a bad update: usually exploding gradients or a learning rate that's too high."
        )
        report["nanVerdict"] = "The weights of %s are non-finite (%s in all). %s" % (report["nanLayer"], tensors(len(bad_weights)), cause)
    elif bad_grads:
        report["nanWhere"] = "gradients"
        report["nanLayer"] = _module_of(bad_grads[0])
        report["nanVerdict"] = (
            "The weights are finite, but the gradients of %s are not (%s in all): the backward pass overflowed. "
            "With fp16, use a GradScaler or switch to bf16; otherwise clip gradients with torch.nn.utils.clip_grad_norm_." % (report["nanLayer"], tensors(len(bad_grads)))
        )
    else:
        report["nanWhere"] = "forward"
        report["nanVerdict"] = (
            "The weights%s are finite, so the NaN came from the forward pass or the loss itself: log or sqrt of a "
            "non-positive value, a division by zero, or a bad batch." % (" and gradients" if with_grad else "")
        )
    if norms and norms[0][0] > 1e3:
        report["nanVerdict"] += " The largest gradient norm was %.3g, in %s." % (norms[0][0], _module_of(norms[0][1]))
    return report


class Run:
    """A Converlt run handle. Safe to use whether or not Converlt launched the script."""

    def __init__(self, project=None, config=None, name=None, total_steps=None):
        self.id = os.environ.get("CONVERGE_RUN_ID")
        self.project = project or os.environ.get("CONVERGE_PROJECT")
        self.name = name
        self.config = dict(config or {}) if not hasattr(config, "__dict__") or isinstance(config, dict) else dict(vars(config))
        if total_steps:
            self.config["total_steps"] = int(total_steps)
        self.active = is_active()
        self._lock = threading.Lock()
        self._next_step = 0
        self._closed = False
        self._model = None
        self._nan_reported = False
        if self.active:
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
        if not clean:
            return
        if self._model is not None and not self._nan_reported and any(isinstance(v, str) for v in clean.values()):
            # Before the metric: once the agent sees the NaN it may stop the run.
            self._nan_reported = True
            try:
                report = _nan_report(self._model)
            except Exception:
                report = None
            if report:
                self._write({"type": "nan_detail", "data": _jsonable(report)})
        self._write({"type": "metric", "step": int(step), "values": clean})

    def watch(self, model):
        """On the first non-finite metric, check the model's weights and gradients to locate the NaN."""
        self._model = model
        return model

    def log_dataset(self, source, name=None):
        """Record a dataset with a fingerprint: a path (file or folder), a Hugging Face Dataset, or a dataset with .root."""
        if not self.active:
            return
        from . import _inputs

        try:
            rec = _inputs.describe(source, name=name)
        except Exception:
            rec = {"kind": "dataset", "name": name or repr(source)[:200]}
        rec = {k: v for k, v in rec.items() if v is not None}
        rec.update(type="input", source="sdk")
        self._write(_jsonable(rec))

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
        if not self.active or self._closed:
            return
        _emit(record)

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


def run(project=None, config=None, name=None, total_steps=None):
    """Start (or return) the current run. `total_steps` lets Converlt forecast time and cost."""
    global _current
    if _current is None or _current._closed:
        _current = Run(project=project, config=config, name=name, total_steps=total_steps)
    else:
        if config:
            _current.update_config(config)
        if total_steps:
            _current.update_config({"total_steps": int(total_steps)})
    return _current


def current_run():
    return _current


def log(values, step=None):
    run().log(values, step=step)


def log_checkpoint(path, step=None):
    run().log_checkpoint(path, step=step)


def log_dataset(source, name=None):
    run().log_dataset(source, name=name)
