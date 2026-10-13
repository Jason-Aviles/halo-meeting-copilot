import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  SPEECHMATICS_REGIONS,
  type AiProvider,
  type AnswerLength,
  type AnswerStyle,
  type AssistMode,
  type ClaudeModel,
  type OpenAIModel,
  type PublicSettings,
  type SettingsUpdate,
  type SpeechmaticsRegion,
  type SttProvider,
} from "../shared/types";

type SecretName = "deepgramKey" | "speechmaticsKey" | "anthropicKey" | "openaiKey";
const SECRET_NAMES: SecretName[] = ["deepgramKey", "speechmaticsKey", "anthropicKey", "openaiKey"];

interface StoredSettings {
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
  mode: "interview",
  answerStyle: "natural",
  answerLength: "brief",
  context: "",
  autoAnswer: false,
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
    mode: s.mode,
    answerStyle: s.answerStyle,
    answerLength: s.answerLength,
    context: s.context,
    autoAnswer: s.autoAnswer,
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
    if (update.aiProvider !== "claude" && update.aiProvider !== "openai") {
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
