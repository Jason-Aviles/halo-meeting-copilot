import type {
  AnswerLength,
  AnswerStyle,
  AssistMode,
  HaloApi,
  NotesFormat,
  PublicSettings,
  Speaker,
  TranscriptEvent,
  TranscriptLine,
} from "../shared/types";
import { AudioCapture } from "./audio";
import { initHistory, showView, type View } from "./history";
import { renderMarkdown } from "./markdown";
import { endsWithQuestion } from "./questions";
import { initReferences } from "./references";
import { TranscriptView } from "./transcript-view";

declare global {
  interface Window {
    halo: HaloApi;
  }
}

const api = window.halo;

/** How many recent transcript lines to send with each answer request. */
const MAX_LINES_SENT = 300;
/**
 * Wait this long after their last words before auto-answering. Any new speech
 * from them in the meantime resets it, so a pause mid-question doesn't trigger.
 */
const AUTO_ANSWER_DELAY_MS = 900;

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
  setStt: $<HTMLSelectElement>("set-stt"),
  sttKeyLabel: $("stt-key-label"),
  setSttKey: $<HTMLInputElement>("set-stt-key"),
  setLanguage: $<HTMLInputElement>("set-language"),
  setAiModel: $<HTMLSelectElement>("set-ai-model"),
  aiKeyLabel: $("ai-key-label"),
  setAiKey: $<HTMLInputElement>("set-ai-key"),
  setAuto: $<HTMLInputElement>("set-auto"),
  setNotesFormat: $<HTMLSelectElement>("set-notes-format"),
  setContext: $<HTMLTextAreaElement>("set-context"),
  aiKeyField: $("ai-key-field"),
  localFields: $("local-fields"),
  setLocalUrl: $<HTMLInputElement>("set-local-url"),
  setLocalModel: $<HTMLInputElement>("set-local-model"),
  localModels: $<HTMLDataListElement>("local-models"),
  localStatus: $("local-status"),
  btnLocalRefresh: $<HTMLButtonElement>("btn-local-refresh"),
  settingsError: $("settings-error"),
  chipModelText: $("chip-model-text"),
  btnCopy: $<HTMLButtonElement>("btn-copy"),
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
  callEndedAt: 0,
  /** The meeting app seen during the current or last call; it stays after the call ends. */
  lastMeetingApp: null as string | null,
  /** Id of the call saved when listening last stopped; a later summary is attached to it. */
  savedCallId: null as number | null,
  lastSummary: "",
  autoTimer: undefined as number | undefined,
  /** The "Them" turn last auto-answered, so the same question isn't answered twice. */
  lastAutoAnswered: "",
};

const audio = new AudioCapture();

/** Streamed answer text: chunks are appended to one text node rather than re-copying the whole answer. */
let answerText = document.createTextNode("");
/** The raw Markdown of the minutes being written; re-rendered at most once a frame. */
let notesMarkdown = "";
let notesFrame = 0;

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
  // Show it wherever the user is looking: the settings form has its own slot.
  const inSettings = !el.viewSettings.hidden;
  const target = inSettings ? el.settingsError : el.error;
  const other = inSettings ? el.error : el.settingsError;
  target.hidden = !message;
  target.textContent = message ?? "";
  other.hidden = true;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Errors thrown in the main process arrive wrapped by Electron.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// ---------- transcript ----------

const transcriptView = new TranscriptView(el.transcript, el.transcriptEmpty);

/** Full redraw from state; only used when a call starts or the transcript is cleared. */
function renderTranscript(): void {
  transcriptView.reset(state.lines);
  for (const speaker of ["them", "you"] as const) {
    transcriptView.setPartial(speaker, state.interim[speaker]);
  }
}

function onTranscript(event: TranscriptEvent): void {
  if (!event.isFinal) {
    state.interim[event.speaker] = event.text;
    transcriptView.setPartial(event.speaker, event.text);
    // They're still talking, so a pending auto-answer waits for them to finish.
    if (event.speaker === "them" && event.text.trim()) window.clearTimeout(state.autoTimer);
  } else {
    state.interim[event.speaker] = "";
    transcriptView.setPartial(event.speaker, "");
    const last = state.lines[state.lines.length - 1];
    // Merge consecutive finals from the same speaker into one line.
    if (last && last.speaker === event.speaker) {
      last.text += " " + event.text;
      transcriptView.updateLast(last.text);
    } else {
      const line = { speaker: event.speaker, text: event.text };
      state.lines.push(line);
      transcriptView.append(line);
    }

    if (event.speaker === "them" && state.listening && state.settings?.autoAnswer) {
      window.clearTimeout(state.autoTimer);
      // Judge their whole turn so far, not just this chunk: questions often span chunks.
      const turn = state.lines[state.lines.length - 1];
      if (turn.speaker === "them" && turn.text !== state.lastAutoAnswered && endsWithQuestion(turn.text)) {
        state.autoTimer = window.setTimeout(() => {
          state.lastAutoAnswered = turn.text;
          void ask();
        }, AUTO_ANSWER_DELAY_MS);
      }
    }
  }
}

