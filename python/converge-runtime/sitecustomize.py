"""Converlt: zero-setup instrumentation for runs launched by the Converlt agent.

The agent puts this folder first on PYTHONPATH, so Python imports this file at startup. Outside
a Converlt run it does nothing. If the environment has its own sitecustomize, that one still runs.
"""

import os
import sys


def _converge_install():
    if not os.environ.get("CONVERGE_SDK_FILE") or os.environ.get("CONVERGE_NO_AUTOHOOK"):
        return
    try:
        from converge import _autohook

        _autohook.install()
    except Exception:
        pass


def _chain_next_sitecustomize():
    import importlib.machinery
    import importlib.util

    here = os.path.dirname(os.path.abspath(__file__))
    rest = [p for p in sys.path if os.path.abspath(p or os.curdir) != here]
    spec = importlib.machinery.PathFinder.find_spec("sitecustomize", rest)
    if spec is None or spec.loader is None or not spec.origin or os.path.abspath(spec.origin) == os.path.abspath(__file__):
        return
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


_converge_install()
try:
    _chain_next_sitecustomize()
except Exception:
    pass
