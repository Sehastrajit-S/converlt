// Phone alerts through ntfy (https://ntfy.sh): the agent on the GPU machine posts to a topic URL
// when a run ends or needs attention, and the ntfy app on the phone shows it. The topic name is
// the only secret, so Converlt generates a long random one. Self-hosted ntfy servers work too.

/** https://server[/prefix]/topic → [server URL, topic]. Same rule as the agent's NTFY_URL_RE. */
const NTFY_URL_RE = /^(https?:\/\/[^/?#]+(?:\/[^/?#]+)*)\/([A-Za-z0-9_-]{1,64})\/?$/;

export function parseNtfyUrl(url: string): { server: string; topic: string } | null {
  const m = NTFY_URL_RE.exec(url.trim());
  return m ? { server: m[1]!, topic: m[2]! } : null;
}

export async function publishNtfy(url: string, title: string, message: string, tags: string[] = []): Promise<void> {
  const target = parseNtfyUrl(url);
  if (!target) throw new Error("That isn't an ntfy topic URL. It should look like https://ntfy.sh/converlt-…");
  const res = await fetch(`${target.server}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: target.topic, title, message, tags }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
