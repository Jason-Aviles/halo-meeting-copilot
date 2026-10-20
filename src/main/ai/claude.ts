import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel } from "../../shared/types";
import type { Prompt } from "./prompts";

const FALLBACK_MODELS = new Set<ClaudeModel>(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const NO_EFFORT_MODELS = new Set<ClaudeModel>(["claude-sonnet-4-5", "claude-haiku-4-5"]);

/**
 * One client per key, so answers reuse its warm HTTPS connection instead of
 * paying a fresh TLS handshake each time.
 */
let shared: { apiKey: string; client: Anthropic } | undefined;
function clientFor(apiKey: string): Anthropic {
  if (shared?.apiKey !== apiKey) shared = { apiKey, client: new Anthropic({ apiKey }) };
  return shared.client;
}

/**
 * The notes and reference docs come first and are cached for an hour: they're
 * the big part of the prompt, they stay the same for the whole call, and calls
 * often go quiet for longer than the default 5-minute cache. The instructions
 * follow with their own breakpoint, so switching style, length or mode only
 * re-reads the small part.
 */
function systemBlocks(prompt: Prompt): Anthropic.Beta.BetaTextBlockParam[] {
  const blocks: Anthropic.Beta.BetaTextBlockParam[] = [];
  if (prompt.notes) {
    blocks.push({ type: "text", text: prompt.notes, cache_control: { type: "ephemeral", ttl: "1h" } });
  }
  blocks.push({ type: "text", text: prompt.instructions, cache_control: { type: "ephemeral" } });
  return blocks;
}

function effortFor(model: ClaudeModel, prompt: Prompt) {
  // The effort setting is rejected by Sonnet 4.5 and Haiku 4.5.
  return NO_EFFORT_MODELS.has(model) ? {} : { output_config: { effort: prompt.effort } };
}

export async function streamClaude(opts: {
  apiKey: string;
  model: ClaudeModel;
  prompt: Prompt;
  signal: AbortSignal;
  onText(text: string): void;
}): Promise<void> {
  // The server-side refusal fallback ("default" form) is only documented for these models.
  const fallback = FALLBACK_MODELS.has(opts.model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};

  const stream = clientFor(opts.apiKey).beta.messages.stream(
    {
      model: opts.model,
      // Haiku 4.5's output limit is 64K; 16K suits every model here.
      max_tokens: 16_000,
      ...effortFor(opts.model, opts.prompt),
      ...fallback,
      system: systemBlocks(opts.prompt),
      messages: [{ role: "user", content: opts.prompt.userMessage }],
    },
    { signal: opts.signal },
  );

  stream.on("text", (text) => opts.onText(text));
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to answer this one.");
  }
}

/**
 * Writes the prompt prefix to the cache before the first question, so the first
 * answer starts as fast as the rest. max_tokens 0 runs prefill only: nothing is
 * generated or billed as output. Effort must match real answers or the cache
 * entry won't be the one they read.
 */
export async function prewarmClaude(opts: { apiKey: string; model: ClaudeModel; prompt: Prompt }): Promise<void> {
  await clientFor(opts.apiKey).beta.messages.create({
    model: opts.model,
    max_tokens: 0,
    ...effortFor(opts.model, opts.prompt),
    system: systemBlocks(opts.prompt),
    messages: [{ role: "user", content: "warmup" }],
  });
}

export function describeClaudeError(err: unknown): string | undefined {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return undefined;
}
