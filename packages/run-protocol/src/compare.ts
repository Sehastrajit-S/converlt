export interface ConfigDiffRow {
  key: string;
  values: (unknown | undefined)[];
  differs: boolean;
}

/** Flattens nested objects into dotted keys: {opt: {lr: 1}} -> {"opt.lr": 1}. */
export function flattenConfig(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flattenConfig(v as Record<string, unknown>, key));
    else out[key] = v;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b || (Number.isNaN(a) && Number.isNaN(b));
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rows for every key across configs; differing rows first, then alphabetical. */
export function diffConfigs(configs: Record<string, unknown>[]): ConfigDiffRow[] {
  const flat = configs.map((c) => flattenConfig(c));
  const keys = new Set<string>();
  for (const f of flat) for (const k of Object.keys(f)) keys.add(k);
  const rows: ConfigDiffRow[] = [];
  for (const key of keys) {
    const values = flat.map((f) => (key in f ? f[key] : undefined));
    const differs = values.some((v) => !sameValue(v, values[0]));
    rows.push({ key, values, differs });
  }
  rows.sort((a, b) => Number(b.differs) - Number(a.differs) || a.key.localeCompare(b.key));
  return rows;
}

/** Metric keys present in at least `minRuns` runs. */
export function sharedMetricKeys(metricKeySets: string[][], minRuns = 2): string[] {
  const counts = new Map<string, number>();
  for (const keys of metricKeySets) for (const k of new Set(keys)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= Math.min(minRuns, metricKeySets.length))
    .map(([k]) => k)
    .sort();
}
