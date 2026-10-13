import WebSocket from "ws";
import type { SpeechmaticsRegion } from "../../shared/types";
import { MAX_PENDING_CHUNKS, SAMPLE_RATE, whenClosed, type SttCallbacks, type SttStream } from "./types";

// https://docs.speechmatics.com/rt-api-ref
export function openSpeechmatics(
  apiKey: string,
  region: SpeechmaticsRegion,
  language: string,
  cb: SttCallbacks,
): SttStream {
  const ws = new WebSocket(`wss://${region}.rt.speechmatics.com/v2`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const pending: Buffer[] = [];
  let started = false;
  let chunksSent = 0;

  const sendAudio = (chunk: Buffer) => {
    ws.send(chunk);
    chunksSent++;
  };

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        message: "StartRecognition",
        audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: SAMPLE_RATE },
        transcription_config: {
          language: language === "multi" ? "auto" : language,
          enable_partials: true,
          // Lowest allowed: finals arrive sooner at a small accuracy cost.
          max_delay: 0.7,
          operating_point: "enhanced",
        },
      }),
    );
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.message) {
      case "RecognitionStarted":
        started = true;
        for (const chunk of pending) sendAudio(chunk);
        pending.length = 0;
        break;
      case "AddPartialTranscript":
      case "AddTranscript": {
        const text: string = (msg.metadata?.transcript ?? "").trim();
        if (text) cb.onTranscript(text, msg.message === "AddTranscript");
        break;
      }
      case "Error":
        cb.onError(`Speechmatics: ${msg.reason ?? msg.type ?? "unknown error"}`);
        break;
      case "EndOfTranscript":
        ws.close();
        break;
    }
  });

  ws.on("error", (err) => {
    const hint = /401|403/.test(err.message) ? " Check your Speechmatics API key." : "";
    cb.onError(`Speechmatics: ${err.message}.${hint}`);
  });

  ws.on("close", () => cb.onClose());

  return {
    send(chunk) {
      if (started && ws.readyState === WebSocket.OPEN) sendAudio(chunk);
      else if (!started && pending.length < MAX_PENDING_CHUNKS) pending.push(chunk);
    },
    close() {
      if (started && ws.readyState === WebSocket.OPEN) {
        // Speechmatics flushes remaining finals, then replies with EndOfTranscript,
        // on which the message handler above closes the socket.
        ws.send(JSON.stringify({ message: "EndOfStream", last_seq_no: chunksSent }));
      } else if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
      return whenClosed(ws, 2_000);
    },
  };
}
