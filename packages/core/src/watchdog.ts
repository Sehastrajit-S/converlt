// Idle watchdog for cloud pods. It runs on the pod itself, so it works even when this computer
// is off or the gateway isn't running: when no GPU work has happened for the chosen time, the
// pod stops itself (storage is kept, GPU billing ends). It uses the pod-scoped RUNPOD_API_KEY
// and RUNPOD_POD_ID that RunPod injects into every pod.
import { shq, type RemoteTransport } from "./transport.ts";

const WATCHDOG = String.raw`
import json, os, subprocess, sys, time, urllib.request

IDLE_MIN = float(sys.argv[1])
STATE = os.path.expanduser("~/.converge/watchdog.json")

def container_env():
    # Injected variables are on PID 1; SSH shells don't always inherit them.
    env = dict(os.environ)
    try:
        with open("/proc/1/environ", "rb") as f:
            for item in f.read().split(b"\0"):
                if b"=" in item:
                    k, v = item.split(b"=", 1)
                    env.setdefault(k.decode(errors="replace"), v.decode(errors="replace"))
    except OSError:
        pass
    return env

def gpu_busy():
    try:
        apps = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True, text=True, timeout=30).stdout.strip()
        if apps:
            return True
        util = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=30).stdout.split()
        return any(float(u) > 10 for u in util if u.strip())
    except Exception:
        return True  # can't tell: never stop on uncertainty

def stop(pod, key):
    for cmd in (["runpodctl", "stop", "pod", pod], ["runpodctl", "pod", "stop", pod]):
        try:
            if subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0:
                return "runpodctl"
        except Exception:
            pass
    req = urllib.request.Request("https://rest.runpod.io/v1/pods/%s/stop" % pod, method="POST", headers={"Authorization": "Bearer " + key})
    urllib.request.urlopen(req, timeout=60)
    return "api"

env = container_env()
pod, key = env.get("RUNPOD_POD_ID"), env.get("RUNPOD_API_KEY", "")
if not pod:
    sys.exit("not a RunPod pod")
idle_since = None
while True:
    if gpu_busy():
        idle_since = None
    elif idle_since is None:
        idle_since = time.time()
    state = {"pid": os.getpid(), "idleMinutes": IDLE_MIN, "idleSince": idle_since and int(idle_since * 1000), "checkedAt": int(time.time() * 1000)}
    if idle_since is not None and time.time() - idle_since >= IDLE_MIN * 60:
        try:
            state["stoppedBy"] = stop(pod, key)
        except Exception as e:
            state["error"] = str(e)[:300]
        with open(STATE, "w") as f:
            json.dump(state, f)
        time.sleep(300)  # the pod is going down; if stopping failed, keep trying
        idle_since = time.time() - IDLE_MIN * 60
        continue
    with open(STATE, "w") as f:
        json.dump(state, f)
    time.sleep(60)
`;

const LAUNCH = `import os, subprocess, sys
path, minutes = sys.argv[1], sys.argv[2]
subprocess.Popen([sys.executable, path, minutes], stdin=subprocess.DEVNULL, stdout=open(path + ".log", "ab"), stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
print("started")`;

/**
 * Installs (or replaces) the watchdog on a pod. `minutes <= 0` removes it.
 * Safe to call repeatedly: an existing watchdog is stopped first.
 */
export async function installWatchdog(t: RemoteTransport, python: string, minutes: number): Promise<void> {
  const file = "$HOME/.converge/converlt_watchdog.py";
  const kill = `pkill -f converlt_watchdog.py >/dev/null 2>&1 || true`;
  if (!(minutes > 0)) {
    await t.exec(`${kill}; rm -f "$HOME/.converge/watchdog.json"`);
    return;
  }
  const r = await t.exec(
    `${kill}; mkdir -p "$HOME/.converge" && printf %s ${shq(WATCHDOG)} > "${file}" && ${python} -c ${shq(LAUNCH)} "${file}" ${shq(String(Math.round(minutes)))}`,
  );
  if (r.code !== 0 || !r.stdout.includes("started")) throw new Error(`Could not start the idle watchdog: ${(r.stderr || r.stdout).trim().slice(-300)}`);
}
