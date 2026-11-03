// Converlt Cloud models in the editor's chat model picker: OpenRouter models through the Converlt
// Gateway, paid from the user's credits. Requests stream from the gateway's OpenAI-compatible
// endpoint; text and tool calls are reported back as language-model response parts.
import * as vscode from "vscode";
import type { ModelInfo } from "@converge/core";
import type { Host } from "../host.ts";

/** Shown in the picker by default; any catalog model can be added with `converge.chat.models`. */
export const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-haiku-5.5",
  "openai/gpt-6.1-sol",
  "openai/gpt-6.1-terra",
  "google/gemini-4-argon",
  "google/gemini-3.8-flash",
  "deepseek/deepseek-v4-pro-0813",
  "qwen/qwen3.8-max-0902",
  "moonshotai/kimi-k3.1-pro",
  "x-ai/grok-4.7",
  "mistralai/devstral-2512",
];

type Info = vscode.LanguageModelChatInformation & { isUserSelectable?: boolean; isDefault?: boolean; detail?: string };

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

const credits = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2));

function toOpenAI(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    const parts = m.content as readonly unknown[];
    const text = parts
      .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
      .map((p) => p.value)
      .join("");
    if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
      const calls = parts.filter((p): p is vscode.LanguageModelToolCallPart => p instanceof vscode.LanguageModelToolCallPart);
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.callId, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
      continue;
    }
    // Tool results travel as their own messages, before any user text in the same turn.
    for (const p of parts) {
      if (!(p instanceof vscode.LanguageModelToolResultPart)) continue;
      const content = p.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : typeof c === "string" ? c : JSON.stringify(c))).join("");
      out.push({ role: "tool", tool_call_id: p.callId, content });
    }
    if (text) out.push({ role: (m.role as number) === 3 ? "system" : "user", content: text });
  }
  return out;
}

export class ConverltModels implements vscode.LanguageModelChatProvider<Info> {
  private readonly host: Host;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private catalog: { at: number; models: ModelInfo[] } | null = null;

  constructor(host: Host) {
    this.host = host;
  }

  /** Call when the user signs in or out, so the picker refreshes. */
  refresh(): void {
    this.catalog = null;
    this.changed.fire();
  }

  private async models(): Promise<ModelInfo[]> {
    if (this.catalog && Date.now() - this.catalog.at < 10 * 60_000) return this.catalog.models;
    const models = await this.host.service.cloudModels();
    this.catalog = { at: Date.now(), models };
    return models;
  }

  async provideLanguageModelChatInformation(_options: { silent: boolean }, _token: vscode.CancellationToken): Promise<Info[]> {
    if (!(await this.host.service.cloudEndpoint())) return [];
    let catalog: ModelInfo[];
    try {
      catalog = await this.models();
    } catch {
      return [];
    }
    const wanted = vscode.workspace.getConfiguration("converge").get<string[]>("chat.models", DEFAULT_MODELS);
    const byId = new Map(catalog.map((m) => [m.id, m]));
    return wanted
      .map((id) => byId.get(id))
      .filter((m): m is ModelInfo => !!m)
      .map((m, i) => ({
        id: m.id,
        name: m.name.replace(/^[^:]+:\s*/, ""),
        family: m.id.split("/")[0] ?? "converlt",
        version: m.id,
        detail: `${credits(m.inputPerMTok)} / ${credits(m.outputPerMTok)} credits per 1M`,
        tooltip: `${m.name}\n${m.id}\nInput ${m.inputPerMTok} · output ${m.outputPerMTok} credits per million tokens\nContext ${m.contextLength.toLocaleString()} tokens`,
        maxInputTokens: Math.max(8_000, m.contextLength - 32_000),
        maxOutputTokens: 32_000,
        capabilities: { toolCalling: true, imageInput: /image/.test(m.modality) },
        isUserSelectable: true,
        isDefault: i === 0,
      }));
  }

  async provideLanguageModelChatResponse(
    model: Info,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const ep = await this.host.service.cloudEndpoint();
    if (!ep) throw new Error("Sign in to Converlt Cloud to use Converlt models.");
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    try {
      const tools = (options.tools ?? []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
      const res = await fetch(`${ep.url}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ep.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id, messages: toOpenAI(messages), stream: true, ...(tools.length ? { tools } : {}), max_tokens: model.maxOutputTokens }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        let msg = text.slice(0, 300);
        try {
          msg = JSON.parse(text).error?.message ?? msg;
        } catch {
          // not JSON
        }
        throw new Error(res.status === 402 ? `Converlt: ${msg}` : `Converlt Cloud model request failed (${res.status}): ${msg}`);
      }
      // Tool calls stream in fragments keyed by index; they are reported once complete.
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: { choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; error?: { message?: string } };
          try {
            j = JSON.parse(data);
          } catch {
            continue;
          }
          if (j.error) throw new Error(j.error.message ?? "Model error");
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) progress.report(new vscode.LanguageModelTextPart(delta.content));
          for (const tc of delta?.tool_calls ?? []) {
            const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(tc.index, cur);
          }
        }
      }
      for (const c of calls.values()) {
        let input: object = {};
        try {
          input = c.args ? JSON.parse(c.args) : {};
        } catch {
          input = { _invalidJson: c.args };
        }
        progress.report(new vscode.LanguageModelToolCallPart(c.id || `call_${Math.random().toString(36).slice(2)}`, c.name, input));
      }
    } finally {
      sub.dispose();
    }
  }

  async provideTokenCount(_model: Info, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    const s = typeof text === "string" ? text : JSON.stringify(text.content);
    return Math.ceil(s.length / 4);
  }
}
