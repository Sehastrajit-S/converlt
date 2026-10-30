/** Splits a shell command into words, honoring single/double quotes and backslash escapes. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(cur);
      cur = "";
      inToken = false;
    } else {
      cur += ch;
      inToken = true;
    }
  }
  if (inToken) tokens.push(cur);
  return tokens;
}

function coerce(v: string): string | number | boolean {
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

/**
 * Extracts `--key value`, `--key=value` and bare `--flag` options from a training command.
 * Only long options are read; positional arguments and short flags are ignored.
 */
export function parseCliHyperparameters(command: string): Record<string, string | number | boolean> {
  const tokens = tokenizeCommand(command);
  const out: Record<string, string | number | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "&&" || t === ";" || t === "||" || t === "|") {
      // A new command starts; options before it belonged to setup steps.
      for (const k of Object.keys(out)) delete out[k];
      continue;
    }
    if (!t.startsWith("--") || t === "--") continue;
    const body = t.slice(2);
    const eq = body.indexOf("=");
    if (eq > 0) {
      out[body.slice(0, eq).replace(/-/g, "_")] = coerce(body.slice(eq + 1));
      continue;
    }
    const key = body.replace(/-/g, "_");
    const next = tokens[i + 1];
    if (next !== undefined && (!next.startsWith("-") || /^-[\d.]/.test(next)) && !["&&", ";", "||", "|"].includes(next)) {
      out[key] = coerce(next);
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
