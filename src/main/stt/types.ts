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
  close(): void;
}

/** Holds audio that arrives before the socket is ready (about 5 s at 100 ms chunks). */
export const MAX_PENDING_CHUNKS = 50;
