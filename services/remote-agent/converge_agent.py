#!/usr/bin/env python3
"""Converlt remote agent.

Runs on the GPU machine. It is copied there over SSH by the desktop app and
invoked once per operation; it needs only the Python standard library (3.8+).

    probe [--workdir DIR]          machine readiness report (JSON)
    start                          launch a run; manifest JSON on stdin
    status RUN_ID                  current state (JSON)
    list                           all runs on this machine (JSON)
    tail RUN_ID [--from-seq N] [--follow]
                                   stream events as JSON lines, replaying after N
    cancel RUN_ID                  request cancellation (JSON)
    telemetry                      one GPU/host sample (JSON)
    supervise RUN_ID               internal: owns one training process

Each run is owned by a detached supervisor process (its own session), so closing
the app or dropping SSH never stops training. The supervisor is the only writer
of runs/<id>/events.jsonl; every event carries a sequence number so clients can
reconnect and replay from the last one they saw.
"""

import argparse
import collections
import json
import math
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

AGENT_VERSION = "0.1.0"
PROTOCOL_VERSION = 1

CONVERGE_HOME = os.environ.get("CONVERGE_HOME") or os.path.join(os.path.expanduser("~"), ".converge")
RUNS_DIR = os.path.join(CONVERGE_HOME, "runs")
TERMINAL = ("completed", "failed", "cancelled")
RUN_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

MAX_LINE_CHARS = 4000
CR_THROTTLE_SEC = 1.0
HEARTBEAT_SEC = 5.0
# Startup (worker spawn, first-batch caching) looks like a slow loader; judge throughput after this.
DIAG_WARMUP_SEC = float(os.environ.get("CONVERGE_DIAG_WARMUP_SEC") or 180)

OOM_RE = re.compile(
    r"CUDA out of memory|OutOfMemoryError|CUBLAS_STATUS_ALLOC_FAILED|CUDNN_STATUS_(?:ALLOC_FAILED|NOT_SUPPORTED.*memory)|"
    r"cuda runtime error \(2\)|HIP out of memory",
    re.IGNORECASE,
)
LOG_NAN_RE = re.compile(r"\b([\w/.-]*loss[\w/.-]*)\s*[:=]\s*(nan|[-+]?inf(?:inity)?)\b", re.IGNORECASE)

ENV_SNIPPET = r"""
import importlib.util, json, sys
out = {"python": sys.version.split()[0], "pythonPath": sys.executable}
try:
    import torch
    out["torch"] = torch.__version__
    out["torchCuda"] = torch.version.cuda
    out["cudaAvailable"] = bool(torch.cuda.is_available())
    if out["cudaAvailable"]:
        out["torchArchList"] = list(torch.cuda.get_arch_list())
        out["gpuCapability"] = "%d.%d" % torch.cuda.get_device_capability(0)
except Exception as e:
    out.setdefault("torch", None)
    out["torchError"] = "%s: %s" % (type(e).__name__, e)
out["companions"] = [m for m in ("torchvision", "torchaudio") if importlib.util.find_spec(m)]
print(json.dumps(out))
"""


# ---------------------------------------------------------------- utilities


def now():
    return round(time.time(), 3)


def emit_json(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":"), default=str) + "\n")
    sys.stdout.flush()


def fail(message, code="error", exit_code=2):
    emit_json({"ok": False, "error": code, "message": message})
    sys.exit(exit_code)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, data):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), default=str)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def expand_path(p):
    return os.path.abspath(os.path.expanduser(os.path.expandvars(p)))


def run_dir_for(run_id):
    if not RUN_ID_RE.match(run_id or ""):
        fail("invalid run id: %r" % run_id, "invalid_run_id")
    return os.path.join(RUNS_DIR, run_id)


