export type SttProvider = "deepgram" | "speechmatics";

/** "you" is the microphone; "them" is everything playing through the speakers. */
export type Speaker = "you" | "them";

export const SPEECHMATICS_REGIONS = ["eu2", "us2"] as const;
export type SpeechmaticsRegion = (typeof SPEECHMATICS_REGIONS)[number];

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export const OPENAI_MODELS = ["gpt-5.5", "gpt-5.4-mini"] as const;
export type OpenAIModel = (typeof OPENAI_MODELS)[number];

export type AiProvider = "claude" | "openai";

/** Interview: answer questions put to you. Meeting: help you contribute and take notes. */
export type AssistMode = "interview" | "meeting";

/** Natural: words to say aloud, like a person talking. Polished: crisp talking points. */
export type AnswerStyle = "natural" | "polished";

/** Brief: about 15-30 seconds spoken. Detailed: about a minute, with specifics. */
export type AnswerLength = "brief" | "detailed";

/** Settings as the window sees them: secrets are reported only as present/absent. */
export interface PublicSettings {
  sttProvider: SttProvider;
  language: string;
  speechmaticsRegion: SpeechmaticsRegion;
  aiProvider: AiProvider;
  model: ClaudeModel;
  openaiModel: OpenAIModel;
  mode: AssistMode;
  answerStyle: AnswerStyle;
  answerLength: AnswerLength;
  context: string;
  autoAnswer: boolean;
  hasDeepgramKey: boolean;
  hasSpeechmaticsKey: boolean;
  hasAnthropicKey: boolean;
  hasOpenAIKey: boolean;
}

/** A secret set to "" is cleared; an omitted secret is left unchanged. */
export interface SettingsUpdate {
  sttProvider?: SttProvider;
  language?: string;
  speechmaticsRegion?: SpeechmaticsRegion;
  aiProvider?: AiProvider;
  model?: ClaudeModel;
  openaiModel?: OpenAIModel;
  mode?: AssistMode;
  answerStyle?: AnswerStyle;
  answerLength?: AnswerLength;
  context?: string;
  autoAnswer?: boolean;
  deepgramKey?: string;
  speechmaticsKey?: string;
  anthropicKey?: string;
  openaiKey?: string;
}

export interface SessionInfo {
  /** True when the native echo canceller is cleaning the mic stream. */
  echoCancellation: boolean;
}

export interface TranscriptLine {
  speaker: Speaker;
  text: string;
}

export interface TranscriptEvent extends TranscriptLine {
  isFinal: boolean;
}

export interface AnswerRequest {
  /** "answer" suggests what to say next; "summary" writes meeting notes. */
  kind: "answer" | "summary";
  transcript: TranscriptLine[];
  question?: string;
}

export interface SaveCallRequest {
  startedAt: number;
  endedAt: number;
  meetingApp: string | null;
  transcript: TranscriptLine[];
  notes?: string;
}

export interface HistorySearch {
  /** What the user typed; empty lists the most recent calls. */
  query: string;
  offset?: number;
}

export interface HistoryItem {
  id: number;
  title: string;
  startedAt: number;
  endedAt: number;
  meetingApp: string | null;
  /** Matching excerpt. Highlighted terms are wrapped in \u0002 … \u0003. */
  snippet: string;
}

export interface HistoryPage {
  items: HistoryItem[];
  total: number;
  /** Offset for the next page, or null when there are no more results. */
  nextOffset: number | null;
}

export interface CallRecord {
  id: number;
  title: string;
  startedAt: number;
  endedAt: number;
  meetingApp: string | null;
  transcript: TranscriptLine[];
  notes: string;
}

export type AnswerEvent =
  | { id: number; type: "delta"; text: string }
  | { id: number; type: "done" }
  | { id: number; type: "error"; message: string };

export interface ParacatApi {
  getSettings(): Promise<PublicSettings>;
  updateSettings(update: SettingsUpdate): Promise<PublicSettings>;
  startSession(): Promise<SessionInfo>;
  stopSession(): Promise<void>;
  sendAudio(speaker: Speaker, pcm16: ArrayBuffer): void;
  ask(request: AnswerRequest): Promise<number>;
  cancelAnswer(): Promise<void>;
  setPrivateMode(on: boolean): Promise<void>;
  minimize(): Promise<void>;
  quit(): Promise<void>;
  onTranscript(listener: (event: TranscriptEvent) => void): void;
  onAnswer(listener: (event: AnswerEvent) => void): void;
  onSttError(listener: (message: string) => void): void;
  onShortcut(listener: (name: "answer") => void): void;
  /** The meeting app currently using a microphone, e.g. "Zoom", or null. */
  onMeetingApp(listener: (app: string | null) => void): void;
  saveCall(request: SaveCallRequest): Promise<number>;
  updateCallNotes(id: number, notes: string): Promise<void>;
  searchCalls(search: HistorySearch): Promise<HistoryPage>;
  getCall(id: number): Promise<CallRecord | null>;
  deleteCall(id: number): Promise<void>;
}
