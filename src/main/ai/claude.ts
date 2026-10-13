import Anthropic from "@anthropic-ai/sdk";
import type { ClaudeModel } from "../../shared/types";
import type { Prompt } from "./prompts";

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

  // Claude Haiku has no server-side refusal fallback; the larger models do.
  const fallback =
    opts.model === "claude-haiku-5-5"
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

  const stream = client.beta.messages.stream(
    {
      model: opts.model,
      max_tokens: 16_000,
      output_config: { effort: opts.prompt.effort },
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
