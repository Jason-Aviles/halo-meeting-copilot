import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AnswerEvent,
  AnswerRequest,
  HistorySearch,
  SaveCallRequest,
  SessionInfo,
  SettingsUpdate,
  Speaker,
  TranscriptEvent,
} from "../shared/types";
import { describeAnswerError, prewarmAnswers, streamAnswer } from "./answer";
import { deleteCall, getCall, saveCall, searchCalls, updateNotes } from "./history";
import { detectMeetingApp, loadNative, type NativeEchoCanceller } from "./native";
import { listLocalModels } from "./ai/local";
import { getSecret, getSettings, toPublic, updateSettings } from "./settings";
import { addSource, enabledSourceText, jiraQuery, refreshSource, removeSource, setSourceEnabled } from "./sources";
import { openDeepgram } from "./stt/deepgram";
import { openSpeechmatics } from "./stt/speechmatics";
import { withReconnect } from "./stt/reconnect";
import type { SttStream } from "./stt/types";

const RENDERER_HTML = path.join(__dirname, "renderer", "index.html");
const RENDERER_URL = pathToFileURL(RENDERER_HTML).href;

let win: BrowserWindow | undefined;
const sttStreams: Partial<Record<Speaker, SttStream>> = {};
let echoCanceller: NativeEchoCanceller | undefined;
let meetingAppTimer: NodeJS.Timeout | undefined;
let meetingApp: string | null = null;
let answerAbort: AbortController | undefined;
let answerSeq = 0;

function createWindow(): void {
  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 360,
    minHeight: 420,
    frame: false,
    alwaysOnTop: true,
    // Windows 11 acrylic glass behind a translucent page tint (styles.css --tint).
    // On systems without it, the page tint alone keeps the window dark.
    backgroundColor: "#00000000",
    backgroundMaterial: "acrylic",
    title: "Halo",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Stay above full-screen meeting windows.
  win.setAlwaysOnTop(true, "floating");
  win.loadFile(RENDERER_HTML);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.on("closed", () => {
    win = undefined;
    void stopSession();
  });
}

/** Only our own page may call into the main process. */
function fromOurPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url === RENDERER_URL;
}

function handle<Args extends unknown[], R>(
  channel: string,
  fn: (...args: Args) => R | Promise<R>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPage(event)) throw new Error("Unauthorized sender");
    return fn(...(args as Args));
  });
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function startSession(): SessionInfo {
  void stopSession();
  const s = getSettings();
  const key = getSecret(s.sttProvider === "deepgram" ? "deepgramKey" : "speechmaticsKey");
  if (!key) {
    const name = s.sttProvider === "deepgram" ? "Deepgram" : "Speechmatics";
    throw new Error(`Add your ${name} API key in Settings first.`);
  }

  const service = s.sttProvider === "deepgram" ? "Deepgram" : "Speechmatics";
  for (const speaker of ["you", "them"] as const) {
    const side = speaker === "you" ? "your mic" : "their audio";
    sttStreams[speaker] = withReconnect(
      (callbacks) =>
        s.sttProvider === "deepgram"
          ? openDeepgram(key, s.language, callbacks)
          : openSpeechmatics(key, s.speechmaticsRegion, s.language, callbacks),
      {
        onTranscript: (text, isFinal) =>
          send("stt:transcript", { speaker, text, isFinal } satisfies TranscriptEvent),
        onError: (message) => send("stt:error", message),
        onReconnecting: (delayMs) =>
          send("stt:error", `${service} dropped the connection for ${side}. Reconnecting in ${Math.round(delayMs / 1000)} s…`),
        // An empty message clears the warning in the window.
        onRecovered: () => send("stt:error", ""),
        onGiveUp: () =>
          send("stt:error", `${service} keeps dropping the connection for ${side}. Check your key and network, then start listening again.`),
      },
    );
  }

  const native = loadNative();
  echoCanceller = native ? new native.EchoCanceller() : undefined;

  pollMeetingApp();
  meetingAppTimer = setInterval(pollMeetingApp, 3_000);

  // Get the first answer of the call as fast as later ones. Runs in the background.
  const apiKey = aiKey();
  if (apiKey || s.aiProvider === "local") void prewarmAnswers(answerSettings(apiKey));

  return { echoCancellation: Boolean(echoCanceller) };
}

