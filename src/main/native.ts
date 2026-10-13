import path from "node:path";

// Built from native/ by `npm run build:native` and copied next to main.js by build.mjs.
export interface NativeEchoCanceller {
  /** Far-end audio: what's playing through the speakers. */
  pushRender(pcm: Int16Array): void;
  /** Microphone audio with speaker echo removed. */
  processCapture(pcm: Int16Array): Int16Array;
}

interface NativeModule {
  EchoCanceller: new () => NativeEchoCanceller;
  listMicSessions(): Array<{ pid: number; exe: string }>;
}

let cached: NativeModule | null | undefined;

/** Returns the add-on, or null if it isn't built (the app still works without it). */
export function loadNative(): NativeModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = require(path.join(__dirname, "paracat-native.node")) as NativeModule;
  } catch (err) {
    console.warn("Halo native add-on unavailable; echo cancellation is off.", err);
    cached = null;
  }
  return cached;
}

const MEETING_APPS: Record<string, string> = {
  "zoom.exe": "Zoom",
  "ms-teams.exe": "Teams",
  "teams.exe": "Teams",
  "slack.exe": "Slack",
  "discord.exe": "Discord",
  "webex.exe": "Webex",
  "ciscocollabhost.exe": "Webex",
  "skype.exe": "Skype",
  "chrome.exe": "Chrome",
  "msedge.exe": "Edge",
  "firefox.exe": "Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
};

/** Names the app (other than Halo) that is recording from a mic, if any. */
export function detectMeetingApp(): string | null {
  const native = loadNative();
  if (!native) return null;
  const self = path.basename(process.execPath).toLowerCase();
  let sessions: Array<{ exe: string }>;
  try {
    sessions = native.listMicSessions();
  } catch {
    return null;
  }
  for (const { exe } of sessions) {
    const name = exe.toLowerCase();
    if (!name || name === self) continue;
    return MEETING_APPS[name] ?? exe.replace(/\.exe$/i, "");
  }
  return null;
}
