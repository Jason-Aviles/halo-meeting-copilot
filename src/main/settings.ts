import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_MODELS,
  DEFAULT_LOCAL_URL,
  NOTES_FORMATS,
  OPENAI_MODELS,
  SPEECHMATICS_REGIONS,
  type AiProvider,
  type AnswerLength,
  type AnswerStyle,
  type AssistMode,
  type ClaudeModel,
  type NotesFormat,
  type OpenAIModel,
  type PublicSettings,
  type SettingsUpdate,
  type SpeechmaticsRegion,
  type SttProvider,
} from "../shared/types";
import { normalizeLocalUrl } from "./ai/local";
import { listSources } from "./sources";

type SecretName = "deepgramKey" | "speechmaticsKey" | "anthropicKey" | "openaiKey" | "jiraToken";
const SECRET_NAMES: SecretName[] = ["deepgramKey", "speechmaticsKey", "anthropicKey", "openaiKey", "jiraToken"];

interface StoredSettings {
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
  /** e.g. "yourcompany.atlassian.net" */
  jiraSite: string;
  jiraEmail: string;
  /** Each value is encrypted with the OS keychain (DPAPI on Windows) and base64-encoded. */
  secrets: Partial<Record<SecretName, string>>;
}

const DEFAULTS: StoredSettings = {
  sttProvider: "deepgram",
  language: "en",
  speechmaticsRegion: "eu2",
  aiProvider: "claude",
  model: "claude-opus-5-5",
  openaiModel: "gpt-5.5",
  localUrl: DEFAULT_LOCAL_URL,
  localModel: "",
  mode: "interview",
  answerStyle: "natural",
  answerLength: "brief",
  notesFormat: "standard",
  context: "",
  autoAnswer: false,
  jiraSite: "",
  jiraEmail: "",
  secrets: {},
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

let cache: StoredSettings | undefined;

function load(): StoredSettings {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    cache = { ...DEFAULTS, ...raw, secrets: { ...raw.secrets } };
  } catch {
    cache = { ...DEFAULTS, secrets: {} };
  }
  return cache!;
}

function save(settings: StoredSettings): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

/** Accepts "yourco", "yourco.atlassian.net" or a full link; keeps just the host. */
function normalizeJiraSite(input: string): string {
  const trimmed = String(input).trim();
  if (!trimmed) return "";
  let host = "";
  try {
    host = /^[a-z0-9-]+$/i.test(trimmed)
      ? `${trimmed}.atlassian.net`
      : new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    // Reported below.
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) throw new Error("Enter your Jira site, like yourcompany.atlassian.net");
  return host.toLowerCase();
}

export function getSettings(): StoredSettings {
  return load();
}

export function getSecret(name: SecretName): string | undefined {
  const stored = load().secrets[name];
  if (!stored) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}

export function toPublic(): PublicSettings {
  const s = load();
  return {
    sttProvider: s.sttProvider,
    language: s.language,
    speechmaticsRegion: s.speechmaticsRegion,
    aiProvider: s.aiProvider,
    model: s.model,
    openaiModel: s.openaiModel,
    localUrl: s.localUrl,
    localModel: s.localModel,
    mode: s.mode,
    answerStyle: s.answerStyle,
    answerLength: s.answerLength,
    notesFormat: s.notesFormat,
    context: s.context,
    autoAnswer: s.autoAnswer,
    sources: listSources(),
    jiraSite: s.jiraSite,
    jiraEmail: s.jiraEmail,
    hasJiraToken: Boolean(s.secrets.jiraToken),
    hasDeepgramKey: Boolean(s.secrets.deepgramKey),
    hasSpeechmaticsKey: Boolean(s.secrets.speechmaticsKey),
    hasAnthropicKey: Boolean(s.secrets.anthropicKey),
    hasOpenAIKey: Boolean(s.secrets.openaiKey),
  };
}

export function updateSettings(update: SettingsUpdate): PublicSettings {
  const s = load();

  if (update.sttProvider !== undefined) {
    if (update.sttProvider !== "deepgram" && update.sttProvider !== "speechmatics") {
      throw new Error(`Unknown speech-to-text provider: ${update.sttProvider}`);
    }
    s.sttProvider = update.sttProvider;
  }
  if (update.speechmaticsRegion !== undefined) {
    if (!SPEECHMATICS_REGIONS.includes(update.speechmaticsRegion)) {
      throw new Error(`Unknown Speechmatics region: ${update.speechmaticsRegion}`);
    }
    s.speechmaticsRegion = update.speechmaticsRegion;
  }
  if (update.language !== undefined) {
    if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$|^multi$/.test(update.language)) {
      throw new Error(`Language must be a code like "en", "es" or "multi"`);
    }
    s.language = update.language;
  }
  if (update.aiProvider !== undefined) {
    if (update.aiProvider !== "claude" && update.aiProvider !== "openai" && update.aiProvider !== "local") {
      throw new Error(`Unknown AI provider: ${update.aiProvider}`);
    }
    s.aiProvider = update.aiProvider;
  }
  if (update.openaiModel !== undefined) {
    if (!OPENAI_MODELS.includes(update.openaiModel)) {
      throw new Error(`Unknown OpenAI model: ${update.openaiModel}`);
    }
    s.openaiModel = update.openaiModel;
  }
  if (update.localUrl !== undefined) s.localUrl = normalizeLocalUrl(update.localUrl || DEFAULT_LOCAL_URL);
  if (update.localModel !== undefined) s.localModel = String(update.localModel).trim().slice(0, 300);
  if (update.answerStyle !== undefined) {
    if (update.answerStyle !== "natural" && update.answerStyle !== "polished") {
      throw new Error(`Unknown answer style: ${update.answerStyle}`);
    }
    s.answerStyle = update.answerStyle;
  }
  if (update.answerLength !== undefined) {
    if (update.answerLength !== "brief" && update.answerLength !== "detailed") {
      throw new Error(`Unknown answer length: ${update.answerLength}`);
    }
    s.answerLength = update.answerLength;
  }
  if (update.notesFormat !== undefined) {
    if (!NOTES_FORMATS.includes(update.notesFormat)) throw new Error(`Unknown notes format: ${update.notesFormat}`);
    s.notesFormat = update.notesFormat;
  }
  if (update.model !== undefined) {
    if (!CLAUDE_MODELS.includes(update.model)) throw new Error(`Unknown model: ${update.model}`);
    s.model = update.model;
  }
  if (update.mode !== undefined) {
    if (update.mode !== "interview" && update.mode !== "meeting") {
      throw new Error(`Unknown mode: ${update.mode}`);
    }
    s.mode = update.mode;
  }
  if (update.context !== undefined) s.context = String(update.context).slice(0, 20_000);
  if (update.autoAnswer !== undefined) s.autoAnswer = Boolean(update.autoAnswer);
  if (update.jiraSite !== undefined) s.jiraSite = normalizeJiraSite(update.jiraSite);
  if (update.jiraEmail !== undefined) s.jiraEmail = String(update.jiraEmail).trim().slice(0, 200);

  for (const name of SECRET_NAMES) {
    const value = update[name];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed === "") {
      delete s.secrets[name];
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Secure storage isn't available on this system, so keys can't be saved.");
      }
      s.secrets[name] = safeStorage.encryptString(trimmed).toString("base64");
    }
  }

  save(s);
  return toPublic();
}
