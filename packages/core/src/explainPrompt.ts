// The prompt for "Explain with AI" on the Compare page. The rules in run-protocol already chose and
// ranked the causes; the model only words the explanation and suggests how to confirm it.
import type { RunExplanation } from "@converge/run-protocol";
import type { RunView } from "./api.ts";

export const EXPLAIN_MODEL = "anthropic/claude-sonnet-5.5";

const fmt = (v: number | null) => (v === null ? "n/a" : Math.abs(v) >= 1000 || Math.abs(v) < 0.001 ? v.toExponential(3) : v.toPrecision(4));

export function explainPrompt(a: RunView, b: RunView, x: RunExplanation, codeDiff: string): string {
  const causes = x.causes
    .slice(0, 15)
    .map((c, i) => `${i + 1}. [${c.likelihood}] ${c.category}: ${c.subject}${c.from || c.to ? ` (${c.from || "—"} → ${c.to || "—"})` : ""}. ${c.reason}`)
    .join("\n");
  const outcome =
    x.verdict === "unknown"
      ? "The runs share no comparable metric."
      : `Metric: ${x.metric} (${x.lowerIsBetter ? "lower" : "higher"} is better). Where A ended (median of its last 10% of points): ${fmt(x.a)}; where B ended: ${fmt(x.b)}. ` +
        `B is ${x.verdict === "within-noise" ? "within A's noise of" : x.verdict === "worse" ? `${Math.abs(x.gapPct ?? 0).toFixed(1)}% worse than` : `${Math.abs(x.gapPct ?? 0).toFixed(1)}% better than`} A ` +
        `(A's step-to-step noise ≈ ${(x.noisePct ?? 0).toFixed(1)}%).` +
        (x.divergedAtStep !== null ? ` The runs split at step ${x.divergedAtStep}.` : "");
  return [
    "You are helping an ML engineer understand why two training runs turned out differently.",
    `Run A ("${a.manifest.name}", the baseline): \`${a.manifest.command}\` on ${a.summary.env?.gpus?.[0]?.name ?? a.manifest.machine.name}, status ${a.status}.`,
    `Run B ("${b.manifest.name}"): \`${b.manifest.command}\` on ${b.summary.env?.gpus?.[0]?.name ?? b.manifest.machine.name}, status ${b.status}.`,
    "",
    outcome,
    "",
    "Every difference between the runs, ranked by an automatic analysis (most likely first):",
    causes || "(no differences found)",
    x.unchanged.length ? `\nIdentical in both runs: ${x.unchanged.join(", ")}.` : "",
    x.notes.length ? `\nCaveats: ${x.notes.join(" ")}` : "",
    codeDiff ? `\nCode diff for the likeliest code changes:\n\`\`\`diff\n${codeDiff}\n\`\`\`` : "",
    "",
    "In at most 150 words: say which difference most likely explains the outcome and why, referring to the split step and specific code lines where they help.",
    "Only name causes from the list above. If the gap is within noise or nothing listed is a likely cause, say so plainly instead of guessing.",
    "End with one concrete, cheap experiment that would confirm the cause (for example: rerun A with only that one change).",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