// ---------- session ----------

async function startListening(): Promise<void> {
  showError(undefined);
  el.btnSession.disabled = true;
  setStatus("Starting…");
  // Reset before starting: the main process reports the meeting app while it starts.
  state.lastMeetingApp = null;
  try {
    const session = await api.startSession();
    state.echoCancellation = session.echoCancellation;
    await audio.start((speaker, pcm16) => api.sendAudio(speaker, pcm16), session.echoCancellation);
    state.listening = true;
    // Each call gets its own transcript (and its own saved history entry).
    state.lines = [];
    state.interim = { you: "", them: "" };
    renderTranscript();
    state.callStartedAt = Date.now();
    state.callEndedAt = 0;
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
  el.btnSession.disabled = true;
  setStatus("Finishing…");
  // Resolves after both services have sent their final results.
  await api.stopSession().catch(() => {});
  el.btnSession.disabled = false;
  state.listening = false;
  state.callEndedAt = Date.now();
  // Keep any words still only in a partial result rather than dropping them.
  for (const speaker of ["them", "you"] as const) {
    const text = state.interim[speaker].trim();
    if (text) onTranscript({ speaker, text, isFinal: true });
  }
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
      endedAt: state.callEndedAt || Date.now(),
      meetingApp: state.lastMeetingApp,
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
  // For minutes, anything typed in the box becomes extra instructions ("focus on the budget").
  const question = el.question.value;
  el.question.value = "";
  const interview = state.settings?.mode === "interview";
  el.answerTitle.textContent = kind === "summary" ? (interview ? "Interview debrief" : "Minutes") : "Suggested answer";
  state.answerKind = kind;
  el.answer.classList.toggle("notes", kind === "summary");
  el.btnCopy.hidden = true;
  notesMarkdown = "";

  const transcript = [...state.lines];
  for (const speaker of ["them", "you"] as const) {
    if (state.interim[speaker]) transcript.push({ speaker, text: state.interim[speaker] });
  }

  answerText = document.createTextNode("");
  el.answer.replaceChildren(answerText);
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
      meeting: {
        startedAt: state.callStartedAt || Date.now(),
        app: state.meetingApp ?? state.lastMeetingApp,
        // After the call, its length is fixed rather than still counting.
        ...(!state.listening && state.callEndedAt ? { endedAt: state.callEndedAt } : {}),
      },
    });
  } catch (err) {
    el.answer.classList.remove("pending");
    // Give the typed question back so it can be sent again after fixing the problem.
    if (question && !el.question.value) el.question.value = question;
    showError(errorText(err));
  }
}

api.onAnswer((event) => {
  // Ignore events from an answer that a newer request replaced.
  if (event.id !== state.answerId) return;
  if (event.type === "delta") {
    if (state.answerKind === "summary") {
      notesMarkdown += event.text;
      if (!notesFrame) {
        notesFrame = requestAnimationFrame(() => {
          notesFrame = 0;
          renderMarkdown(el.answer, notesMarkdown);
          el.answer.scrollTop = el.answer.scrollHeight;
        });
      }
    } else {
      answerText.appendData(event.text);
      el.answer.scrollTop = el.answer.scrollHeight;
    }
  } else {
    el.answer.classList.remove("pending");
    if (state.answerKind === "summary" && notesMarkdown) {
      cancelAnimationFrame(notesFrame);
      notesFrame = 0;
      renderMarkdown(el.answer, notesMarkdown);
    }
    el.btnCopy.hidden = !(el.answer.textContent ?? "").trim();
    if (event.type === "done" && state.answerKind === "summary") {
      state.lastSummary = notesMarkdown;
      if (state.savedCallId !== null && state.lastSummary) {
        void api.updateCallNotes(state.savedCallId, state.lastSummary).catch(() => {});
      }
    }
    if (event.type === "error") showError(event.message);
  }
});

// ---------- settings ----------

// Settings shows one "service" and one "model" dropdown; each value encodes
// what used to be two separate dropdowns (provider + region, provider + model).

