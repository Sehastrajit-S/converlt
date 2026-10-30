# Run protocol (v1)

The contract between the desktop app and `converge_agent.py`. TypeScript types live in `packages/run-protocol/src/types.ts`.

## Agent commands

The app invokes the agent over SSH as `bash -c '<python> ~/.converge/lib/agent/converge_agent.py <cmd>'`. Each command prints one JSON object, except `tail`, which prints JSON lines. Errors are reported as `{"ok": false, "error": "<code>", "message": "..."}` with a non-zero exit code.

| Command | Purpose |
| --- | --- |
| `probe --workdir D --python P` | Readiness report: GPUs, driver, CUDA, torch, disk, working directory, `checks[]`. |
| `telemetry --workdir D` | One GPU/host sample. |
| `start` (manifest on stdin) | Creates `~/.converge/runs/<runId>/` and spawns a detached supervisor. **Idempotent**: if the run already exists it returns `alreadyStarted: true` and does not launch a second time. |
| `status <runId>` | `status.json` plus `effectiveStatus` and `supervisorAlive`. |
| `tail <runId> --from-seq N [--follow]` | Prints events with `seq > N`. With `--follow` it also prints `heartbeat` lines every 5s and finishes with `{"type":"end","status":...}`. |
| `cancel <runId>` | Writes a cancel marker. The supervisor sends SIGTERM to the process group, then SIGKILL after `cancelGraceSec`. If the supervisor is gone, the agent signals the process group itself. |
| `list` | Every run on the machine. |

## Files per run

```
~/.converge/runs/<runId>/
  manifest.json    AgentStartRequest as received
  status.json      {status, pid, pgid, supervisorPid, exitCode, reason, startedAt, endedAt, lastSeq}
  events.jsonl     append-only event log; the supervisor is the only writer
  sdk.jsonl        written by the SDK inside the training process; the supervisor tails it
  cancel           present once cancellation is requested
  supervisor.log   supervisor's own stderr
```

## Events

Every event has `seq` (contiguous from 1), `ts` (Unix seconds), and `type`:

| type | fields |
| --- | --- |
| `status` | `status`, optional `exitCode`, `reason`, `pid` |
| `log` | `stream` (`stdout`/`stderr`), `line` (max 4000 chars; `\r` progress updates throttled to 1/s) |
| `metric` | `step` (int or null), `values` (map; non-finite values encoded as `"NaN"`, `"Infinity"`, `"-Infinity"`) |
| `config` | `values` (merged into the run's effective config) |
| `env` | `hostname`, `python`, `pythonPath`, `torch`, `torchCuda`, `cudaAvailable`, `driver`, `cudaVersion`, `gpus[]`, `packages[]` |
| `telemetry` | `gpus[]` (`memUsedMiB`, `memTotalMiB`, `utilPct`, `tempC`, `powerW`), `host` (`load1`, `cpuCount`, `memUsedMiB`, `memTotalMiB`, `diskFreeGiB`) |
| `diagnostic` | `kind` (`nan`/`oom`/`exit`/`stall`/`perf`/`exception`/`launch`), `severity`, `message`, `step`, `data`. Clients merge `data` from repeated events of the same kind into one card. |
| `artifact` | `path`, `sizeBytes`, `sha256`, `step` |

## Lifecycle

```
created → preparing → running → completed
                          ├──→ failed      (non-zero exit, stop-on-NaN, launch error)
                          └──→ cancelling → cancelled
any non-terminal ──→ unknown   (supervisor gone, or the client lost the connection)
```

`unknown` is a visibility state, not an outcome. The client never turns a lost connection into `failed`.

## Reconnect and replay

The client stores events in `<project>/.converge/runs/<runId>/events.jsonl` and remembers the last `seq` it applied. When it reconnects, it runs `tail --from-seq <lastSeq> --follow`. The reducer ignores any event with `seq <= lastSeq`, so replays are safe.
