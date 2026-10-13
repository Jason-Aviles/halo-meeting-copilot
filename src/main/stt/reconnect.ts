import type { SttCallbacks, SttStream } from "./types";

export interface ReconnectEvents {
  onTranscript(text: string, isFinal: boolean): void;
  onError(message: string): void;
  /** The connection dropped; another attempt starts after delayMs. */
  onReconnecting(delayMs: number): void;
  /** A new connection is up after a drop. */
  onRecovered(): void;
  /** Too many attempts failed in a row; no more retries. */
  onGiveUp(): void;
}

export interface ReconnectOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Keeps a speech-to-text stream connected for the whole call. When the service
 * drops the connection, it reopens it with exponential backoff. Audio sent while
 * reconnecting is dropped; the provider buffers whatever arrives while its new
 * socket is opening. The attempt count resets only once transcripts flow again,
 * so a connection that opens and immediately fails still counts toward giving up.
 */
export function withReconnect(
  open: (callbacks: SttCallbacks) => SttStream,
  events: ReconnectEvents,
  { maxAttempts = 5, baseDelayMs = 1_000, maxDelayMs = 10_000 }: ReconnectOptions = {},
): SttStream {
  let current: SttStream | undefined;
  /** The stream being shut down by close(); its final results still count. */
  let finishing: SttStream | undefined;
  let stopped = false;
  let attempt = 0;
  let reconnecting = false;
  let timer: NodeJS.Timeout | undefined;

  const connect = () => {
    const stream: SttStream = open({
      onOpen() {
        if (current !== stream || !reconnecting) return;
        reconnecting = false;
        events.onRecovered();
      },
      onTranscript(text, isFinal) {
        if (current !== stream && finishing !== stream) return;
        attempt = 0;
        events.onTranscript(text, isFinal);
      },
      onError(message) {
        if (current === stream) events.onError(message);
      },
      onClose() {
        if (stopped || current !== stream) return;
        current = undefined;
        if (attempt >= maxAttempts) {
          events.onGiveUp();
          return;
        }
        const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        attempt++;
        reconnecting = true;
        events.onReconnecting(delay);
        timer = setTimeout(() => {
          if (!stopped) connect();
        }, delay);
      },
    });
    current = stream;
  };

  connect();

  return {
    send(chunk) {
      current?.send(chunk);
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      const stream = current;
      current = undefined;
      finishing = stream;
      return stream ? stream.close() : Promise.resolve();
    },
  };
}
