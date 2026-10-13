import OpenAI from "openai";
import type { OpenAIModel } from "../../shared/types";
import type { Prompt } from "./prompts";

export async function streamOpenAI(opts: {
  apiKey: string;
  model: OpenAIModel;
  prompt: Prompt;
  signal: AbortSignal;
  onText(text: string): void;
}): Promise<void> {
  const client = new OpenAI({ apiKey: opts.apiKey });

  // OpenAI caches a repeated prompt prefix automatically, so keep the stable
  // instructions and notes ahead of the changing transcript.
  const instructions = opts.prompt.notes
    ? `${opts.prompt.instructions}\n\n${opts.prompt.notes}`
    : opts.prompt.instructions;

  const stream = await client.responses.create(
    {
      model: opts.model,
      instructions,
      input: opts.prompt.userMessage,
      // GPT-4.1 and GPT-4o aren't reasoning models and reject this setting.
      ...(opts.model.startsWith("gpt-5") ? { reasoning: { effort: opts.prompt.effort } } : {}),
      stream: true,
    },
    { signal: opts.signal },
  );

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta":
        opts.onText(event.delta);
        break;
      case "response.refusal.delta":
        opts.onText(event.delta);
        break;
      case "response.failed":
        throw new Error(`OpenAI: ${event.response.error?.message ?? "the response failed"}`);
      case "error":
        throw new Error(`OpenAI: ${event.message}`);
    }
  }
}

export function describeOpenAIError(err: unknown): string | undefined {
  if (err instanceof OpenAI.AuthenticationError) return "Your OpenAI API key was rejected.";
  if (err instanceof OpenAI.RateLimitError) return "OpenAI rate limit or quota hit. Try again in a moment.";
  if (err instanceof OpenAI.APIConnectionError) return "Couldn't reach OpenAI. Check your connection.";
  if (err instanceof OpenAI.APIError) return `OpenAI error ${err.status ?? ""}: ${err.message}`;
  return undefined;
}
