import type {
  AnswerLength,
  AnswerStyle,
  ParacatApi,
  PublicSettings,
  Speaker,
  TranscriptEvent,
  TranscriptLine,
} from "../shared/types";
import { AudioCapture } from "./audio";
import { initHistory, showView, type View } from "./history";

declare global {
  interface Window {
    paracat: ParacatApi;
  }
}

const api = window.paracat;

/** How many recent transcript lines to send with each answer request. */
const MAX_LINES_SENT = 300;
/** Wait this long after a question ends before auto-answering, in case they keep talking. */
const AUTO_ANSWER_DELAY_MS = 800;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  statusDot: $("status-dot"),
  status: $("status"),
  viewMain: $("view-main"),
  viewSettings: $("view-settings"),
  btnSession: $<HTMLButtonElement>("btn-session"),
  chkPrivate: $<HTMLInputElement>("chk-private"),
  transcript: $("transcript"),
  transcriptEmpty: $("transcript-empty"),
  answer: $("answer"),
  answerTitle: $("answer-title"),
  formAsk: $<HTMLFormElement>("form-ask"),
  question: $<HTMLInputElement>("input-question"),
  error: $("error"),
  formSettings: $<HTMLFormElement>("form-settings"),
  setProvider: $<HTMLSelectElement>("set-provider"),
  setLanguage: $<HTMLInputElement>("set-language"),
  setDeepgram: $<HTMLInputElement>("set-deepgram"),
  setSpeechmatics: $<HTMLInputElement>("set-speechmatics"),
  setRegion: $<HTMLSelectElement>("set-region"),
  setAnthropic: $<HTMLInputElement>("set-anthropic"),
  setMode: $<HTMLSelectElement>("set-mode"),
  setAi: $<HTMLSelectElement>("set-ai"),
  setOpenaiModel: $<HTMLSelectElement>("set-openai-model"),
  setOpenai: $<HTMLInputElement>("set-openai"),
  setModel: $<HTMLSelectElement>("set-model"),
  setAuto: $<HTMLInputElement>("set-auto"),
  setContext: $<HTMLTextAreaElement>("set-context"),
};

const state = {
  settings: undefined as PublicSettings | undefined,
  listening: false,
  lines: [] as TranscriptLine[],
  interim: { you: "", them: "" } as Record<Speaker, string>,
  answerId: 0,
  answerKind: "answer" as "answer" | "summary",
  meetingApp: null as string | null,
  echoCancellation: false,
  callStartedAt: 0,
  /** Id of the call saved when listening last stopped; a later summary is attached to it. */
  savedCallId: null as number | null,
  lastSummary: "",
  autoTimer: undefined as number | undefined,
};

const audio = new AudioCapture();

// ---------- helpers ----------

function setStatus(text: string): void {
  el.status.textContent = text;
  el.statusDot.classList.toggle("live", state.listening);
}

function listeningStatus(): string {
  const parts = ["Listening", state.settings?.sttProvider === "speechmatics" ? "Speechmatics" : "Deepgram"];
  if (state.meetingApp) parts.push(state.meetingApp);
  if (!state.echoCancellation) parts.push("no echo cancel: use headphones");
  return parts.join(" · ");
}

