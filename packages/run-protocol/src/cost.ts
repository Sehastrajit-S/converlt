export interface CostEstimate {
  hours: number;
  usd: number | null;
}

/** Estimated compute cost from a user-entered hourly rate. Not provider-billed. */
export function estimateCost(
  hourlyRate: number | undefined,
  startedAt: number | null,
  endedAt: number | null,
  now: number = Date.now() / 1000,
): CostEstimate {
  if (startedAt === null) return { hours: 0, usd: hourlyRate === undefined ? null : 0 };
  const hours = Math.max(0, (endedAt ?? now) - startedAt) / 3600;
  return { hours, usd: hourlyRate === undefined ? null : hours * hourlyRate };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
