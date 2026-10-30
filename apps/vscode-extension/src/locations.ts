import type { DiagnosticEvent } from "@converge/run-protocol";

export interface SourceLocation {
  /** Path relative to the project root, with forward slashes. */
  relPath: string;
  /** 1-based line number. */
  line: number;
}

const PY_FRAME = /File "([^"]+)", line (\d+)/g;
const FAILING_FRAME = /^(.+):(\d+) in /;

/**
 * Maps a path on the GPU machine back into the project. Code is synced to <remoteRoot>/<slug>/,
 * so everything after the last "/<slug>/" segment is the project-relative path.
 */
export function toProjectPath(remotePath: string, slug: string): string | null {
  const p = remotePath.replace(/\\/g, "/");
  const marker = `/${slug}/`;
  const i = p.lastIndexOf(marker);
  if (i < 0) return null;
  const rel = p.slice(i + marker.length);
  return rel && !rel.startsWith("../") ? rel : null;
}

/** The innermost frame inside the project for a diagnostic, if one can be located. */
export function locateDiagnostic(d: DiagnosticEvent, slug: string): SourceLocation | null {
  const data = (d.data ?? {}) as Record<string, unknown>;
  const candidates: { path: string; line: number }[] = [];
  if (typeof data.failingFrame === "string") {
    const m = FAILING_FRAME.exec(data.failingFrame);
    if (m) candidates.push({ path: m[1]!, line: Number(m[2]) });
  }
  const texts = [data.traceback, Array.isArray(data.stderrTail) ? data.stderrTail.join("\n") : undefined];
  for (const t of texts) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(PY_FRAME)) candidates.push({ path: m[1]!, line: Number(m[2]) });
  }
  // Tracebacks list outermost first; the last frame in the project is where it failed.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const rel = toProjectPath(candidates[i]!.path, slug);
    if (rel) return { relPath: rel, line: candidates[i]!.line };
  }
  return null;
}
