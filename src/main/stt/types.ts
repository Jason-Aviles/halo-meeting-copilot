import WebSocket from "ws";

/** Audio sent to every provider: 16 kHz, mono, signed 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;

export interface SttCallbacks {
  /** Interim results replace each other until a final result commits the text. */
  onTranscript(text: string, isFinal: boolean): void;
  onError(message: string): void;
  onClose(): void;
}

export interface SttStream {
  send(chunk: Buffer): void;
  /** Asks the service to finish, resolving once its final results have arrived. */
  close(): Promise<void>;
}

/** Resolves once the socket has closed, forcing it closed after graceMs. */
export function whenClosed(ws: WebSocket, graceMs: number): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => ws.terminate(), graceMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Holds audio that arrives before the socket is ready (about 5 s at 100 ms chunks). */
export const MAX_PENDING_CHUNKS = 50;
