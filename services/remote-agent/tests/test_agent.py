"""Integration tests for the remote agent. POSIX only (run in WSL or Linux).

    python3 -m unittest discover -s services/remote-agent/tests -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
AGENT = os.path.join(ROOT, "services", "remote-agent", "converge_agent.py")
SDK_DIR = os.path.join(ROOT, "python", "converge-runtime")
SMOKE = os.path.join(ROOT, "examples", "smoke", "train.py")


@unittest.skipIf(os.name != "posix", "agent requires POSIX")
class AgentTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="converge-test-")
        self.workdir = os.path.join(self.home, "work")
        os.makedirs(self.workdir)
        shutil.copy(SMOKE, os.path.join(self.workdir, "train.py"))
        self.env = dict(os.environ, CONVERGE_HOME=self.home, CONVERGE_SDK_DIR=SDK_DIR)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def agent(self, *args, stdin=None):
        p = subprocess.run(
            [sys.executable, AGENT] + list(args),
            input=stdin.encode() if stdin else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
            timeout=60,
        )
        return p.returncode, p.stdout.decode()

    def start(self, command, **options):
        run_id = "t" + uuid.uuid4().hex[:10]
        opts = {"stopOnNan": False, "telemetryIntervalSec": 2, "stallMinutes": 0, "cancelGraceSec": 2}
        opts.update(options)
        manifest = {"runId": run_id, "project": "test", "command": command, "workdir": self.workdir, "python": sys.executable, "env": {}, "options": opts}
        rc, out = self.agent("start", stdin=json.dumps(manifest))
        self.assertEqual(rc, 0, out)
        self.assertTrue(json.loads(out)["ok"])
        return run_id

    def wait_status(self, run_id, statuses, timeout=45):
        deadline = time.time() + timeout
        while time.time() < deadline:
            _, out = self.agent("status", run_id)
            st = json.loads(out)
            if st["effectiveStatus"] in statuses:
                return st
            time.sleep(0.3)
        self.fail("timed out waiting for %s; last=%s" % (statuses, st))

    def events(self, run_id, from_seq=0):
        _, out = self.agent("tail", run_id, "--from-seq", str(from_seq))
        return [json.loads(l) for l in out.splitlines() if l.strip()]

    # ------------------------------------------------------------------

    def test_completed_run_records_metrics_config_and_logs(self):
        run_id = self.start("%s train.py --steps 30 --sleep 0.01 --lr 0.05" % sys.executable)
        st = self.wait_status(run_id, ("completed", "failed"))
        self.assertEqual(st["effectiveStatus"], "completed", self.events(run_id))
        evs = self.events(run_id)
        seqs = [e["seq"] for e in evs]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)), "seq must be contiguous")
        types = {e["type"] for e in evs}
        self.assertTrue({"status", "log", "metric", "config", "telemetry", "env"} <= types, types)
        env = [e for e in evs if e["type"] == "env"][0]
        self.assertTrue(env["python"])
        self.assertLess(env["seq"], evs[-1]["seq"], "env is recorded before the final status")
        metrics = [e for e in evs if e["type"] == "metric"]
        self.assertEqual(len(metrics), 30)
        self.assertIn("train/loss", metrics[0]["values"])
        config = [e for e in evs if e["type"] == "config"][0]["values"]
        self.assertEqual(config["lr"], 0.05)
        statuses = [e["status"] for e in evs if e["type"] == "status"]
        self.assertEqual(statuses, ["preparing", "running", "completed"])
        self.assertTrue(any(e["type"] == "log" and "done" in e["line"] for e in evs))

    def test_replay_from_seq(self):
        run_id = self.start("%s train.py --steps 5 --sleep 0" % sys.executable)
        self.wait_status(run_id, ("completed",))
        all_events = self.events(run_id)
        later = self.events(run_id, from_seq=3)
        self.assertEqual(later, all_events[3:])

    def test_follow_streams_until_end(self):
        run_id = self.start("%s train.py --steps 20 --sleep 0.05" % sys.executable)
        p = subprocess.run([sys.executable, AGENT, "tail", run_id, "--follow"], stdout=subprocess.PIPE, env=self.env, timeout=60)
        lines = [json.loads(l) for l in p.stdout.decode().splitlines()]
        self.assertEqual(lines[-1], {"type": "end", "status": "completed"})
        self.assertTrue(any(l.get("type") == "metric" for l in lines))

    def test_nan_detection_and_stop(self):
        run_id = self.start("%s train.py --steps 200 --sleep 0.02 --nan-at 10" % sys.executable, stopOnNan=True)
        st = self.wait_status(run_id, ("failed", "completed", "cancelled"))
        self.assertEqual(st["effectiveStatus"], "failed")
        self.assertEqual(st["reason"], "stopped_on_nan")
        diags = [e for e in self.events(run_id) if e["type"] == "diagnostic" and e["kind"] == "nan"]
        sdk = [d for d in diags if d["data"]["source"] == "sdk"]
        self.assertEqual(len(sdk), 1, diags)
        self.assertEqual(sdk[0]["step"], 10)
        self.assertEqual(sdk[0]["data"]["lastFiniteStep"], 9)
        self.assertTrue(sdk[0]["data"]["stoppedRun"])

    def test_oom_diagnostic_and_exit(self):
        run_id = self.start("%s train.py --steps 100 --sleep 0 --oom-at 5" % sys.executable)
        st = self.wait_status(run_id, ("failed", "completed"))
        self.assertEqual(st["effectiveStatus"], "failed")
        evs = self.events(run_id)
        kinds = [e["kind"] for e in evs if e["type"] == "diagnostic"]
        self.assertIn("oom", kinds)
        self.assertIn("exit", kinds)
        oom = [e for e in evs if e["type"] == "diagnostic" and e["kind"] == "oom"]
        sources = {e["data"].get("source") for e in oom}
        self.assertTrue({"log", "sdk"} & sources)

    def test_exit_code_failure(self):
        run_id = self.start("%s train.py --steps 3 --sleep 0 --exit-code 3" % sys.executable)
        st = self.wait_status(run_id, ("failed", "completed"))
        self.assertEqual(st["exitCode"], 3)
        exit_diag = [e for e in self.events(run_id) if e["type"] == "diagnostic" and e["kind"] == "exit"][0]
        self.assertIn("simulated failure", exit_diag["data"]["stderrTail"])

    def test_cancel(self):
        run_id = self.start("%s train.py --steps 100000 --sleep 0.05" % sys.executable)
        self.wait_status(run_id, ("running",))
        rc, out = self.agent("cancel", run_id)
        self.assertEqual(rc, 0, out)
        st = self.wait_status(run_id, ("cancelled", "failed", "completed"))
        self.assertEqual(st["effectiveStatus"], "cancelled")
        statuses = [e["status"] for e in self.events(run_id) if e["type"] == "status"]
        self.assertEqual(statuses[-2:], ["cancelling", "cancelled"])

    def test_cancel_escalates_to_sigkill(self):
        run_id = self.start("trap '' TERM; while true; do sleep 0.1; done", cancelGraceSec=1)
        self.wait_status(run_id, ("running",))
        self.agent("cancel", run_id)
        st = self.wait_status(run_id, ("cancelled",), timeout=20)
        self.assertEqual(st["effectiveStatus"], "cancelled")

    def test_start_is_idempotent(self):
        run_id = "idem" + uuid.uuid4().hex[:6]
        manifest = {"runId": run_id, "project": "t", "command": "sleep 1", "workdir": self.workdir, "options": {}}
        _, a = self.agent("start", stdin=json.dumps(manifest))
        _, b = self.agent("start", stdin=json.dumps(manifest))
        self.assertTrue(json.loads(b)["alreadyStarted"], b)
        self.wait_status(run_id, ("completed",))
        statuses = [e["status"] for e in self.events(run_id) if e["type"] == "status"]
        self.assertEqual(statuses.count("running"), 1)

    def test_lost_supervisor_reports_unknown_not_failed(self):
        run_id = self.start("sleep 30")
        st = self.wait_status(run_id, ("running",))
        os.kill(st["supervisorPid"], 9)
        st = self.wait_status(run_id, ("unknown",), timeout=10)
        self.assertEqual(st["effectiveStatus"], "unknown")
        # The orphaned training process can still be cancelled.
        self.agent("cancel", run_id)
        self.assertEqual(self.wait_status(run_id, ("cancelled",))["effectiveStatus"], "cancelled")

    def test_progress_bar_carriage_returns_are_throttled(self):
        script = "import time,sys\nfor i in range(200):\n    sys.stdout.write('\\r%d/200' % i); sys.stdout.flush(); time.sleep(0.005)\nprint()\nprint('end')\n"
        with open(os.path.join(self.workdir, "bar.py"), "w") as f:
            f.write(script)
        run_id = self.start("%s bar.py" % sys.executable)
        self.wait_status(run_id, ("completed",))
        logs = [e["line"] for e in self.events(run_id) if e["type"] == "log"]
        self.assertLess(len(logs), 10, logs)
        self.assertIn("end", logs)

    def test_invalid_run_id_rejected(self):
        rc, out = self.agent("status", "../etc")
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out)["error"], "invalid_run_id")

    def test_probe(self):
        rc, out = self.agent("probe", "--workdir", self.workdir, "--python", sys.executable)
        self.assertEqual(rc, 0, out)
        info = json.loads(out)
        names = [c["name"] for c in info["checks"]]
        self.assertIn("PyTorch", names)
        self.assertTrue(info["python"]["python"])


if __name__ == "__main__":
    unittest.main()
