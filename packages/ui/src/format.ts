export { formatDuration } from "@converge/run-protocol";

export function formatNumber(v: number | null | undefined, digits = 4): string {
  if (v === null || v === undefined) return "—";
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return Number(v.toPrecision(digits)).toString();
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatMiB(mib: number | null | undefined): string {
  if (mib === null || mib === undefined) return "—";
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

export function timeAgo(tsSec: number | null | undefined): string {
  if (!tsSec) return "—";
  const d = Date.now() / 1000 - tsSec;
  if (d < 45) return "just now";
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d ago`;
  return new Date(tsSec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDate(tsSec: number | null | undefined): string {
  if (!tsSec) return "—";
  return new Date(tsSec * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatValue(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "number") return formatNumber(v, 6);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

export function shortCommit(c: string | null | undefined): string {
  return c ? c.slice(0, 8) : "—";
}
