// Sweeps: one base command run over several settings (a grid, or a random sample of it). Each
// setting becomes an ordinary run with the values written into its command line, so it is
// recorded, compared and reproduced like any other run.

export type SweepValues = Record<string, string[]>;

export interface SweepPoint {
  command: string;
  params: Record<string, string>;
  /** "lr=3e-4 batch-size=64" */
  label: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bare = (key: string) => key.trim().replace(/^-+/, "");

/** A value as one shell word. */
export function shellWord(v: string): string {
  return /^[\w.+\-/:=,@%]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command with `--key value` set: an existing `--key value`, `--key=value` (with - and _
 * treated alike, as argparse does) is replaced in place; otherwise it is added at the end.
 */
export function setArg(command: string, key: string, value: string): string {
  const k = bare(key).split(/[-_]/).map(esc).join("[-_]");
  const re = new RegExp(`(^|\\s)--(${k})(=|\\s+)(?!--)("[^"]*"|'[^']*'|[^\\s;&|]+)`);
  const v = shellWord(value);
  if (re.test(command)) return command.replace(re, (_m, pre: string, name: string, sep: string) => `${pre}--${name}${sep === "=" ? "=" : " "}${v}`);
  return `${command.trimEnd()} --${bare(key)} ${v}`;
}

const fmtNum = (x: number) => (Number.isInteger(x) ? String(x) : Number(x.toPrecision(3)).toString());

/** "1e-4..1e-2 x4 log" → 4 log-spaced values; "16..64 x3" → 16, 40, 64. */
function expandRange(text: string): string[] | string {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*\.\.\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(?:x\s*(\d+))?\s*(log)?\s*$/i.exec(text);
  if (!m) return "not a range";
  const a = Number(m[1]);
  const b = Number(m[2]);
  const n = Math.max(2, Number(m[3] ?? 3));
  const log = !!m[4];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "not a range";
  if (log && (a <= 0 || b <= 0)) return "a log range needs positive ends";
  if (n > 50) return "at most 50 values per range";
  const ints = !log && Number.isInteger(a) && Number.isInteger(b) && !/[.e]/i.test(m[1]! + m[2]!);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = log ? Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a))) : a + t * (b - a);
    out.push(ints ? String(Math.round(x)) : fmtNum(x));
  }
  return [...new Set(out)];
}

/**
 * Sweep values, one setting per line (or separated by ";"):
 *   lr = 1e-3, 3e-4, 1e-4
 *   batch-size = 32, 64
 *   lr = 1e-4..1e-2 x4 log      (4 values, evenly spaced on a log scale)
 */
export function parseSweepValues(text: string): { values: SweepValues; errors: string[] } {
  const values: SweepValues = {};
  const errors: string[] = [];
  for (const raw of text.split(/[\n;]/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`"${line}": write name = value, value, …`);
      continue;
    }
    const key = bare(line.slice(0, eq));
    const rhs = line.slice(eq + 1).trim();
    if (!/^[A-Za-z][\w-]*$/.test(key)) {
      errors.push(`"${key}" isn't an option name`);
      continue;
    }
    let vals: string[];
    if (rhs.includes("..")) {
      const r = expandRange(rhs);
      if (typeof r === "string") {
        errors.push(`${key}: ${r}`);
        continue;
      }
      vals = r;
    } else {
      vals = [...new Set(rhs.split(",").map((v) => v.trim()).filter(Boolean))];
    }
    if (!vals.length) {
      errors.push(`${key}: no values`);
      continue;
    }
    values[key] = vals;
  }
  return { values, errors };
}

export const sweepGridSize = (values: SweepValues) => Object.values(values).reduce((n, v) => n * v.length, Object.keys(values).length ? 1 : 0);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SweepOptions {
  /** "grid": every combination; "random": `max` combinations picked at random. */
  mode: "grid" | "random";
  /** Most runs to start. A grid larger than this is refused rather than cut short. */
  max: number;
  seed?: number;
}

/** The runs of a sweep, or an error saying why it can't be made. */
export function expandSweep(base: string, values: SweepValues, opts: SweepOptions): SweepPoint[] | { error: string } {
  const keys = Object.keys(values);
  if (!base.trim()) return { error: "Enter the command to sweep." };
  if (!keys.length) return { error: "Add at least one option to vary, e.g. lr = 1e-3, 3e-4." };
  const size = sweepGridSize(values);
  if (opts.mode === "grid" && size > opts.max) return { error: `That grid is ${size} runs; the limit is ${opts.max}. Use fewer values, or a random sample.` };
  const index = (i: number) => {
    const params: Record<string, string> = {};
    for (let j = keys.length - 1; j >= 0; j--) {
      const v = values[keys[j]!]!;
      params[keys[j]!] = v[i % v.length]!;
      i = Math.floor(i / v.length);
    }
    return params;
  };
  let picks: number[];
  if (opts.mode === "grid" || size <= opts.max) picks = [...Array(size).keys()];
  else {
    const rnd = mulberry32(opts.seed ?? 1);
    const set = new Set<number>();
    while (set.size < opts.max) set.add(Math.floor(rnd() * size));
    picks = [...set];
  }
  return picks.map((i) => {
    const params = index(i);
    const command = keys.reduce((c, k) => setArg(c, k, params[k]!), base.trim());
    return { command, params: Object.fromEntries(keys.map((k) => [k, params[k]!])), label: keys.map((k) => `${k}=${params[k]}`).join(" ") };
  });
}
