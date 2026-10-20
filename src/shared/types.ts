export type SttProvider = "deepgram" | "speechmatics";

/** "you" is the microphone; "them" is everything playing through the speakers. */
export type Speaker = "you" | "them";

export const SPEECHMATICS_REGIONS = ["eu2", "us2"] as const;
export type SpeechmaticsRegion = (typeof SPEECHMATICS_REGIONS)[number];

export const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  // Older models, all still active on the Claude API.
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];

export const OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.4-mini",
  // Older models.
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
] as const;
export type OpenAIModel = (typeof OPENAI_MODELS)[number];

/** "local" is any OpenAI-compatible server on your machine or network, such as LM Studio or Ollama. */
export type AiProvider = "claude" | "openai" | "local";

export const DEFAULT_LOCAL_URL = "http://localhost:1234/v1";

/** The tickets assigned to you that aren't done, most recently updated first. */
export const DEFAULT_JIRA_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/** A document, folder or repository whose text answers can draw on. */
export interface SourceInfo {
  id: string;
  kind: "file" | "folder" | "github" | "jira";
  /** A file or folder path, a GitHub URL, or a Jira JQL query. */
  location: string;
  title: string;
  /** Included in answers when true. */
  enabled: boolean;
  /** Characters of text captured on the last refresh. */
  chars: number;
  /** How many files that text came from. */
  files: number;
  refreshedAt: number;
}

/** Interview: answer questions put to you. Meeting: help you contribute and take notes. */
export type AssistMode = "interview" | "meeting";

/** Natural: words to say aloud, like a person talking. Polished: crisp talking points. */
export type AnswerStyle = "natural" | "polished";

/** Brief: about 15-30 seconds spoken. Detailed: about a minute, with specifics. */
export type AnswerLength = "brief" | "detailed";

/** Which minutes template Summarize uses in Meeting mode. Interview mode always writes a debrief. */
export const NOTES_FORMATS = ["standard", "client", "kickoff", "board", "brainstorm"] as const;
export type NotesFormat = (typeof NOTES_FORMATS)[number];

/** Settings as the window sees them: secrets are reported only as present/absent. */
export interface PublicSettings {
  sttProvider: SttProvider;
  language: string;
  speechmaticsRegion: SpeechmaticsRegion;
  aiProvider: AiProvider;
  model: ClaudeModel;
  openaiModel: OpenAIModel;
  localUrl: string;
  localModel: string;
  mode: AssistMode;
  answerStyle: AnswerStyle;
  answerLength: AnswerLength;
  notesFormat: NotesFormat;
  context: string;
  autoAnswer: boolean;
  sources: SourceInfo[];
  jiraSite: string;
  jiraEmail: string;
  hasJiraToken: boolean;
  hasGithubToken: boolean;
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
  localUrl?: string;
  localModel?: string;
  mode?: AssistMode;
  answerStyle?: AnswerStyle;
  answerLength?: AnswerLength;
  notesFormat?: NotesFormat;
  context?: string;
  autoAnswer?: boolean;
  jiraSite?: string;
  jiraEmail?: string;
  jiraToken?: string;
  githubToken?: string;
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
  /** For an answer, what to answer; for a summary, extra instructions such as "focus on the budget". */
  question?: string;
  /** When the call started and where, for the notes header. */
  meeting?: { startedAt: number; app: string | null; endedAt?: number };
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

export interface HaloApi {
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
  /** A message from the main process for the user, e.g. a hotkey that couldn't be registered. */
  onNotice(listener: (message: string) => void): void;
  /** The meeting app currently using a microphone, e.g. "Zoom", or null. */
  onMeetingApp(listener: (app: string | null) => void): void;
  saveCall(request: SaveCallRequest): Promise<number>;
  updateCallNotes(id: number, notes: string): Promise<void>;
  searchCalls(search: HistorySearch): Promise<HistoryPage>;
  getCall(id: number): Promise<CallRecord | null>;
  deleteCall(id: number): Promise<void>;
  /** Model ids offered by a local server, e.g. LM Studio's loaded models. */
  listLocalModels(url: string): Promise<string[]>;
  /** Each of these opens a picker or fetches, then returns the updated list. */
  addSourceFiles(): Promise<SourceInfo[]>;
  addSourceFolder(): Promise<SourceInfo[]>;
  addSourceGithub(url: string): Promise<SourceInfo[]>;
  /** Uses the Jira site, email and token saved in Settings. */
  addSourceJira(jql: string): Promise<SourceInfo[]>;
  refreshSource(id: string): Promise<SourceInfo[]>;
  removeSource(id: string): Promise<SourceInfo[]>;
  setSourceEnabled(id: string, enabled: boolean): Promise<SourceInfo[]>;
}
