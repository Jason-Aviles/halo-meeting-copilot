import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel } from "../../shared/types";
import type { Prompt } from "./prompts";

const FALLBACK_MODELS = new Set<ClaudeModel>(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const NO_EFFORT_MODELS = new Set<ClaudeModel>(["claude-sonnet-4-5", "claude-haiku-4-5"]);

export async function streamClaude(opts: {
  apiKey: string;
  model: ClaudeModel;
  prompt: Prompt;
  signal: AbortSignal;
  onText(text: string): void;
}): Promise<void> {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: opts.prompt.instructions },
  ];
  if (opts.prompt.notes) {
    // The instructions and notes are identical across a call, so cache them.
    system.push({ type: "text", text: opts.prompt.notes, cache_control: { type: "ephemeral" } });
  }

  // The server-side refusal fallback ("default" form) is only documented for these models.
  const fallback = FALLBACK_MODELS.has(opts.model)
    ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
    : {};
  // The effort setting is rejected by Sonnet 4.5 and Haiku 4.5.
  const effort = NO_EFFORT_MODELS.has(opts.model) ? {} : { output_config: { effort: opts.prompt.effort } };

  const stream = client.beta.messages.stream(
    {
      model: opts.model,
      // Haiku 4.5's output limit is 64K; 16K suits every model here.
      max_tokens: 16_000,
      ...effort,
      ...fallback,
      system,
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

export function describeClaudeError(err: unknown): string | undefined {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic error ${err.status ?? ""}: ${err.message}`;
  return undefined;
}