function pollMeetingApp(): void {
  const app = detectMeetingApp();
  if (app !== meetingApp) {
    meetingApp = app;
    send("meeting:app", app);
  }
}

/** Routes a 100 ms PCM16 chunk to speech-to-text, cleaning echo from the mic. */
function onAudio(speaker: Speaker, chunk: Int16Array): void {
  if (speaker === "them") {
    echoCanceller?.pushRender(chunk);
  } else if (echoCanceller) {
    chunk = echoCanceller.processCapture(chunk);
    if (chunk.length === 0) return;
  }
  sttStreams[speaker]?.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
}

/** Stops capture processing; resolves once both services have sent their final results. */
function stopSession(): Promise<void> {
  const closing: Promise<void>[] = [];
  for (const speaker of ["you", "them"] as const) {
    const stream = sttStreams[speaker];
    delete sttStreams[speaker];
    if (stream) closing.push(stream.close());
  }
  echoCanceller = undefined;
  clearInterval(meetingAppTimer);
  meetingAppTimer = undefined;
  if (meetingApp !== null) {
    meetingApp = null;
    send("meeting:app", null);
  }
  return Promise.all(closing).then(() => undefined);
}

/** The key for the selected AI provider; "" for a local model or when none is saved. */
function aiKey(): string {
  const provider = getSettings().aiProvider;
  if (provider === "local") return "";
  return getSecret(provider === "openai" ? "openaiKey" : "anthropicKey") ?? "";
}

/** Everything an answer needs from Settings except the request itself. */
function answerSettings(apiKey: string) {
  const settings = getSettings();
  return {
    provider: settings.aiProvider,
    apiKey,
    claudeModel: settings.model,
    openaiModel: settings.openaiModel,
    localUrl: settings.localUrl,
    localModel: settings.localModel,
    mode: settings.mode,
    style: settings.answerStyle,
    length: settings.answerLength,
    notesFormat: settings.notesFormat,
    context: settings.context,
    references: enabledSourceText(),
  };
}

function ask(request: AnswerRequest): number {
  // Number every request, even ones that fail, so the window's expected id stays in step.
  const id = ++answerSeq;
  answerAbort?.abort();

  const settings = getSettings();
  const provider = settings.aiProvider;
  const apiKey = aiKey();
  if (provider !== "local" && !apiKey) {
    throw new Error(`Add your ${provider === "openai" ? "OpenAI" : "Anthropic"} API key in Settings first.`);
  }

  const abort = new AbortController();
  answerAbort = abort;
  const emit = (event: AnswerEvent) => send("answer:event", event);

  streamAnswer({
    ...answerSettings(apiKey),
    request: {
      kind: request.kind === "summary" ? "summary" : "answer",
      transcript: Array.isArray(request.transcript) ? request.transcript : [],
      question: typeof request.question === "string" ? request.question : undefined,
      meeting:
        request.meeting && Number.isFinite(Number(request.meeting.startedAt))
          ? {
              startedAt: Number(request.meeting.startedAt),
              app: typeof request.meeting.app === "string" ? request.meeting.app.slice(0, 60) : null,
              ...(Number.isFinite(Number(request.meeting.endedAt)) ? { endedAt: Number(request.meeting.endedAt) } : {}),
            }
          : undefined,
    },
    signal: abort.signal,
    onText: (text) => emit({ id, type: "delta", text }),
  })
    .then(() => emit({ id, type: "done" }))
    .catch((err) => {
      if (abort.signal.aborted) emit({ id, type: "done" });
      else emit({ id, type: "error", message: describeAnswerError(provider, err) });
    })
    .finally(() => {
      if (answerAbort === abort) answerAbort = undefined;
    });

  return id;
}