def safe_number(v):
    """JSON-safe metric value: non-finite floats become strings."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        f = float(v)
        if math.isnan(f):
            return "NaN"
        if math.isinf(f):
            return "Infinity" if f > 0 else "-Infinity"
        return v
    if isinstance(v, str) and v in ("NaN", "Infinity", "-Infinity"):
        return v
    try:
        return safe_number(float(v))
    except (TypeError, ValueError):
        return None


def is_non_finite(v):
    return v in ("NaN", "Infinity", "-Infinity")


def run_cmd(args, timeout=15, shell_login=False):
    """Runs a command, returning (returncode, stdout) or (None, '') if unavailable."""
    try:
        if shell_login:
            args = ["bash", "-lc", args]
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return None, ""


def shell_quote(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


# ---------------------------------------------------------------- hardware


def _num(s, cast=float):
    s = (s or "").strip()
    if not s or s.startswith("[") or s.lower() in ("n/a", "not supported"):
        return None
    try:
        return cast(float(s))
    except ValueError:
        return None


def query_gpus():
    if not shutil.which("nvidia-smi"):
        return []
    rc, out = run_cmd(
        [
            "nvidia-smi",
            "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,driver_version",
            "--format=csv,noheader,nounits",
        ],
        timeout=10,
    )
    if rc != 0:
        return []
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 8:
            continue
        gpus.append(
            {
                "index": _num(parts[0], int),
                "name": parts[1],
                "memUsedMiB": _num(parts[2], int) or 0,
                "memTotalMiB": _num(parts[3], int) or 0,
                "utilPct": _num(parts[4]),
                "tempC": _num(parts[5]),
                "powerW": _num(parts[6]),
                "driver": parts[7] or None,
            }
        )
    return gpus


def cuda_driver_version():
    if not shutil.which("nvidia-smi"):
        return None
    rc, out = run_cmd(["nvidia-smi"], timeout=10)
    # Drivers from the 600 series print "CUDA UMD Version: 13.3" instead of "CUDA Version: 12.4".
    m = re.search(r"CUDA (?:UMD )?Version:\s*([\d.]+)", out or "")
    return m.group(1) if m else None


def gpu_capability():
    """Compute capability of GPU 0 from the driver (drivers 510+), e.g. "8.9"."""
    if not shutil.which("nvidia-smi"):
        return None
    rc, out = run_cmd(["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"], timeout=10)
    first = (out or "").strip().splitlines()[:1]
    return first[0].strip() if rc == 0 and first and re.match(r"^\d+\.\d+$", first[0].strip()) else None


# ---------------------------------------------------------------- phone alerts

NTFY_URL_RE = re.compile(r"^(https?://[^/?#]+(?:/[^/?#]+)*)/([A-Za-z0-9_-]{1,64})/?$")


def ntfy_publish(url, title, message, priority=3, tags=None):
    """Posts to an ntfy topic URL (https://ntfy.sh/<topic>, or a self-hosted server). True on success."""
    import urllib.request

    m = NTFY_URL_RE.match(url or "")
    if not m:
        return False
    body = {"topic": m.group(2), "title": title[:250], "message": message[:3500], "priority": priority, "tags": tags or []}
    req = urllib.request.Request(
        m.group(1) + "/",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": "converlt-agent/%s" % AGENT_VERSION},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


def fmt_duration(sec):
    sec = int(max(0, sec))
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm" % (sec // 60)
    return "%dh %dm" % (sec // 3600, (sec % 3600) // 60)


def host_sample(path):
    load1 = None
    try:
        load1 = round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        pass
    mem_total = mem_used = None
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, v = line.partition(":")
                info[k] = int(v.strip().split()[0])
        mem_total = info["MemTotal"] // 1024
        mem_used = (info["MemTotal"] - info.get("MemAvailable", info.get("MemFree", 0))) // 1024
    except (OSError, KeyError, ValueError, IndexError):
        pass
    disk_free = None
    try:
        probe = path
        while probe and not os.path.exists(probe):
            probe = os.path.dirname(probe)
        disk_free = round(shutil.disk_usage(probe or "/").free / 2 ** 30, 1)
    except OSError:
        pass
    return {"load1": load1, "cpuCount": os.cpu_count(), "memUsedMiB": mem_used, "memTotalMiB": mem_total, "diskFreeGiB": disk_free}


def gpu_samples(gpus):
    return [{k: g[k] for k in ("index", "name", "memUsedMiB", "memTotalMiB", "utilPct", "tempC", "powerW")} for g in gpus]


def python_env(python):
    rc, out = run_cmd("%s -c %s" % (python, shell_quote(ENV_SNIPPET)), timeout=60, shell_login=True)
    if rc != 0:
        return {"python": None, "torch": None, "torchError": "could not run %s" % python}
    try:
        return json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"python": None, "torch": None}


# ---------------------------------------------------------------- run state


def proc_alive(pid, marker=None):
    if not pid:
        return False
    cmdline_path = "/proc/%d/cmdline" % pid
    if os.path.exists("/proc"):
        try:
            with open(cmdline_path, "rb") as f:
                cmdline = f.read().decode("utf-8", "replace")
        except OSError:
            return False
        return marker is None or marker in cmdline
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def load_state(run_dir):
    return read_json(os.path.join(run_dir, "status.json"), {}) or {}


def effective_state(run_id, run_dir):
    state = load_state(run_dir)
    status = state.get("status", "unknown")
    alive = proc_alive(state.get("supervisorPid"), "supervise")
    if status not in TERMINAL and not alive:
        # Give a freshly started supervisor a moment to come up before calling it lost.
        created = state.get("createdAt") or 0
        status = "created" if time.time() - created < 10 and status == "created" else "unknown"
    return dict(state, runId=run_id, effectiveStatus=status, supervisorAlive=alive)


def last_seq_in_file(path):
    seq = 0
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 65536))
            for line in f.read().splitlines():
                try:
                    seq = max(seq, int(json.loads(line.decode("utf-8")).get("seq", 0)))
                except (ValueError, AttributeError):
                    pass
    except OSError:
        pass
    return seq


