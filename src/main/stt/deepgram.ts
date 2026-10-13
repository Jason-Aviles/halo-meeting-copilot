import WebSocket from "ws";
import { MAX_PENDING_CHUNKS, SAMPLE_RATE, whenClosed, type SttCallbacks, type SttStream } from "./types";

// https://developers.deepgram.com/docs/live-streaming-audio
export function openDeepgram(apiKey: string, language: string, cb: SttCallbacks): SttStream {
  const params = new URLSearchParams({
    model: "nova-3",
    language,
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: "300",
  });
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  const pending: Buffer[] = [];
  let keepAlive: NodeJS.Timeout | undefined;

  ws.on("open", () => {
    for (const chunk of pending) ws.send(chunk);
    pending.length = 0;
    // Deepgram closes idle sockets after ~10 s without audio or a KeepAlive.
    keepAlive = setInterval(() => ws.send(JSON.stringify({ type: "KeepAlive" })), 8_000);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "Results") {
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (text) cb.onTranscript(text, Boolean(msg.is_final));
    } else if (msg.type === "Error") {
      cb.onError(`Deepgram: ${msg.description ?? msg.message ?? "unknown error"}`);
    }
  });

  ws.on("error", (err) => {
    const hint = /401|403/.test(err.message) ? " Check your Deepgram API key." : "";
    cb.onError(`Deepgram: ${err.message}.${hint}`);
  });

  ws.on("close", () => {
    clearInterval(keepAlive);
    cb.onClose();
  });

  return {
    send(chunk) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else if (ws.readyState === WebSocket.CONNECTING && pending.length < MAX_PENDING_CHUNKS) {
        pending.push(chunk);
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        // Deepgram sends its remaining final results, then closes the socket.
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
      return whenClosed(ws, 1_500);
    },
  };
}