/** Paths come only from the system picker, never from the page. */
async function pickAndAdd(kind: "file" | "folder") {
  const result = await dialog.showOpenDialog(win!, {
    title: kind === "file" ? "Add reference files" : "Add a folder or local repo",
    properties: kind === "file" ? ["openFile", "multiSelections"] : ["openDirectory"],
    ...(kind === "file"
      ? { filters: [{ name: "Text and code", extensions: ["md", "txt", "markdown", "rst", "json", "yaml", "yml", "csv", "html", "ts", "js", "py", "*"] }] }
      : {}),
  });
  let sources = toPublic().sources;
  for (const p of result.canceled ? [] : result.filePaths) sources = await addSource(kind, p);
  return sources;
}

function registerIpc(): void {
  handle("settings:get", () => toPublic());
  handle("settings:update", (update: SettingsUpdate) => updateSettings(update));
  handle("session:start", () => startSession());
  handle("session:stop", () => stopSession());
  handle("answer:ask", (request: AnswerRequest) => ask(request));
  handle("answer:cancel", () => answerAbort?.abort());
  handle("window:private", (on: boolean) => win?.setContentProtection(Boolean(on)));
  handle("window:minimize", () => win?.minimize());
  handle("app:quit", () => app.quit());
  handle("history:save", (request: SaveCallRequest) => saveCall(request));
  handle("history:updateNotes", (id: number, notes: string) => updateNotes(Number(id), String(notes)));
  handle("history:search", (search: HistorySearch) =>
    searchCalls({ query: String(search?.query ?? ""), offset: Number(search?.offset ?? 0) }),
  );
  handle("history:get", (id: number) => getCall(Number(id)) ?? null);
  handle("history:delete", (id: number) => deleteCall(Number(id)));
  handle("local:models", (url: string) => listLocalModels(String(url)));
  handle("sources:addFiles", () => pickAndAdd("file"));
  handle("sources:addFolder", () => pickAndAdd("folder"));
  handle("sources:addGithub", (url: string) => addSource("github", String(url)));
  handle("sources:addJira", (input: string) => addSource("jira", jiraQuery(String(input))));
  handle("sources:refresh", (id: string) => refreshSource(String(id)));
  handle("sources:remove", (id: string) => removeSource(String(id)));
  handle("sources:setEnabled", (id: string, on: boolean) => setSourceEnabled(String(id), Boolean(on)));

  ipcMain.on("audio:chunk", (event, speaker: Speaker, pcm16: ArrayBuffer) => {
    if (!fromOurPage(event)) return;
    if (speaker !== "you" && speaker !== "them") return;
    if (!(pcm16 instanceof ArrayBuffer) || pcm16.byteLength % 2 !== 0) return;
    onAudio(speaker, new Int16Array(pcm16));
  });
}

function configureSession(): void {
  const ses = session.defaultSession;

  // Microphone and screen/system-audio capture are the only permissions the page needs.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ours = details.requestingUrl === RENDERER_URL && wc === win?.webContents;
    callback(ours && (permission === "media" || permission === "display-capture"));
  });

  // getDisplayMedia() from the page: share system audio via WASAPI loopback, no picker.
  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const [screen] = await desktopCapturer.getSources({ types: ["screen"] });
      if (!screen) return callback({});
      callback({ video: screen, audio: "loopback" });
    },
    { useSystemPicker: false },
  );
}

function registerShortcuts(): void {
  const shortcuts: Array<[string, string, () => void]> = [
    ["CommandOrControl+Shift+Enter", "Ctrl+Shift+Enter (answer)", () => send("shortcut", "answer")],
    [
      "CommandOrControl+Shift+Space",
      "Ctrl+Shift+Space (show/hide)",
      () => {
        if (!win) return;
        if (win.isVisible()) win.hide();
        else win.showInactive();
      },
    ],
  ];
  // register() returns false when another app already owns the key combination.
  const taken = shortcuts.filter(([accel, , fn]) => !globalShortcut.register(accel, fn)).map(([, label]) => label);
  if (taken.length > 0 && win) {
    const message = `Another app is using ${taken.join(" and ")}, so that hotkey won't work in Halo.`;
    win.webContents.once("did-finish-load", () => send("app:notice", message));
  }
}

app.whenReady().then(() => {
  configureSession();
  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void stopSession();
  answerAbort?.abort();
});

app.on("window-all-closed", () => app.quit());