function sttChoice(s: PublicSettings): string {
  return s.sttProvider === "speechmatics" ? `speechmatics:${s.speechmaticsRegion}` : "deepgram";
}

function aiChoice(s: PublicSettings): string {
  if (s.aiProvider === "local") return "local:";
  return s.aiProvider === "openai" ? `openai:${s.openaiModel}` : `claude:${s.model}`;
}

/** A short name for the model chip, e.g. "Opus 5.5" or "Local · qwen3-8b". */
function modelLabel(s: PublicSettings): string {
  if (s.aiProvider === "local") return s.localModel ? `Local · ${s.localModel.split("/").pop()}` : "Local";
  const option = [...el.setAiModel.options].find((o) => o.value === aiChoice(s));
  return (option?.textContent ?? s.model).split(" · ")[0].replace(/^Claude /, "");
}

function renderModelChip(): void {
  if (state.settings) el.chipModelText.textContent = modelLabel(state.settings);
}

/** Shows the key field for whichever service is selected; other saved keys are kept. */
function refreshKeyFields(): void {
  const s = state.settings;
  const speechmatics = el.setStt.value.startsWith("speechmatics");
  el.sttKeyLabel.textContent = speechmatics ? "Speechmatics API key" : "Deepgram API key";
  el.setSttKey.placeholder = (speechmatics ? s?.hasSpeechmaticsKey : s?.hasDeepgramKey)
    ? "Saved. Type to replace"
    : "Paste your key";

  const local = el.setAiModel.value.startsWith("local:");
  el.aiKeyField.hidden = local;
  el.localFields.hidden = !local;

  const openai = el.setAiModel.value.startsWith("openai:");
  el.aiKeyLabel.textContent = openai ? "OpenAI API key" : "Anthropic API key";
  el.setAiKey.placeholder = (openai ? s?.hasOpenAIKey : s?.hasAnthropicKey)
    ? "Saved. Type to replace"
    : "Paste your key";
}

function fillSettingsForm(s: PublicSettings): void {
  el.setStt.value = sttChoice(s);
  el.setAiModel.value = aiChoice(s);
  el.setLanguage.value = s.language;
  el.setAuto.checked = s.autoAnswer;
  el.setContext.value = s.context;
  el.setNotesFormat.value = s.notesFormat;
  el.setLocalUrl.value = s.localUrl;
  el.setLocalModel.value = s.localModel;
  el.setSttKey.value = "";
  el.setAiKey.value = "";
  refreshKeyFields();
}

el.setStt.addEventListener("change", () => {
  el.setSttKey.value = "";
  refreshKeyFields();
});
el.setAiModel.addEventListener("change", () => {
  el.setAiKey.value = "";
  refreshKeyFields();
});

type SettingsTab = "speech" | "ai" | "context";
const tabButtons = document.querySelectorAll<HTMLButtonElement>("[data-tab]");
const panes = document.querySelectorAll<HTMLElement>("[data-pane]");

