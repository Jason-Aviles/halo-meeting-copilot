import {
  app,
  BrowserWindow,
  desktopCapturer,
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
import { describeAnswerError, streamAnswer } from "./answer";
import { deleteCall, getCall, saveCall, searchCalls, updateNotes } from "./history";
import { detectMeetingApp, loadNative, type NativeEchoCanceller } from "./native";
import { getSecret, getSettings, toPublic, updateSettings } from "./settings";
import { openDeepgram } from "./stt/deepgram";
import { openSpeechmatics } from "./stt/speechmatics";
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
    stopSession();
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
  stopSession();
  const s = getSettings();
  const key = getSecret(s.sttProvider === "deepgram" ? "deepgramKey" : "speechmaticsKey");
  if (!key) {
    const name = s.sttProvider === "deepgram" ? "Deepgram" : "Speechmatics";
    throw new Error(`Add your ${name} API key in Settings first.`);
  }

  for (const speaker of ["you", "them"] as const) {
    const callbacks = {
      onTranscript: (text: string, isFinal: boolean) =>
        send("stt:transcript", { speaker, text, isFinal } satisfies TranscriptEvent),
      onError: (message: string) => send("stt:error", message),
      onClose: () => {
        if (sttStreams[speaker] === stream) delete sttStreams[speaker];
      },
    };
    const stream =
      s.sttProvider === "deepgram"
        ? openDeepgram(key, s.language, callbacks)
        : openSpeechmatics(key, s.speechmaticsRegion, s.language, callbacks);
    sttStreams[speaker] = stream;
  }

  const native = loadNative();
  echoCanceller = native ? new native.EchoCanceller() : undefined;

  pollMeetingApp();
  meetingAppTimer = setInterval(pollMeetingApp, 3_000);

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

function stopSession(): void {
  for (const speaker of ["you", "them"] as const) {
    sttStreams[speaker]?.close();
    delete sttStreams[speaker];
  }
  echoCanceller = undefined;
  clearInterval(meetingAppTimer);
  meetingAppTimer = undefined;
  if (meetingApp !== null) {
    meetingApp = null;
    send("meeting:app", null);
  }
}

function ask(request: AnswerRequest): number {
  // Number every request, even ones that fail, so the window's expected id stays in step.
  const id = ++answerSeq;
  answerAbort?.abort();

  const settings = getSettings();
  const openai = settings.aiProvider === "openai";
  const apiKey = getSecret(openai ? "openaiKey" : "anthropicKey");
  if (!apiKey) {
    throw new Error(`Add your ${openai ? "OpenAI" : "Anthropic"} API key in Settings first.`);
  }

  const abort = new AbortController();
  answerAbort = abort;
  const emit = (event: AnswerEvent) => send("answer:event", event);

  streamAnswer({
    provider: settings.aiProvider,
    apiKey,
    claudeModel: settings.model,
    openaiModel: settings.openaiModel,
    mode: settings.mode,
    style: settings.answerStyle,
    length: settings.answerLength,
    context: settings.context,
    request: {
      kind: request.kind === "summary" ? "summary" : "answer",
      transcript: Array.isArray(request.transcript) ? request.transcript : [],
      question: typeof request.question === "string" ? request.question : undefined,
    },
    signal: abort.signal,
    onText: (text) => emit({ id, type: "delta", text }),
  })
    .then(() => emit({ id, type: "done" }))
    .catch((err) => {
      if (abort.signal.aborted) emit({ id, type: "done" });
      else emit({ id, type: "error", message: describeAnswerError(err) });
    })
    .finally(() => {
      if (answerAbort === abort) answerAbort = undefined;
    });

  return id;
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
  globalShortcut.register("CommandOrControl+Shift+Enter", () => send("shortcut", "answer"));
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
}

app.whenReady().then(() => {
  configureSession();
  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopSession();
  answerAbort?.abort();
});

app.on("window-all-closed", () => app.quit());
