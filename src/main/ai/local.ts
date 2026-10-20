import OpenAI from "openai";
import type { Prompt } from "./prompts";

/**
 * LM Studio, Ollama, llama.cpp's server and similar tools all speak the OpenAI
 * Chat Completions API, so one client covers them. None of them need a key, but
 * the SDK insists on one.
 */
let shared: { baseURL: string; client: OpenAI } | undefined;
function client(baseURL: string): OpenAI {
  if (shared?.baseURL !== baseURL) shared = { baseURL, client: new OpenAI({ baseURL, apiKey: "local", maxRetries: 0 }) };
  return shared.client;
}

function systemText(prompt: Prompt): string {
  // Same order as Claude: the long, stable notes first so the server can reuse them.
  return prompt.notes ? `${prompt.notes}\n\n${prompt.instructions}` : prompt.instructions;
}

/**
 * Loads the model and processes the shared prompt prefix before the first
 * question. LM Studio and Ollama keep that prefix cached, so the first real
 * answer skips most of its prompt processing.
 */
export async function prewarmLocal(opts: { url: string; model: string; prompt: Prompt }): Promise<void> {
  if (!opts.model) return;
  await client(opts.url).chat.completions.create({
    model: opts.model,
    max_tokens: 1,
    messages: [
      { role: "system", content: systemText(opts.prompt) },
      { role: "user", content: "warmup" },
    ],
  });
}

export function normalizeLocalUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    throw new Error("The local server address should look like http://localhost:1234/v1");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The local server address must start with http:// or https://");
  }
  // LM Studio and Ollama both serve the OpenAI API under /v1.
  const base = parsed.href.replace(/\/+$/, "");
  return parsed.pathname === "" || parsed.pathname === "/" ? `${base}/v1` : base;
}

export async function listLocalModels(url: string): Promise<string[]> {
  const page = await client(normalizeLocalUrl(url)).models.list({ timeout: 5_000 });
  return page.data.map((m) => m.id).sort();
}

export async function streamLocal(opts: {
  url: string;
  model: string;
  prompt: Prompt;
  signal: AbortSignal;
  onText(text: string): void;
}): Promise<void> {
  if (!opts.model) throw new Error("Pick a local model in Settings first.");

  const system = systemText(opts.prompt);

  const stream = await client(opts.url).chat.completions.create(
    {
      model: opts.model,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: opts.prompt.userMessage },
      ],
    },
    { signal: opts.signal },
  );

  const filter = new ThinkFilter(opts.onText);
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) filter.push(text);
  }
}

/**
 * Reasoning models (Qwen, DeepSeek R1…) sometimes put their thinking in the
 * answer text inside <think>…</think>. Drop it, since the user only reads the reply.
 */
class ThinkFilter {
  private buffer = "";
  private thinking = false;
  private started = false;

  constructor(private readonly emit: (text: string) => void) {}

  push(text: string): void {
    this.buffer += text;
    for (;;) {
      if (this.thinking) {
        const end = this.buffer.indexOf("</think>");
        if (end === -1) {
          // Keep only enough to catch a closing tag split across chunks.
          this.buffer = this.buffer.slice(-7);
          return;
        }
        this.buffer = this.buffer.slice(end + "</think>".length);
        this.thinking = false;
        continue;
      }
      const start = this.buffer.indexOf("<think>");
      if (start !== -1) {
        this.out(this.buffer.slice(0, start));
        this.buffer = this.buffer.slice(start + "<think>".length);
        this.thinking = true;
        continue;
      }
      // Hold back a possible partial "<think" at the end.
      const lt = this.buffer.lastIndexOf("<");
      const hold = lt !== -1 && "<think>".startsWith(this.buffer.slice(lt)) ? lt : this.buffer.length;
      this.out(this.buffer.slice(0, hold));
      this.buffer = this.buffer.slice(hold);
      return;
    }
  }

  private out(text: string): void {
    // Skip the blank lines models leave after their thinking.
    if (!this.started) text = text.replace(/^\s+/, "");
    if (!text) return;
    this.started = true;
    this.emit(text);
  }
}

export function describeLocalError(err: unknown): string | undefined {
  if (err instanceof OpenAI.APIConnectionError) {
    return "Couldn't reach the local AI server. Is LM Studio's server (or Ollama) running?";
  }
  if (err instanceof OpenAI.NotFoundError) {
    return "The local server doesn't have that model. Load it, or pick another in Settings.";
  }
  if (err instanceof OpenAI.APIError) return `Local AI error ${err.status ?? ""}: ${err.message}`;
  return undefined;
}