function showTab(tab: SettingsTab): void {
  for (const b of tabButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
    b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  for (const p of panes) p.hidden = p.dataset.pane !== tab;
}
for (const b of tabButtons) b.addEventListener("click", () => showTab(b.dataset.tab as SettingsTab));

function showSettings(show: boolean, tab?: SettingsTab): void {
  el.settingsError.hidden = true;
  showView(show ? "settings" : "main");
  if (show && state.settings) fillSettingsForm(state.settings);
  if (show) showTab(tab ?? "speech");
}

async function findLocalModels(): Promise<void> {
  el.btnLocalRefresh.disabled = true;
  el.localStatus.textContent = "Asking the server…";
  try {
    const models = await api.listLocalModels(el.setLocalUrl.value || "http://localhost:1234/v1");
    el.localModels.replaceChildren(
      ...models.map((id) => Object.assign(document.createElement("option"), { value: id })),
    );
    if (models.length && !models.includes(el.setLocalModel.value)) el.setLocalModel.value = models[0];
    el.localStatus.textContent = models.length
      ? `Found ${models.length} model${models.length === 1 ? "" : "s"}. Pick one from the list.`
      : "The server is running but has no models loaded. Load one in LM Studio first.";
  } catch {
    el.localStatus.textContent = "Couldn't reach the server. Start LM Studio's local server (or Ollama) and try again.";
  } finally {
    el.btnLocalRefresh.disabled = false;
  }
}
el.btnLocalRefresh.addEventListener("click", () => void findLocalModels());

el.formSettings.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [sttProvider, region] = el.setStt.value.split(":") as [
    PublicSettings["sttProvider"],
    PublicSettings["speechmaticsRegion"] | undefined,
  ];
  const [aiProvider, aiModel] = el.setAiModel.value.split(/:(.*)/s) as [PublicSettings["aiProvider"], string];
  const sttKey = el.setSttKey.value.trim() || undefined;
  const aiKey = el.setAiKey.value.trim() || undefined;
  const aiUpdate =
    aiProvider === "local"
      ? { localUrl: el.setLocalUrl.value, localModel: el.setLocalModel.value }
      : aiProvider === "openai"
        ? { openaiModel: aiModel as PublicSettings["openaiModel"], openaiKey: aiKey }
        : { model: aiModel as PublicSettings["model"], anthropicKey: aiKey };

  try {
    state.settings = await api.updateSettings({
      sttProvider,
      ...(region ? { speechmaticsRegion: region } : {}),
      language: el.setLanguage.value.trim() || "en",
      aiProvider,
      ...aiUpdate,
      ...(sttProvider === "speechmatics" ? { speechmaticsKey: sttKey } : { deepgramKey: sttKey }),
      autoAnswer: el.setAuto.checked,
      notesFormat: el.setNotesFormat.value as NotesFormat,
      context: el.setContext.value,
    });
    showSettings(false);
    showError(undefined);
    renderToggles();
    renderModelChip();
    references.render();
    if (state.listening) setStatus("Settings saved. Restart listening to apply them");
  } catch (err) {
    // Stay on the form so the problem can be fixed.
    showError(errorText(err));
  }
});

const references = initReferences(api, {
  getSources: () => state.settings?.sources ?? [],
  onChange: (sources) => {
    if (state.settings) state.settings.sources = sources;
  },
  onError: (message) => showError(message),
  onManage: () => showSettings(true, "context"),
});

// ---------- one-tap toggles: mode, answer style, answer length ----------

const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
const styleButtons = document.querySelectorAll<HTMLButtonElement>("[data-style]");
const lengthButtons = document.querySelectorAll<HTMLButtonElement>("[data-length]");

function renderToggles(): void {
  const s = state.settings;
  for (const b of modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === s?.mode));
  for (const b of styleButtons) b.setAttribute("aria-pressed", String(b.dataset.style === s?.answerStyle));
  for (const b of lengthButtons) b.setAttribute("aria-pressed", String(b.dataset.length === s?.answerLength));
}

async function setToggle(update: { mode?: AssistMode; answerStyle?: AnswerStyle; answerLength?: AnswerLength }) {
  try {
    state.settings = await api.updateSettings(update);
    renderToggles();
  } catch (err) {
    showError(errorText(err));
  }
}

for (const b of modeButtons) {
  b.addEventListener("click", () => void setToggle({ mode: b.dataset.mode as AssistMode }));
}
for (const b of styleButtons) {
  b.addEventListener("click", () => void setToggle({ answerStyle: b.dataset.style as AnswerStyle }));
}
for (const b of lengthButtons) {
  b.addEventListener("click", () => void setToggle({ answerLength: b.dataset.length as AnswerLength }));
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
$("chip-model").addEventListener("click", () => showSettings(true, "ai"));
el.btnCopy.addEventListener("click", async () => {
  const text = state.answerKind === "summary" ? notesMarkdown : (el.answer.textContent ?? "");
  try {
    await navigator.clipboard.writeText(text.trim());
    el.btnCopy.textContent = "Copied";
    window.setTimeout(() => (el.btnCopy.textContent = "Copy"), 1500);
  } catch {
    showError("Couldn't copy to the clipboard.");
  }
});
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
api.onNotice((message) => showError(message));
api.onMeetingApp((app) => {
  state.meetingApp = app;
  // Detection only runs during a session, so any app reported belongs to this call.
  if (app) state.lastMeetingApp = app;
  if (state.listening) setStatus(listeningStatus());
});
api.onShortcut((name) => {
  if (name === "answer") void ask();
});

void api.getSettings().then((s) => {
  state.settings = s;
  renderToggles();
  renderModelChip();
  references.render();
  const sttKey = s.sttProvider === "deepgram" ? s.hasDeepgramKey : s.hasSpeechmaticsKey;
  const aiKey = s.aiProvider === "local" || (s.aiProvider === "openai" ? s.hasOpenAIKey : s.hasAnthropicKey);
  if (!sttKey) showSettings(true, "speech");
  else if (!aiKey) showSettings(true, "ai");
});
