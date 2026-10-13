import type {
  AiProvider,
  AnswerLength,
  AnswerRequest,
  AnswerStyle,
  AssistMode,
  ClaudeModel,
  OpenAIModel,
} from "../shared/types";
import { describeClaudeError, streamClaude } from "./ai/claude";
import { describeOpenAIError, streamOpenAI } from "./ai/openai";
import { buildPrompt } from "./ai/prompts";

export interface AnswerOptions {
  provider: AiProvider;
  apiKey: string;
  claudeModel: ClaudeModel;
  openaiModel: OpenAIModel;
  mode: AssistMode;
  style: AnswerStyle;
  length: AnswerLength;
  context: string;
  request: AnswerRequest;
  signal: AbortSignal;
  onText(text: string): void;
}

export function streamAnswer(opts: AnswerOptions): Promise<void> {
  const prompt = buildPrompt({
    mode: opts.mode,
    style: opts.style,
    length: opts.length,
    context: opts.context,
    request: opts.request,
  });
  const common = { apiKey: opts.apiKey, prompt, signal: opts.signal, onText: opts.onText };
  return opts.provider === "openai"
    ? streamOpenAI({ ...common, model: opts.openaiModel })
    : streamClaude({ ...common, model: opts.claudeModel });
}

export function describeAnswerError(err: unknown): string {
  return (
    describeClaudeError(err) ??
    describeOpenAIError(err) ??
    (err instanceof Error ? err.message : String(err))
  );
}