function showError(message: string | undefined): void {
  el.error.hidden = !message;
  el.error.textContent = message ?? "";
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Errors thrown in the main process arrive wrapped by Electron.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ---------- transcript ----------

function renderTranscript(): void {
  const atBottom =
    el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 40;

  el.transcript.replaceChildren();
  const rows: Array<TranscriptLine & { interim?: boolean }> = [...state.lines];
  for (const speaker of ["them", "you"] as const) {
    if (state.interim[speaker]) rows.push({ speaker, text: state.interim[speaker], interim: true });
  }

  if (rows.length === 0) {
    el.transcript.append(el.transcriptEmpty);
    return;
  }

  for (const row of rows) {
    const p = document.createElement("p");
    p.className = row.speaker + (row.interim ? " interim" : "");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = row.speaker === "them" ? "Them" : "You";
    p.append(who, document.createTextNode(row.text));
    el.transcript.append(p);
  }

  if (atBottom) el.transcript.scrollTop = el.transcript.scrollHeight;
}

function onTranscript(event: TranscriptEvent): void {
  if (!event.isFinal) {
    state.interim[event.speaker] = event.text;
  } else {
    state.interim[event.speaker] = "";
    const last = state.lines[state.lines.length - 1];
    // Merge consecutive finals from the same speaker into one line.
    if (last && last.speaker === event.speaker) last.text += " " + event.text;
    else state.lines.push({ speaker: event.speaker, text: event.text });

    if (event.speaker === "them" && state.settings?.autoAnswer && /\?\s*$/.test(event.text)) {
      window.clearTimeout(state.autoTimer);
      state.autoTimer = window.setTimeout(() => void ask(), AUTO_ANSWER_DELAY_MS);
    }
  }
  renderTranscript();
}

// ---------- session ----------

async function startListening(): Promise<void> {
  showError(undefined);
  el.btnSession.disabled = true;
  setStatus("Starting…");
  try {
    const session = await api.startSession();
    state.echoCancellation = session.echoCancellation;
    await audio.start((speaker, pcm16) => api.sendAudio(speaker, pcm16), session.echoCancellation);
    state.listening = true;
    state.callStartedAt = Date.now();
    state.savedCallId = null;
    state.lastSummary = "";
    el.btnSession.textContent = "Stop listening";
    setStatus(listeningStatus());
  } catch (err) {
    await api.stopSession().catch(() => {});
    state.listening = false;
    setStatus("Idle");
    showError(errorText(err));
  } finally {
    el.btnSession.disabled = false;
  }
}

async function stopListening(): Promise<void> {
  audio.stop();
  await api.stopSession().catch(() => {});
  state.listening = false;
  state.interim = { you: "", them: "" };
  el.btnSession.textContent = "Start listening";
  setStatus("Idle");
  renderTranscript();
  await saveCurrentCall();
}

async function saveCurrentCall(): Promise<void> {
  if (state.lines.length === 0) return;
  try {
    state.savedCallId = await api.saveCall({
      startedAt: state.callStartedAt || Date.now(),
      endedAt: Date.now(),
      meetingApp: state.meetingApp,
      transcript: state.lines,
      notes: state.lastSummary,
    });
    setStatus("Idle · call saved to history");
  } catch (err) {
    showError(`Couldn't save this call: ${errorText(err)}`);
  }
}

// ---------- answers ----------

async function ask(kind: "answer" | "summary" = "answer"): Promise<void> {
  window.clearTimeout(state.autoTimer);
  showError(undefined);
  const question = kind === "answer" ? el.question.value : "";
  if (kind === "answer") el.question.value = "";
  el.answerTitle.textContent = kind === "summary" ? "Meeting notes" : "Suggested answer";
  state.answerKind = kind;

  const transcript = [...state.lines];
  for (const speaker of ["them", "you"] as const) {
    if (state.interim[speaker]) transcript.push({ speaker, text: state.interim[speaker] });
  }

  el.answer.textContent = "";
  el.answer.classList.add("pending");
  // The main process numbers requests 1, 2, 3…; claim the next id now so events
  // from the request this one replaces are ignored even before ask() resolves.
  state.answerId++;
  try {
    state.answerId = await api.ask({
      kind,
      // Notes cover the whole call; answers only need the recent part.
      transcript: kind === "summary" ? transcript : transcript.slice(-MAX_LINES_SENT),
      question,
    });
  } catch (err) {
    el.answer.classList.remove("pending");
    showError(errorText(err));
  }
}

api.onAnswer((event) => {
  // Ignore events from an answer that a newer request replaced.
  if (event.id !== state.answerId) return;
  if (event.type === "delta") {
    el.answer.textContent += event.text;
    el.answer.scrollTop = el.answer.scrollHeight;
  } else {
    el.answer.classList.remove("pending");
    if (event.type === "done" && state.answerKind === "summary") {
      state.lastSummary = el.answer.textContent ?? "";
      if (state.savedCallId !== null && state.lastSummary) {
        void api.updateCallNotes(state.savedCallId, state.lastSummary).catch(() => {});
      }
    }
    if (event.type === "error") showError(event.message);
  }
});

// ---------- settings ----------

function keyPlaceholder(saved: boolean): string {
  return saved ? "Saved. Type to replace" : "Not set";
}

function fillSettingsForm(s: PublicSettings): void {
  el.setProvider.value = s.sttProvider;
  el.setMode.value = s.mode;
  el.setAi.value = s.aiProvider;
  el.setOpenaiModel.value = s.openaiModel;
  el.setModel.value = s.model;
  el.setLanguage.value = s.language;
  el.setRegion.value = s.speechmaticsRegion;
  el.setAuto.checked = s.autoAnswer;
  el.setContext.value = s.context;
  const keyFields: Array<[HTMLInputElement, boolean]> = [
    [el.setDeepgram, s.hasDeepgramKey],
    [el.setSpeechmatics, s.hasSpeechmaticsKey],
    [el.setAnthropic, s.hasAnthropicKey],
    [el.setOpenai, s.hasOpenAIKey],
  ];
  for (const [input, saved] of keyFields) {
    input.value = "";
    input.placeholder = keyPlaceholder(saved);
  }
}

function showSettings(show: boolean): void {
  showView(show ? "settings" : "main");
  if (show && state.settings) fillSettingsForm(state.settings);
}

el.formSettings.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyValue = (input: HTMLInputElement) => (input.value.trim() ? input.value.trim() : undefined);
  try {
    state.settings = await api.updateSettings({
      sttProvider: el.setProvider.value as PublicSettings["sttProvider"],
      language: el.setLanguage.value.trim() || "en",
      speechmaticsRegion: el.setRegion.value as PublicSettings["speechmaticsRegion"],
      mode: el.setMode.value as PublicSettings["mode"],
      aiProvider: el.setAi.value as PublicSettings["aiProvider"],
      openaiModel: el.setOpenaiModel.value as PublicSettings["openaiModel"],
      model: el.setModel.value as PublicSettings["model"],
      autoAnswer: el.setAuto.checked,
      context: el.setContext.value,
      deepgramKey: keyValue(el.setDeepgram),
      speechmaticsKey: keyValue(el.setSpeechmatics),
      anthropicKey: keyValue(el.setAnthropic),
      openaiKey: keyValue(el.setOpenai),
    });
    showError(undefined);
    showSettings(false);
    renderStyleToggles();
    if (state.listening) setStatus("Settings saved. Restart listening to apply them");
  } catch (err) {
    showSettings(false);
    showError(errorText(err));
  }
});

