import { contextBridge, ipcRenderer } from "electron";
import type { HaloApi } from "../shared/types";

const api: HaloApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (update) => ipcRenderer.invoke("settings:update", update),
  startSession: () => ipcRenderer.invoke("session:start"),
  stopSession: () => ipcRenderer.invoke("session:stop"),
  sendAudio: (speaker, pcm16) => ipcRenderer.send("audio:chunk", speaker, pcm16),
  ask: (request) => ipcRenderer.invoke("answer:ask", request),
  cancelAnswer: () => ipcRenderer.invoke("answer:cancel"),
  setPrivateMode: (on) => ipcRenderer.invoke("window:private", on),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  quit: () => ipcRenderer.invoke("app:quit"),
  onTranscript: (listener) => ipcRenderer.on("stt:transcript", (_e, event) => listener(event)),
  onAnswer: (listener) => ipcRenderer.on("answer:event", (_e, event) => listener(event)),
  onSttError: (listener) => ipcRenderer.on("stt:error", (_e, message) => listener(message)),
  onShortcut: (listener) => ipcRenderer.on("shortcut", (_e, name) => listener(name)),
  onMeetingApp: (listener) => ipcRenderer.on("meeting:app", (_e, app) => listener(app)),
  saveCall: (request) => ipcRenderer.invoke("history:save", request),
  updateCallNotes: (id, notes) => ipcRenderer.invoke("history:updateNotes", id, notes),
  searchCalls: (search) => ipcRenderer.invoke("history:search", search),
  getCall: (id) => ipcRenderer.invoke("history:get", id),
  deleteCall: (id) => ipcRenderer.invoke("history:delete", id),
};

contextBridge.exposeInMainWorld("halo", api);