class EventLog:
    """Single-writer, append-only JSONL log with monotonic sequence numbers."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.seq = last_seq_in_file(path)
        self.f = open(path, "a", encoding="utf-8")

    def emit(self, type_, **fields):
        with self.lock:
            self.seq += 1
            ev = {"seq": self.seq, "ts": now(), "type": type_}
            ev.update(fields)
            self.f.write(json.dumps(ev, separators=(",", ":"), default=str) + "\n")
            self.f.flush()
            return self.seq


# ---------------------------------------------------------------- supervisor


class Supervisor:
    def __init__(self, run_id):
        self.run_id = run_id
        self.run_dir = run_dir_for(run_id)
        self.manifest = read_json(os.path.join(self.run_dir, "manifest.json"))
        if not self.manifest:
            raise SystemExit("manifest missing")
        self.options = self.manifest.get("options") or {}
        self.events = EventLog(os.path.join(self.run_dir, "events.jsonl"))
        self.state = load_state(self.run_dir)
        self.state.update({"supervisorPid": os.getpid(), "agentVersion": AGENT_VERSION})
        self.state_lock = threading.Lock()
        self.proc = None
        self.stop = threading.Event()
        self.cancel_reason = None
        self.last_activity = time.time()
        self.last_finite = {}
        self.reported = set()
        self.nan_source = None
        self.stderr_tail = collections.deque(maxlen=40)
        self.latest_gpus = []
        self.util_window = collections.deque()
        self.started_at = None
        self.last_step = None
        self.first_error = None
        self.nan_detail = None
        self.data_windows = collections.deque(maxlen=6)
        self.data_wait_pct = None
        self.notified = set()

    # -- phone alerts

    def name(self):
        return str(self.manifest.get("name") or self.run_id)

    def notify(self, key, title, message, priority=3, tags=None, wait=False):
        """Sends one phone alert per key, if the run has a notify URL. Never raises."""
        url = self.options.get("notifyUrl")
        if not url or key in self.notified:
            return
        self.notified.add(key)
        t = threading.Thread(target=ntfy_publish, args=(url, title, message, priority, tags), daemon=True)
        t.start()
        if wait:
            t.join(timeout=12)

    def at_step(self):
        return " at step {:,}".format(self.last_step) if self.last_step is not None else ""

    # -- state

    def set_status(self, status, **extra):
        with self.state_lock:
            fields = {k: v for k, v in extra.items() if k in ("exitCode", "reason", "pid")}
            seq = self.events.emit("status", status=status, **fields)
            self.state.update(extra)
            self.state["status"] = status
            self.state["lastSeq"] = seq
            self.state["updatedAt"] = now()
            write_json_atomic(os.path.join(self.run_dir, "status.json"), self.state)

    def diagnostic(self, kind, severity, message, step=None, data=None, once=True):
        if severity == "error" and self.first_error is None and kind in ("oom", "exception", "nan"):
            self.first_error = (kind, message)
        if once and kind in self.reported:
            if data:
                # Merge further evidence into the same card on the client.
                self.events.emit("diagnostic", kind=kind, severity=severity, message=message, step=step, data=data)
            return
        self.reported.add(kind)
        self.events.emit("diagnostic", kind=kind, severity=severity, message=message, step=step, data=data or {})

    # -- main

    def run(self):
        m = self.manifest
        self.set_status("preparing")
        workdir = expand_path(m.get("workdir") or "~")
        try:
            os.makedirs(workdir, exist_ok=True)
        except OSError as e:
            self.diagnostic("launch", "error", "Cannot create working directory %s: %s" % (workdir, e))
            self.set_status("failed", exitCode=None, reason="launch_error", endedAt=now())
            return

        sdk_dir = os.environ.get("CONVERGE_SDK_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sdk")
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in (m.get("env") or {}).items()})
        env.update(
            {
                "CONVERGE_RUN_ID": self.run_id,
                "CONVERGE_PROJECT": str(m.get("project", "")),
                "CONVERGE_RUN_DIR": self.run_dir,
                "CONVERGE_SDK_FILE": os.path.join(self.run_dir, "sdk.jsonl"),
                "PYTHONUNBUFFERED": "1",
                "PYTHONPATH": sdk_dir + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""),
            }
        )

        env_thread = threading.Thread(target=self.capture_env, args=(env, workdir), daemon=True)
        env_thread.start()

        try:
            self.proc = subprocess.Popen(
                ["bash", "-lc", m["command"]],
                cwd=workdir,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as e:
            self.diagnostic("launch", "error", "Failed to start command: %s" % e)
            self.set_status("failed", exitCode=None, reason="launch_error", endedAt=now())
            return

        self.started_at = time.time()
        self.set_status("running", pid=self.proc.pid, pgid=self.proc.pid, startedAt=now())
        readers = [
            threading.Thread(target=self.read_stream, args=(self.proc.stdout, "stdout"), daemon=True),
            threading.Thread(target=self.read_stream, args=(self.proc.stderr, "stderr"), daemon=True),
        ]
        for t in readers:
            t.start()
        sdk_thread = threading.Thread(target=self.tail_sdk, daemon=True)
        sdk_thread.start()
        threading.Thread(target=self.telemetry_loop, daemon=True).start()
        threading.Thread(target=self.watchdog_loop, daemon=True).start()

        rc = self.proc.wait()
        for t in readers:
            t.join(timeout=10)
        self.stop.set()
        sdk_thread.join(timeout=5)
        # Short runs can end before pip freeze does; record the environment before the final status.
        env_thread.join(timeout=30)
        self.finish(rc)

    def finish(self, rc):
        ended = now()
        took = " after %s" % fmt_duration(time.time() - self.started_at) if self.started_at else ""
        if self.cancel_reason == "user":
            self.set_status("cancelled", exitCode=rc, reason="user", endedAt=ended)
            return
        if self.cancel_reason == "nan":
            self.set_status("failed", exitCode=rc, reason="stopped_on_nan", endedAt=ended)
            msg = self.first_error[1] if self.first_error else "A metric became non-finite."
            self.notify("end", "%s stopped: NaN loss" % self.name(), "Stopped%s%s. %s" % (self.at_step(), took, msg), priority=4, tags=["warning"], wait=True)
            return
        if rc == 0:
            self.set_status("completed", exitCode=0, endedAt=ended)
            # Report the validation loss if there is one, else a loss, else any metric.
            keys = sorted(self.last_finite, key=lambda k: (not re.search(r"val.*loss", k, re.I), not re.search(r"loss", k, re.I), k))
            metric = ""
            if keys:
                step, v = self.last_finite[keys[0]]
                metric = " %s %.4g%s." % (keys[0], v, " at step {:,}".format(step) if step is not None else "")
            self.notify("end", "%s finished" % self.name(), "Training completed%s.%s" % (took, metric), priority=3, tags=["white_check_mark"], wait=True)
            return
        if rc < 0:
            sig = -rc
            try:
                name = signal.Signals(sig).name
            except ValueError:
                name = "signal %d" % sig
            msg = "Process was killed by %s." % name
            if sig == signal.SIGKILL:
                msg += " This is often the host out-of-memory killer; check RAM usage."
        elif rc == 137:
            msg = "Process exited with code 137 (SIGKILL). This is often the host out-of-memory killer."
        else:
            msg = "Process exited with code %d." % rc
        if "oom" in self.reported:
            msg = "Training stopped after a CUDA out-of-memory error (exit code %s)." % rc
        self.diagnostic("exit", "error", msg, data={"exitCode": rc, "stderrTail": list(self.stderr_tail)})
        self.set_status("failed", exitCode=rc, reason="exit_code", endedAt=ended)
        if self.first_error and self.first_error[0] == "oom":
            why = "CUDA out of memory."
        elif self.first_error:
            why = self.first_error[1]
        else:
            why = msg
        self.notify("end", "%s failed" % self.name(), "Failed%s%s: %s" % (self.at_step(), took, why), priority=4, tags=["rotating_light"], wait=True)

    # -- process output

    def read_stream(self, pipe, stream):
        fd = pipe.fileno()
        buf = b""
        last_cr_emit = 0.0
        pending_cr = None
        prev_sep = b"\n"
        sep_re = re.compile(rb"[\r\n]")
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while True:
                m = sep_re.search(buf)
                if not m:
                    break
                i = m.start()
                sep, line, buf = buf[i:i + 1], buf[:i], buf[i + 1:]
                if sep == b"\r":
                    # Progress bars redraw with \r: keep at most one update per second.
                    if buf.startswith(b"\n"):
                        buf = buf[1:]
                        self.on_line(stream, line)
                        pending_cr, prev_sep = None, b"\n"
                        continue
                    if line:
                        pending_cr = line
                        if time.time() - last_cr_emit >= CR_THROTTLE_SEC:
                            self.on_line(stream, line)
                            last_cr_emit = time.time()
                            pending_cr = None
                    prev_sep = b"\r"
                else:
                    if line or prev_sep != b"\r":
                        self.on_line(stream, line)
                    pending_cr, prev_sep = None, b"\n"
            if len(buf) > MAX_LINE_CHARS * 4:
                self.on_line(stream, buf)
                buf = b""
        if pending_cr is not None and not buf:
            self.on_line(stream, pending_cr)
        if buf:
            self.on_line(stream, buf)

    def on_line(self, stream, raw):
        text = raw.decode("utf-8", "replace")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " …[truncated]"
        self.last_activity = time.time()
        self.events.emit("log", stream=stream, line=text)
        if stream == "stderr":
            self.stderr_tail.append(text)
        if OOM_RE.search(text):
            data = {"line": text.strip()[:1000], "source": "log"}
            if self.latest_gpus:
                data["gpus"] = gpu_samples(self.latest_gpus)
            self.diagnostic("oom", "error", "CUDA out of memory.", data=data)
        m = LOG_NAN_RE.search(text)
        if m and self.nan_source is None:
            self.on_nan(m.group(1), None, source="log", line=text.strip()[:500])

    # -- SDK channel

    def tail_sdk(self):
        path = os.path.join(self.run_dir, "sdk.jsonl")
        f = None
        buf = ""
        while True:
            stopping = self.stop.is_set()
            if f is None and os.path.exists(path):
                f = open(path, "r", encoding="utf-8")
            if f is not None:
                while True:
                    chunk = f.readline()
                    if not chunk:
                        break
                    buf += chunk
                    if not buf.endswith("\n"):
                        break
                    line, buf = buf, ""
                    try:
                        self.on_sdk_record(json.loads(line))
                    except ValueError:
                        pass
            if stopping:
                return
            time.sleep(0.2)

    def on_sdk_record(self, rec):
        kind = rec.get("type")
        if kind == "metric":
            values = {}
            for k, v in (rec.get("values") or {}).items():
                sv = safe_number(v)
                if sv is not None:
                    values[str(k)] = sv
            if not values:
                return
            step = rec.get("step")
            step = int(step) if isinstance(step, (int, float)) and not isinstance(step, bool) else None
            self.last_activity = time.time()
            if step is not None and (self.last_step is None or step > self.last_step):
                self.last_step = step
            self.events.emit("metric", step=step, values=values)
            for k, v in values.items():
                if is_non_finite(v):
                    self.on_nan(k, step, source="sdk", value=v)
                else:
                    self.last_finite[k] = (step, v)
        elif kind == "config":
            self.events.emit("config", values=rec.get("values") or {})
        elif kind == "artifact":
            self.events.emit(
                "artifact",
                path=str(rec.get("path", "")),
                sizeBytes=rec.get("sizeBytes"),
                sha256=rec.get("sha256"),
                step=rec.get("step"),
            )
        elif kind == "oom":
            self.diagnostic("oom", "error", "CUDA out of memory.", data=dict(rec.get("data") or {}, source="sdk"))
        elif kind == "exception":
            self.diagnostic(
                "exception",
                "error",
                "%s: %s" % (rec.get("excType", "Exception"), str(rec.get("message", ""))[:500]),
                data={"traceback": rec.get("traceback", "")[-6000:]},
            )
        elif kind == "nan_detail":
            # Where the non-finite values are (weights, gradients, or neither); the SDK writes it
            # just before the metric, but a log-detected NaN may already have opened the card.
            self.nan_detail = dict(rec.get("data") or {})
            if "nan" in self.reported:
                self.events.emit("diagnostic", kind="nan", severity="error", message="Non-finite value detected.", step=None, data=self.nan_detail)
        elif kind == "perf":
            self.on_data_window(rec)
        elif kind == "input":
            fields = {k: rec.get(k) for k in ("kind", "name", "path", "revision", "fingerprint", "method", "files", "bytes", "source")}
            if fields["kind"] in ("dataset", "weights") and fields["name"]:
                self.events.emit("input", **{k: v for k, v in fields.items() if v is not None})

    def on_data_window(self, rec):
        """Data-loader timing from the SDK: how much of each window the training loop waited for batches."""
        wall = rec.get("wallSec")
        wait = rec.get("dataWaitSec")
        if not isinstance(wall, (int, float)) or not isinstance(wait, (int, float)) or wall <= 0:
            return
        self.data_windows.append((min(wait, wall), wall, rec))
        total_wall = sum(w for _, w, _ in self.data_windows)
        if total_wall < min(60, DIAG_WARMUP_SEC):
            return
        pct = 100.0 * sum(x for x, _, _ in self.data_windows) / total_wall
        self.data_wait_pct = round(pct, 1)
        if pct < 40 or "dataloader" in self.reported or not self.started_at or time.time() - self.started_at < DIAG_WARMUP_SEC:
            return
        workers = rec.get("numWorkers")
        cpus = os.cpu_count() or 1
        per_gpu = max(1, cpus // max(1, len(self.latest_gpus) or 1))
        suggest = max(2, min(8, per_gpu - 1))
        data = {
            "dataWaitPct": self.data_wait_pct,
            "numWorkers": workers,
            "suggestedWorkers": suggest,
            "pinMemory": rec.get("pinMemory"),
            "persistentWorkers": rec.get("persistentWorkers"),
            "batchSize": rec.get("batchSize"),
            "cpuCount": cpus,
        }
        utils = [u for _, u in self.util_window]
        if utils:
            data["avgUtilPct"] = round(sum(utils) / len(utils), 1)
        workers_txt = " with num_workers=%s" % workers if workers is not None else ""
        self.diagnostic(
            "dataloader",
            "warning",
            "%d%% of training time is spent waiting for the next batch%s. The GPU sits idle while the data loader prepares data." % (round(pct), workers_txt),
            data=data,
        )

    def on_nan(self, key, step, source, value="NaN", line=None):
        # A log-pattern hit often arrives before the SDK metric for the same step;
        # the SDK record is more precise, so it may still enrich the diagnostic once.
        if self.nan_source == "sdk" or (self.nan_source == "log" and source == "log"):
            return
        first = self.nan_source is None
        self.nan_source = source
        self.reported.add("nan")
        last = self.last_finite.get(key)
        data = {"metric": key, "value": value, "source": source}
        if last:
            data["lastFiniteStep"], data["lastFiniteValue"] = last
        if line:
            data["line"] = line
        if self.nan_detail:
            data.update(self.nan_detail)
        stop = bool(self.options.get("stopOnNan"))
        data["stoppedRun"] = stop
        message = "Non-finite value detected in %s." % key
        if first and self.first_error is None:
            self.first_error = ("nan", message)
        self.events.emit("diagnostic", kind="nan", severity="error", message=message, step=step, data=data)
        if stop and first:
            self.begin_cancel("nan")
        elif first:
            where = " at step {:,}".format(step) if step is not None else self.at_step()
            self.notify("nan", "%s: NaN loss" % self.name(), "%s is %s%s. The run is still going; it won't recover on its own." % (key, value, where), priority=4, tags=["warning"])

    # -- telemetry and watchdog

    def telemetry_loop(self):
        interval = max(2.0, float(self.options.get("telemetryIntervalSec") or 10))
        workdir = expand_path(self.manifest.get("workdir") or "~")
        started = time.time()
        first = True
        while True:
            if not first and self.stop.wait(interval):
                return
            first = False
            gpus = query_gpus()
            self.latest_gpus = gpus
            self.events.emit("telemetry", gpus=gpu_samples(gpus), host=host_sample(workdir))
            if not gpus:
                continue
            ts = time.time()
            utils = [g["utilPct"] for g in gpus if g["utilPct"] is not None]
            if utils:
                self.util_window.append((ts, sum(utils) / len(utils)))
            while self.util_window and ts - self.util_window[0][0] > 300:
                self.util_window.popleft()
            if ts - started > 300 and len(self.util_window) >= 5:
                avg = sum(u for _, u in self.util_window) / len(self.util_window)
                if avg < 20 and "perf" not in self.reported:
                    data = {"avgUtilPct": round(avg, 1)}
                    if self.data_wait_pct is not None:
                        data["dataWaitPct"] = self.data_wait_pct
                    self.diagnostic(
                        "perf",
                        "warning",
                        "GPU utilization averaged %.0f%% over the last 5 minutes. The input pipeline or CPU work may be the bottleneck." % avg,
                        data=data,
                    )
            for g in gpus:
                if g["memTotalMiB"] and g["memUsedMiB"] / g["memTotalMiB"] > 0.97 and "vram" not in self.reported:
                    self.reported.add("vram")
                    self.events.emit(
                        "diagnostic",
                        kind="perf",
                        severity="warning",
                        message="GPU %s memory is above 97%% (%d / %d MiB)." % (g["index"], g["memUsedMiB"], g["memTotalMiB"]),
                        step=None,
                        data={"vramPct": round(100.0 * g["memUsedMiB"] / g["memTotalMiB"], 1)},
                    )

    def watchdog_loop(self):
        cancel_path = os.path.join(self.run_dir, "cancel")
        stall_sec = float(self.options.get("stallMinutes") or 0) * 60
        while not self.stop.wait(1.0):
            if self.cancel_reason is None and os.path.exists(cancel_path):
                self.begin_cancel("user")
            if stall_sec and "stall" not in self.reported and time.time() - self.last_activity > stall_sec:
                message = "No output or metrics for %d minutes. Training may be stalled." % (stall_sec // 60)
                self.diagnostic("stall", "warning", message, data={"silentForSec": int(time.time() - self.last_activity)})
                self.notify("stall", "%s may be stalled" % self.name(), message, priority=4, tags=["hourglass"])

    def begin_cancel(self, reason):
        if self.cancel_reason is not None or self.proc is None:
            return
        self.cancel_reason = reason
        self.set_status("cancelling", reason=reason)
        self.signal_group(signal.SIGTERM)
        grace = float(self.options.get("cancelGraceSec") or 20)

        def escalate():
            deadline = time.time() + grace
            while time.time() < deadline:
                if self.proc.poll() is not None:
                    return
                time.sleep(0.2)
            self.signal_group(signal.SIGKILL)

        threading.Thread(target=escalate, daemon=True).start()

    def signal_group(self, sig):
        try:
            os.killpg(self.proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def capture_env(self, env, workdir):
        python = self.manifest.get("python") or "python3"
        info = {"hostname": socket.gethostname()}
        try:
            p = subprocess.run(
                ["bash", "-lc", "%s -c %s" % (python, shell_quote(ENV_SNIPPET))],
                cwd=workdir, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
            )
            info.update(json.loads(p.stdout.decode("utf-8", "replace").strip().splitlines()[-1]))
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            pass
        info.pop("torchError", None)
        info.pop("companions", None)
        if not info.get("gpuCapability"):
            info["gpuCapability"] = gpu_capability()
        try:
            p = subprocess.run(
                ["bash", "-lc", "%s -m pip freeze --disable-pip-version-check" % python],
                cwd=workdir, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
            )
            info["packages"] = [l for l in p.stdout.decode("utf-8", "replace").splitlines() if l.strip()][:1000]
        except (OSError, subprocess.SubprocessError):
            pass
        gpus = query_gpus()
        info["gpus"] = [{"index": g["index"], "name": g["name"], "memTotalMiB": g["memTotalMiB"]} for g in gpus]
        info["driver"] = gpus[0]["driver"] if gpus else None
        info["cudaVersion"] = cuda_driver_version()
        self.events.emit("env", **info)


# ---------------------------------------------------------------- commands


def cmd_probe(args):
    workdir = expand_path(args.workdir or "~/converge")
    gpus = query_gpus()
    py = python_env(args.python) if args.python else {"python": sys.version.split()[0], "torch": None}
    host = host_sample(workdir)
    writable = False
    try:
        os.makedirs(workdir, exist_ok=True)
        test = os.path.join(workdir, ".converge-write-test")
        with open(test, "w") as f:
            f.write("ok")
        os.remove(test)
        writable = True
    except OSError:
        pass
    checks = [
        {"name": "Python 3.8+ for agent", "ok": sys.version_info >= (3, 8), "detail": sys.version.split()[0]},
        {"name": "NVIDIA driver", "ok": bool(gpus), "detail": ("driver %s" % gpus[0]["driver"]) if gpus else "nvidia-smi not found or no GPUs"},
        {"name": "Training Python", "ok": bool(py.get("python")), "detail": py.get("pythonPath") or py.get("torchError") or "not found"},
        {"name": "PyTorch", "ok": bool(py.get("torch")), "detail": py.get("torch") or py.get("torchError") or "not installed"},
        {"name": "CUDA in PyTorch", "ok": bool(py.get("cudaAvailable")), "detail": ("CUDA %s" % py.get("torchCuda")) if py.get("cudaAvailable") else "unavailable"},
        {"name": "Disk space", "ok": (host["diskFreeGiB"] or 0) >= 10, "detail": "%s GiB free" % host["diskFreeGiB"]},
        {"name": "Working directory", "ok": writable, "detail": workdir},
    ]
    emit_json(
        {
            "ok": True,
            "agentVersion": AGENT_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "hostname": socket.gethostname(),
            "platform": sys.platform,
            "os": " ".join(os.uname()) if hasattr(os, "uname") else sys.platform,
            "gpus": gpu_samples(gpus),
            "driver": gpus[0]["driver"] if gpus else None,
            "cudaVersion": cuda_driver_version(),
            "gpuCapability": py.get("gpuCapability") or gpu_capability(),
            "python": py,
            "host": host,
            "workdir": workdir,
            "checks": checks,
            "ready": all(c["ok"] for c in checks if c["name"] not in ("Disk space",)),
        }
    )


def cmd_start(args):
    try:
        manifest = json.load(sys.stdin)
    except ValueError as e:
        fail("invalid manifest JSON: %s" % e, "invalid_manifest")
    run_id = manifest.get("runId")
    run_dir = run_dir_for(run_id)
    if not manifest.get("command"):
        fail("manifest has no command", "invalid_manifest")
    status_path = os.path.join(run_dir, "status.json")
    if os.path.exists(status_path):
        # Idempotent: a retried start must not launch training twice.
        emit_json(dict(effective_state(run_id, run_dir), ok=True, alreadyStarted=True))
        return
    os.makedirs(run_dir, exist_ok=True)
    write_json_atomic(os.path.join(run_dir, "manifest.json"), manifest)
    write_json_atomic(status_path, {"status": "created", "createdAt": now(), "lastSeq": 0})
    with open(os.path.join(run_dir, "supervisor.log"), "ab") as log:
        p = subprocess.Popen(
            [sys.executable, os.path.abspath(__file__), "supervise", run_id],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            cwd=run_dir,
            close_fds=True,
            start_new_session=True,
        )
    # The supervisor records its own pid in status.json; writing it here would race with it.
    emit_json({"ok": True, "runId": run_id, "supervisorPid": p.pid, "runDir": run_dir})


def cmd_supervise(args):
    sup = Supervisor(args.run_id)
    try:
        sup.run()
    except Exception as e:  # never leave a run silently "running"
        import traceback

        sup.diagnostic("launch", "error", "Converlt supervisor error: %s" % e, data={"traceback": traceback.format_exc()[-4000:]})
        if sup.proc is not None and sup.proc.poll() is None:
            sup.signal_group(signal.SIGTERM)
        sup.set_status("failed", reason="supervisor_error", endedAt=now())


def cmd_status(args):
    run_dir = run_dir_for(args.run_id)
    if not os.path.isdir(run_dir):
        fail("run not found", "run_not_found")
    emit_json(dict(effective_state(args.run_id, run_dir), ok=True))


def cmd_list(args):
    runs = []
    if os.path.isdir(RUNS_DIR):
        for run_id in sorted(os.listdir(RUNS_DIR)):
            run_dir = os.path.join(RUNS_DIR, run_id)
            if not RUN_ID_RE.match(run_id) or not os.path.isdir(run_dir):
                continue
            m = read_json(os.path.join(run_dir, "manifest.json"), {}) or {}
            st = effective_state(run_id, run_dir)
            runs.append({"runId": run_id, "project": m.get("project"), "command": m.get("command"), "status": st["effectiveStatus"], "lastSeq": st.get("lastSeq", 0)})
    emit_json({"ok": True, "runs": runs})


def cmd_tail(args):
    run_dir = run_dir_for(args.run_id)
    if not os.path.isdir(run_dir):
        emit_json({"type": "error", "error": "run_not_found", "message": "run %s not found on this machine" % args.run_id})
        sys.exit(2)
    path = os.path.join(run_dir, "events.jsonl")
    f = None
    buf = ""
    last_hb = 0.0
    out = sys.stdout
    try:
        while True:
            state = effective_state(args.run_id, run_dir)
            if f is None and os.path.exists(path):
                f = open(path, "r", encoding="utf-8")
            wrote = False
            if f is not None:
                while True:
                    chunk = f.readline()
                    if not chunk:
                        break
                    buf += chunk
                    if not buf.endswith("\n"):
                        break
                    line, buf = buf, ""
                    try:
                        seq = json.loads(line).get("seq", 0)
                    except ValueError:
                        continue
                    if seq > args.from_seq:
                        out.write(line)
                        wrote = True
            if wrote:
                out.flush()
            status = state["effectiveStatus"]
            if not args.follow:
                return
            if status in TERMINAL or status == "unknown":
                emit_json({"type": "end", "status": status})
                return
            if time.time() - last_hb >= HEARTBEAT_SEC:
                emit_json({"type": "heartbeat", "ts": now(), "status": status, "supervisorAlive": state["supervisorAlive"], "lastSeq": state.get("lastSeq", 0)})
                last_hb = time.time()
            time.sleep(0.25)
    except (BrokenPipeError, KeyboardInterrupt):
        try:
            sys.stdout = open(os.devnull, "w")
        except OSError:
            pass


def cmd_cancel(args):
    run_dir = run_dir_for(args.run_id)
    if not os.path.isdir(run_dir):
        fail("run not found", "run_not_found")
    state = effective_state(args.run_id, run_dir)
    if state.get("status") in TERMINAL:
        emit_json(dict(state, ok=True, alreadyFinished=True))
        return
    with open(os.path.join(run_dir, "cancel"), "w") as f:
        f.write("user")
    if not state["supervisorAlive"]:
        # Orphaned training process: stop it directly and record the outcome ourselves.
        pgid = state.get("pgid")
        if pgid:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        log = EventLog(os.path.join(run_dir, "events.jsonl"))
        seq = log.emit("status", status="cancelled", reason="user_orphaned")
        state.update({"status": "cancelled", "reason": "user_orphaned", "lastSeq": seq, "endedAt": now()})
        for k in ("effectiveStatus", "supervisorAlive", "runId"):
            state.pop(k, None)
        write_json_atomic(os.path.join(run_dir, "status.json"), state)
    emit_json({"ok": True, "runId": args.run_id, "requested": True})


def cmd_telemetry(args):
    emit_json({"ok": True, "ts": now(), "gpus": gpu_samples(query_gpus()), "host": host_sample(expand_path(args.workdir or "~"))})


def main(argv=None):
    parser = argparse.ArgumentParser(prog="converge_agent")
    parser.add_argument("--version", action="version", version=AGENT_VERSION)
    sub = parser.add_subparsers(dest="cmd")
    p = sub.add_parser("probe")
    p.add_argument("--workdir")
    p.add_argument("--python")
    sub.add_parser("start")
    for name in ("status", "cancel", "supervise"):
        sub.add_parser(name).add_argument("run_id")
    sub.add_parser("list")
    p = sub.add_parser("tail")
    p.add_argument("run_id")
    p.add_argument("--from-seq", type=int, default=0)
    p.add_argument("--follow", action="store_true")
    p = sub.add_parser("telemetry")
    p.add_argument("--workdir")
    args = parser.parse_args(argv)
    handlers = {
        "probe": cmd_probe,
        "start": cmd_start,
        "status": cmd_status,
        "cancel": cmd_cancel,
        "supervise": cmd_supervise,
        "list": cmd_list,
        "tail": cmd_tail,
        "telemetry": cmd_telemetry,
    }
    if args.cmd not in handlers:
        parser.print_help()
        return 2
    os.makedirs(RUNS_DIR, exist_ok=True)
    handlers[args.cmd](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
