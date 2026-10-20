import type {
  AiProvider,
  AnswerLength,
  AnswerRequest,
  AnswerStyle,
  AssistMode,
  NotesFormat,
  ClaudeModel,
  OpenAIModel,
} from "../shared/types";
import { describeClaudeError, prewarmClaude, streamClaude } from "./ai/claude";
import { describeLocalError, prewarmLocal, streamLocal } from "./ai/local";
import { describeOpenAIError, streamOpenAI } from "./ai/openai";
import { buildPrompt } from "./ai/prompts";

export interface AnswerOptions {
  provider: AiProvider;
  /** Empty for a local model. */
  apiKey: string;
  claudeModel: ClaudeModel;
  openaiModel: OpenAIModel;
  localUrl: string;
  localModel: string;
  mode: AssistMode;
  style: AnswerStyle;
  length: AnswerLength;
  notesFormat: NotesFormat;
  context: string;
  references: string;
  request: AnswerRequest;
  signal: AbortSignal;
  onText(text: string): void;
}

function promptFor(opts: Omit<AnswerOptions, "signal" | "onText">) {
  return buildPrompt({
    mode: opts.mode,
    style: opts.style,
    length: opts.length,
    notesFormat: opts.notesFormat,
    context: opts.context,
    references: opts.references,
    local: opts.provider === "local",
    request: opts.request,
  });
}

/**
 * Primes the provider for the first answer of a call: a warm connection, and
 * the notes and instructions already cached. Failures are ignored; the real
 * answer will report any problem.
 */
export async function prewarmAnswers(opts: Omit<AnswerOptions, "signal" | "onText" | "request">): Promise<void> {
  // Only the stable prefix matters, so an empty transcript is fine.
  const prompt = promptFor({ ...opts, request: { kind: "answer", transcript: [] } });
  try {
    if (opts.provider === "claude") await prewarmClaude({ apiKey: opts.apiKey, model: opts.claudeModel, prompt });
    else if (opts.provider === "local") await prewarmLocal({ url: opts.localUrl, model: opts.localModel, prompt });
    // OpenAI caches prompt prefixes automatically on first use; nothing to do ahead of time.
  } catch {
    // Best effort only.
  }
}

export function streamAnswer(opts: AnswerOptions): Promise<void> {
  const prompt = promptFor(opts);
  const common = { prompt, signal: opts.signal, onText: opts.onText };
  switch (opts.provider) {
    case "local":
      return streamLocal({ ...common, url: opts.localUrl, model: opts.localModel });
    case "openai":
      return streamOpenAI({ ...common, apiKey: opts.apiKey, model: opts.openaiModel });
    default:
      return streamClaude({ ...common, apiKey: opts.apiKey, model: opts.claudeModel });
  }
}

export function describeAnswerError(provider: AiProvider, err: unknown): string {
  // Local servers use the OpenAI SDK too, so pick the describer by provider.
  const describe = { claude: describeClaudeError, openai: describeOpenAIError, local: describeLocalError }[provider];
  return (
    describe(err) ??
    (err instanceof Error ? err.message : String(err))
  );
}
