import type { ConnectionState, LocalRunState, RunStatus } from "./types.ts";

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ["preparing", "running", "failed", "cancelled"],
  preparing: ["running", "failed", "cancelling", "cancelled"],
  running: ["cancelling", "completed", "failed", "cancelled"],
  cancelling: ["cancelled", "failed", "completed"],
  completed: [],
  failed: [],
  cancelled: [],
  // Unknown is a visibility state, not an outcome: any real status may follow it.
  unknown: ["preparing", "running", "cancelling", "completed", "failed", "cancelled"],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  if (from === to) return true;
  if (to === "unknown") return !isTerminal(from);
  return TRANSITIONS[from].includes(to);
}

/**
 * The status shown to the user. A lost connection never turns into "failed":
 * if we cannot observe a live run, we say so.
 */
export function displayStatus(
  agentStatus: RunStatus | null,
  local: LocalRunState | null,
  connection: ConnectionState,
): RunStatus {
  if (local?.phase === "launch_failed") return "failed";
  if (agentStatus === null) return local?.phase === "preparing" ? "preparing" : "unknown";
  if (isTerminal(agentStatus)) return agentStatus;
  if (connection === "lost") return "unknown";
  return agentStatus;
}
