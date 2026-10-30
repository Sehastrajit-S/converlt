// OpenRouter: model catalog and OpenAI-compatible chat completions. The response's usage.cost
// (USD) is what the gateway charges against the user's credits.

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  architecture?: { modality?: string };
  /** USD per token, as decimal strings. */
  pricing: { prompt: string; completion: string };
}

export class OpenRouter {
  private readonly key: string;
  private readonly url: string;
  private readonly referer: string;
  private cache: { at: number; models: OpenRouterModel[] } | null = null;

  constructor(key: string, url: string, referer: string) {
    this.key = key;
    this.url = url.replace(/\/$/, "");
    this.referer = referer;
  }

  get configured(): boolean {
    return !!this.key;
  }

  /** The catalog is public; cached for 10 minutes. */
  async models(): Promise<OpenRouterModel[]> {
    if (this.cache && Date.now() - this.cache.at < 10 * 60_000) return this.cache.models;
    const res = await fetch(`${this.url}/models`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`OpenRouter models failed (${res.status})`);
    const j = (await res.json()) as { data: OpenRouterModel[] };
    this.cache = { at: Date.now(), models: j.data };
    return j.data;
  }

  /** Forwards a chat completion request body unchanged (it may ask to stream). */
  chat(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    if (!this.key) throw new Error("Models are not configured on this gateway (OPENROUTER_API_KEY).");
    return fetch(`${this.url}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.referer,
        "X-Title": "Converlt",
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

/** Cost in USD of a finished completion, from usage.cost, falling back to the catalog price. */
export function usageCostUsd(usage: unknown, model: OpenRouterModel | undefined): number {
  const u = (usage ?? {}) as { cost?: number; prompt_tokens?: number; completion_tokens?: number };
  if (typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0) return u.cost;
  if (!model) return 0;
  return (u.prompt_tokens ?? 0) * Number(model.pricing.prompt) + (u.completion_tokens ?? 0) * Number(model.pricing.completion);
}