// ---------- answer style toggles ----------

const styleButtons = document.querySelectorAll<HTMLButtonElement>("[data-style]");
const lengthButtons = document.querySelectorAll<HTMLButtonElement>("[data-length]");

function renderStyleToggles(): void {
  const s = state.settings;
  for (const b of styleButtons) b.setAttribute("aria-pressed", String(b.dataset.style === s?.answerStyle));
  for (const b of lengthButtons) b.setAttribute("aria-pressed", String(b.dataset.length === s?.answerLength));
}

async function setAnswerFormat(update: { answerStyle?: AnswerStyle; answerLength?: AnswerLength }) {
  try {
    state.settings = await api.updateSettings(update);
    renderStyleToggles();
  } catch (err) {
    showError(errorText(err));
  }
}

for (const b of styleButtons) {
  b.addEventListener("click", () => void setAnswerFormat({ answerStyle: b.dataset.style as AnswerStyle }));
}
for (const b of lengthButtons) {
  b.addEventListener("click", () => void setAnswerFormat({ answerLength: b.dataset.length as AnswerLength }));
}

// ---------- wiring ----------

el.btnSession.addEventListener("click", () => {
  void (state.listening ? stopListening() : startListening());
});
el.chkPrivate.addEventListener("change", () => void api.setPrivateMode(el.chkPrivate.checked));
el.formAsk.addEventListener("submit", (event) => {
  event.preventDefault();
  void ask();
});
$("btn-summary").addEventListener("click", () => void ask("summary"));
$("btn-clear").addEventListener("click", () => {
  state.lines = [];
  state.interim = { you: "", them: "" };
  renderTranscript();
});
$("btn-settings").addEventListener("click", () => showSettings(Boolean(el.viewSettings.hidden)));
initHistory(api, { onError: (message) => showError(message) });
$("btn-settings-cancel").addEventListener("click", () => showSettings(false));
$("btn-minimize").addEventListener("click", () => void api.minimize());
$("btn-close").addEventListener("click", () => void api.quit());

api.onTranscript(onTranscript);
api.onSttError((message) => showError(message));
api.onMeetingApp((app) => {
  state.meetingApp = app;
  if (state.listening) setStatus(listeningStatus());
});
api.onShortcut((name) => {
  if (name === "answer") void ask();
});

void api.getSettings().then((s) => {
  state.settings = s;
  renderStyleToggles();
  const sttKey = s.sttProvider === "deepgram" ? s.hasDeepgramKey : s.hasSpeechmaticsKey;
  const aiKey = s.aiProvider === "openai" ? s.hasOpenAIKey : s.hasAnthropicKey;
  if (!sttKey || !aiKey) showSettings(true);
});
