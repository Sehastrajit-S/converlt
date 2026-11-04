"""Zero-setup instrumentation, installed at interpreter start (sitecustomize) for runs Converlt launched.

Nothing is imported eagerly: each hook runs right after its module is first imported by the
training script, so a script that never imports torch pays nothing.

- torch.utils.data: time spent waiting for the next batch, reported every 30 s, so a data-loader
  bottleneck can be named instead of guessed from GPU utilization.
- datasets.load_dataset and transformers' from_pretrained: which dataset and which pretrained
  weights the run read, with fingerprints, so Compare can tell when data changed.

Every hook is wrapped so a failure inside it can never break the training script. Set
CONVERGE_NO_AUTOHOOK=1 to turn all of it off.
"""

import importlib.abc
import os
import sys
import threading
import time

from . import _emit, _inputs, _jsonable

REPORT_EVERY_SEC = float(os.environ.get("CONVERGE_PERF_REPORT_SEC") or 30)
_installed = False


class _HookedLoader(importlib.abc.Loader):
    """Runs the module's real loader, then the hook. Other attributes go to the real loader."""

    def __init__(self, loader, hook):
        self._loader = loader
        self._hook = hook

    def create_module(self, spec):
        return self._loader.create_module(spec)

    def exec_module(self, module):
        self._loader.exec_module(module)
        try:
            self._hook(module)
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._loader, name)


class _PostImportFinder(importlib.abc.MetaPathFinder):
    def __init__(self, hooks):
        self.hooks = hooks

    def find_spec(self, fullname, path, target=None):
        hook = self.hooks.get(fullname)
        if hook is None:
            return None
        for finder in sys.meta_path:
            if finder is self or not hasattr(finder, "find_spec"):
                continue
            spec = finder.find_spec(fullname, path, target)
            if spec is not None:
                break
        else:
            return None
        if spec.loader is None or not hasattr(spec.loader, "exec_module"):
            return spec
        del self.hooks[fullname]
        spec.loader = _HookedLoader(spec.loader, hook)
        return spec


# ---------------------------------------------------------------- data loader timing


class _DataTimer:
    def __init__(self):
        self.lock = threading.Lock()
        self.window_start = None
        self.wait = 0.0
        self.batches = 0

    def add(self, sec, it):
        t = time.monotonic()
        with self.lock:
            if self.window_start is None:
                self.window_start = t - sec
            self.wait += sec
            self.batches += 1
            wall = t - self.window_start
            if wall < REPORT_EVERY_SEC:
                return
            wait, batches = self.wait, self.batches
            self.window_start, self.wait, self.batches = t, 0.0, 0
        sampler = getattr(it, "_index_sampler", None)
        _emit(
            {
                "type": "perf",
                "wallSec": round(wall, 3),
                "dataWaitSec": round(wait, 3),
                "batches": batches,
                "numWorkers": getattr(it, "_num_workers", None),
                "pinMemory": getattr(it, "_pin_memory", None),
                "persistentWorkers": getattr(it, "_persistent_workers", None),
                "batchSize": getattr(sampler, "batch_size", None),
            }
        )


_timer = _DataTimer()


def _hook_dataloader(module):
    it_cls = getattr(module, "_BaseDataLoaderIter", None)
    if it_cls is None or getattr(it_cls, "_converge_timed", False):
        return
    original = it_cls.__next__

    def __next__(self):
        t0 = time.perf_counter()
        try:
            return original(self)
        finally:
            try:
                _timer.add(time.perf_counter() - t0, self)
            except Exception:
                pass

    it_cls.__next__ = __next__
    it_cls._converge_timed = True


# ---------------------------------------------------------------- datasets and weights

_recording = threading.local()


def _record(rec):
    rec = {k: v for k, v in rec.items() if v is not None}
    rec.update(type="input", source="auto")
    _emit(_jsonable(rec))


def _hook_datasets(module):
    original = getattr(module, "load_dataset", None)
    if original is None or getattr(original, "_converge_wrapped", False):
        return

    def load_dataset(*args, **kwargs):
        result = original(*args, **kwargs)
        if getattr(_recording, "busy", False):
            return result
        _recording.busy = True
        try:
            path = args[0] if args else kwargs.get("path")
            config = args[1] if len(args) > 1 else kwargs.get("name")
            name = "%s/%s" % (path, config) if config else str(path)
            rec = _inputs.describe(result, name=name)
            rec["revision"] = kwargs.get("revision")
            if kwargs.get("split"):
                rec["name"] = "%s[%s]" % (name, kwargs["split"])
            _record(rec)
        except Exception:
            pass
        finally:
            _recording.busy = False
        return result

    load_dataset._converge_wrapped = True
    module.load_dataset = load_dataset


def _hook_transformers(module):
    base = getattr(module, "PreTrainedModel", None)
    method = base.__dict__.get("from_pretrained") if base is not None else None
    if not isinstance(method, classmethod) or getattr(method.__func__, "_converge_wrapped", False):
        return
    original = method.__func__

    def from_pretrained(cls, *args, **kwargs):
        outer = not getattr(_recording, "busy", False)
        _recording.busy = True
        try:
            model = original(cls, *args, **kwargs)
        finally:
            if outer:
                _recording.busy = False
        if outer:
            try:
                source = args[0] if args else kwargs.get("pretrained_model_name_or_path")
                config = getattr(model, "config", None)
                rec = {"kind": "weights", "name": str(source), "revision": getattr(config, "_commit_hash", None) or kwargs.get("revision")}
                if isinstance(source, (str, os.PathLike)) and os.path.isdir(str(source)):
                    rec = _inputs.describe(source, name=str(source), kind="weights")
                    rec["revision"] = getattr(config, "_commit_hash", None)
                _record(rec)
            except Exception:
                pass
        return model

    from_pretrained._converge_wrapped = True
    base.from_pretrained = classmethod(from_pretrained)


HOOKS = {
    "torch.utils.data.dataloader": _hook_dataloader,
    "datasets.load": _hook_datasets,
    "transformers.modeling_utils": _hook_transformers,
}


def install():
    global _installed
    if _installed:
        return
    _installed = True
    pending = {}
    for name, hook in HOOKS.items():
        mod = sys.modules.get(name)
        if mod is not None:
            try:
                hook(mod)
            except Exception:
                pass
        else:
            pending[name] = hook
    if pending:
        sys.meta_path.insert(0, _PostImportFinder(pending))
